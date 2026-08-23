#!/usr/bin/env node
/**
 * The resize repaint must re-arm on every resize event.
 *
 * A resize renders one deliberately over-tall frame to trigger Ink's own
 * clear-and-replay path. The frame is reverted on a timer. Driven by a BOOLEAN
 * that revert never re-armed: `setTall(true)` while already true is a React
 * no-op, so no re-render, so the `[tall]` effect did not re-run and the timer
 * was never rescheduled. The spacer stayed on screen as a permanent
 * screen-height gap, and dragging a window fires enough events to reach that
 * state on the second one.
 *
 * The pty harness (tests/tui/resize-check.py) does NOT catch this: the spacer is
 * viewport+1 rows by design, so it overflows, Ink full-clears anyway, and the
 * final screen looks fine. That is why the regression is pinned here instead —
 * at the level the bug actually lives.
 *
 * Run:  node tests/resize-effect.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/* ── the behaviour ────────────────────────────────────────────────────── */

// Rendered in a real Ink tree, because the whole point is React's bail-out on
// an unchanged state value — which only happens in a real reconciler.
const probe = join(root, '.resize-probe.mjs')
writeFileSync(probe, `
import React, { useState, useEffect } from 'react'
import { render, Box, Text } from 'ink'

let boolRuns = 0, countRuns = 0
function Probe() {
  const [flag, setFlag] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => { if (flag) boolRuns++ }, [flag])
  useEffect(() => { if (tick) countRuns++ }, [tick])
  useEffect(() => {
    // Three resize events, as dragging a window produces.
    const fire = () => { setFlag(true); setTick((n) => n + 1) }
    fire()
    setTimeout(fire, 25)
    setTimeout(fire, 50)
    setTimeout(() => {
      console.log('RESULT bool=' + boolRuns + ' count=' + countRuns)
      process.exit(0)
    }, 150)
  }, [])
  return React.createElement(Box, null, React.createElement(Text, null, '.'))
}
render(React.createElement(Probe))
`)

const r = spawnSync('script', ['-qec', `node ${probe}`, '/dev/null'],
  { encoding: 'utf8', timeout: 20_000, cwd: root })
try { unlinkSync(probe) } catch { /* already gone */ }

const m = /RESULT bool=(\d+) count=(\d+)/.exec(r.stdout || '')
ok('the probe ran', !!m, (r.stdout || '').slice(-120))
if (m) {
  const [, boolRuns, countRuns] = m.map(Number)
  ok('a counter effect re-runs on every event', countRuns === 3, `${countRuns} of 3`)
  ok('a boolean effect does NOT — this is the bug', boolRuns < 3, `${boolRuns} of 3`)
}

/* ── the component uses it ────────────────────────────────────────────── */

const app = readFileSync(join(root, 'src/ui/App.jsx'), 'utf8')
ok('App drives the repaint from a counter', /setResizeTick\(\(n\) => n \+ 1\)/.test(app))
ok('the resize handler does not set a bare boolean', !/onResize = \(\) => \{[^}]*setTall\(true\)/.test(app))
ok('the spacer is cleared on a timer', /setTimeout\(\(\) => setTall\(false\)/.test(app),
   'the revert is gone — the spacer will stick')
ok('the revert effect keys on the counter', /\}, \[resizeTick\]\)/.test(app))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
