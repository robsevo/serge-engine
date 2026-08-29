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
import { getTodos } from './tools/todo.mjs'
import { makeTaskTool } from './tools/task.mjs'
import { checkSeat, loadSeats } from './seats.mjs'
import { replay } from './sessions.mjs'

const MAX_TURNS = 40
/** A turn shorter than this finished while you were still looking at it. */
const NOTIFY_AFTER_MS = Number(process.env.SERGE_NOTIFY_AFTER ?? 45) * 1000
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
  cwd, model, onToken, onReasoning, onNotice, onTool, onToolResult, onAsk, onQuestion, onTodos,
  permissionMode = 'default',
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
  let userTurns = 0
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
  // The roster is read ONCE for the whole loop. `checkSeat(name)` defaults its
  // second argument to `loadSeats()`, so calling it per agent re-read and
  // re-scanned the 49KB litellm.yaml sixteen times at every session start —
  // 13.5ms of file I/O, before the first frame, to answer sixteen Map lookups
  // that cost 0.8ms together. `loadSeats` memoises now too, so this is belt and
  // braces; it is also the version that says what it means.
  const roster = agents.size ? loadSeats() : null
  for (const a of agents.values()) {
    if (!a.model) continue
    const v = checkSeat(a.model, roster)
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
    // A subagent sees no conversation, no CLAUDE.md and no memory — only its
    // brief. So SubagentStart's context is the ONLY way the brain can hand it
    // the repo card, the seat notes and the swarm doctrine. Discarding it, as
    // this did until 2026-08-23, launches every specialist blind.
    const ss = await runHooks('SubagentStart',
      { ...base(), subagent_id: subId, subagent_type: matcher, prompt: brief }, matcher, settings)
    const briefed = ss.context.length ? `${ss.context.join('\n\n')}\n\n${brief}` : brief
    try {
      const out = await subLoop({
        brief: briefed, cwd, provider, settings, session, permissionMode, depth: 1,
        agent, tools, maxTurns,
      })
      // SubagentStop is a GATE, not a notification: the brain's
      // subagent-refs-gate can block a subagent that cited files it never read.
      // Blocking after the fact cannot un-run it — what it does is stop the
      // parent from building on an unsound result.
      const sstop = await runHooks('SubagentStop',
        { ...base(), subagent_id: subId, subagent_type: matcher, last_assistant_message: out.text },
        matcher, settings)
      if (sstop.blocked) {
        return { ...out, text: `${out.text}\n\n--- BLOCKED BY SubagentStop HOOK ---\n${sstop.reason}` }
      }
      if (sstop.context.length) return { ...out, text: `${out.text}\n\n${sstop.context.join('\n')}` }
      return out
    } catch (e) {
      // The subagent already failed, so there is nothing left to block — but a
      // hook may still explain WHY, and that belongs with the error rather than
      // in a discarded return value.
      const failed = await runHooks('SubagentStop',
        { ...base(), subagent_id: subId, subagent_type: matcher, error: String(e?.message ?? e) },
        matcher, settings)
      const why = failed.context.length ? `\n\n${failed.context.join('\n')}` : ''
      return { error: String(e?.message ?? e) + why }
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
      const src = resumed ? 'resume' : 'startup'
      const ss = await runHooks('SessionStart', { ...base(), source: src }, src, settings)
      // SessionStart's context is what the brain KNOWS: memory-load carries the
      // memories, repo-card the project, progress/reflexion what the last
      // session left. Running these and dropping their output — which is what
      // happened until 2026-08-23 — is a 25KB-per-session silent amnesia: the
      // hooks all fire, nothing they say reaches the model, and the only symptom
      // is an agent that has read nothing.
      for (const c of ss.context) messages.push({ role: 'system', content: c })
      const idx = skillIndex(skills)
      if (idx) messages.push({ role: 'system', content: idx })
      started = true
    }

    const ups = await runHooks('UserPromptSubmit', { ...base(), prompt }, undefined, settings)
    if (ups.blocked) {
      onNotice?.(`blocked: ${ups.reason}`, 'user')
      return { text: '', blocked: true, reason: ups.reason }
    }

    transcript.userPrompt(prompt)
    for (const c of ups.context) messages.push({ role: 'system', content: c })
    messages.push({ role: 'user', content: prompt })
    userTurns++

  let final = ''
  let stopHookActive = false
  let todoNudged = false
  const startedAt = Date.now()
  // Scoped to this user turn, not the session: globbing the same pattern again
  // in a later turn is ordinary (the tree may have changed) — doing it three
  // times inside one turn is a loop.
  const repeatedCalls = new Map()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Compaction happens BEFORE the request, never mid-flight: a summary built
    // from a half-finished exchange loses the half that mattered.
    if (shouldCompact(messages, COMPACT_AT_CHARS)) {
      const trigger = 'auto'
      await runHooks('PreCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
      const r = await compact({ messages, complete, provider })
      if (r.failed) {
        onNotice?.('compaction failed — continuing uncompacted', 'user')
      } else {
        messages = r.messages
        onNotice?.(`compacted context (-${r.droppedChars} chars)`, 'user')
      }
      // compact-survival's whole job is to put back what the summary dropped.
      // Running it and discarding its output is worse than not running it: the
      // hook reports success and the context is gone anyway.
      const pc = await runHooks('PostCompact', { ...base(), trigger, size_chars: size(messages) }, trigger, settings)
      for (const c of pc.context) messages.push({ role: 'system', content: c })
    }

    const { text, toolCalls, usage: u } = await complete({
      ...provider,
      messages,
      // Task is replaced when agents exist, so the enum lists the real roster.
      tools: toolSchemas(null, extraSchemas)
        .map((t) => (sessionTools[t.function.name] ? asSchema(sessionTools[t.function.name]) : t)),
      onToken, onReasoning, onNotice, signal,
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
        stop = await runHooks('Stop', {
          ...base(), last_assistant_message: text, stop_hook_active: stopHookActive,
        }, undefined, settings)
      } catch (e) {
        await runHooks('StopFailure', { ...base(), error: String(e?.message ?? e) }, undefined, settings)
        stop = { blocked: false }
      }

      if (stop.blocked) {
        stopHookActive = true
        onNotice?.(`stop hook: ${stop.reason}`, 'model')
        messages.push({ role: 'user', content: stop.reason })
        continue
      }

      // TaskCompleted is the brain's task-evidence-gate — it can block a turn
      // that claims a task is done without evidence. Discarding its verdict is
      // what let "done" mean "the model said so".
      const tc = await runHooks('TaskCompleted', { ...base(), last_assistant_message: text }, undefined, settings)
      if (tc.blocked && !stopHookActive) {
        stopHookActive = true
        onNotice?.(`task-completed gate: ${tc.reason}`, 'model')
        messages.push({ role: 'user', content: tc.reason })
        continue
      }

      // A plan the model wrote and never closed out. It states what it is doing
      // in the imperative, so leaving boxes open at the end says the work is
      // unfinished — and the user reads it that way, because that is what it
      // means. Observed: a research turn wrote three steps, answered fully, and
      // left all three open.
      //
      // Nudged ONCE per turn (todoNudged), and only when the turn actually did
      // something — a turn that answered a question without touching the list
      // has nothing to close. Without the one-shot this is an infinite loop the
      // moment a model declines.
      const open = getTodos(sessionId).filter((t) => t.status !== 'completed')
      if (open.length && !todoNudged && turn > 0) {
        todoNudged = true
        onNotice?.(`${open.length} todo(s) still open`, 'model')
        messages.push({
          role: 'user',
          content: `Your todo list still has ${open.length} item(s) not marked completed: `
            + open.map((t) => JSON.stringify(t.content)).join(', ')
            + '. If that work is done, call TodoWrite with their status set to completed. '
            + 'If it is genuinely not done, say in one line what is left and why — do not '
            + 'redo the work you just did.',
        })
        continue
      }

      // `agent_completed` — the other half of the notification contract the
      // brain already implements (notify-desk.sh titles it "Serge finished")
      // and the engine never fired, so a long turn finished silently and you
      // learned about it by looking. Gated on duration: a turn that answered in
      // four seconds was answered while you were watching, and a popup for it is
      // noise. SERGE_NOTIFY_AFTER=0 turns it off.
      const took = Date.now() - startedAt
      if (took >= NOTIFY_AFTER_MS && NOTIFY_AFTER_MS > 0) {
        void runHooks('Notification', {
          ...base(),
          notification_type: 'agent_completed',
          message: `${(took / 1000).toFixed(0)}s · ${String(final || '').split('\n')[0].slice(0, 140) || 'turn complete'}`,
        }, 'agent_completed', settings)
      }
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

      const pre = await runHooks('PreToolUse', payload, call.name, settings)
      if (pre.blocked) {
        results.push({ id: call.id, content: `Blocked by PreToolUse hook: ${pre.reason}`, isError: true })
        onToolResult?.(call.name, pre.reason, true)
        onNotice?.(`denied ${call.name}: ${pre.reason}`, 'user')
        // NO Notification here. This used to fire `permission_prompt`, which the
        // brain's notify-desk.sh renders as a CRITICAL desktop alert titled
        // "Serge needs permission" — for a decision that was already made, by a
        // gate, with nobody being asked anything. Observed on tool-dedupe-guard:
        // a popup demanding attention for a call the model had already been told
        // to stop repeating. An alert that names a wait that is not happening
        // teaches you to ignore alerts, which costs you the one that is real.
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
        // HERE is the moment a human is genuinely needed: the turn stops until
        // someone answers. Fired before the await, not after — a notification
        // that arrives once the wait is over has nothing left to tell you.
        // Deliberately not awaited: the alert is a side effect, and making the
        // prompt wait on notify-send would add its latency to every decision.
        void runHooks('Notification', {
          ...base(),
          notification_type: 'permission_prompt',
          message: `${call.name}: ${verdict.reason}`,
        }, 'permission_prompt', settings)
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
        onToolResult?.(call.name, verdict.reason, true)
        onNotice?.(`denied ${call.name}: ${detail}`, 'user')
        // Again: no alert for a denial. Either the user just answered it — in
        // which case they are at the terminal and know — or policy refused it
        // without asking, in which case there is nothing to answer.
        await runHooks('PostToolUseFailure',
          { ...payload, tool_response: `Permission denied: ${verdict.reason}` }, call.name, settings)
        continue
      }

      // AskUserQuestion stops the turn on a person exactly as a permission
      // prompt does, and the brain has a notification type for it. Without this
      // the engine went quiet and waited.
      if (call.name === 'AskUserQuestion' && onQuestion) {
        void runHooks('Notification', {
          ...base(),
          notification_type: 'agent_needs_input',
          message: String(call.input?.question || 'Serge has a question').slice(0, 160),
        }, 'agent_needs_input', settings)
      }

      const out = await runTool(call.name, call.input, {
        cwd, depth: 0, spawnSubagent, mcp, sessionTools,
        // The todo list is keyed by session, so two sessions in one process do
        // not overwrite each other's plan.
        sessionId,
        onTodos: (t) => onTodos?.(t),
        // AskUserQuestion needs someone to ask. Absent (headless), the tool
        // says so and refuses rather than picking an answer nobody gave.
        onQuestion: onQuestion ? (q) => onQuestion(q) : undefined,
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
      const post = await runHooks(out.isError ? 'PostToolUseFailure' : 'PostToolUse',
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

      // A model that repeats a call it already made, verbatim, is looping —
      // observed 2026-08-22, when a greeting produced `Glob {"pattern":"*"}`
      // three times against $HOME, each round-trip costing a full model call on
      // a slow seat. Serving the same bytes silently gives it no reason to stop,
      // so say plainly that this already ran and what it returned.
      const sig = call.name + '\u0000' + JSON.stringify(call.input ?? {})
      const seenAt = repeatedCalls.get(sig)
      if (seenAt !== undefined && !isError) {
        content = `${content}\n\n--- REPEATED CALL ---\nThis exact call already ran `
          + `earlier in this turn and returned the same thing. Repeating it cannot `
          + `produce new information — use what you already have, or change the call.`
        onNotice?.(`${call.name} repeated an identical call`, 'model')
      } else {
        repeatedCalls.set(sig, true)
      }

      results.push({ id: call.id, content: boundResult(call.name, content), isError })
      // `out.diff` is UI-only and deliberately not in `content`: the model just
      // wrote the edit, so echoing it back spends context restating what it
      // already knows. The reader is the one who has not seen it.
      onToolResult?.(call.name, content, isError, isError ? null : out.diff ?? null)
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
    // Counted explicitly, not derived from the message list. Everything the
    // ENGINE injects — a Stop-hook bounce, the task-evidence gate, the todo
    // nudge — is also role:'user', so filtering the list reported 2 turns for
    // one question and made "N turn(s)" on exit meaningless.
    get turns() { return userTurns },
    get usage() { return { ...usage } },
    /** Characters of live history — what the ctx% meter is a fraction of. */
    get contextChars() { return size(messages) },
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
