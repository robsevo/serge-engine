#!/usr/bin/env node
/**
 * run.mjs — the Serge engine conformance harness (M0).
 *
 * WHAT IT IS FOR
 *   serge-public ships a brain with no body: install.sh takes `--engine <path>`
 *   and the only thing that has ever satisfied it is a Claude Code derivative.
 *   Before writing an MIT engine to fill that slot, we need the slot's shape
 *   written down. This harness extracts it by OBSERVATION, not by reading source.
 *
 * HOW IT AVOIDS GRADING ITSELF
 *   It never asks the engine what it supports. It builds a throwaway SERGE_HOME,
 *   wires probe.mjs into all 13 hook slots, drives the real binary, and reports
 *   only what actually arrived on a hook's stdin. Two guards keep that honest:
 *
 *     1. Run it against a KNOWN-GOOD engine (serge-0.1.0) first. Whatever it
 *        reports there IS the contract, and a green run means something because
 *        it went green on a system that demonstrably works.
 *     2. `--self-test` builds a deliberately inert engine that satisfies the
 *        static layout checks and nothing else, then asserts this harness
 *        REJECTS it. A test suite that cannot fail is not a test suite.
 *
 * USAGE
 *   node tests/conformance/run.mjs --engine /path/to/engine [--out docs/ENGINE-CONTRACT.md]
 *   node tests/conformance/run.mjs --self-test
 *   flags: --keep (don't delete the run dir)  --timeout <sec>  --router <url>
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, statSync,
} from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENTS, LAYOUT, TOOLS, TRANSCRIPT, CONTROL, COMMON_FIELDS } from './spec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PROBE = join(HERE, 'probe.mjs')

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}
const has = (n) => argv.includes(n)

const SELF_TEST = has('--self-test')
const KEEP = has('--keep')
const TIMEOUT_MS = Number(arg('--timeout', '240')) * 1000
const ROUTER = arg('--router', 'http://localhost:4000/v1')
const OUT = arg('--out', null)

// ─── tiny reporting helpers ──────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' }

const findings = []          // {level, area, msg}
const ok = (area, msg) => { findings.push({ level: 'ok', area, msg }); console.log(`  ${C.g}ok${C.x}    ${msg}`) }
const bad = (area, msg) => { findings.push({ level: 'fail', area, msg }); console.log(`  ${C.r}FAIL${C.x}  ${msg}`) }
const warn = (area, msg) => { findings.push({ level: 'warn', area, msg }); console.log(`  ${C.y}warn${C.x}  ${msg}`) }
const info = (msg) => console.log(`  ${C.d}${msg}${C.x}`)
const head = (t) => console.log(`\n${C.b}${t}${C.x}`)

// ─── run dir ─────────────────────────────────────────────────────────────────
const RUNS = join(HERE, '.runs')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = join(RUNS, stamp)
const HOME_DIR = join(RUN, 'serge-home')
const WORK = join(RUN, 'workspace')
mkdirSync(HOME_DIR, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ─── the engine under test ───────────────────────────────────────────────────
let ENGINE = arg('--engine', null)
if (SELF_TEST) ENGINE = buildInertEngine(join(RUN, 'inert-engine'))
if (!ENGINE) {
  console.error('run.mjs: --engine <path> is required (or --self-test)')
  process.exit(64)
}
ENGINE = resolve(ENGINE)

console.log(`${C.b}Serge engine conformance — M0${C.x}`)
info(`engine:  ${ENGINE}`)
info(`run dir: ${RUN}`)
if (SELF_TEST) info('mode:    SELF-TEST (expecting this engine to be REJECTED)')

// ═════════════════════════════════════════════════════════════════════════════
// Tier 1 — static layout (install.sh:92-117)
// ═════════════════════════════════════════════════════════════════════════════
head('Tier 1 — engine layout (install.sh contract)')

let launcher = null
for (const cand of LAYOUT.launcherCandidates) {
  const p = join(ENGINE, cand)
  if (existsSync(p)) { launcher = p; break }
}
if (launcher) {
  ok('layout', `launcher found: ${launcher.replace(ENGINE + '/', '')}`)
  const first = readFileSync(launcher, 'utf8').split('\n')[0] || ''
  if (/^#!.*(bash|sh)\b/.test(first)) {
    ok('layout', 'launcher is a shell script — it can export router env before exec')
  } else {
    warn('layout', `launcher shebang is "${first.trim()}" — a bare node wrapper cannot set `
      + 'CLAUDE_CODE_USE_OPENAI / OPENAI_BASE_URL, so the engine will fall back to its built-in model')
  }
} else {
  bad('layout', `no launcher — install.sh:117 looks for ${LAYOUT.launcherCandidates.join(', ')}`)
}

const entry = join(ENGINE, LAYOUT.entrypoint)
if (existsSync(entry)) {
  const v = spawnSync('node', [entry, '--version'], { encoding: 'utf8', timeout: 60_000 })
  if (v.status === 0 && (v.stdout || '').trim()) {
    ok('layout', `${LAYOUT.entrypoint} --version → ${v.stdout.trim().split('\n')[0]}`)
  } else {
    bad('layout', `${LAYOUT.entrypoint} --version failed (install.sh:105 requires this)`)
  }
} else {
  bad('layout', `missing ${LAYOUT.entrypoint} (install.sh:105)`)
}

existsSync(join(ENGINE, LAYOUT.manifest))
  ? ok('layout', 'package.json present')
  : warn('layout', 'no package.json — install.sh skips dependency install')

// ═════════════════════════════════════════════════════════════════════════════
// Router preflight — the engine needs an OpenAI-compatible endpoint.
// ═════════════════════════════════════════════════════════════════════════════
head('Tier 2 — router preflight')
const rc = spawnSync('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `${ROUTER}/models`], { encoding: 'utf8' })
if ((rc.stdout || '').trim() === '200') {
  ok('router', `OpenAI-compatible router reachable at ${ROUTER}`)
} else {
  warn('router', `router not reachable at ${ROUTER} — live scenarios will be skipped. `
    + 'Start it: systemctl --user start serge-router')
}
const ROUTER_UP = (rc.stdout || '').trim() === '200'

// ═════════════════════════════════════════════════════════════════════════════
// Live scenarios
// ═════════════════════════════════════════════════════════════════════════════
const observed = new Map()   // event -> [records]

if (ROUTER_UP && launcher) {
  head('Tier 3 — lifecycle events')
  const s1 = scenario('lifecycle', 'record',
    'Reply with exactly the word PONG and nothing else. Do not use any tools.')
  gradeEvents(['SessionStart', 'UserPromptSubmit', 'Stop'], s1.recs)

  head('Tier 4 — tool events')
  const sentinel = join(WORK, 'tool-ran.txt')
  const s2 = scenario('tools', 'record',
    `Use the Bash tool to run exactly this command: touch ${sentinel}\nThen reply DONE.`)
  gradeEvents(['PreToolUse', 'PostToolUse'], s2.recs)
  existsSync(sentinel)
    ? ok('tools', 'Bash tool actually executed (sentinel file created)')
    : bad('tools', 'Bash tool never ran — cannot validate tool events against real execution')

  head('Tier 5 — transcript shape')
  gradeTranscript(s2.transcript)

  head('Tier 6 — hook control protocol (deny)')
  const denied = join(WORK, 'should-not-exist.txt')
  const s3 = scenario('block', 'block',
    `Use the Bash tool to run exactly this command: touch ${denied}\nThen reply DONE.`)
  // An absent sentinel only proves the deny worked if the engine actually
  // REACHED the hook. Without this guard an engine that does nothing at all
  // scores a pass here — the same trivially-true check this harness exists to
  // stamp out.
  gradeDeny(s3, 'block', denied, 'exit 2')

  const deniedJson = join(WORK, 'should-not-exist-json.txt')
  const s4 = scenario('blockjson', 'blockjson',
    `Use the Bash tool to run exactly this command: touch ${deniedJson}\nThen reply DONE.`)
  gradeDeny(s4, 'blockjson', deniedJson, 'hookSpecificOutput permissionDecision=deny',
    'the four real PreToolUse gates (path-reality, vague-delete, constitution-edit, '
    + 'tool-dedupe) deny ONLY this way, so all four would be silently bypassed')

  // PostToolUse blocking. The tool has already run, so there is no side effect to
  // check — the ONLY observable is whether the engine surfaced the block to the
  // model. An engine that fires the hook and discards its verdict looks fully
  // gated while algo-gate, semgrep-scan and arch-gate are all silently disarmed.
  // Observed on this engine 2026-08-22: arch-gate flagged a swallowed error and
  // the turn reported "built, tested, and confirmed".
  const s5 = scenario('blockpost', 'blockpost',
    'Use the Bash tool to run exactly this command: echo post-hook-probe\nThen reply DONE.')
  const armedPost = s5.recs.some((r) => r.event === 'PostToolUse' && r.mode === 'block')
  if (!armedPost) {
    warn('control', 'PostToolUse deny not exercised — the hook never fired')
  } else if (/blocked|denied|conformance/i.test(s5.finalText || '')) {
    ok('control', 'PostToolUse deny (exit 2) was surfaced to the model')
  } else {
    bad('control', 'PostToolUse hook exited 2 but the engine carried on as if it had not — '
      + 'every blocking post-hook (algo-gate, semgrep-scan, arch-gate) is disarmed')
  }
} else {
  warn('scenarios', 'live scenarios skipped — need both a launcher and a reachable router')
}

// ═════════════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════════════
head('Result')
const fails = findings.filter((f) => f.level === 'fail')
const warns = findings.filter((f) => f.level === 'warn')
console.log(`  ${findings.filter((f) => f.level === 'ok').length} ok, ${fails.length} fail, ${warns.length} warn`)

if (OUT) { writeContract(resolve(REPO, OUT)); info(`contract written: ${OUT}`) }

if (!KEEP && !fails.length) rmSync(RUN, { recursive: true, force: true })
else info(`run dir kept: ${RUN}`)

// Self-test inverts the meaning of the exit code: the inert engine MUST fail.
if (SELF_TEST) {
  if (fails.length) {
    console.log(`\n  ${C.g}SELF-TEST PASSED${C.x} — harness correctly rejected an inert engine (${fails.length} failure(s)).`)
    process.exit(0)
  }
  console.log(`\n  ${C.r}SELF-TEST FAILED${C.x} — an engine that does nothing was accepted.`)
  console.log('  The harness cannot detect a non-conforming engine, so no result it produces means anything.')
  process.exit(1)
}
process.exit(fails.length ? 1 : 0)

// ═════════════════════════════════════════════════════════════════════════════
// helpers
// ═════════════════════════════════════════════════════════════════════════════


/**
 * Grade a deny scenario on TWO independent signals:
 *   - no PostToolUse fired  → the gated call itself never completed (direct)
 *   - the sentinel is absent → nothing else did the work either (side effect)
 * Either alone is unsound. PostToolUse alone misses an engine that runs the tool
 * and skips the event; the sentinel alone is defeated by the model reaching for
 * a different tool, which is exactly what happened before this was fixed.
 */
function gradeDeny(s, mode, sentinel, label, consequence = '') {
  const armed = s.recs.some((r) => r.event === 'PreToolUse' && r.mode === mode)
  if (!armed) {
    warn('control', `${label}: not exercised — PreToolUse never fired, so nothing is proved`)
    return
  }
  const completed = s.recs.filter((r) => r.event === 'PostToolUse')
  const tail = consequence ? ` — ${consequence}` : ''
  if (completed.length) {
    bad('control', `${label} was ignored: ${completed.length} tool call(s) completed anyway `
      + `(${completed.map((r) => r.payload?.tool_name).join(', ')})${tail}`)
  } else if (existsSync(sentinel)) {
    bad('control', `${label}: no tool reported completing, but the sentinel exists — `
      + `something ran without firing PostToolUse${tail}`)
  } else {
    ok('control', `${label} blocked every tool call (no PostToolUse, no side effect)`)
  }
}

/** Write a fresh SERGE_HOME whose every hook slot is the probe. */
function writeHome(logPath, mode) {
  const hooks = {}
  for (const ev of EVENTS) {
    // The deny scenario arms only Bash on PreToolUse; everything else records.
    const armEvent = mode === 'blockpost' ? 'PostToolUse' : 'PreToolUse'
    const arming = (mode === 'block' || mode === 'blockjson' || mode === 'blockpost')
      && ev.name === armEvent
    const m = arming ? (mode === 'blockpost' ? 'block' : mode) : 'record'
    // Arm on EVERY tool. Denying only Bash proves nothing once the engine has
    // Write and Glob: a model refused one tool simply reaches for another, and
    // the sentinel appears anyway. Observed 2026-08-22 — Bash was correctly
    // denied and the file was created by Write two calls later.
    const matcher = arming ? '*' : (ev.matcher || '*')
    hooks[ev.name] = [{
      matcher,
      hooks: [{
        type: 'command',
        command: `node ${PROBE} ${ev.name} ${logPath} ${m}`,
        timeout: 15,
      }],
    }]
  }
  writeFileSync(join(HOME_DIR, 'settings.json'), JSON.stringify({
    permissions: { allowBypassPermissionsMode: true },
    skipDangerousModePermissionPrompt: true,
    skipFullAccessModePermissionPrompt: true,
    includeCoAuthoredBy: false,
    hooks,
  }, null, 2))
  // A minimal CLAUDE.md keeps the engine from hunting for project config.
  writeFileSync(join(HOME_DIR, 'CLAUDE.md'), '# conformance run\n')
}

/** Drive the real engine once and return the probe records for that run. */
function scenario(name, mode, prompt) {
  const logPath = join(RUN, `probe-${name}.jsonl`)
  writeFileSync(logPath, '')
  writeHome(logPath, mode)

  const r = spawnSync(launcher, ['--yolo', '-p', prompt], {
    cwd: WORK,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: { ...process.env, SERGE_HOME: HOME_DIR, CLAUDE_CONFIG_DIR: HOME_DIR },
  })

  if (r.error && r.error.code === 'ETIMEDOUT') {
    bad('scenario', `[${name}] engine did not finish within ${TIMEOUT_MS / 1000}s`)
  } else if (r.status !== 0 && mode !== 'block') {
    warn('scenario', `[${name}] engine exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`)
  }

  const recs = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    : []

  let transcript = null
  for (const rec of recs) {
    if (!observed.has(rec.event)) observed.set(rec.event, [])
    observed.get(rec.event).push(rec)
    // Per-scenario. Grading the lifecycle transcript for tool_use blocks
    // reports "no tools" on an engine that ran tools perfectly well — it just
    // ran them in a different scenario.
    if (!transcript && rec.payload?.transcript_path) transcript = rec.payload.transcript_path
  }
  info(`[${name}] ${recs.length} hook invocation(s) observed`)
  return { recs, transcript, finalText: `${r.stdout || ''}\n${r.stderr || ''}` }
}

/** Grade the named events against the spec's required fields. */
function gradeEvents(names, recs) {
  for (const name of names) {
    const spec = EVENTS.find((e) => e.name === name)
    const hits = recs.filter((r) => r.event === name)
    if (!hits.length) {
      const say = spec.tier === 'core' ? bad : warn
      say('events', `${name} never fired (${spec.tier})`)
      continue
    }
    const rec = hits[0]
    if (rec.parseError) { bad('events', `${name} fired but stdin was not valid JSON (${rec.parseError})`); continue }
    if (rec.stallReason) { bad('events', `${name} fired but ${rec.stallReason}`); continue }

    const keys = new Set(rec.keys)
    const missing = spec.fields.filter((f) => !keys.has(f))
    // hook_event_name must not merely exist — it must name the right event.
    const named = rec.payload?.hook_event_name
    if (named && named !== name) {
      warn('events', `${name}: hook_event_name reports "${named}"`)
    }
    if (!missing.length) {
      ok('events', `${name} ×${hits.length} — all fields present (${spec.fields.join(', ')})`)
    } else {
      const core = missing.filter((f) => COMMON_FIELDS.includes(f))
      const say = (spec.tier === 'core' && core.length) ? bad : warn
      say('events', `${name} ×${hits.length} — missing: ${missing.join(', ')}`)
    }
  }
}

/** Validate the JSONL transcript the hooks are expected to re-read. */
function gradeTranscript(transcriptPath) {
  if (!transcriptPath) { bad('transcript', 'no hook payload carried transcript_path'); return }
  if (!existsSync(transcriptPath)) { bad('transcript', `transcript_path does not exist: ${transcriptPath}`); return }

  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  let parsed = 0, toolUse = 0, toolResult = 0, linked = 0, realUser = 0
  const ids = new Set()
  for (const l of lines) {
    let e
    try { e = JSON.parse(l) } catch { continue }
    parsed++
    const c = e?.message?.content
    if (e.type === 'user' && (typeof c === 'string'
      || (Array.isArray(c) && c.some((b) => b?.type === 'text')))) realUser++
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool_use') { toolUse++; if (b.id) ids.add(b.id) }
      if (b?.type === 'tool_result') { toolResult++; if (ids.has(b.tool_use_id)) linked++ }
    }
  }

  parsed === lines.length && parsed > 0
    ? ok('transcript', `valid JSONL — ${parsed} entries`)
    : bad('transcript', `${lines.length - parsed} of ${lines.length} lines are not JSON`)
  realUser > 0
    ? ok('transcript', `${realUser} real user prompt(s) distinguishable from tool results`)
    : warn('transcript', 'no user entry with text content — hooks cannot find a turn boundary')
  toolUse > 0
    ? ok('transcript', `${toolUse} tool_use block(s) recorded`)
    : bad('transcript', 'no tool_use blocks — gates cannot see what the turn ran')
  linked > 0
    ? ok('transcript', `${linked} tool_result(s) linked by tool_use_id`)
    : bad('transcript', 'no tool_result linked to a tool_use id')
}

/** An engine that passes the layout checks and does nothing else. */
function buildInertEngine(dir) {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'cli.mjs'),
    'if (process.argv.includes("--version")) { console.log("0.0.0-inert"); process.exit(0) }\nprocess.exit(0)\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"inert","version":"0.0.0"}\n')
  const l = join(dir, 'serge')
  writeFileSync(l, '#!/usr/bin/env bash\n# fires no hooks, writes no transcript\nexit 0\n')
  spawnSync('chmod', ['+x', l])
  return dir
}

/** Emit the observed contract as markdown — the real M0 deliverable. */
function writeContract(path) {
  const L = []
  L.push('# Serge engine contract', '')
  L.push('> Generated by `tests/conformance/run.mjs`. Every line below was observed by')
  L.push('> driving a real engine and recording what arrived on a hook\'s stdin —')
  L.push('> nothing here is read off source or assumed.', '')
  // Record WHICH engine, not WHERE it lives: the absolute path leaks the
  // author's home directory into a committed file, and the reference engine's
  // name is not ours to publish.
  L.push(`- engine under test: \`${basename(ENGINE)}\``)
  L.push(`- generated: ${new Date().toISOString()}`, '')

  L.push('## Layout (install.sh:92-117)', '')
  L.push('| requirement | value |', '|---|---|')
  L.push(`| launcher (first match wins) | \`${LAYOUT.launcherCandidates.join('`, `')}\` |`)
  L.push(`| entrypoint | \`${LAYOUT.entrypoint}\` — \`node ${LAYOUT.entrypoint} --version\` must answer |`)
  L.push(`| manifest | \`${LAYOUT.manifest}\` |`, '')

  L.push('## Hook events', '')
  L.push('| event | tier | observed | payload keys seen |', '|---|---|---|---|')
  for (const ev of EVENTS) {
    const hits = observed.get(ev.name) || []
    const seen = hits.length ? `${hits.length}×` : (ev.tier === 'core' ? '**no**' : 'not exercised')
    const keys = hits.length ? '`' + (hits[0].keys || []).join('`, `') + '`' : '—'
    L.push(`| \`${ev.name}\` | ${ev.tier} | ${seen} | ${keys} |`)
  }
  L.push('')
  L.push('### Notes', '')
  for (const ev of EVENTS) if (ev.note) L.push(`- **${ev.name}** — ${ev.note}`)
  L.push('')

  L.push('## Tools the brain names in matchers', '')
  L.push(`- core: \`${TOOLS.core.join('`, `')}\``)
  L.push(`- extended: \`${TOOLS.extended.join('`, `')}\``, '')

  L.push('## Transcript', '')
  L.push(`Format: ${TRANSCRIPT.format}`, '')
  L.push('| block | required keys |', '|---|---|')
  for (const [k, v] of Object.entries(TRANSCRIPT.contentBlocks)) {
    L.push(`| \`${k}\` | \`${v.join('`, `')}\` |`)
  }
  L.push('')
  for (const r of TRANSCRIPT.rules) L.push(`- ${r}`)
  L.push('')

  L.push('## Hook control protocol', '')
  L.push(`- block via exit code 2 — ${CONTROL.block.exitCode2}`)
  L.push(`- block via JSON — \`${CONTROL.block.json}\``)
  L.push(`- pass — ${CONTROL.pass}`)
  L.push(`- ${CONTROL.note}`, '')

  L.push('## This run', '')
  for (const f of findings) L.push(`- ${f.level === 'ok' ? '✅' : f.level === 'fail' ? '❌' : '⚠️'} ${f.msg}`)
  L.push('')

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, L.join('\n'))
}
