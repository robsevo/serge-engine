/**
 * The agent loop.
 *
 *   SessionStart → UserPromptSubmit → [ model → tools → model → … ] → Stop
 *
 * Each tool call is gated by PreToolUse and reported by PostToolUse, and every
 * step is written to the transcript as it happens — not summarised afterwards.
 * That ordering is the point: the transcript is what the gates read to decide
 * whether a turn's claims are true, so it has to record what happened rather
 * than what the model said happened.
 */
import { randomUUID } from 'node:crypto'
import { Transcript } from './transcript.mjs'
import { runHooks, basePayload } from './hooks.mjs'
import { loadSettings, providerConfig } from './config.mjs'
import { toolSchemas, runTool, SUBAGENT_TOOLS } from './tools/index.mjs'
import { complete } from './provider.mjs'
import { checkPermission } from './permissions.mjs'
import { shouldCompact, compact, size } from './compact.mjs'

const MAX_TURNS = 40
const COMPACT_AT_CHARS = Number(process.env.SERGE_COMPACT_AT || 400_000)

export async function runSession({
  prompt, cwd, model, onToken, onNotice, permissionMode = 'default',
}) {
  const settings = loadSettings()
  const provider = providerConfig(settings)
  if (model) provider.model = model

  const sessionId = randomUUID()
  const transcript = new Transcript(sessionId, cwd)
  const session = { sessionId, cwd, transcript, permissionMode }
  const base = () => basePayload(session)

  runHooks('SessionStart', { ...base(), source: 'startup' }, 'startup', settings)

  const ups = runHooks('UserPromptSubmit', { ...base(), prompt }, undefined, settings)
  if (ups.blocked) {
    onNotice?.(`blocked: ${ups.reason}`)
    return { text: '', blocked: true, reason: ups.reason, sessionId, transcriptPath: transcript.path }
  }

  transcript.userPrompt(prompt)

  let messages = [
    ...ups.context.map((c) => ({ role: 'system', content: c })),
    { role: 'user', content: prompt },
  ]

  /** Subagent spawner, injected into the Task tool (see tools/task.mjs). */
  const spawnSubagent = async ({ prompt: brief, label }) => {
    const subId = randomUUID()
    runHooks('SubagentStart', { ...base(), subagent_id: subId, subagent_type: label, prompt: brief },
      label, settings)
    try {
      const out = await subLoop({
        brief, cwd, provider, settings, session, permissionMode, depth: 1,
      })
      runHooks('SubagentStop', { ...base(), subagent_id: subId, subagent_type: label, last_assistant_message: out.text },
        label, settings)
      return out
    } catch (e) {
      runHooks('SubagentStop', { ...base(), subagent_id: subId, subagent_type: label, error: String(e?.message ?? e) },
        label, settings)
      return { error: String(e?.message ?? e) }
    }
  }

  let final = ''
  let stopHookActive = false
  let mode = permissionMode

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Compaction happens BEFORE the request, never mid-flight: a summary built
    // from a half-finished exchange loses the half that mattered.
    if (shouldCompact(messages, COMPACT_AT_CHARS)) {
      const trigger = 'auto'
      runHooks('PreCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
      const r = await compact({ messages, complete, provider })
      if (r.failed) {
        onNotice?.('compaction failed — continuing uncompacted')
      } else {
        messages = r.messages
        onNotice?.(`compacted context (-${r.droppedChars} chars)`)
      }
      runHooks('PostCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
    }

    const { text, toolCalls } = await complete({
      ...provider, messages, tools: toolSchemas(), onToken, onNotice,
    })

    if (!toolCalls.length) {
      final = text
      if (text) transcript.assistantText(text)
      messages.push({ role: 'assistant', content: text })

      let stop
      try {
        stop = runHooks('Stop', {
          ...base(), last_assistant_message: text, stop_hook_active: stopHookActive,
        }, undefined, settings)
      } catch (e) {
        runHooks('StopFailure', { ...base(), error: String(e?.message ?? e) }, undefined, settings)
        stop = { blocked: false }
      }

      if (stop.blocked) {
        stopHookActive = true
        onNotice?.(`stop hook: ${stop.reason}`)
        messages.push({ role: 'user', content: stop.reason })
        continue
      }

      runHooks('TaskCompleted', { ...base(), last_assistant_message: text }, undefined, settings)
      return { text: final, blocked: false, sessionId, transcriptPath: transcript.path }
    }

    transcript.assistantToolUse(toolCalls)
    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    })

    const results = []
    for (const call of toolCalls) {
      const payload = { ...base(), tool_name: call.name, tool_input: call.input, tool_use_id: call.id }

      const pre = runHooks('PreToolUse', payload, call.name, settings)
      if (pre.blocked) {
        results.push({ id: call.id, content: `Blocked by PreToolUse hook: ${pre.reason}`, isError: true })
        onNotice?.(`denied ${call.name}: ${pre.reason}`)
        runHooks('Notification', { ...base(), notification_type: 'permission_prompt', message: pre.reason },
          'permission_prompt', settings)
        continue
      }

      const verdict = checkPermission({
        tool: call.name, input: call.input, mode, settings, cwd,
        hookDecision: pre.decision, hookReason: pre.reason,
      })
      if (!verdict.allow) {
        results.push({ id: call.id, content: `Permission denied: ${verdict.reason}`, isError: true })
        onNotice?.(`denied ${call.name}: ${verdict.reason}`)
        runHooks('Notification', { ...base(), notification_type: 'permission_prompt', message: verdict.reason },
          'permission_prompt', settings)
        runHooks('PostToolUseFailure',
          { ...payload, tool_response: `Permission denied: ${verdict.reason}` }, call.name, settings)
        continue
      }

      const out = await runTool(call.name, call.input, {
        cwd, depth: 0, spawnSubagent,
        // Approving a plan is what ends plan mode — the tool cannot do it
        // itself, because the mode belongs to the session, not the call.
        onPlanApproved: () => { if (mode === 'plan') mode = 'acceptEdits' },
      })

      // A PostToolUse hook can BLOCK. The call already happened — post means
      // post — so blocking cannot undo it; what it does is force the model to
      // deal with what the hook found instead of moving on. Serge's algo-gate,
      // semgrep-scan and arch-gate all work this way, and discarding this result
      // silently disarms every one of them: observed 2026-08-22, when arch-gate
      // correctly flagged a swallowed error and the engine reported success.
      const post = runHooks(out.isError ? 'PostToolUseFailure' : 'PostToolUse',
        { ...payload, tool_response: out.content }, call.name, settings)

      let content = out.content
      let isError = out.isError
      if (post.blocked) {
        content = `${out.content}\n\n--- BLOCKED BY PostToolUse HOOK ---\n${post.reason}`
        isError = true
        onNotice?.(`post-hook blocked ${call.name}: ${String(post.reason).split('\n')[0]}`)
      } else if (post.context.length) {
        content = `${out.content}\n\n${post.context.join('\n')}`
      }
      results.push({ id: call.id, content, isError })
    }

    transcript.toolResults(results)
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') })
    }
  }

  onNotice?.(`stopped after ${MAX_TURNS} turns without a final answer`)
  return { text: final, blocked: false, exhausted: true, sessionId, transcriptPath: transcript.path }
}

/**
 * A subagent: same loop, reduced tools, no hooks of its own beyond the
 * Subagent* pair the parent fires. It shares the parent's transcript so the
 * gates see one coherent record of the turn.
 */
async function subLoop({ brief, cwd, provider, settings, session, permissionMode, depth }) {
  const messages = [{ role: 'user', content: brief }]
  for (let turn = 0; turn < 12; turn++) {
    const { text, toolCalls } = await complete({
      ...provider, messages, tools: toolSchemas(SUBAGENT_TOOLS),
    })
    if (!toolCalls.length) return { text }

    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    })

    for (const call of toolCalls) {
      const verdict = checkPermission({
        tool: call.name, input: call.input, mode: permissionMode, settings, cwd,
      })
      const out = verdict.allow
        ? await runTool(call.name, call.input, { cwd, depth })
        : { content: `Permission denied: ${verdict.reason}`, isError: true }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(out.content ?? '') })
    }
  }
  return { text: '', error: 'subagent exhausted its turn budget' }
}
