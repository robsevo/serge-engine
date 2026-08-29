#!/usr/bin/env node
/**
 * The seat roster is read once, and re-read when it changes.
 *
 * `algo_check bigo` flagged `.exec()` inside a loop in seats.mjs as an N+1. That
 * part was a false positive — it is `RegExp.exec` over one line of YAML, pure
 * CPU. But looking at the call graph it named turned up a real one right above
 * it: `checkSeat(name)` defaults its roster argument to `loadSeats()`, and
 * `createSession` validates one seat per agent in a loop over the brain's 16
 * agents. So starting a session read and re-scanned the same 49KB litellm.yaml
 * sixteen times — 13.5ms of blocking file I/O before the first frame, to answer
 * sixteen Map lookups worth 0.8ms in total.
 *
 * Fixed twice on purpose: the loop hoists the load (that is the one that reads
 * as intent), and `loadSeats` memoises (that is the one that protects the other
 * five call sites). The memo is keyed on the file's mtime and size, because a
 * cache that only invalidates on restart would make `--seats` lie to you right
 * after you edited the router config — which is exactly when you would look.
 *
 * Run:  node tests/seats-cache.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSeats, checkSeat, forgetSeats } from '../src/seats.mjs'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'serge-seats-'))
const yaml = join(dir, 'litellm.yaml')

const roster = (names) => 'model_list:\n' + names.map((n) =>
  `  - model_name: ${n}\n    litellm_params:\n      model: openai/${n}\n      rpm: 30\n`).join('')

writeFileSync(yaml, roster(['local-coder', 'cloud-brain', 'search-fast']))
forgetSeats()

/* ── it parses ────────────────────────────────────────────────────────── */
{
  const s = loadSeats(yaml)
  ok('the roster parses', s?.size === 3, String(s?.size))
  ok('a known seat passes', checkSeat('local-coder', s).ok === true)
  const bad = checkSeat('local-codr', s)
  ok('a typo fails', bad.ok === false)
  ok('and suggests the right spelling', /local-coder/.test(bad.reason), bad.reason?.slice(0, 60))
}

/* ── it is read once ──────────────────────────────────────────────────── */
{
  forgetSeats()
  const first = loadSeats(yaml)
  const again = loadSeats(yaml)
  ok('a second call returns the SAME object, not a re-parse', first === again)
}

/* ── and re-read when the file changes ────────────────────────────────── */
{
  const before = loadSeats(yaml)
  writeFileSync(yaml, roster(['local-coder', 'cloud-brain', 'search-fast', 'vision-seat']))
  const after = loadSeats(yaml)
  ok('editing the file invalidates the memo', after !== before)
  ok('and the new seat is visible', after?.has('vision-seat') === true,
     [...(after?.keys() ?? [])].join(','))
  ok('checkSeat agrees immediately', checkSeat('vision-seat', loadSeats(yaml)).ok === true)
}
{
  // Same size, different content, same second: mtime is what catches this, and
  // a filesystem with coarse timestamps is why size alone is not enough either.
  const before = loadSeats(yaml)
  writeFileSync(yaml, roster(['local-coder', 'cloud-brain', 'search-fast', 'vision-seaT']))
  const after = loadSeats(yaml)
  ok('a same-length rewrite is not served stale',
     after?.has('vision-seaT') === true, [...(after?.keys() ?? [])].join(','))
  void before
}

/* ── it still fails open ──────────────────────────────────────────────── */
{
  forgetSeats()
  ok('a missing roster is null, not a throw', loadSeats(join(dir, 'nope.yaml')) === null)
  ok('and checkSeat passes everything when there is no roster',
     checkSeat('anything', null).ok === true)
}
{
  forgetSeats()
  writeFileSync(join(dir, 'empty.yaml'), '# just a comment\n')
  ok('a roster with no seats is null', loadSeats(join(dir, 'empty.yaml')) === null)
  ok('and that answer is cached too, without re-reading',
     loadSeats(join(dir, 'empty.yaml')) === null)
}

/* ── the cost ─────────────────────────────────────────────────────────── */
{
  const big = join(dir, 'big.yaml')
  // Shaped like the real file: ~50KB, mostly comments and nested provider config.
  writeFileSync(big, roster(Array.from({ length: 22 }, (_, i) => `seat-${i}`))
    + Array.from({ length: 1200 }, (_, i) => `# padding line ${i} ${'-'.repeat(30)}`).join('\n'))
  forgetSeats()

  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 16; i++) forgetSeats(), loadSeats(big)   // the old behaviour
  const cold = Number(process.hrtime.bigint() - t0) / 1e6

  forgetSeats()
  loadSeats(big)
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 16; i++) loadSeats(big)
  const warm = Number(process.hrtime.bigint() - t1) / 1e6

  console.log(`        16 loads: ${cold.toFixed(2)}ms uncached → ${warm.toFixed(2)}ms cached`)
  ok('16 lookups no longer cost 16 file scans', warm < cold / 4,
     `${cold.toFixed(2)}ms → ${warm.toFixed(2)}ms`)
}

rmSync(dir, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
