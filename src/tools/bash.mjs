import { spawnSync } from 'node:child_process'

const MAX = 30_000

export const bash = {
  name: 'Bash',
  description: 'Run a shell command and return its combined output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000).' },
    },
    required: ['command'],
  },
  run(input, ctx) {
    const cmd = String(input.command ?? '')
    if (!cmd.trim()) return { content: 'Bash: empty command', isError: true }

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
