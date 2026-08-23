import { spawnSync } from 'node:child_process'
import { startShell } from '../background.mjs'

const MAX = 30_000

export const bash = {
  name: 'Bash',
  description: 'Run a shell command and return its combined output. '
    + 'Set run_in_background for anything that does not end on its own — a dev server, '
    + 'a watcher, a tail — and read it with BashOutput. A foreground call waits for the '
    + 'process to exit, which for a server is never.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000).' },
      run_in_background: {
        type: 'boolean',
        description: 'Return immediately with a job id instead of waiting. Read output with BashOutput, stop it with KillShell.',
      },
      description: { type: 'string', description: 'What this command does, in active voice.' },
    },
    required: ['command'],
  },
  run(input, ctx) {
    const cmd = String(input.command ?? '')
    if (!cmd.trim()) return { content: 'Bash: empty command', isError: true }

    if (input.run_in_background) {
      const r = startShell({
        command: cmd, cwd: ctx.cwd,
        description: String(input.description ?? ''), kind: 'bash',
      })
      if (r.error) return { content: `Bash (background) failed: ${r.error}`, isError: true }
      return {
        content: `[${r.id}] started in the background: ${cmd}\n`
          + `Read new output with BashOutput(bash_id="${r.id}"), stop it with KillShell(shell_id="${r.id}").`,
      }
    }

    const r = spawnSync('bash', ['-c', cmd], {
      cwd: ctx.cwd,
      encoding: 'utf8',
      timeout: Math.min(Number(input.timeout) || 120_000, 600_000),
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    })

    if (r.error?.code === 'ETIMEDOUT') {
      return { content: `Command timed out after ${Number(input.timeout) || 120_000}ms`, isError: true }
    }

    const body = ((r.stdout || '') + (r.stderr || '')).trim()
    const clipped = body.length > MAX ? `${body.slice(0, MAX)}\n… [${body.length - MAX} bytes truncated]` : body
    // A non-zero exit must surface as is_error — gates read that field to tell a
    // clean run from a failed one, and a "successful" failed command is exactly
    // the kind of false green this engine exists to avoid.
    return {
      content: clipped || `(no output, exit ${r.status ?? 0})`,
      isError: (r.status ?? 0) !== 0,
    }
  },
}
