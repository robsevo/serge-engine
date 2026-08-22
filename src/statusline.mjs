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
import { spawnSync } from 'node:child_process'

export function renderStatusLine({ settings, sessionId, cwd, model, usage }) {
  const cfg = settings?.statusLine
  if (!cfg || cfg.type !== 'command' || !cfg.command) return ''

  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    model: { id: model, display_name: model },
    // The brain's script reads these to show live token counts; without them it
    // falls back to whatever it can compute itself.
    usage: usage ? { input_tokens: usage.prompt, output_tokens: usage.completion } : undefined,
  })

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
