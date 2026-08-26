#!/usr/bin/env node
/**
 * Two regressions in the dynamic region during a turn.
 *
 * 1. ESCAPE MUST INTERRUPT. The key handler dropped every keystroke while busy
 *    ("keystrokes during a turn are ignored") and only checked for escape
 *    below that guard, so escape never reached a running turn. The only way to
 *    stop Serge was ctrl-c — the key people press to QUIT. Escape now stops
 *    the turn, and it must keep its other job (closing the command menu) when
 *    idle, and must never quit.
 *
 * 2. THE TICK MUST NOT RE-ARM ITSELF. The 80ms animation interval listed
 *    `stream` and `thinking` in its dependency array and then SET both from
 *    inside the interval. Every flushed chunk therefore tore the interval down
 *    and rebuilt it. While a reasoning seat streamed, the clock never completed
 *    a period and the spinner, bar and input line repainted out of step — the
 *    flicker this pins.
 *
 * The probe runs in a real Ink tree because the fix depends on React's bail-out
 * for an unchanged state value and on real dependency comparison, neither of
 * which a hand-rolled fake reproduces.
 *
 * Run:  node tests/turn-input.test.mjs
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

/* ── 1. escape reaches a running turn ─────────────────────────────────────── */

/**
 * Press escape on the REAL component and see which callback fires.
 *
 * It has to be a real pty with real bytes. Ink reads keys through its own input
 * parser, which holds a lone ESC back for a moment to tell it apart from the
 * start of an escape SEQUENCE, and injecting a fake stdin skips that path
 * entirely — an emitted 'data' event never reaches useInput at all. So: `script`
 * for the pty, and stdin held open past the parser's flush, or the keypress is
 * still pending when the process exits and every count reads zero.
 *
 * @param busy  whether a turn is running while the key is pressed
 */
function pressEscape(busy) {
  const src = join(root, '.esc-probe.jsx')
  const bundle = join(root, '.esc-probe.mjs')
  writeFileSync(src, `
import React, { useState, useEffect } from 'react'
import { render } from 'ink'
import { PromptInput } from './src/ui/PromptInput.jsx'

let stopped = 0, interrupted = 0, submitted = 0
function Probe() {
  const [busy] = useState(${busy})
  useEffect(() => {
    setTimeout(() => {
      console.log('RESULT stop=' + stopped + ' int=' + interrupted + ' sub=' + submitted)
      process.exit(0)
    }, 900)
  }, [])
  return React.createElement(PromptInput, {
    busy,
    onStop: () => { stopped++ },
    onInterrupt: () => { interrupted++ },
    onSubmit: () => { submitted++ },
    onCycleMode: () => {},
    history: [],
    commands: [],
  })
}
render(React.createElement(Probe))
`)
  // Node cannot import .jsx, so the probe is bundled the way the build
  // transforms components — otherwise this tests a copy, not what ships.
  const built = spawnSync(join(root, 'node_modules/.bin/esbuild'),
    [src, '--bundle', '--format=esm', '--platform=node', '--jsx=automatic',
     '--packages=external', `--outfile=${bundle}`],
    { encoding: 'utf8', timeout: 60_000, cwd: root })

  const run = built.status === 0
    ? spawnSync('sh', ['-c',
        `(printf '\\033'; sleep 1.2) | script -qec "node ${bundle}" /dev/null`],
        { encoding: 'utf8', timeout: 30_000, cwd: root })
    : { stdout: '' }
  for (const f of [src, bundle]) { try { unlinkSync(f) } catch { /* already gone */ } }

  const m = /RESULT stop=(\d+) int=(\d+) sub=(\d+)/.exec(run.stdout || '')
  return m
    ? { stopped: +m[1], interrupted: +m[2], submitted: +m[3], raw: run.stdout }
    : { raw: (built.stderr || '') + (run.stdout || '') }
}

const during = pressEscape(true)
ok('the escape probe ran during a turn', during.stopped !== undefined, (during.raw || '').slice(-200))
if (during.stopped !== undefined) {
  ok('escape during a turn stops it', during.stopped === 1,
     `${during.stopped} stop(s) — the busy guard swallowed the key again`)
  ok('escape during a turn never takes the quit path', during.interrupted === 0,
     'escape reached interrupt(), which exits when nothing is running')
}

const idle = pressEscape(false)
ok('the escape probe ran at an idle prompt', idle.stopped !== undefined, (idle.raw || '').slice(-200))
if (idle.stopped !== undefined) {
  ok('escape at an idle prompt stops nothing', idle.stopped === 0, `${idle.stopped} stop(s)`)
  ok('escape at an idle prompt never quits', idle.interrupted === 0,
     'escape must not inherit ctrl-c’s exit behaviour')
  ok('escape at an idle prompt submits nothing', idle.submitted === 0)
}

/* ── 2. the animation tick does not re-arm on its own output ──────────────── */

const tickProbe = join(root, '.tick-probe.mjs')
writeFileSync(tickProbe, `
import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text } from 'ink'

let armings = 0
function Probe() {
  const [busy] = useState(true)
  const [stream, setStream] = useState('')
  const buf = useRef('')

  // Chunks arrive between ticks, exactly as a streaming seat delivers them.
  useEffect(() => {
    let n = 0
    const feed = setInterval(() => { buf.current += 'x'.repeat(++n) }, 20)
    setTimeout(() => clearInterval(feed), 300)
  }, [])

  useEffect(() => {
    armings++
    const t = setInterval(() => { setStream(buf.current) }, 80)
    return () => clearInterval(t)
  }, [busy])                       // <- the fix: NOT [busy, stream]

  useEffect(() => {
    setTimeout(() => {
      console.log('RESULT armings=' + armings + ' len=' + buf.current.length)
      process.exit(0)
    }, 400)
  }, [])
  return React.createElement(Box, null, React.createElement(Text, null, stream.slice(-1) || '.'))
}
render(React.createElement(Probe))
`)

const t = spawnSync('script', ['-qec', `node ${tickProbe}`, '/dev/null'],
  { encoding: 'utf8', timeout: 20_000, cwd: root })
try { unlinkSync(tickProbe) } catch { /* already gone */ }

const tm = /RESULT armings=(\d+) len=(\d+)/.exec(t.stdout || '')
ok('the tick probe ran', !!tm, (t.stdout || '').slice(-160))
if (tm) {
  const [, armings, len] = tm.map(Number)
  ok('chunks actually streamed during the probe', len > 0, 'nothing arrived, so nothing was proven')
  ok('the interval is armed ONCE for the whole turn', armings === 1,
     `${armings} armings — a dep the interval itself sets rebuilds the clock every chunk`)
}

/* ── the components use them ──────────────────────────────────────────────── */

const app = readFileSync(join(root, 'src/ui/App.jsx'), 'utf8')
const input = readFileSync(join(root, 'src/ui/PromptInput.jsx'), 'utf8')

ok('the tick effect depends on busy alone',
   /setElapsed\(\(Date\.now\(\)[\s\S]{0,320}?\}, \[busy\]\)/.test(app),
   'stream/thinking are back in the dep array — the flicker returns with them')
ok('escape is handled before the busy guard',
   input.indexOf('key.escape') < input.indexOf('if (busy) return'),
   'the guard runs first again, so escape cannot reach a running turn')
ok('escape while busy calls the stop path', /if \(busy\) \{ onStop\(\); return \}/.test(input))
ok('stop only aborts, never exits',
   /const stop = useCallback\(\(\) => \{ abortRef\.current\?\.abort\(\) \}, \[\]\)/.test(app),
   'if stop gained an exit() it would quit the session on escape')
ok('the abort controller is armed before the busy state is painted',
   app.indexOf('abortRef.current = new AbortController()') < app.indexOf('setBusy(true)'),
   'escape pressed during the pre-turn hooks finds no controller and falls through to quit')

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
