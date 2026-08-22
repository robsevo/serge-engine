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
import { loadSkills, skillIndex, loadAgents } from './brain.mjs'
import { makeSkillTool } from './tools/skill.mjs'
import { makeTaskTool } from './tools/task.mjs'
import { checkSeat } from './seats.mjs'
import { replay } from './sessions.mjs'

const MAX_TURNS = 40
const COMPACT_AT_CHARS = Number(process.env.SERGE_COMPACT_AT || 400_000)

/**
 * Hard ceiling on what any single tool result may put into context.
 *
 * Every tool already caps its own output, but "every tool" is a promise that
 * holds only until someone adds the next one. This is the choke point that does
 * not depend on remembering: whatever a tool returns, a bounded amount reaches
 * the model.
 *
 * The failure this prevents is specific and expensive. A summarize-then-inject
 * path that FAILS OPEN — falling back to raw content when the summarizer is
 * busy or rate-limited — can push ~25k tokens of unprocessed page into a turn.
 * The model then spends the rest of the turn distracted by material nothing
 * asked for, and the cause is invisible because everything "succeeded".
 *
 * Truncating is the fail-CLOSED choice: the model is told plainly that it is
 * seeing a fragment and how to get the rest, which is strictly better than
 * silently reshaping the turn.
 */
const MAX_TOOL_RESULT_CHARS = Number(process.env.SERGE_MAX_TOOL_RESULT || 60_000)

function boundResult(name, content) {
  const s = String(content ?? '')
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s
  const keep = Math.floor(MAX_TOOL_RESULT_CHARS * 0.75)
  const tail = MAX_TOOL_RESULT_CHARS - keep
  return s.slice(0, keep)
    + `\n\n… [${name} returned ${s.length} chars; ${s.length - MAX_TOOL_RESULT_CHARS} omitted from the middle. `
    + `Narrow the call — a pattern, a path, a line range — rather than asking again.]\n\n`
    + s.slice(-tail)
}

/**
 * A session: conversation state that outlives a single prompt.
 *
 * The headless path (`runSession`, below) is one call to `send()`; an
 * interactive session is many. Everything that must persist across turns —
 * the message history, the permission mode after a plan is approved, the
 * transcript, whether SessionStart has fired — lives here rather than inside
 * the turn, which is what makes the second prompt aware of the first.
 */
export function createSession({
  cwd, model, onToken, onNotice, onTool, onAsk, permissionMode = 'default',
  mcp = null, resumeFrom = null, forkParent = null, loadBrain = true,
}) {
  const settings = loadSettings()
  const provider = providerConfig(settings)
  if (model) provider.model = model

  const sessionId = randomUUID()
  // A fork records its parent, so replay can follow the chain instead of the
  // branch losing everything before the split.
  const transcript = new Transcript(sessionId, cwd, forkParent)
  const session = { sessionId, cwd, transcript, permissionMode }
  const base = () => basePayload(session)

  let messages = []
  let mode = permissionMode
  let started = false
  // "always allow" answers, scoped to this session. Kept here rather than
  // written to settings: a decision made to get one turn moving should not
  // quietly become permanent policy on disk.
  const sessionAllow = new Set()
  // Cumulative across the session, so the status line reflects the conversation
  // rather than the last request.
  const usage = { prompt: 0, completion: 0, requests: 0 }

  // Skills are session-scoped: the index goes into context once, and the Skill
  // tool that reads a body is built against THIS session's set.
  const skills = loadBrain ? loadSkills() : new Map()
  const agents = loadBrain ? loadAgents() : new Map()

  // A definition naming a seat the router does not have would fail inside a
  // subagent nobody is watching, so it is caught here and reported once.
  for (const a of agents.values()) {
    if (!a.model) continue
    const v = checkSeat(a.model)
    if (!v.ok) {
      onNotice?.(`agent ${a.name}: ${v.reason.split('\n')[0]} — it will run on the session seat`)
      a.model = null
    }
  }

  const sessionTools = {
    ...(skills.size ? { Skill: makeSkillTool(skills) } : {}),
    ...(agents.size ? { Task: makeTaskTool(agents) } : {}),
  }
  const asSchema = (t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  })
  const extraSchemas = [
    ...(skills.size ? [asSchema(sessionTools.Skill)] : []),
    ...(mcp?.tools ?? []),
  ]

  // Resume: replay a prior transcript into message state. The conversation is
  // continued, not re-run — no hooks fire for turns that already happened.
  let resumed = null
  if (resumeFrom) {
    const r = replay(resumeFrom)
    messages = r.messages
    resumed = { turns: r.turns, dropped: r.dropped, path: resumeFrom }
  }

  /** Subagent spawner, injected into the Task tool (see tools/task.mjs). */
  const spawnSubagent = async ({ prompt: brief, label, agentType = null, tools = null, maxTurns = null }) => {
    const subId = randomUUID()
    const agent = agentType ? agents.get(agentType) : null
    if (agentType && !agent) {
      return { error: `unknown subagent_type "${agentType}". Available: ${[...agents.keys()].join(', ')}` }
    }
    // The hook matcher is the AGENT TYPE where there is one: the brain matches
    // SubagentStop on `scout|researcher|Explore`, so passing a free-text label
    // would silently skip those gates.
    const matcher = agentType || label
    runHooks('SubagentStart',
      { ...base(), subagent_id: subId, subagent_type: matcher, prompt: brief }, matcher, settings)
    try {
      const out = await subLoop({
        brief, cwd, provider, settings, session, permissionMode, depth: 1,
        agent, tools, maxTurns,
      })
      runHooks('SubagentStop', { ...base(), subagent_id: subId, subagent_type: matcher, last_assistant_message: out.text },
        matcher, settings)
      return out
    } catch (e) {
      runHooks('SubagentStop', { ...base(), subagent_id: subId, subagent_type: matcher, error: String(e?.message ?? e) },
        matcher, settings)
      return { error: String(e?.message ?? e) }
    }
  }

  /**
   * One user prompt, run to a final answer.
   * @param {string} prompt
   * @param {{signal?: AbortSignal}} [opts] signal aborts an in-flight generation
   */
  async function send(prompt, { signal } = {}) {
    // SessionStart fires once for the session, not once per prompt: its 10
    // hooks load memory, the repo card and the reasoning overlay, and re-running
    // them every turn would re-inject the same context indefinitely.
    if (!started) {
      runHooks('SessionStart', { ...base(), source: resumed ? 'resume' : 'startup' },
        resumed ? 'resume' : 'startup', settings)
      const idx = skillIndex(skills)
      if (idx) messages.push({ role: 'system', content: idx })
      started = true
    }

    const ups = runHooks('UserPromptSubmit', { ...base(), prompt }, undefined, settings)
    if (ups.blocked) {
      onNotice?.(`blocked: ${ups.reason}`, 'user')
      return { text: '', blocked: true, reason: ups.reason }
    }

    transcript.userPrompt(prompt)
    for (const c of ups.context) messages.push({ role: 'system', content: c })
    messages.push({ role: 'user', content: prompt })

  let final = ''
  let stopHookActive = false

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Compaction happens BEFORE the request, never mid-flight: a summary built
    // from a half-finished exchange loses the half that mattered.
    if (shouldCompact(messages, COMPACT_AT_CHARS)) {
      const trigger = 'auto'
      runHooks('PreCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
      const r = await compact({ messages, complete, provider })
      if (r.failed) {
        onNotice?.('compaction failed — continuing uncompacted', 'user')
      } else {
        messages = r.messages
        onNotice?.(`compacted context (-${r.droppedChars} chars)`, 'user')
      }
      runHooks('PostCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
    }

    const { text, toolCalls, usage: u } = await complete({
      ...provider,
      messages,
      // Task is replaced when agents exist, so the enum lists the real roster.
      tools: toolSchemas(null, extraSchemas)
        .map((t) => (sessionTools[t.function.name] ? asSchema(sessionTools[t.function.name]) : t)),
      onToken, onNotice, signal,
    })
    if (u) {
      usage.prompt += u.prompt_tokens ?? 0
      usage.completion += u.completion_tokens ?? 0
    }
    usage.requests++

    if (!toolCalls.length) {
      final = text
      if (text) transcript.assistantText(text, u)
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
        onNotice?.(`stop hook: ${stop.reason}`, 'model')
        messages.push({ role: 'user', content: stop.reason })
        continue
      }

      runHooks('TaskCompleted', { ...base(), last_assistant_message: text }, undefined, settings)
      return { text: final, blocked: false }
    }

    transcript.assistantToolUse(toolCalls, u)
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
      onTool?.(call.name, call.input)
      const payload = { ...base(), tool_name: call.name, tool_input: call.input, tool_use_id: call.id }

      const pre = runHooks('PreToolUse', payload, call.name, settings)
      if (pre.blocked) {
        results.push({ id: call.id, content: `Blocked by PreToolUse hook: ${pre.reason}`, isError: true })
        onNotice?.(`denied ${call.name}: ${pre.reason}`, 'user')
        runHooks('Notification', { ...base(), notification_type: 'permission_prompt', message: pre.reason },
          'permission_prompt', settings)
        continue
      }

      let verdict = sessionAllow.has(call.name)
        ? { allow: true, decision: 'allow', reason: 'allowed for this session' }
        : checkPermission({
            tool: call.name, input: call.input, mode, settings, cwd,
            hookDecision: pre.decision, hookReason: pre.reason,
          })

      // `ask` means "a human could answer this". With someone at a terminal,
      // ask them — resolving it to a refusal is only correct when there is
      // nobody to ask, which was true headless and is not true here.
      if (!verdict.allow && verdict.rule === 'ask' && onAsk) {
        const answer = await onAsk({ tool: call.name, input: call.input, reason: verdict.reason })
        if (answer === 'always') { sessionAllow.add(call.name); verdict = { allow: true, decision: 'allow', reason: 'allowed for this session' } }
        else if (answer === 'yes') verdict = { allow: true, decision: 'allow', reason: 'allowed once' }
        else verdict = { allow: false, decision: 'deny', reason: 'declined', rule: 'user' }
      }

      if (!verdict.allow) {
        // The hint only helps where nobody could be asked. In a session the user
        // just answered, and telling them how to edit settings.json is noise.
        const detail = verdict.reason + (!onAsk && verdict.hint ? ` ${verdict.hint}` : '')
        results.push({ id: call.id, content: `Permission denied: ${detail}`, isError: true })
        onNotice?.(`denied ${call.name}: ${detail}`, 'user')
        runHooks('Notification', { ...base(), notification_type: 'permission_prompt', message: verdict.reason },
          'permission_prompt', settings)
        runHooks('PostToolUseFailure',
          { ...payload, tool_response: `Permission denied: ${verdict.reason}` }, call.name, settings)
        continue
      }

      const out = await runTool(call.name, call.input, {
        cwd, depth: 0, spawnSubagent, mcp, sessionTools,
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
        onNotice?.(`post-hook blocked ${call.name}: ${String(post.reason).split('\n')[0]}`, 'model')
      } else if (post.context.length) {
        content = `${out.content}\n\n${post.context.join('\n')}`
      }
      results.push({ id: call.id, content: boundResult(call.name, content), isError })
    }

    transcript.toolResults(results)
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') })
    }
  }

    onNotice?.(`stopped after ${MAX_TURNS} turns without a final answer`, 'user')
    return { text: final, blocked: false, exhausted: true }
  }

  return {
    sessionId,
    transcriptPath: transcript.path,
    send,
    /** Live view for the REPL's status line and /model. */
    get model() { return provider.model },
    set model(m) { provider.model = m },
    get mode() { return mode },
    set mode(m) { mode = m },
    get turns() { return messages.filter((m) => m.role === 'user').length },
    get usage() { return { ...usage } },
    get skills() { return skills },
    get agents() { return agents },
    get resumed() { return resumed },
    /** Drop history but keep the session — the transcript still records it. */
    clear() { messages = []; return true },
  }
}

/**
 * Headless: one prompt, one answer. A session with exactly one `send`.
 */
export async function runSession({ prompt, ...opts }) {
  const s = createSession(opts)
  const r = await s.send(prompt)
  return { ...r, sessionId: s.sessionId, transcriptPath: s.transcriptPath }
}

/**
 * A subagent: same loop, reduced tools, no hooks of its own beyond the
 * Subagent* pair the parent fires. It shares the parent's transcript so the
 * gates see one coherent record of the turn.
 */
async function subLoop({
  brief, cwd, provider, settings, session, permissionMode, depth,
  agent = null, tools = null, maxTurns = null,
}) {
  // The agent's body IS its system prompt, and its `model:` is a SEAT — running
  // a cheap discovery agent on the expensive reasoning seat is the exact waste
  // the roster exists to prevent.
  const messages = [
    ...(agent?.prompt ? [{ role: 'system', content: agent.prompt }] : []),
    { role: 'user', content: brief },
  ]
  const subProvider = { ...provider, ...(agent?.model ? { model: agent.model } : {}) }
  const toolSet = tools ?? SUBAGENT_TOOLS
  const budget = maxTurns ?? 12

  for (let turn = 0; turn < budget; turn++) {
    const { text, toolCalls } = await complete({
      ...subProvider, messages, tools: toolSchemas(toolSet),
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
      messages.push({ role: 'tool', tool_call_id: call.id, content: boundResult(call.name, out.content) })
    }
  }
  return { text: '', error: 'subagent exhausted its turn budget' }
}
