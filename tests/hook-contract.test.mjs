#!/usr/bin/env node
/**
 * Every hook verdict is either used or explicitly waived.
 *
 * This bug class has now appeared FOUR times in this engine: PostToolUse
 * verdicts discarded (so arch-gate reported a finding and the turn shipped
 * anyway), SessionStart context discarded (25KB of memory per session),
 * SubagentStop discarded (a gate that can block), TaskCompleted discarded
 * (the evidence gate). Each time the hook ran, reported success, and its
 * answer went nowhere — invisible from the outside, because nothing errors.
 *
 * So this is a STATIC check over the source, not a behavioural one: it fails
 * when a `runHooks(...)` call neither binds its result nor names itself in
 * FIRE_AND_FORGET below. Adding a hook call now forces a decision about its
 * verdict rather than letting silence be the default.
 *
 * Run:  node tests/hook-contract.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Events whose result is deliberately ignored, each with the reason. A hook on
 * one of these cannot block and cannot inject — if the brain ever wires one
 * that tries, this list is the thing to revisit.
 */
const FIRE_AND_FORGET = {
  Notification: 'a desktop/desk notification has no verdict to give',
  StopFailure: 'reports that Stop itself threw; there is nothing left to gate',
  PreCompact: 'fires BEFORE the summary exists — its context would be dropped by the very compaction it announces; PostCompact is where survival context goes back',
  PostToolUseFailure: 'the call already failed and the model already sees the error',
}

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? '\n        ' + d : ''}`) }
}

const files = ['src/loop.mjs', 'src/hooks.mjs', 'src/repl.mjs', 'src/ink-repl.mjs', 'src/cli.mjs']
const sites = []
for (const rel of files) {
  let text
  try { text = readFileSync(join(root, rel), 'utf8') } catch { continue }
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!/runHooks\(/.test(line)) return
    // An event name can be computed — `runHooks(err ? 'PostToolUseFailure' :
    // 'PostToolUse', …)` — so take every quoted name on the line. Matching only
    // a literal first argument silently skipped the single most important gate
    // in the engine and reported it as "never fired".
    const names = [...line.matchAll(/'([A-Z][A-Za-z]+)'/g)].map((x) => x[1])
    if (!names.length) return
    // Bound when this line assigns it, or a nearby line does (`stop =` after a
    // `let stop` declaration, which is a real and correct pattern).
    const bound = /(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?runHooks/.test(line)
      || /^\s*\w+\s*=\s*(?:await\s+)?runHooks/.test(line)
      || /=\s*runHooks/.test(line)
    for (const event of names) sites.push({ event, file: rel, line: i + 1, bound })
  })
}

ok('hook call sites were found at all', sites.length >= 10, `found ${sites.length}`)

const unhandled = sites.filter((s) => !s.bound && !(s.event in FIRE_AND_FORGET))
ok('every hook verdict is used or waived', unhandled.length === 0,
   unhandled.map((u) => `${u.event} discarded at ${u.file}:${u.line}`).join('\n        '))

// The waiver list must stay honest: waiving an event nothing fires is dead
// config that hides the next real gap.
const fired = new Set(sites.map((s) => s.event))
const stale = Object.keys(FIRE_AND_FORGET).filter((e) => !fired.has(e))
ok('no stale waivers', stale.length === 0, `waived but never fired: ${stale.join(', ')}`)

// The gates that can block must be BOUND, named explicitly so a future edit
// that "simplifies" one back to a bare call fails here.
for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'TaskCompleted',
                  'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PostCompact']) {
  const s = sites.filter((x) => x.event === ev)
  ok(`${ev} is fired and its result bound`, s.length > 0 && s.every((x) => x.bound),
     s.length ? s.filter((x) => !x.bound).map((x) => `${x.file}:${x.line}`).join(' ') : 'never fired')
}

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
