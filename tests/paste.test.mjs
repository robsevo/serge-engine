#!/usr/bin/env node
/**
 * A paste goes into the box, not into the model.
 *
 * WHAT WENT WRONG. `useInput` gets a chunk of text and looks for a newline
 * inside it, because piped input arrives exactly that way — `"ab\n"` with
 * `key.return` false — and scripted runs have to submit. A terminal WITHOUT
 * bracketed paste mode delivers a paste through that same channel, so the two
 * were indistinguishable. Pasting six lines submitted the FIRST one and
 * discarded the other five, silently:
 *
 *     paste "please review this function\ndef f(xs): …"
 *     → SUBMITTED: "please review this function"
 *
 * You get an answer about the sentence, from a model that never saw the
 * function, with nothing on screen to say five lines went missing.
 *
 * `usePaste` enables bracketed paste mode (ESC[?2004h). The terminal then wraps
 * a paste in ESC[200~ … ESC[201~ and Ink routes it to the paste channel instead
 * of to `useInput` — which is what finally tells a paste apart from a pipe. The
 * newline branch in `useInput` is untouched, so scripted input still works.
 *
 * The second half is height. The input is part of the LIVE region, and a live
 * region taller than the viewport is what makes Ink wipe the terminal on every
 * frame (see live-region.test.mjs). A 400-line paste must not reintroduce that,
 * so the value is windowed and App budgets against the rows it will draw.
 *
 * Run:  node tests/paste.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// From dist/, like the other UI tests: node cannot load .jsx directly, so
// `npm run build` has to have run. The source is asserted against separately
// below, so a stale build cannot make these pass on their own.
import { promptRowsFor, MAX_INPUT_ROWS } from '../dist/ui/PromptInput.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/* ── the height the input claims, which App budgets against ───────────── */

ok('a single line is one row', promptRowsFor('hello') === 1)
ok('an empty value is one row', promptRowsFor('') === 1)
ok('two lines are two rows', promptRowsFor('a\nb') === 2)
ok('a value at the cap needs no marker', promptRowsFor('a\n'.repeat(MAX_INPUT_ROWS - 1) + 'b') === MAX_INPUT_ROWS)
ok('past the cap it windows and counts the rest',
   promptRowsFor('x\n'.repeat(400)) === MAX_INPUT_ROWS + 1,
   String(promptRowsFor('x\n'.repeat(400))))
ok('a 400-line paste can never be more than the cap plus its marker',
   promptRowsFor('x\n'.repeat(400)) <= MAX_INPUT_ROWS + 1)
{
  let worst = null
  for (const lines of [1, 2, 5, 6, 7, 40, 4000]) {
    for (const cap of [1, 2, 3, 6, 12]) {
      const rows = promptRowsFor(Array.from({ length: lines }, () => 'y').join('\n'), cap)
      if (rows > cap + 1) worst = `${lines} lines at cap ${cap} → ${rows} rows`
    }
  }
  ok('the reported height never exceeds its cap plus one, at any size',
     worst === null, worst ?? '')
}

/* ── the components are wired to it ───────────────────────────────────── */

const input = readFileSync(join(root, 'src/ui/PromptInput.jsx'), 'utf8')
ok('the prompt subscribes to the paste channel', /usePaste\(\(text\) =>/.test(input))
ok('a paste does not submit',
   !/usePaste\(\(text\) => \{[\s\S]{0,600}onSubmit\(/.test(input))
ok('CRLF and a trailing newline are normalised away',
   /replace\(\/\\\\r\\\\n\?\/g, '\\\\n'\)/.test(input) || /\\r\\n\?/.test(input))
ok('the newline branch in useInput survives, so piped input still submits',
   /const nl = input\.indexOf\('\\n'\)/.test(input))
ok('ctrl-j inserts a newline instead', /input === 'j'/.test(input))

const app = readFileSync(join(root, 'src/ui/App.jsx'), 'utf8')
ok('App tracks how tall the input has grown', /onHeight=\{setInputRows\}/.test(app))
ok('and takes those rows out of the live budget',
   /promptRows: promptRows \+ extraInputRows/.test(app))
ok('and caps the input against the terminal height too', /const inputMax = /.test(app))

/* ── end to end, on a real pty ────────────────────────────────────────── */

const py = spawnSync('python3', [join(root, 'tests/tui/paste-check.py')],
  { encoding: 'utf8', timeout: 180_000, cwd: root })

if (py.error && py.error.code === 'ENOENT') {
  console.log('  skip  pty check (no python3)')
} else {
  const out = py.stdout || ''
  const wrapped = /RESULT wrapped bracketed=(\w+) on_paste=(\d+) on_enter=(\d+)/.exec(out)
  ok('the pty harness ran', !!wrapped, out.trim().slice(-220))
  if (wrapped) {
    ok('the app asks the terminal for bracketed paste', wrapped[1] === 'True')
    ok('a real paste submits NOTHING on its own', Number(wrapped[2]) === 0,
       `${wrapped[2]} submissions`)
    ok('Enter afterwards submits it once', Number(wrapped[3]) === 1, `${wrapped[3]} submissions`)
    ok('and the whole paste survives, newlines and all',
       !/FAIL the submitted text lost/.test(out),
       (/FAIL the submitted text lost.*/.exec(out) ?? [''])[0])
  }
  const raw = /RESULT raw on_paste=(\d+)/.exec(out)
  ok('an unwrapped chunk still submits — piped and scripted input keep working',
     raw && Number(raw[1]) === 1, raw?.[1] ?? 'not run')

  const big = /RESULT big lines=400 clears=(\d+)/.exec(out)
  ok('a 400-line paste never makes Ink clear the terminal',
     big && Number(big[1]) === 0, big?.[1] ?? 'not run')
}

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
