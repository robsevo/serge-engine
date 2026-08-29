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
import { spawn } from 'node:child_process'
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

/**
 * Run one hook command without blocking the event loop.
 *
 * spawnSync held the thread for the whole hook. Measured on this brain: 476ms
 * for UserPromptSubmit, during which a 100ms heartbeat fired ZERO times — so
 * the spinner could not animate and its clock stayed at 0s. From outside that
 * is indistinguishable from a hang, which is exactly how it was reported.
 *
 * Same contract as before: stdout/stderr/status, and a timeout that kills the
 * process rather than waiting on it.
 */
function runOne(command, body, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      // `detached` is what makes the timeout's `process.kill(-pid)` below mean
      // anything: without it the hook shares OUR process group, `-pid` names no
      // group, the kill throws ESRCH and only the bash wrapper is signalled —
      // so a hook that spawned a helper left the helper running past its own
      // timeout. Detached also keeps a terminal Ctrl+C off the hook, which is
      // right: interrupting a turn should not half-run a gate.
      child = spawn('bash', ['-c', command], { env: process.env, detached: true })
    } catch {
      resolve(null)                                  // could not spawn — fail open
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }

    // The tree, not just the shell: a hook that spawns a helper would otherwise
    // outlive its own timeout.
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      done(null)                                     // timed out — fail open
    }, timeoutMs)

    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', () => done(null))
    child.on('close', (status) => done({ stdout, stderr, status }))

    try { child.stdin.write(body); child.stdin.end() } catch { /* the hook may not read stdin */ }
  })
}

export async function runHooks(event, payload, subject = undefined, settings = null) {
  const cfg = settings ?? loadSettings()
  const groups = cfg?.hooks?.[event]
  const out = { blocked: false, reason: null, context: [], decision: null }
  if (!Array.isArray(groups)) return out

  const body = JSON.stringify({ hook_event_name: event, ...payload })

  for (const group of groups) {
    if (!matches(group?.matcher, subject)) continue
    for (const h of group?.hooks ?? []) {
      if (h?.type !== 'command' || !h?.command) continue

      // Awaited, not spawnSync: a synchronous spawn holds the event loop for
      // the hook's whole runtime. Measured on this brain, UserPromptSubmit
      // blocked it for 476ms and a 100ms heartbeat fired ZERO times — which
      // is why the spinner froze with its clock stuck at 0s.
      const r = await runOne(h.command, body, (Number(h.timeout) || 60) * 1000)
      // spawn failed, or it timed out and was killed — fail open either way.
      if (!r) continue

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
