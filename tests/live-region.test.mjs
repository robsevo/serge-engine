#!/usr/bin/env node
/**
 * The live region must never be taller than the viewport.
 *
 * WHY THAT IS THE INVARIANT. Ink has two ways to write a frame. The ordinary one
 * is `eraseLines(n) + frame`, which touches only the rows it owns. The other —
 * taken whenever a frame is taller than the terminal (ink.js
 * `shouldClearTerminalForFrame`: `nextOutputHeight > viewportRows`) — is
 *
 *     clearTerminal + fullStaticOutput + frame
 *
 * `clearTerminal` is ESC[2J ESC[3J ESC[H: erase the screen, erase the
 * SCROLLBACK, home the cursor. `fullStaticOutput` is every committed row of the
 * session, replayed from the top. On the 80ms animation tick that is a full
 * wipe-and-replay twelve times a turn, and it is exactly what "it flickers and
 * scrolls to the top when it's thinking" describes.
 *
 * Two things had no ceiling. The streaming reply was rendered whole, however
 * long it got; and the buffer holding it was never cleared between the model
 * calls WITHIN a turn, so a turn with five tool calls held all five preambles
 * on screen at once. Both are fixed — the tail is bounded (ui/live.mjs) and
 * finished prose is committed to <Static> at each tool boundary — and both are
 * pinned here.
 *
 * Run:  node tests/live-region.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rowsFor, tailToRows, liveBudget, CHROME_ROWS } from '../src/ui/live.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/* ── the budget arithmetic ────────────────────────────────────────────── */

ok('an empty line still occupies a row', rowsFor('', 80) === 1)
ok('a short line is one row', rowsFor('hello', 80) === 1)
ok('a line at exactly the width is one row', rowsFor('x'.repeat(80), 80) === 1)
ok('a line one past the width is two', rowsFor('x'.repeat(81), 80) === 2)
ok('wide characters are not undercounted', rowsFor('あ'.repeat(41), 80) >= 1)

ok('the budget shrinks with the terminal',
   liveBudget({ rows: 24 }) < liveBudget({ rows: 50 }))
ok('the budget never goes negative',
   liveBudget({ rows: 8 }) === 0 && liveBudget({ rows: 24, todoRows: 99 }) === 0)
ok('todos and prompts take their share from it',
   liveBudget({ rows: 40, todoRows: 5, promptRows: 8 }) === 40 - CHROME_ROWS - 13)

/* ── the tail ─────────────────────────────────────────────────────────── */

const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')

{
  const t = tailToRows(ten, 4, 80)
  ok('the tail keeps the LAST lines', t.text.split('\n')[0] === 'line 6', t.text.split('\n')[0])
  ok('the tail fits the budget', t.text.split('\n').length === 4)
  ok('the tail reports what it dropped', t.hidden === 6, String(t.hidden))
}
{
  const t = tailToRows(ten, 100, 80)
  ok('a text that fits is returned whole', t.text === ten && t.hidden === 0)
}
{
  // A wrapped paragraph: 500 characters at width 50 is 10 rows on its own.
  const t = tailToRows('x'.repeat(500), 3, 50)
  const rows = t.text.split('\n').reduce((n, l) => n + rowsFor(l, 50), 0)
  ok('one over-long line is clipped, not dropped', t.text.length > 0 && rows <= 3,
     `${rows} rows`)
}
{
  const t = tailToRows(ten, 0, 80)
  ok('a zero budget yields nothing', t.text === '' && t.hidden === 10)
}
{
  // The property that matters: whatever comes back fits, for any budget.
  let worst = null
  for (const budget of [1, 2, 3, 5, 9, 17, 40]) {
    for (const width of [24, 40, 80, 200]) {
      const text = Array.from({ length: 60 }, (_, i) => 'y'.repeat((i * 37) % 240)).join('\n')
      const t = tailToRows(text, budget, width)
      const rows = t.text.split('\n').reduce((n, l) => n + rowsFor(l, width), 0)
      if (rows > budget) worst = `budget ${budget} width ${width} → ${rows} rows`
    }
  }
  ok('the tail never exceeds its budget, at any size', worst === null, worst ?? '')
}

/* ── the component honours it ─────────────────────────────────────────── */

const app = readFileSync(join(root, 'src/ui/App.jsx'), 'utf8')
ok('App budgets the live region', /const budget = liveBudget\(/.test(app))
ok('App renders the tail, not the whole stream', /tailToRows\(stream,/.test(app))
ok('the raw stream is no longer rendered whole',
   !/items=\{\[\{ id: 'stream', kind: 'text', text: stream \}\]\}/.test(app))
ok('finished prose is committed at tool boundaries',
   /onTool\(name, input\) \{[\s\S]{0,220}flushStream\(\)/.test(app))
ok('a gate bouncing the turn also commits it',
   /onNotice\(m, kind = 'user'\) \{[\s\S]{0,260}flushStream\(\)/.test(app))
ok('the live buffer is reset when it is committed',
   /flushStream = useCallback\(\(\) => \{[\s\S]{0,200}streamBuf\.current = ''/.test(app))

/* ── end to end, on a real pty ────────────────────────────────────────── */

const py = spawnSync('python3', [join(root, 'tests/tui/live-region.py')],
  { encoding: 'utf8', timeout: 180_000, cwd: root })

if (py.error && py.error.code === 'ENOENT') {
  console.log('  skip  pty check (no python3)')
} else {
  const out = py.stdout || ''
  const rows = [...out.matchAll(/RESULT (\S+) clears=(\d+)/g)]
  ok('the pty harness ran every size', rows.length === 5, out.trim().slice(-200))
  for (const [, size, n] of rows) {
    ok(`${size} — Ink never clears the terminal mid-turn`, Number(n) === 0, `${n} clears`)
  }
}

/* ── and one keystroke must not repaint the whole region ──────────────── */

// The overflow fix above stops Ink CLEARING the terminal. This is the other
// half: what it costs to draw the frames it does write. Ink's default renderer
// erases and rewrites the entire live region for every frame, so a single
// keystroke redrew nine rows — the flicker you see in the input box while
// typing, and on every 80ms tick while a turn runs. `incrementalRendering`
// (ink-repl.mjs) rewrites only the lines that differ.
const keys = spawnSync('python3', [join(root, 'tests/tui/typing-cost.py')],
  { encoding: 'utf8', timeout: 120_000, cwd: root })

if (keys.error && keys.error.code === 'ENOENT') {
  console.log('  skip  typing cost (no python3)')
} else {
  const line = /RESULT .*/.exec(keys.stdout || '')?.[0] ?? ''
  const perKey = Number(/rows_per_key=([\d.]+)/.exec(line)?.[1] ?? NaN)
  ok('the typing probe ran', Number.isFinite(perKey), (keys.stdout || '').trim().slice(-160))
  ok('a keystroke does not repaint the whole live region', perKey < 2, line)
  console.log(`        ${line.replace('RESULT ', '')}`)
}

const src = readFileSync(join(root, 'src/ink-repl.mjs'), 'utf8')
ok('the session asks Ink for incremental rendering',
   /incrementalRendering:\s*true/.test(src))
ok('and the probe renders with the same options as the session',
   /incrementalRendering:\s*true/.test(readFileSync(join(root, 'tests/tui/live-region-probe.mjs'), 'utf8')))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
