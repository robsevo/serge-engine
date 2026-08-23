/**
 * BashOutput, KillShell, Monitor, Sleep, TaskOutput.
 *
 * All five sit on one registry (`src/background.mjs`), because they are one
 * capability seen from different angles: work that outlives the tool call that
 * started it. The brain references four of them and none existed, so anything
 * long-running — a dev server, a test watcher, a log tail — could only be run
 * by blocking the turn until it finished, which for a server is never.
 */
import { startShell, readJob, killJob, listJobs, getJob } from '../background.mjs'

const MAX_OUT = 30_000

/** Trim from the FRONT: the end of a log is the part you are waiting for. */
function clamp(text, limit = MAX_OUT) {
  const s = String(text ?? '')
  if (s.length <= limit) return s
  return `… [${s.length - limit} earlier characters omitted]\n` + s.slice(s.length - limit)
}

function render(r) {
  const head = `[${r.id}] ${r.status}`
    + (r.exitCode !== null && r.exitCode !== undefined ? ` · exit ${r.exitCode}` : '')
    + (r.signal ? ` · ${r.signal}` : '')
    + ` · ${r.seconds}s`
  const parts = [head]
  if (r.droppedBytes) {
    // Said plainly: a model reading a truncated log without knowing it was
    // truncated will conclude the missing events never happened.
    parts.push(`NOTE: ${r.droppedBytes} bytes of earlier output were dropped (rolling buffer).`)
  }
  if (r.stdout) parts.push(clamp(r.stdout))
  if (r.stderr) parts.push('--- stderr ---\n' + clamp(r.stderr))
  if (!r.stdout && !r.stderr) {
    parts.push(r.status === 'running'
      ? '(no new output since the last read — it is still running)'
      : '(no new output)')
  }
  return parts.join('\n')
}

export const bashOutput = {
  name: 'BashOutput',
  description:
    'Read output from a background shell started with Bash(run_in_background) or Monitor. '
    + 'Returns only what arrived SINCE THE LAST READ, so polling shows progress rather than '
    + 'repeating what you already saw. Call with no bash_id to list every background job.',
  parameters: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'The id returned when the job started. Omit to list all jobs.' },
      filter: { type: 'string', description: 'Optional regex; only matching lines are returned' },
    },
  },
  run(input) {
    const id = String(input?.bash_id ?? '').trim()
    if (!id) {
      const jobs = listJobs()
      if (!jobs.length) return { content: 'No background jobs.' }
      return {
        content: jobs.map((j) =>
          `[${j.id}] ${j.status.padEnd(9)} ${j.seconds}s  ${String(j.command).replace(/\s+/g, ' ').slice(0, 70)}`,
        ).join('\n'),
      }
    }
    const r = readJob(id, { filter: input?.filter ?? null })
    if (r.error) return { content: r.error, isError: true }
    return { content: render(r) }
  },
}

export const killShell = {
  name: 'KillShell',
  description:
    'Kill a background shell and everything it spawned. Use it when a job is no longer needed — '
    + 'a dev server left running holds its port, and the next attempt to start one fails for '
    + 'reasons that look nothing like the cause.',
  parameters: {
    type: 'object',
    properties: { shell_id: { type: 'string', description: 'The id of the job to kill' } },
    required: ['shell_id'],
  },
  run(input) {
    const id = String(input?.shell_id ?? '').trim()
    if (!id) return { content: 'KillShell requires a shell_id.', isError: true }
    const r = killJob(id)
    if (r.error) return { content: r.error, isError: true }
    if (r.alreadyDone) return { content: `[${id}] was already ${r.status}.` }
    return { content: `[${id}] killed${r.note ? ` (${r.note})` : ''}.` }
  },
}

export const monitor = {
  name: 'Monitor',
  description:
    'Run a long-lived command in the background and watch it: a dev server, a test watcher, '
    + 'a log tail. Returns immediately with an id — read it with BashOutput, stop it with '
    + 'KillShell. Use this instead of Bash for anything that does not end on its own, because '
    + 'a plain Bash call waits for a process that never exits.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run and monitor' },
      description: { type: 'string', description: 'What this command does, in active voice' },
    },
    required: ['command'],
  },
  run(input, ctx) {
    const command = String(input?.command ?? '').trim()
    if (!command) return { content: 'Monitor requires a command.', isError: true }
    const r = startShell({
      command, cwd: ctx?.cwd ?? process.cwd(),
      description: String(input?.description ?? ''), kind: 'monitor',
    })
    if (r.error) return { content: `Monitor failed: ${r.error}`, isError: true }
    return {
      content: `[${r.id}] monitoring: ${command}\n`
        + `Read new output with BashOutput(bash_id="${r.id}"), stop it with KillShell(shell_id="${r.id}").`,
    }
  },
}

export const sleep = {
  name: 'Sleep',
  description:
    'Wait for a duration without holding a shell process. Prefer this over Bash("sleep N"), '
    + 'which occupies a shell for the whole wait. Use it when polling a background job that '
    + 'needs time to produce output.',
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'How long to wait, 0.1 to 60' },
    },
    required: ['seconds'],
  },
  async run(input) {
    const raw = Number(input?.seconds)
    if (!Number.isFinite(raw) || raw <= 0) {
      return { content: 'Sleep requires a positive number of seconds.', isError: true }
    }
    // Capped: an unbounded sleep is a hang the user cannot tell from a crash,
    // and the model can always sleep again.
    const s = Math.min(60, raw)
    await new Promise((r) => setTimeout(r, s * 1000))
    return {
      content: `Slept ${s}s.` + (s < raw ? ` (capped from ${raw}s — call again to wait longer.)` : ''),
    }
  },
}

export const taskOutput = {
  name: 'TaskOutput',
  description:
    'Read the output of a background subagent started with Task(run_in_background). '
    + 'Returns what has arrived since the last read. Call with no task_id to list every job.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The id returned when the task started. Omit to list all.' },
    },
  },
  run(input) {
    const id = String(input?.task_id ?? '').trim()
    if (!id) {
      const jobs = listJobs().filter((j) => j.kind === 'task')
      if (!jobs.length) return { content: 'No background tasks.' }
      return { content: jobs.map((j) => `[${j.id}] ${j.status.padEnd(9)} ${j.seconds}s  ${j.command}`).join('\n') }
    }
    const job = getJob(id)
    if (!job) return { content: `no background task ${id}`, isError: true }
    if (job.kind !== 'task') {
      // Named explicitly rather than silently answering about the wrong thing.
      return { content: `[${id}] is a ${job.kind} job, not a task — read it with BashOutput.`, isError: true }
    }
    const r = readJob(id)
    if (r.error) return { content: r.error, isError: true }
    return { content: render(r) }
  },
}
