#!/usr/bin/env node
/**
 * Background shells and the tools over them.
 *
 * This is the area where a bug is invisible until it is expensive: a leaked
 * process holds a port, an unbounded buffer is an out-of-memory crash on a
 * chatty dev server, and a kill that misses the process group reports success
 * while the server is still running. So the assertions below check the
 * OPERATING SYSTEM, not just the return values — is the pid actually gone, did
 * the child of the shell die with it.
 *
 * Run:  node tests/background.test.mjs
 */
import { startShell, readJob, killJob, listJobs, getJob, reapAll, _reset } from '../src/background.mjs'
import { bashOutput, killShell, monitor, sleep, taskOutput } from '../src/tools/background.mjs'
import { bash } from '../src/tools/bash.mjs'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const cwd = mkdtempSync(join(tmpdir(), 'serge-bg-'))

/* ── the registry ─────────────────────────────────────────────────────── */
console.log('── registry ──')

const a = startShell({ command: 'echo one; sleep 0.2; echo two', cwd })
ok('a shell starts and gets an id', typeof a.id === 'string' && a.id.length > 0, JSON.stringify(a))

await wait(120)
const first = readJob(a.id)
ok('output is readable while running', /one/.test(first.stdout), JSON.stringify(first.stdout))
ok('status is running', first.status === 'running', first.status)

// The cursor is the whole point: a second read must not repeat the first.
const second = readJob(a.id)
ok('a second read does NOT repeat what was already read', !/one/.test(second.stdout),
   JSON.stringify(second.stdout))

await wait(400)
const third = readJob(a.id)
ok('later output arrives on the next read', /two/.test(third.stdout), JSON.stringify(third.stdout))
ok('a finished job reports completed', third.status === 'completed', third.status)
ok('exit code is captured', third.exitCode === 0, String(third.exitCode))

const failing = startShell({ command: 'exit 3', cwd })
await wait(300)
const f = readJob(failing.id)
ok('a non-zero exit is reported as failed', f.status === 'failed' && f.exitCode === 3,
   `${f.status}/${f.exitCode}`)

/* ── killing kills the GROUP ──────────────────────────────────────────── */
console.log('\n── killing ──')

// A shell that spawns a child. Killing only the shell leaves the child holding
// whatever it holds — the classic "port still in use" ghost.
const g = startShell({ command: 'sleep 30 & echo $! > child.pid; wait', cwd })
await wait(400)
const shellPid = getJob(g.id).pid
ok('the shell is running', alive(shellPid))

let childPid = null
try {
  const { readFileSync } = await import('node:fs')
  childPid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8').trim())
} catch { /* reported below */ }
ok('the child pid was captured', Number.isInteger(childPid) && childPid > 0, String(childPid))

killJob(g.id, { graceMs: 200 })
await wait(700)
ok('the shell is dead', !alive(shellPid))
ok('the CHILD died with it (process group)', childPid ? !alive(childPid) : false,
   childPid ? `pid ${childPid} still alive` : 'no child pid')

/* ── bounded buffers ──────────────────────────────────────────────────── */
console.log('\n── bounds ──')

// 2MB of output into a 256KB buffer. Keeping it all is the OOM this guards.
const noisy = startShell({ command: `head -c 2000000 /dev/zero | tr '\\0' 'x'`, cwd })
await wait(1500)
const n = readJob(noisy.id)
ok('a flood is truncated, not buffered whole', n.stdout.length <= 300_000, `${n.stdout.length} chars`)
ok('the dropped byte count is reported', n.droppedBytes > 0, String(n.droppedBytes))
killJob(noisy.id)

/* ── the tools ────────────────────────────────────────────────────────── */
console.log('\n── tools ──')

const bgStart = bash.run({ command: 'echo hello-bg; sleep 5', run_in_background: true }, { cwd })
const bgId = (bgStart.content.match(/\[([0-9a-f]+)\]/) || [])[1]
ok('Bash(run_in_background) returns immediately with an id', !!bgId, bgStart.content.slice(0, 70))
ok('it tells you how to read it', /BashOutput/.test(bgStart.content))

await wait(300)
const readOut = bashOutput.run({ bash_id: bgId })
ok('BashOutput reads it', /hello-bg/.test(readOut.content), readOut.content.slice(0, 70))

const listed = bashOutput.run({})
ok('BashOutput with no id lists jobs', listed.content.includes(bgId), listed.content.slice(0, 80))

const filtered = bashOutput.run({ bash_id: bgId, filter: '[' })
ok('a bad filter regex is reported, not ignored', filtered.isError === true, filtered.content.slice(0, 60))

const killed = killShell.run({ shell_id: bgId })
ok('KillShell reports the kill', /killed/i.test(killed.content), killed.content)
await wait(300)
ok('the job is no longer running', getJob(bgId).status !== 'running', getJob(bgId).status)

ok('KillShell on an unknown id errors', killShell.run({ shell_id: 'nope' }).isError === true)
ok('BashOutput on an unknown id errors', bashOutput.run({ bash_id: 'nope' }).isError === true)

const mon = monitor.run({ command: 'echo watching; sleep 5', description: 'test monitor' }, { cwd })
const monId = (mon.content.match(/\[([0-9a-f]+)\]/) || [])[1]
ok('Monitor starts and returns an id', !!monId, mon.content.slice(0, 60))
await wait(300)
ok('Monitor output is readable via BashOutput', /watching/.test(bashOutput.run({ bash_id: monId }).content))
ok('TaskOutput refuses a shell job by name', taskOutput.run({ task_id: monId }).isError === true)
killShell.run({ shell_id: monId })

const t0 = Date.now()
const slept = await sleep.run({ seconds: 0.3 })
ok('Sleep actually waits', Date.now() - t0 >= 250, `${Date.now() - t0}ms`)
ok('Sleep reports the duration', /0\.3s/.test(slept.content), slept.content)
const capped = await sleep.run({ seconds: 9999 })
ok('Sleep is capped and says so', /capped/.test(capped.content), capped.content)
ok('Sleep rejects a non-number', (await sleep.run({ seconds: 'soon' })).isError === true)

/* ── reaping ──────────────────────────────────────────────────────────── */
console.log('\n── reaping ──')

const orphan = startShell({ command: 'sleep 60', cwd })
await wait(250)
const orphanPid = getJob(orphan.id).pid
ok('a long job is running before reap', alive(orphanPid))
const reaped = reapAll()
await wait(400)
ok('reapAll reports what it killed', reaped >= 1, String(reaped))
ok('nothing is left running after reap', !alive(orphanPid), `pid ${orphanPid} survived`)

_reset()
const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
