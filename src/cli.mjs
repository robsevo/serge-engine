#!/usr/bin/env node
/**
 * serge-engine CLI.
 *
 * M1 supports the headless path (`-p`) end to end. Interactive TUI is not built
 * yet and says so rather than pretending — see README milestones.
 */
import { runSession } from './loop.mjs'
import { providerConfig, loadSettings, configDir, cliName, VERSION } from './config.mjs'
import { MODES } from './permissions.mjs'
import { loadSeats, checkSeat, renderSeats } from './seats.mjs'
import { listSessions, findSession, renderSessions } from './sessions.mjs'
import { startMcp } from './mcp.mjs'
import { reapAll } from './background.mjs'

export async function main(argv = process.argv.slice(2)) {
  const has = (...f) => f.some((x) => argv.includes(x))
  const val = (f, d = null) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1] }

  if (has('--version', '-v')) { console.log(`${VERSION} (serge-engine)`); return 0 }
  if (has('--help', '-h')) { console.log(HELP); return 0 }

  if (has('--sessions')) {
    console.log(renderSessions(listSessions(process.cwd())))
    return 0
  }

  if (has('--seats')) {
    console.log(renderSeats())
    return 0
  }

  if (has('--doctor')) {
    const p = providerConfig(loadSettings())
    const seats = loadSeats()
    const verdict = checkSeat(p.model, seats)
    console.log(`config dir : ${configDir()}`)
    console.log(`router     : ${p.baseUrl}`)
    console.log(`model      : ${p.model}${verdict.ok ? (seats ? ' ✓' : '') : '  ✗ NOT IN ROSTER'}`)
    console.log(`seats      : ${seats ? `${seats.size} configured (--seats to list)` : 'no litellm.yaml found'}`)
    try {
      // A doctor that hangs is worse than one that reports a failure.
      const r = await fetch(`${p.baseUrl}/models`, {
        headers: { authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      console.log(`reachable  : ${r.ok ? 'yes' : `no (HTTP ${r.status})`}`)
      return r.ok ? 0 : 1
    } catch (e) {
      console.log(`reachable  : no (${e.message})`)
      return 1
    }
  }

  const printIdx = argv.findIndex((a) => a === '-p' || a === '--print')

  // --continue resumes the newest session here; --resume takes an id or prefix,
  // and with no argument means the newest as well. An unmatched ref is an error
  // rather than a silent new session: "it forgot everything" is the worst way
  // to discover a typo.
  let resumeFrom = null
  let resumeInfo = null
  let forkParent = null
  const forking = has('--fork')
  if (has('--continue', '-c') || has('--resume', '-r') || forking) {
    const ref = val('--resume') || val('-r') || val('--fork')
    const hit = findSession(process.cwd(), ref && !ref.startsWith('-') ? ref : null)
    if (!hit) {
      process.stderr.write(ref
        ? `serge-engine: no session matching "${ref}" in this directory.\n  ${cliName()} --sessions to list them.\n`
        : 'serge-engine: no previous session in this directory.\n')
      return 64
    }
    resumeFrom = hit.path
    resumeInfo = hit
    // A fork continues the conversation in a NEW transcript that points back at
    // the original, so the original is never appended to and can be forked again.
    if (forking) forkParent = hit.id
  }

  // No -p means an interactive session. Refuse only when there is no terminal
  // to read from: a piped stdin with no -p is almost always a mistake, and
  // opening a REPL on it would hang with no prompt visible.
  if (printIdx === -1) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'serge-engine: no terminal, and no -p.\n'
        + '  Interactive needs a TTY. For a scripted run:  serge -p "your prompt"\n')
      return 64
    }
    const mode0 = has('--yolo', '--auto') ? 'fullAccess' : (val('--permission-mode') || 'default')
    if (!MODES.includes(mode0)) {
      process.stderr.write(`serge-engine: unknown permission mode "${mode0}"\n`)
      return 64
    }
    const seat0 = val('--model') || providerConfig(loadSettings()).model
    const chk = checkSeat(seat0)
    if (!chk.ok) { process.stderr.write(`serge-engine: ${chk.reason}\n`); return 64 }
    const mcp = await startMcp({ onNotice: (m) => process.stderr.write(`serge-engine: ${m}\n`) })
    // SERGE_TUI=readline falls back to the dependency-free renderer; the Ink
    // one is default because it is what actually matches serge.
    const useInk = process.env.SERGE_TUI !== 'readline'
    const { repl } = useInk
      ? { repl: (await import('./ink-repl.mjs')).inkRepl }
      : await import('./repl.mjs')
    try {
      return await repl({
        cwd: process.cwd(), model: val('--model'), permissionMode: mode0,
        mcp, resumeFrom, resumeInfo, forkParent,
      })
    } finally {
      mcp.stop()
      reapAll()
    }
  }


  const prompt = argv[printIdx + 1] ?? (await readStdin())
  if (!prompt || !prompt.trim()) {
    process.stderr.write('serge-engine: -p needs a prompt (argument or stdin)\n')
    return 64
  }

  // --yolo / --auto are how serge's launcher spells fullAccess.
  const mode = has('--yolo', '--auto') ? 'fullAccess' : (val('--permission-mode') || 'default')
  if (!MODES.includes(mode)) {
    process.stderr.write(`serge-engine: unknown permission mode "${mode}" (expected: ${MODES.join(', ')})\n`)
    return 64
  }

  // Check the seat BEFORE the request. A typo otherwise surfaces as a router
  // error part-way through a turn, which reads like an outage rather than a
  // misspelling — the roster is right there, so say so in 40ms.
  const seatName = val('--model') || providerConfig(loadSettings()).model
  const seatCheck = checkSeat(seatName)
  if (!seatCheck.ok) {
    process.stderr.write(`serge-engine: ${seatCheck.reason}\n`)
    return 64
  }

  const mcp = await startMcp({ onNotice: (m) => process.stderr.write(`serge-engine: ${m}\n`) })
  try {
    const res = await runSession({
      prompt,
      cwd: process.cwd(),
      model: val('--model'),
      mcp,
      resumeFrom,
      forkParent,
      permissionMode: mode,
      onToken: (t) => process.stdout.write(t),
      onNotice: (m) => process.stderr.write(`serge-engine: ${m}\n`),
    })
    process.stdout.write('\n')
    return res.blocked ? 1 : 0
  } catch (e) {
    process.stderr.write(`serge-engine: ${e?.message ?? e}\n`)
    return 1
  } finally {
    mcp.stop()
    reapAll()
  }
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((r) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => r(s.trim()))
  })
}

// Padded rather than hand-spaced: the name is whatever the launcher was
// invoked as, so a wrapper called something longer than `serge` would walk the
// description column off by its own length difference on every line.
const use = (args, desc = '') =>
  `  ${(cliName() + (args ? ` ${args}` : '')).padEnd(25)}${desc}`.trimEnd()

const HELP = `serge-engine ${VERSION} — an MIT agent engine for serge-public

${use('', 'open an interactive session')}
${use('-p "prompt"', 'run one headless turn')}
${use('--doctor', 'show config/router status')}
${use('--version')}

  --model <seat>           override OPENAI_MODEL for this run
  --continue, -c           resume the most recent session in this directory
  --resume [id]            resume a session by id or prefix (newest if omitted)
  --fork [id]              branch from a session — continues it in a NEW
                           transcript, leaving the original untouched
  --sessions               list resumable sessions here
  --seats                  list the model seats this router has configured
  --permission-mode <m>    default | acceptEdits | plan | bypassPermissions | fullAccess
  --yolo, --auto           shorthand for --permission-mode fullAccess

Headless has no TTY, so anything that would prompt is DENIED with the rule that
would allow it. Add it to settings.permissions.allow, or use --yolo.
`

if (import.meta.url === `file://${process.argv[1]}`) {
  // Without the catch an unexpected throw escapes as an unhandled rejection:
  // node prints its own trace and exits 1, so the user sees a stack dump where
  // this file has a perfectly good error path.
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      process.stderr.write(`serge-engine: ${e?.stack ?? e}\n`)
      process.exit(1)
    })
}
