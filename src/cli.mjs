#!/usr/bin/env node
/**
 * serge-engine CLI.
 *
 * M1 supports the headless path (`-p`) end to end. Interactive TUI is not built
 * yet and says so rather than pretending — see README milestones.
 */
import { runSession } from './loop.mjs'
import { providerConfig, loadSettings, configDir } from './config.mjs'
import { MODES } from './permissions.mjs'
import { loadSeats, checkSeat, renderSeats } from './seats.mjs'

export const VERSION = '0.1.0'

export async function main(argv = process.argv.slice(2)) {
  const has = (...f) => f.some((x) => argv.includes(x))
  const val = (f, d = null) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1] }

  if (has('--version', '-v')) { console.log(`${VERSION} (serge-engine)`); return 0 }
  if (has('--help', '-h')) { console.log(HELP); return 0 }

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
  if (printIdx === -1) {
    process.stderr.write(
      'serge-engine 0.1.0 — headless only so far.\n'
      + '  Use:  serge -p "your prompt"\n'
      + '  The interactive session (M3) is not built yet.\n')
    return 64
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

  try {
    const res = await runSession({
      prompt,
      cwd: process.cwd(),
      model: val('--model'),
      permissionMode: mode,
      onToken: (t) => process.stdout.write(t),
      onNotice: (m) => process.stderr.write(`serge-engine: ${m}\n`),
    })
    process.stdout.write('\n')
    return res.blocked ? 1 : 0
  } catch (e) {
    process.stderr.write(`serge-engine: ${e?.message ?? e}\n`)
    return 1
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

const HELP = `serge-engine ${VERSION} — an MIT agent engine for serge-public

  serge -p "prompt"        run one headless turn
  serge --doctor           show config/router status
  serge --version

  --model <seat>           override OPENAI_MODEL for this run
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
