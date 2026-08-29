#!/usr/bin/env node
/**
 * Typing while Serge is thinking.
 *
 * The input used to drop every keystroke for the whole length of a turn
 * ("keystrokes during a turn are ignored"), so the one moment you most want to
 * say something — watching it head somewhere you did not mean — was the one
 * moment the keyboard was dead. Waiting meant losing the thought; ctrl-c meant
 * losing the turn.
 *
 * Now a mid-turn line is QUEUED, and the loop hands it to the model at its next
 * round, framed so the model triages it first: a correction is folded into the
 * work in flight, separate work goes on the todo list and waits its turn. What
 * this pins:
 *
 *   1. A queued message reaches the model DURING the turn it was typed into —
 *      at the next round, not after the turn ends.
 *   2. A turn does not END with a message still unread. Without this, anything
 *      typed in the last half-second of a turn strands until the next prompt,
 *      which from the outside is the input having eaten it.
 *   3. The framing states the triage rather than leaving it to judgement.
 *   4. The key handler carries no blanket busy guard, and Enter routes to the
 *      queue instead of opening a second turn against a running session.
 *
 * The loop cases drive the REAL provider against a local OpenAI-compatible
 * server, so the loop, the streaming parser and the queue are all on the path
 * under test — no seam exists in production code that only tests use.
 *
 * Run:  node tests/queued-input.test.mjs
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`

/**
 * Run one scripted turn, typing into it at a chosen point.
 *
 * `script[i]` is what the model answers to request i. `typeAt` says which
 * request is in flight when the user hits Enter — the enqueue happens inside
 * the request handler, which is genuinely "while the turn is running": `send`
 * is awaiting this response when it fires.
 *
 * @returns the bodies of every request, in order.
 */
async function turnWithTyping({ script, typeAt, text }) {
  const cwd = mkdtempSync(join(tmpdir(), 'serge-queue-'))
  const seen = []
  let session = null
  let step = 0

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      try { seen.push(JSON.parse(body).messages || []) } catch { seen.push([]) }
      // The user types. `send` is parked on this very response, so the message
      // lands in the queue mid-turn exactly as a keystroke would.
      if (step === typeAt) session?.enqueue(text)

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
  process.env.CLAUDE_CONFIG_DIR = cwd        // an empty brain: no hooks, no skills

  const { createSession } = await import('../src/loop.mjs')
  const handed = []
  session = createSession({
    cwd, model: 'test-seat', permissionMode: 'fullAccess',
    onInterject: (t) => handed.push(...t),
  })
  const res = await session.send('do the thing')
  server.close()
  return { seen, res, handed, pending: session.pending }
}

/** Every user-role message across a request, flattened. */
const userText = (msgs) => msgs.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n')

/* ── 1. it reaches the model DURING the turn, between tool calls ──────────── */

const mid = await turnWithTyping({
  script: [
    { tool: { id: 't1', name: 'Glob', args: { pattern: '*' } } },
    { text: 'done' },
  ],
  typeAt: 0,
  text: 'actually use tabs, not spaces',
})

ok('the turn ran more than one round', mid.seen.length >= 2, `${mid.seen.length} request(s)`)
if (mid.seen.length >= 2) {
  ok('a message typed mid-turn reaches the NEXT round',
     userText(mid.seen[1]).includes('actually use tabs, not spaces'),
     'the model never saw it — it waited for the turn to end, which is the bug')
  ok('the first round did not already carry it',
     !userText(mid.seen[0]).includes('actually use tabs'),
     'it was injected before it was typed, so the test proves nothing')
}
ok('the queue is empty once it has been handed over', mid.pending.length === 0)
ok('the front-end is told what was handed over',
   mid.handed.length === 1 && mid.handed[0] === 'actually use tabs, not spaces',
   'without onInterject the message never appears in the transcript the user reads')

/* ── 2. a turn does not END with a message still unread ───────────────────── */

// The model answers on the FIRST round with no tool calls — the turn is over on
// every path except the one under test. A message typed while that answer was
// streaming must still be read, or it strands until the next prompt.
const late = await turnWithTyping({
  script: [
    { text: 'all finished' },
    { text: 'and now with tabs' },
  ],
  typeAt: 0,
  text: 'wait — use tabs',
})

ok('a turn with an unread message does not end',
   late.seen.length >= 2,
   `${late.seen.length} request(s) — the loop returned with a message still queued, `
   + 'so it strands until the next prompt')
if (late.seen.length >= 2) {
  ok('the late message is put to the model',
     userText(late.seen[1]).includes('wait — use tabs'))
  ok('the answer the user gets is the one that read it',
     late.res.text === 'and now with tabs', `got ${JSON.stringify(late.res.text)}`)
}
ok('nothing is left queued when the turn really ends', late.pending.length === 0)

/* ── 3. the framing states the triage ─────────────────────────────────────── */

const { interjection } = await import('../src/loop.mjs')
const framed = interjection(['use tabs', 'also add a test'])

ok('the framing carries both messages',
   framed.includes('use tabs') && framed.includes('also add a test'))
ok('it says the message arrived mid-turn', /mid-turn/.test(framed),
   'without this the model reads it as the next request and abandons the current one')
ok('it names the correction outcome', /CORRECTION/.test(framed))
ok('it names the separate-work outcome, and says not to switch',
   /SEPARATE WORK/.test(framed) && /Do not switch to it/.test(framed))
ok('it routes separate work to the list the user can see',
   /TodoWrite/.test(framed),
   'the todo list IS the queue on screen — Todos.jsx renders it live')
ok('it covers amending work already queued',
   /ALREADY ON THE LIST/.test(framed),
   'a later message that changes a queued step must rewrite it, not race it')
ok('it asks which outcome it was',
   /say in one line which it was/i.test(framed),
   'the user cannot otherwise tell whether their message landed in this turn or is waiting')

/* ── 4. the input queues rather than dropping or double-sending ───────────── */

/**
 * Type at the REAL component and see where the line went.
 *
 * A real pty with real bytes, for the reason tests/turn-input.test.mjs gives:
 * Ink reads keys through its own parser, and an injected stdin never reaches
 * useInput at all.
 */
function typeInto(busy, keys) {
  const src = join(root, '.queue-probe.jsx')
  const bundle = join(root, '.queue-probe.mjs')
  writeFileSync(src, `
import React, { useState, useEffect } from 'react'
import { render } from 'ink'
import { PromptInput } from './src/ui/PromptInput.jsx'

let queued = [], submitted = []
function Probe() {
  const [busy] = useState(${busy})
  useEffect(() => {
    setTimeout(() => {
      console.log('RESULT q=' + JSON.stringify(queued) + ' s=' + JSON.stringify(submitted))
      process.exit(0)
    }, 900)
  }, [])
  return React.createElement(PromptInput, {
    busy,
    onQueue: (t) => { queued.push(t); return true },
    onSubmit: (t) => { submitted.push(t) },
    onStop: () => {}, onInterrupt: () => {}, onCycleMode: () => {},
    history: [], commands: [],
  })
}
render(React.createElement(Probe))
`)
  const built = spawnSync(join(root, 'node_modules/.bin/esbuild'),
    [src, '--bundle', '--format=esm', '--platform=node', '--jsx=automatic',
     '--packages=external', `--outfile=${bundle}`],
    { encoding: 'utf8', timeout: 60_000, cwd: root })

  const run = built.status === 0
    ? spawnSync('sh', ['-c',
        `(printf '${keys}'; sleep 1.2) | script -qec "node ${bundle}" /dev/null`],
        { encoding: 'utf8', timeout: 30_000, cwd: root })
    : { stdout: '' }
  for (const f of [src, bundle]) { try { unlinkSync(f) } catch { /* already gone */ } }

  const m = /RESULT q=(\[.*?\]) s=(\[.*?\])/.exec(run.stdout || '')
  return m
    ? { queued: JSON.parse(m[1]), submitted: JSON.parse(m[2]), raw: run.stdout }
    : { raw: (built.stderr || '') + (run.stdout || '') }
}

const busyType = typeInto(true, 'use tabs\\r')
ok('the typing probe ran during a turn', !!busyType.queued, (busyType.raw || '').slice(-200))
if (busyType.queued) {
  ok('typing during a turn is not dropped',
     busyType.queued.length === 1 && busyType.queued[0] === 'use tabs',
     `queued ${JSON.stringify(busyType.queued)} — the busy guard is back`)
  ok('it does NOT open a second turn',
     busyType.submitted.length === 0,
     'onSubmit fired mid-turn: two sends against one session share one history, '
     + 'and whichever finished last would overwrite the other')
}

const idleType = typeInto(false, 'use tabs\\r')
ok('the typing probe ran at an idle prompt', !!idleType.submitted, (idleType.raw || '').slice(-200))
if (idleType.submitted) {
  ok('an idle prompt still SENDS',
     idleType.submitted.length === 1 && idleType.submitted[0] === 'use tabs',
     `submitted ${JSON.stringify(idleType.submitted)}`)
  ok('an idle prompt queues nothing', idleType.queued.length === 0)
}

/* ── the components and the loop keep their side of it ────────────────────── */

const input = readFileSync(join(root, 'src/ui/PromptInput.jsx'), 'utf8')
const app = readFileSync(join(root, 'src/ui/App.jsx'), 'utf8')
const loop = readFileSync(join(root, 'src/loop.mjs'), 'utf8')

const keyHandler = (() => {
  const start = input.indexOf('useInput((input, key) =>')
  const end = input.indexOf('\n  })', start)
  return start < 0 || end < 0 ? '' : input.slice(start, end)
})()
ok('the key handler was located', keyHandler.length > 0)
ok('the key handler has no blanket busy guard',
   !/\n\s*if \(busy\) return(?![a-zA-Z])/.test(keyHandler),
   'every keystroke is dropped mid-turn again — nothing can be queued, and escape '
   + 'cannot reach a running turn either')
ok('Enter routes to the queue while busy',
   /if \(busy\) \{ if \(onQueue\?\.\(text\)\) clear\(\); return \}/.test(input))
ok('a refused line is kept in the box',
   input.includes('const clear = () => {') && /if \(onQueue\?\.\(text\)\) clear\(\)/.test(input),
   'clearing regardless means a refused command vanishes and has to be retyped')

ok('commands are refused rather than queued',
   /if \(parseCommand\(text\)\) \{/.test(app),
   'a queued /clear would drop the history the running turn is still writing into')
ok('a queue the turn never reached becomes the next turn',
   app.includes('session.takePending()'),
   'an escaped turn would otherwise leave typed messages in a list nothing reads')
ok('the queued list is budgeted into the live region',
   app.includes('queuedRowsFor(queued)') && app.includes('queuedRows'),
   'unbudgeted rows push the frame past the viewport, which is what makes Ink '
   + 'wipe the terminal every 80ms (ui/live.mjs)')

ok('the loop drains the queue after compaction, not before',
   loop.indexOf("runHooks('PostCompact'") < loop.indexOf('onInterject?.(texts)'),
   'a message injected before compaction can be summarised away before the model reads it')
ok('the loop refuses to finish with a message still queued',
   /if \(pending\.length\) continue/.test(loop))
ok('it refuses BEFORE the end-of-turn gates run',
   loop.indexOf('if (pending.length) continue') < loop.indexOf("runHooks('Stop'"),
   'Stop, the evidence gate and the todo nudge all judge a FINISHED turn')

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
