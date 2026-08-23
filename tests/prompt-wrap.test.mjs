#!/usr/bin/env node
/**
 * The prompt line must not lose characters when it wraps.
 *
 * It used to render as FOUR sibling <Text> nodes in a row <Box> — prompt,
 * text-before-cursor, cursor, text-after-cursor. Ink wraps each sibling on its
 * own, so once the line was wide enough to wrap, the character sitting on the
 * break was consumed and the space after `❯` was trimmed. At 40 columns
 * `…nintendo switch with…` drew as `…nintendo switc` / `with…`: the h was gone
 * from the SCREEN while still present in the state, so retyping never helped and
 * only a resize — which forces Ink to clear and replay — brought it back.
 *
 * Ink also erases by counting `\n` in its own output (build/log-update.js), not
 * terminal rows, so a line that soft-wraps leaves rows behind on every redraw.
 * Both checks are here: nothing lost, and the two counts agree.
 *
 * Run:  node tests/prompt-wrap.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const probe = join(here, 'fixtures', 'prompt-wrap-probe.mjs')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? '\n        ' + d : ''}`) }
}

const run = (cols, value, cursor) => {
  const args = [probe, String(cols)]
  if (value !== undefined) args.push(value)
  if (cursor !== undefined) args.push(String(cursor))
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'))
  if (!line) throw new Error('probe produced no result\n' + r.stdout + r.stderr)
  return JSON.parse(line)
}

const LONG = '/sc:research "we have a nintendo switch with the dongle'

// The width that reproduced it. 30 and 24 wrap harder; 100 does not wrap at all.
for (const cols of [100, 55, 40, 30, 24]) {
  const r = run(cols, LONG)
  // Compared without whitespace: a space sitting on the wrap point is consumed
  // by the wrap, which is correct. A letter disappearing is not.
  ok(`${String(cols).padStart(3)} cols — every character survives the wrap`,
     r.seenDense === r.typedDense,
     `typed ${JSON.stringify(r.typed)}\n        shown ${JSON.stringify(r.seen)}`)
  ok(`${String(cols).padStart(3)} cols — erase count matches rows on screen`,
     r.stringLines === r.terminalRows,
     `Ink erases ${r.stringLines}, terminal shows ${r.terminalRows}`)
}

// The reported symptom was a quote that "wasn't there". Pin the quote itself,
// with the cursor on it and just past it.
const q = run(40, LONG, 13)
ok('a quote under the cursor is still drawn', q.seenDense === q.typedDense,
   `shown ${JSON.stringify(q.seen)}`)
const q2 = run(40, LONG, 14)
ok('a quote just behind the cursor is still drawn', q2.seenDense === q2.typedDense,
   `shown ${JSON.stringify(q2.seen)}`)

// The prompt marker keeps its trailing space; sibling layout used to eat it.
const p = run(55, LONG)
ok('the space after the prompt marker survives', p.lines[0].startsWith('❯ '),
   `first line ${JSON.stringify(p.lines[0])}`)

console.log(`\n  ${pass}/${pass + fails.length} passed`)
process.exit(fails.length ? 1 : 0)
