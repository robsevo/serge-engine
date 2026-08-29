#!/usr/bin/env node
/**
 * Edits must show what they changed.
 *
 * Edit, MultiEdit and Write returned one sentence — "MultiEdit: applied 3
 * edit(s) to /path (4 replacement(s))" — and both front-ends print the first
 * line of a tool result, so that sentence was the entire record of a file being
 * rewritten. You could watch a session edit twelve files and see nothing about
 * what went into any of them.
 *
 * Run:  node tests/diff.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffLines, summarize, renderDiffText } from '../src/diff.mjs'
import { TOOLS } from '../src/tools/index.mjs'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'serge-diff-'))
const at = (n) => join(dir, n)

/* ── the diff itself ──────────────────────────────────────────────────── */

{
  const d = diffLines('a\nb\nc\n', 'a\nB\nc\n')
  ok('a one-line change is one add and one delete', d.added === 1 && d.removed === 1,
     `+${d.added} -${d.removed}`)
  ok('the changed lines are marked',
     d.lines.some((l) => l.type === 'del' && l.text === 'b')
     && d.lines.some((l) => l.type === 'add' && l.text === 'B'))
  ok('unchanged neighbours come along as context',
     d.lines.some((l) => l.type === 'ctx' && l.text === 'a'))
}
{
  const d = diffLines('same\n', 'same\n')
  ok('no change is no diff', d.added === 0 && d.removed === 0)
}
{
  const d = diffLines('', 'one\ntwo\n')
  ok('a new file is all additions', d.removed === 0 && d.added >= 2, `+${d.added} -${d.removed}`)
}
{
  // The trim-then-LCS path: a one-line edit inside a large file must not build
  // a table over the file. If it did, this would not return promptly.
  const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
  const t0 = Date.now()
  const d = diffLines(big, big.replace('line 9999', 'line NINE'))
  const ms = Date.now() - t0
  ok('a small edit in a huge file stays cheap', ms < 1500, `${ms}ms`)
  ok('and still finds the one changed line', d.added === 1 && d.removed === 1,
     `+${d.added} -${d.removed}`)
  ok('the untouched bulk is summarised, not printed',
     d.lines.some((l) => l.type === 'gap'))
}
{
  // Two files with nothing in common: the LCS guard must refuse the table.
  const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n')
  const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n')
  const t0 = Date.now()
  const d = diffLines(a, b)
  ok('a total rewrite degrades instead of allocating', Date.now() - t0 < 1500,
     `${Date.now() - t0}ms`)
  ok('and still reports both sides', d.added === 5000 && d.removed === 5000,
     `+${d.added} -${d.removed}`)
}
{
  const d = diffLines('x\n', Array.from({ length: 300 }, (_, i) => `n${i}`).join('\n'))
  const s = summarize(d, { maxLines: 24 })
  ok('the rendered window is bounded', s.lines.length <= 24, String(s.lines.length))
  ok('and says how much it withheld', s.hidden > 200, String(s.hidden))
  ok('the text renderer marks adds and deletes',
     /\+ n0/.test(renderDiffText(d, { color: false })))
}

/* ── the tools return one ─────────────────────────────────────────────── */

{
  writeFileSync(at('e.txt'), 'alpha\nbeta\ngamma\n')
  const r = TOOLS.Edit.run(
    { file_path: at('e.txt'), old_string: 'beta', new_string: 'BETA' }, { cwd: dir })
  ok('Edit succeeds', !r.isError, r.content)
  ok('Edit returns a diff', !!r.diff?.lines?.length)
  ok('Edit names the file it changed', r.diff?.file === at('e.txt'))
  ok('Edit counts the change', r.diff.added === 1 && r.diff.removed === 1)
  ok('the diff is NOT pasted into the model-facing content',
     !r.content.includes('BETA'), r.content)
}
{
  writeFileSync(at('m.txt'), 'one\ntwo\nthree\n')
  const r = TOOLS.MultiEdit.run({
    file_path: at('m.txt'),
    edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'three', new_string: '3' }],
  }, { cwd: dir })
  ok('MultiEdit succeeds', !r.isError, r.content)
  ok('MultiEdit returns a diff covering both edits',
     r.diff.added === 2 && r.diff.removed === 2, `+${r.diff?.added} -${r.diff?.removed}`)
  ok('MultiEdit diffs against the ORIGINAL file',
     r.diff.lines.some((l) => l.type === 'del' && l.text === 'one'))
}
{
  writeFileSync(at('w.txt'), 'before\n')
  const r = TOOLS.Write.run({ file_path: at('w.txt'), content: 'after\n' }, { cwd: dir })
  ok('Write over an existing file diffs against what was there',
     r.diff.lines.some((l) => l.type === 'del' && l.text === 'before')
     && r.diff.lines.some((l) => l.type === 'add' && l.text === 'after'),
     JSON.stringify(r.diff?.lines))
  ok('Write actually wrote', readFileSync(at('w.txt'), 'utf8') === 'after\n')
}
{
  const r = TOOLS.Write.run({ file_path: at('new.txt'), content: 'fresh\n' }, { cwd: dir })
  ok('a new file diffs as pure addition', r.diff.removed === 0 && r.diff.added >= 1,
     `+${r.diff?.added} -${r.diff?.removed}`)
}
{
  writeFileSync(at('f.txt'), 'kept\n')
  const r = TOOLS.Edit.run(
    { file_path: at('f.txt'), old_string: 'absent', new_string: 'x' }, { cwd: dir })
  ok('a failed edit carries no diff', r.isError && !r.diff)
  ok('and leaves the file alone', readFileSync(at('f.txt'), 'utf8') === 'kept\n')
}

rmSync(dir, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
