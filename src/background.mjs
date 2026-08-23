/**
 * Background work: shells and subagents that outlive the tool call that started
 * them.
 *
 * Every Bash call was synchronous before this, so `npm run dev`, a test watcher
 * or a log tail could only be run by blocking the turn until it finished — which
 * for a server is never. The brain assumes otherwise: it references Monitor,
 * BashOutput, TaskOutput and Sleep, and all four need something to hold a
 * running process between turns.
 *
 * THE THREE THINGS THAT MAKE THIS SAFE, none of which are optional:
 *
 *   Bounded buffers. A chatty process emits output forever. Keeping all of it
 *   is an out-of-memory crash on a long-running dev server, so each stream
 *   keeps a rolling tail and counts what it dropped, and says so on read.
 *
 *   Process GROUPS. Children are spawned detached so killing kills the group.
 *   `npm run dev` is a shell that spawns node; killing only the shell leaves
 *   the server holding the port, and the next run fails with EADDRINUSE for
 *   reasons that look nothing like the cause.
 *
 *   Reaping at exit. A background process whose parent is gone is a leak the
 *   user has to find with `ps`. Everything still running is killed when the
 *   session ends.
 *
 * Reads are CURSOR-based: each call returns only what arrived since the last
 * one. Returning the whole buffer every time would re-feed the model output it
 * already reasoned about, which is how a polling loop convinces itself nothing
 * is changing.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Per-stream rolling tail. Older output is dropped, and the drop is counted. */
const MAX_BUFFER = 256 * 1024
/** Hard ceiling on concurrently tracked jobs, so a loop cannot fork-bomb. */
const MAX_JOBS = 32

const jobs = new Map()

function tail(buf, chunk) {
  const next = buf.text + chunk
  if (next.length <= MAX_BUFFER) return { text: next, dropped: buf.dropped }
  const keep = next.slice(next.length - MAX_BUFFER)
  return { text: keep, dropped: buf.dropped + (next.length - MAX_BUFFER) }
}

/**
 * Start a shell command in the background.
 * @returns {{id:string}|{error:string}}
 */
export function startShell({ command, cwd, description = '', kind = 'bash' }) {
  const live = [...jobs.values()].filter((j) => j.status === 'running').length
  if (live >= MAX_JOBS) {
    return { error: `too many background jobs (${live}); kill some with KillShell first` }
  }

  const id = randomUUID().slice(0, 8)
  let child
  try {
    child = spawn('bash', ['-c', command], {
      cwd,
      // Its own process group, so kill() can take the whole tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { error: `could not start: ${e?.message ?? e}` }
  }

  const job = {
    id,
    kind,
    command,
    description,
    cwd,
    pid: child.pid,
    child,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    out: { text: '', dropped: 0 },
    err: { text: '', dropped: 0 },
    cursor: { out: 0, err: 0 },
  }

  child.stdout?.on('data', (d) => { job.out = tail(job.out, d.toString()) })
  child.stderr?.on('data', (d) => { job.err = tail(job.err, d.toString()) })
  child.on('error', (e) => {
    job.status = 'failed'
    job.err = tail(job.err, `\n[spawn error] ${e?.message ?? e}\n`)
    job.endedAt = Date.now()
  })
  child.on('exit', (code, signal) => {
    job.status = signal ? 'killed' : code === 0 ? 'completed' : 'failed'
    job.exitCode = code
    job.signal = signal
    job.endedAt = Date.now()
  })

  jobs.set(id, job)
  return { id }
}

/** Register an already-running promise (a background subagent) as a job. */
export function startTask({ label, promise, description = '' }) {
  const id = randomUUID().slice(0, 8)
  const job = {
    id,
    kind: 'task',
    command: label,
    description,
    cwd: null,
    pid: null,
    child: null,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    out: { text: '', dropped: 0 },
    err: { text: '', dropped: 0 },
    cursor: { out: 0, err: 0 },
  }
  jobs.set(id, job)

  Promise.resolve(promise).then(
    (r) => {
      job.out = tail(job.out, typeof r === 'string' ? r : (r?.text ?? JSON.stringify(r ?? '')))
      job.status = r?.error ? 'failed' : 'completed'
      job.exitCode = r?.error ? 1 : 0
      job.endedAt = Date.now()
    },
    (e) => {
      job.err = tail(job.err, String(e?.message ?? e))
      job.status = 'failed'
      job.exitCode = 1
      job.endedAt = Date.now()
    },
  )
  return { id }
}

export function getJob(id) {
  return jobs.get(String(id ?? '').trim()) ?? null
}

export function listJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id, kind: j.kind, status: j.status, command: j.command,
    pid: j.pid, seconds: Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000),
  }))
}

/**
 * Output that arrived since the last read.
 *
 * @param filter  optional regex; non-matching LINES are dropped. Invalid
 *                patterns are reported rather than silently ignored, because a
 *                filter that quietly matches nothing looks exactly like a
 *                process that quietly produced nothing.
 */
export function readJob(id, { filter = null } = {}) {
  const job = getJob(id)
  if (!job) return { error: `no background job ${id}` }

  let re = null
  if (filter) {
    try { re = new RegExp(filter) } catch (e) {
      return { error: `bad filter regex ${JSON.stringify(filter)}: ${e?.message ?? e}` }
    }
  }

  const slice = (buf, key) => {
    // The buffer is a rolling tail, so a cursor into dropped output no longer
    // points where it did. Clamping to 0 re-reads what survived instead of
    // returning nothing, which is the less wrong of the two.
    const start = Math.min(job.cursor[key], buf.text.length)
    const text = buf.text.slice(start)
    job.cursor[key] = buf.text.length
    return text
  }

  let out = slice(job.out, 'out')
  let err = slice(job.err, 'err')
  if (re) {
    const keep = (t) => t.split('\n').filter((l) => re.test(l)).join('\n')
    out = keep(out)
    err = keep(err)
  }

  return {
    id: job.id,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
    command: job.command,
    stdout: out,
    stderr: err,
    droppedBytes: job.out.dropped + job.err.dropped,
    seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
  }
}

/**
 * Kill a job's whole process group.
 *
 * SIGTERM first, then SIGKILL if it is still alive — a process that ignores
 * TERM would otherwise be reported as killed while still holding its port.
 */
export function killJob(id, { graceMs = 2000 } = {}) {
  const job = getJob(id)
  if (!job) return { error: `no background job ${id}` }
  if (job.status !== 'running') return { ok: true, alreadyDone: true, status: job.status }
  if (!job.pid) {
    // A subagent is not a process; there is nothing to signal.
    job.status = 'killed'
    job.endedAt = Date.now()
    return { ok: true, detached: true }
  }

  const signalGroup = (sig) => {
    // Negative pid = the whole group, which is why spawn used detached.
    try { process.kill(-job.pid, sig); return true } catch { /* fall through */ }
    try { process.kill(job.pid, sig); return true } catch { return false }
  }

  const sent = signalGroup('SIGTERM')
  if (!sent) {
    job.status = 'killed'
    job.endedAt = Date.now()
    return { ok: true, note: 'process was already gone' }
  }
  const t = setTimeout(() => { if (job.status === 'running') signalGroup('SIGKILL') }, graceMs)
  t.unref?.()
  return { ok: true }
}

/** Kill everything still running. Called when the session ends. */
export function reapAll() {
  let n = 0
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.pid) {
      try { process.kill(-job.pid, 'SIGKILL') } catch {
        try { process.kill(job.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      n++
    }
  }
  return n
}

/** Test seam: drop all state. */
export function _reset() {
  reapAll()
  jobs.clear()
}
