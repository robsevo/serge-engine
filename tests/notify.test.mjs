#!/usr/bin/env node
/**
 * A notification must name a wait that is actually happening.
 *
 * WHAT WENT WRONG. The engine fired `Notification{permission_prompt}` after
 * every PreToolUse hook block and after every permission denial. The brain
 * renders that type as a CRITICAL desktop alert titled "Serge needs permission"
 * (dot-serge/notify-desk.sh: `URGENT = {permission_prompt, ...}`). So
 * tool-dedupe-guard refusing a repeated MultiEdit — a decision already made, by
 * a gate, with nobody being asked anything — raised a popup demanding attention
 * for a question that did not exist. Meanwhile the one moment a human IS needed,
 * `onAsk` blocking the turn on a keypress, fired nothing at all, and neither did
 * a turn finishing after ten minutes: `agent_completed` and `agent_needs_input`
 * are implemented in the brain's notifier and were never sent by the engine.
 *
 * An alert that cries wolf is worse than no alert: it trains you to dismiss the
 * one that is real.
 *
 * Drives the REAL loop against a local OpenAI-compatible server, with a real
 * settings.json whose Notification hook records what it was sent — same shape as
 * repeat-guard.test.mjs, and for the same reason: no seam in production code
 * that exists only for tests.
 *
 * Run:  node tests/notify.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const cwd = mkdtempSync(join(tmpdir(), 'serge-notify-'))
const log = join(cwd, 'notified.txt')

// The brain's contract: the payload arrives on stdin. This records the type.
writeFileSync(join(cwd, 'record.sh'),
  '#!/usr/bin/env bash\n'
  + `python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("notification_type",""))' >> ${JSON.stringify(log)} 2>/dev/null\n`
  + 'exit 0\n')

// A PreToolUse gate that denies the way the real ones do — JSON, never exit 2.
writeFileSync(join(cwd, 'deny.sh'),
  '#!/usr/bin/env bash\n'
  + 'echo \'{"hookSpecificOutput":{"permissionDecision":"deny",'
  + '"permissionDecisionReason":"Duplicate Bash call in this step"}}\'\nexit 0\n')

writeFileSync(join(cwd, 'settings.json'), JSON.stringify({
  hooks: {
    Notification: [{ matcher: '*', hooks: [{ type: 'command', command: `bash ${join(cwd, 'record.sh')}`, timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${join(cwd, 'deny.sh')}`, timeout: 10 }] }],
  },
}))

/* ── a scripted seat ──────────────────────────────────────────────────── */

let script = []
let step = 0
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`
const server = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    const s = script[Math.min(step++, script.length - 1)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (s.tool) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: s.tool.id, type: 'function',
        function: { name: s.tool.name, arguments: JSON.stringify(s.tool.args) } }] } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    } else {
      res.write(sse({ choices: [{ delta: { content: s.text } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
process.env.OPENAI_API_KEY = 'sk-test'
process.env.CLAUDE_CONFIG_DIR = cwd
// A turn in this test takes milliseconds; without this every one of them would
// also raise agent_completed and the first two cases could not tell the types
// apart. The last case sets it back.
process.env.SERGE_NOTIFY_AFTER = '3600'

const { createSession } = await import('../src/loop.mjs')

const types = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  .split('\n').map((s) => s.trim()).filter(Boolean)
const reset = () => rmSync(log, { force: true })

/* ── 1. a gate denial must not claim a human is needed ────────────────── */
{
  reset()
  script = [{ tool: { id: 't1', name: 'Bash', args: { command: 'ls' } } }, { text: 'done' }]
  step = 0
  const s = createSession({ cwd, model: 'test-seat', permissionMode: 'fullAccess' })
  const r = await s.send('go')
  await new Promise((r2) => setTimeout(r2, 300))
  ok('the denied turn still finished', /done/.test(r.text || ''), JSON.stringify(r).slice(0, 100))
  ok('a PreToolUse denial raises NO permission alert',
     !types().includes('permission_prompt'), types().join(',') || '(none)')
}

/* ── 2. blocking on a human must ──────────────────────────────────────── */
{
  reset()
  script = [
    { tool: { id: 't2', name: 'Write', args: { file_path: join(cwd, 'x.txt'), content: 'hi' } } },
    { text: 'done' },
  ]
  step = 0
  let asked = false
  let seenWhileWaiting = []
  const s = createSession({
    cwd, model: 'test-seat', permissionMode: 'default',
    // The alert has to be out by the time the turn is blocked on the answer —
    // one that lands after the wait has nothing left to tell anyone.
    onAsk: async () => {
      asked = true
      await new Promise((r) => setTimeout(r, 400))
      seenWhileWaiting = types()
      return 'no'
    },
  })
  await s.send('go')
  ok('a tool needing an answer does ask', asked)
  ok('the alert fires BEFORE the wait, not after',
     seenWhileWaiting.includes('permission_prompt'), seenWhileWaiting.join(',') || '(none)')
}

/* ── 3. a question for the user is an alert too ───────────────────────── */
{
  reset()
  script = [
    { tool: { id: 't3', name: 'AskUserQuestion', args: {
      question: 'which one?', header: 'Pick', options: [{ label: 'a' }, { label: 'b' }],
    } } },
    { text: 'done' },
  ]
  step = 0
  let seenWhileWaiting = []
  const s = createSession({
    cwd, model: 'test-seat', permissionMode: 'fullAccess',
    onQuestion: async () => {
      await new Promise((r) => setTimeout(r, 400))
      seenWhileWaiting = types()
      return 'a'
    },
  })
  await s.send('go')
  ok('AskUserQuestion announces that it is waiting',
     seenWhileWaiting.includes('agent_needs_input'), seenWhileWaiting.join(',') || '(none)')
}

/* ── 4. a turn that took a while says it finished ─────────────────────── */
{
  reset()
  server.close()
  const total = pass + fails.length
  // Re-imported with a different threshold: NOTIFY_AFTER_MS is read once, at
  // module load, so the env has to be set before the import that reads it.
  const child = await import('node:child_process')
  const probe = join(cwd, 'completed.mjs')
  writeFileSync(probe, `
import { createServer } from 'node:http'
const sse = (o) => 'data: ' + JSON.stringify(o) + '\\n\\n'
const srv = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ choices: [{ delta: { content: 'all done' } }] }))
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    res.end('data: [DONE]\\n\\n')
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + srv.address().port + '/v1'
process.env.OPENAI_API_KEY = 'sk-test'
process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(cwd)}
process.env.SERGE_NOTIFY_AFTER = '0.001'
const { createSession } = await import(${JSON.stringify(join(process.cwd(), 'src/loop.mjs'))})
const s = createSession({ cwd: ${JSON.stringify(cwd)}, model: 'test-seat', permissionMode: 'fullAccess' })
await s.send('go')
await new Promise((r) => setTimeout(r, 500))
srv.close()
process.exit(0)
`)
  const r = child.spawnSync('node', [probe], { encoding: 'utf8', timeout: 30_000, cwd: process.cwd() })
  ok('the completion probe ran', r.status === 0, (r.stderr || '').slice(-200))
  ok('a completed turn raises agent_completed', types().includes('agent_completed'),
     types().join(',') || '(none)')
  void total
}

rmSync(cwd, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
