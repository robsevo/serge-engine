/**
 * The status line.
 *
 * The brain configures `statusLine: { type: "command", command: "..." }` and the
 * script prints one line: seat, cwd, token counts, budget. This runs it and
 * shows the result, so a Serge install's own status appears here rather than a
 * reimplementation that would drift from it.
 *
 * Failures are silent by design. A status line is decoration; a broken one must
 * not print an error after every turn, and certainly must not end the session.
 */
import { spawnSync, spawn } from 'node:child_process'

/**
 * The payload the brain's script reads on stdin.
 *
 * Split out because there are now two callers with the same contract and only
 * one of them can afford to block — see `renderStatusLineAsync`.
 */
function payloadFor({ sessionId, cwd, model, usage }) {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    model: { id: model, display_name: model },
    usage: usage ? { input_tokens: usage.prompt, output_tokens: usage.completion } : undefined,
  })
}

/**
 * The same status line, without holding the event loop.
 *
 * WHY IT MATTERS UNDER INK. `spawnSync` stops everything: no timers fire, no
 * frames are written, no keystroke is read. The brain's script is ~23ms here,
 * which is survivable — but the timeout below is FIVE SECONDS, and the only
 * thing standing between a slow status script and a five-second frozen terminal
 * was the script staying fast. That is not a property anyone maintains on
 * purpose. The hook dispatcher (hooks.mjs) already moved off spawnSync for
 * exactly this reason and for exactly this symptom.
 */
export function renderStatusLineAsync(opts) {
  const cfg = opts?.settings?.statusLine
  if (!cfg || cfg.type !== 'command' || !cfg.command) return Promise.resolve('')

  return new Promise((resolve) => {
    let child
    try {
      child = spawn('bash', ['-c', cfg.command], { env: process.env })
    } catch {
      resolve('')                                   // decoration; never fatal
      return
    }
    let out = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } ; done('') }, 5000)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', () => {})
    child.on('error', () => done(''))
    child.on('close', (status) => done(status === 0 ? (out.split('\n')[0] ?? '').trimEnd() : ''))
    try { child.stdin.write(payloadFor(opts)); child.stdin.end() } catch { /* may not read stdin */ }
  })
}

export function renderStatusLine({ settings, sessionId, cwd, model, usage }) {
  const cfg = settings?.statusLine
  if (!cfg || cfg.type !== 'command' || !cfg.command) return ''

  // The brain's script reads `usage` to show live token counts; without it the
  // script falls back to whatever it can compute itself.
  const payload = payloadFor({ sessionId, cwd, model, usage })

  try {
    const r = spawnSync('bash', ['-c', cfg.command], {
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      env: process.env,
    })
    if (r.error || r.status !== 0) return ''
    return (r.stdout || '').split('\n')[0].trimEnd()
  } catch {
    return ''
  }
}
