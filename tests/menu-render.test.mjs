#!/usr/bin/env node
/**
 * The command menu, rendered for real.
 *
 * This exists because a React duplicate-key warning is invisible to every
 * other suite here: it is a console warning, not a thrown error, so a menu
 * that silently drops a row still "passes". A brain publishing its own /cost
 * alongside the built-in is exactly that case, and it shipped.
 *
 * The probe runs on a pty (Ink needs a real TTY) and its stderr is the subject.
 *
 * Run:  node tests/menu-render.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const probe = join(here, 'fixtures', 'menu-probe.mjs')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// `script` gives the probe a pty; without one Ink renders nothing at all and
// every assertion below would pass vacuously — which is why the first check is
// that the menu actually appeared.
const r = spawnSync('script', ['-qec', `node ${probe}`, '/dev/null'], {
  encoding: 'utf8', timeout: 25_000, cwd: join(here, '..'),
})
const out = (r.stdout || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
const err = r.stderr || ''
// A pty merges stderr into stdout, so warnings land in either stream.
const both = out + err

// Not vacuous: if Ink rendered nothing (no pty, a crashed probe) every check
// below would pass on an empty string, so this one has to fail loudly first.
ok('the menu rendered', /\u276f\s+\/cost\s{2,}\S/.test(out), out.slice(-200))
ok('no duplicate-key warning', !/same key/i.test(both),
   (both.match(/.{0,80}same key.{0,40}/i) || [''])[0])
// React 19 dropped the `Warning:` prefix, so matching on it passed even with
// the duplicate key present — a check that cannot fail is not a check. These
// are the shapes React 19 actually emits.
const REACT_NOISE = /Encountered two children|Each child in a list|unique "key"|validateDOMNesting|Cannot update a component|Maximum update depth/i
ok('no React warning at all', !REACT_NOISE.test(both),
   (both.match(REACT_NOISE) || [''])[0])
// Both rows survive: the built-in and the brain file shadowing it. React
// dropping one would make this 1.
//
// Counted as menu ROWS in the final frame, not occurrences anywhere: the typed
// text `/cost` is on the input line too, and every intermediate frame is still
// in the buffer, so a naive count of the string reads 3 and would have "passed"
// for the wrong reason.
const finalFrame = out.slice(out.lastIndexOf('\u276f '))
const rows = finalFrame.split('\n').filter((l) => /^\s*(\u276f\s+)?\/cost\s{2,}\S/.test(l))
ok('both /cost rows render', rows.length === 2, `saw ${rows.length}: ${rows.join(' | ').slice(0, 90)}`)
ok('the shadow is marked as such', /shadowed/.test(out))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
