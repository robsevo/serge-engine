/**
 * Hook dispatcher.
 *
 * Serge's brain is 65 shell scripts wired to 13 events through settings.json.
 * The engine's job is to fire them with the right payload and honour what they
 * say back. Contract captured in docs/ENGINE-CONTRACT.md.
 *
 * CONTROL PROTOCOL — a hook can stop the turn two ways:
 *   exit 2                                    → blocked, stderr goes to the model
 *   {"decision":"block","reason":"..."}       → blocked, reason goes to the model
 * Anything else is a pass. On UserPromptSubmit a passing hook's stdout is
 * injected as extra context (this is how the directives work).
 *
 * FAIL-OPEN is deliberate: a hook that crashes, times out, or cannot be spawned
 * must not take the session down. A gate that cannot run has proved nothing —
 * but it also has no standing to block.
 */
import { spawnSync } from 'node:child_process'
import { loadSettings } from './config.mjs'

/**
 * settings.json matcher syntax: `|` alternation, `*` (or empty) matches all.
 * The subject is the tool name for tool events, `source` for SessionStart,
 * `trigger` for compaction, and undefined where the event has no subject.
 */
export function matches(matcher, subject) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (subject === undefined || subject === null) return false
  return String(matcher).split('|').map((s) => s.trim()).filter(Boolean)
    .some((m) => m === '*' || m === subject)
}

/**
 * Fire every hook wired to `event` whose matcher accepts `subject`.
 * @returns {{blocked:boolean, reason:string|null, context:string[]}}
 */
export function runHooks(event, payload, subject = undefined, settings = null) {
  const cfg = settings ?? loadSettings()
  const groups = cfg?.hooks?.[event]
  const out = { blocked: false, reason: null, context: [], decision: null }
  if (!Array.isArray(groups)) return out

  const body = JSON.stringify({ hook_event_name: event, ...payload })

  for (const group of groups) {
    if (!matches(group?.matcher, subject)) continue
    for (const h of group?.hooks ?? []) {
      if (h?.type !== 'command' || !h?.command) continue

      let r
      try {
        r = spawnSync('bash', ['-c', h.command], {
          input: body,
          encoding: 'utf8',
          timeout: (Number(h.timeout) || 60) * 1000,
          env: process.env,
        })
      } catch {
        continue                                  // could not spawn — fail open
      }
      if (r.error) continue                       // timeout / ENOENT — fail open

      const stdout = (r.stdout || '').trim()
      const stderr = (r.stderr || '').trim()

      if (r.status === 2) {
        out.blocked = true
        out.reason = stderr || stdout || `${event} hook denied the action`
        return out                                // first block wins; stop asking
      }

      if (stdout.startsWith('{')) {
        try {
          const j = JSON.parse(stdout)

          // Legacy/simple form, used by stop-checks.sh and claims-gate.sh.
          if (j.decision === 'block') {
            out.blocked = true
            out.reason = j.reason || `${event} hook returned decision=block`
            return out
          }

          // hookSpecificOutput — what the REAL PreToolUse gates emit.
          // path-reality-gate, vague-delete-gate, gate-on-constitution-edit and
          // tool-dedupe-guard all deny this way and NEVER exit 2. An engine that
          // only understands exit codes silently ignores every one of them,
          // which looks exactly like having no gates at all.
          const hso = j.hookSpecificOutput
          if (hso && typeof hso === 'object') {
            const reason = hso.permissionDecisionReason || `${event} hook decision`
            if (hso.permissionDecision === 'deny') {
              out.blocked = true
              out.reason = reason
              return out
            }
            if (hso.permissionDecision === 'allow') {
              // A hook vouching for the action short-circuits the engine's own
              // rules — that is the point of subagent-brief-gate's "allow".
              out.decision = 'allow'
              out.reason = reason
            }
            if (hso.permissionDecision === 'ask') {
              out.decision = 'ask'
              out.reason = reason
            }
            if (typeof hso.additionalContext === 'string') out.context.push(hso.additionalContext)
          }

          if (typeof j.additionalContext === 'string') out.context.push(j.additionalContext)
          continue
        } catch {
          // Not JSON after all — fall through and treat it as plain context.
        }
      }

      if (stdout && event === 'UserPromptSubmit') out.context.push(stdout)
    }
  }
  return out
}

/** Payload fields every event carries. */
export function basePayload(session) {
  return {
    session_id: session.sessionId,
    cwd: session.cwd,
    transcript_path: session.transcript.path,
    permission_mode: session.permissionMode,
  }
}
