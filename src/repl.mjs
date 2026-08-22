/**
 * The interactive session.
 *
 * A conversation that keeps going: history persists across prompts, the same
 * hooks fire on every turn, and the loop only ends when you end it.
 *
 * Built on `readline`, which handles the things that actually matter in a REPL:
 * line editing, history, tab completion, and correct terminal signal handling.
 * The pinned status pane is in pane.mjs.
 *
 * THE THREE INTERRUPTS, and why they differ:
 *   Ctrl+C while generating  aborts THIS turn, keeps the session. The reply so
 *                            far is kept in history, because the model said it
 *                            and pretending otherwise makes the next turn
 *                            incoherent.
 *   Ctrl+C at an empty prompt  first press warns, second exits. A single
 *                            keystroke should not discard a long conversation.
 *   Ctrl+D                   exits immediately — that is what EOF means.
 */
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { createSession } from './loop.mjs'
import { providerConfig, loadSettings, configDir, VERSION } from './config.mjs'
import { loadSeats, checkSeat, renderSeats } from './seats.mjs'
import { MODES } from './permissions.mjs'
import { loadCommands, expandCommand } from './brain.mjs'
import { createSpinner } from './spinner.mjs'
import { renderStatusLine } from './statusline.mjs'
import { renderStartup, renderHeader } from './startup.mjs'
import { clawd, MOTION } from './clawd.mjs'
import { MODES as ALL_MODES } from './permissions.mjs'
import { createPane, fit, visible } from './pane.mjs'

const C = stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m',
      c: '\x1b[36m', x: '\x1b[0m' }
  : { dim: '', b: '', g: '', y: '', r: '', c: '', x: '' }

/** 1234 -> 1.2k. Token counts are read at a glance, not audited. */
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const HELP = `
  ${C.b}Commands${C.x}
    /help              this
    /seats             model seats the router has configured
    /skills            skills the model can load on demand
    /agents            named subagents Task can spawn, and their seats
    /mcp               MCP servers and their tool counts
    /model [seat]      show or switch the seat for this session
    /mode [name]       show or switch permission mode
                       (${MODES.join(' · ')})
    /clear             forget the conversation, keep the session
    /cost              turns so far, and where the transcript is
    /exit              leave

  ${C.b}Keys${C.x}
    Ctrl+C             while generating: stop this turn
                       at an empty prompt: press twice to exit
    Ctrl+D             exit
`

export async function repl({ cwd, model, permissionMode, mcp = null, resumeFrom = null, resumeInfo = null, forkParent = null }) {
  const settings = loadSettings()
  const seats = loadSeats()
  // The brain authors its own slash commands as markdown; the engine finds and
  // expands them rather than defining them.
  const commands = loadCommands()

  const spinner = createSpinner({ settings })
  // Two reserved rows at the bottom: a rule, and a live status line. Output
  // scrolls above them and scrollback is untouched — see pane.mjs.
  // Four rows: a rule, then Clawd on the left with the status stacked beside
  // him. He lives in the PANE rather than the header because the pane repaints —
  // scrollback does not, and a mascot that only moves if you scroll to him is
  // not moving.
  const pane = createPane({ rows: 4 })
  let tickCount = 0
  // The status line spawns a process, so it is refreshed per TURN, not per
  // animation frame — a 100ms spinner tick would fork ten times a second.
  let statusCache = ''
  let streaming = false
  let paneTimer = null
  // Set while a permission prompt owns the terminal, so the pane's repaint timer
  // does not overwrite the question between asking and the keypress.
  let prompting = false

  const MODE_LABEL = {
    default: 'ask before edits',
    acceptEdits: 'accept edits on',
    plan: 'plan mode — no changes',
    bypassPermissions: 'bypass permissions',
    fullAccess: 'full access — no prompts',
  }

  const paintPane = (spinning = false) => {
    if (!pane.enabled || prompting) return
    const cols = stdout.columns || 80
    const u = session.usage
    const tok = u.prompt + u.completion

    // He looks around and blinks while a turn is in flight, and rests between
    // them. The feet shuffle on a slower cycle than the gaze so the two are not
    // in lockstep, which reads as mechanical rather than alive.
    const art = spinning
      ? clawd({
          pose: MOTION[Math.floor(tickCount / 6) % MOTION.length],
          feetFrame: Math.floor(tickCount / 3),
          color: Boolean(stdout.isTTY),
        })
      : clawd({ color: Boolean(stdout.isTTY) })

    const top = spinning
      ? `${C.y}${spinner.frame()}${C.x}`
      : `${C.g}●${C.x} ${C.dim}ready${C.x}`
    const status = statusCache || `${C.dim}${session.model}  ${session.turns} turn(s)${C.x}`
    const mode = session.mode
    const marker = mode === 'plan' ? `${C.y}⏸${C.x}` : `${C.c}▶▶${C.x}`
    const modeRow = `${marker} ${C.dim}${MODE_LABEL[mode] ?? mode} (shift+tab to cycle)${C.x}`
    const meter = `${C.dim}${tok ? `${fmt(tok)} tok` : ''}${C.x}`

    // Clawd is 8 columns wide at his widest row; pad the narrow rows so the
    // text column starts at the same place on all three.
    const CW = 8
    const beside = (i, text) => {
      const a = art[i] ?? ''
      const padding = ' '.repeat(Math.max(0, CW - visible(a)))
      return ` ${a}${padding}  ${text}`
    }
    const gap = Math.max(1, cols - visible(beside(0, top)) - visible(meter) - 1)

    pane.set([
      `${C.dim}${'─'.repeat(Math.max(0, cols))}${C.x}`,
      beside(0, top) + ' '.repeat(gap) + meter,
      beside(1, status),
      beside(2, modeRow),
    ])
  }

  // The spinner owns the screen until the first token, then gets out of the way.
  // Notices and tool lines have to clear it too, or they print into its row.
  // With a pane the spinner never touches the screen, so notices and tool lines
  // just print — the pane repaints itself on its own timer.
  const say = (line) => {
    if (!pane.enabled && spinner.active) { spinner.stop(); stdout.write(line); spinner.start(); return }
    stdout.write(line)
  }

  const session = createSession({
    cwd,
    model,
    permissionMode: permissionMode || 'default',
    mcp,
    resumeFrom,
    forkParent,
    onToken: (t) => {
      if (!streaming) { spinner.stop(); streaming = true }
      stdout.write(t)
    },
    onNotice: (m) => say(`  ${C.dim}└${C.x} ${C.dim}${m}${C.x}\n`),
    onTool: (name, input) => {
      const arg = input?.command || input?.file_path || input?.pattern
        || input?.query || input?.name || ''
      // `●` rather than a pictograph: glyphs outside the common ranges fall back
      // to a replacement box in plenty of terminal fonts, and a broken marker on
      // every tool call is worse than a plain one.
      say(`  ${C.c}●${C.x} ${C.b}${name}${C.x}`
        + `${arg ? `  ${C.dim}${String(arg).replace(/\s+/g, ' ').slice(0, 68)}${C.x}` : ''}\n`)
    },
    onAsk: askPermission,
  })

  stdout.write(renderStartup({
    seats,
    baseUrl: providerConfig(settings).baseUrl,
    cwd,
    commands: commands.size,
    skills: session.skills.size,
    agents: session.agents.size,
    mcp: mcp?.servers?.length ? `${mcp.servers.length}` : '',
    resumed: session.resumed
      ? `${forkParent ? 'forked from' : 'resumed'} ${resumeInfo ? resumeInfo.id.slice(0, 8) : ''}`
        + ` · ${session.resumed.turns} prior turn(s)`
      : null,
    color: Boolean(stdout.isTTY),
  }))
  stdout.write(renderHeader({
    version: VERSION,
    effort: settings.effortLevel || '',
    cwd,
    sprite: false,          // he lives in the pane, where he can move
    color: Boolean(stdout.isTTY),
  }))
  statusCache = renderStatusLine({
    settings, sessionId: session.sessionId, cwd, model: session.model, usage: session.usage,
  })
  pane.start()
  paintPane()

  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: `${C.c}❯${C.x} `,
    historySize: 500,
    completer(line) {
      const cmds = ['/help', '/seats', '/skills', '/agents', '/mcp', '/model', '/mode',
                    '/clear', '/cost', '/exit',
                    ...[...commands.keys()].map((c) => `/${c}`)].sort()
      const hits = cmds.filter((c) => c.startsWith(line))
      return [hits.length ? hits : (line.startsWith('/') ? cmds : []), line]
    },
  })

  let generating = null          // AbortController while a turn is in flight
  let pendingExit = false        // armed by a Ctrl+C at an empty prompt
  // rl.close() does not end the for-await immediately — the iterator drains
  // whatever is already buffered first. Prompting during that drain throws
  // ERR_USE_AFTER_CLOSE, which is how /exit crashed instead of exiting.
  let closing = false

  const prompt = () => { if (!closing) rl.prompt() }
  // stdin reaching EOF closes readline without going through /exit, so `closing`
  // alone is not enough to know whether resume/prompt are still legal.
  rl.on('close', () => { closing = true })

  // shift+tab cycles the permission mode, the way serge does. readline does not
  // surface it, so the raw sequence is intercepted before it reaches the line
  // editor — otherwise it inserts a literal tab.
  const CYCLE = ['default', 'acceptEdits', 'plan', 'fullAccess']
  if (stdin.isTTY) {
    stdin.on('data', (buf) => {
      if (String(buf) !== '\x1b[Z' || prompting || generating) return
      const i = CYCLE.indexOf(session.mode)
      session.mode = CYCLE[(i + 1) % CYCLE.length]
      paintPane()
    })
  }

  // readline's own SIGINT handling would kill the process. Take it over so a
  // Ctrl+C can mean "stop this turn" without meaning "throw away the session".
  /**
   * Ask for one tool call, on the terminal the user is already sitting at.
   *
   * Raw mode for a single keypress: a permission prompt that needs Enter is one
   * more thing between the user and the answer, and the answer is one character.
   * readline is paused for the duration so it does not also consume the key.
   */
  async function askPermission({ tool, input, reason }) {
    if (!stdin.isTTY) return 'no'
    const subject = String(input?.command || input?.file_path || input?.pattern
      || input?.query || input?.name || '').replace(/\s+/g, ' ').slice(0, 68)

    // The pane repaints on a timer; leaving it running would overwrite the
    // prompt between the question and the keypress.
    const wasPrompting = prompting
    prompting = true
    stdout.write(`\n  ${C.y}${reason}${C.x}\n`)
    if (subject) stdout.write(`  ${C.dim}${tool}${C.x}  ${subject}\n`)
    stdout.write(`  ${C.b}y${C.x} ${C.dim}once${C.x}   ${C.b}a${C.x} ${C.dim}always ${tool} this session${C.x}`
      + `   ${C.b}n${C.x} ${C.dim}no${C.x}  ${C.dim}›${C.x} `)

    const wasRaw = stdin.isRaw
    rl.pause()
    if (!wasRaw) stdin.setRawMode(true)
    stdin.resume()

    const key = await new Promise((resolve) => {
      const onKey = (buf) => {
        stdin.off('data', onKey)
        // FIRST character only. Raw mode delivers one keystroke at a time from a
        // terminal, but piped input arrives as a whole line — comparing the
        // whole chunk to 'y' then fails every answer.
        resolve(String(buf).slice(0, 1))
      }
      stdin.on('data', onKey)
    })

    if (!wasRaw) stdin.setRawMode(false)
    const answer = key === 'y' || key === 'Y' ? 'yes'
      : key === 'a' || key === 'A' ? 'always'
      : 'no'
    const label = { yes: `${C.g}allowed once`, always: `${C.g}always for ${tool}`, no: `${C.r}declined` }[answer]
    stdout.write(`${label}${C.x}\n\n`)
    prompting = wasPrompting
    // Ctrl+C at the prompt means "stop the whole turn", not just "decline this
    // one call" — otherwise the model retries and asks again immediately.
    if (key === '\u0003' && generating) generating.abort()
    return answer
  }

  rl.on('SIGINT', () => {
    if (generating) {
      generating.abort()
      stdout.write(`\n${C.y}  · stopped${C.x}\n`)
      return
    }
    if (pendingExit) { closing = true; rl.close(); return }
    pendingExit = true
    stdout.write(`\n${C.dim}  (Ctrl+C again to exit, or keep typing)${C.x}\n`)
    prompt()
  })

  async function handleCommand(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/)
    const arg = rest.join(' ').trim()

    switch (cmd) {
      case '/help':
        stdout.write(HELP)
        return true

      case '/seats':
        stdout.write(renderSeats(seats) + '\n')
        return true

      case '/model': {
        if (!arg) { stdout.write(`  ${session.model}\n`); return true }
        const v = checkSeat(arg, seats)
        if (!v.ok) { stdout.write(`${C.r}  ${v.reason}${C.x}\n`); return true }
        session.model = arg
        stdout.write(`${C.g}  seat → ${arg}${C.x}\n`)
        return true
      }

      case '/mode': {
        if (!arg) { stdout.write(`  ${session.mode}\n`); return true }
        if (!MODES.includes(arg)) {
          stdout.write(`${C.r}  unknown mode "${arg}" — expected: ${MODES.join(', ')}${C.x}\n`)
          return true
        }
        session.mode = arg
        stdout.write(`${C.g}  mode → ${arg}${C.x}\n`)
        return true
      }

      case '/clear':
        session.clear()
        stdout.write(`${C.g}  conversation cleared${C.x} ${C.dim}(the transcript still has it)${C.x}\n`)
        return true

      case '/cost': {
        const u = session.usage
        stdout.write(`  ${session.turns} turn(s) · ${u.requests} request(s)\n`
          + `  ${fmt(u.prompt)} in · ${fmt(u.completion)} out · ${fmt(u.prompt + u.completion)} total\n`
          + `  ${C.dim}${session.transcriptPath}${C.x}\n`)
        return true
      }

      case '/skills': {
        if (!session.skills.size) { stdout.write('  (no skills in this config dir)\n'); return true }
        for (const sk of session.skills.values()) {
          stdout.write(`  ${C.b}${sk.name}${C.x}  ${C.dim}`
            + `${(sk.whenToUse || sk.description).replace(/\s+/g, ' ').slice(0, 96)}${C.x}\n`)
        }
        stdout.write(`${C.dim}  the model loads one itself with the Skill tool${C.x}\n`)
        return true
      }

      case '/agents': {
        if (!session.agents.size) { stdout.write('  (no agents/ in this config dir)\n'); return true }
        for (const a of [...session.agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
          stdout.write(`  ${C.b}${a.name.padEnd(16)}${C.x}${C.c}${(a.model || 'session seat').padEnd(15)}${C.x}`
            + `${C.dim}${(a.description || '').replace(/\s+/g, ' ').slice(0, 62)}${C.x}\n`)
        }
        return true
      }

      case '/mcp':
        stdout.write(mcp?.servers?.length
          ? mcp.servers.map((s) => `  ${s.name}  ${s.tools} tool(s)`).join('\n') + '\n'
          : '  (no MCP servers configured or reachable)\n')
        return true

      case '/exit':
      case '/quit':
        closing = true
        rl.close()
        return true

      default: {
        if (!cmd.startsWith('/')) return false
        // A brain-authored command: expand its body and send it as the prompt.
        const brainCmd = commands.get(cmd.slice(1))
        if (brainCmd) {
          stdout.write(`${C.dim}  → ${brainCmd.name}${C.x}\n`)
          return { prompt: expandCommand(brainCmd, arg) }
        }
        stdout.write(`${C.r}  unknown command ${cmd}${C.x} — /help\n`)
        return true
      }
    }
  }

  prompt()

  for await (const line of rl) {
    if (closing) break
    pendingExit = false
    const text = line.trim()
    if (!text) { prompt(); continue }

    const handled = await handleCommand(text)
    if (handled === true) { prompt(); continue }
    // A brain command expands into a prompt; anything else is the prompt itself.
    const toSend = (handled && handled.prompt) ? handled.prompt : text

    generating = new AbortController()
    // Pause input while the model streams: keystrokes typed mid-generation
    // would otherwise interleave with the output and land in the next prompt.
    rl.pause()
    streaming = false
    const before = session.usage
    let tick
    if (pane.enabled) {
      spinner.begin()
      tick = setInterval(() => {
        const u = session.usage
        const t = u.prompt + u.completion - before.prompt - before.completion
        spinner.update(t > 0 ? `${fmt(t)} tok` : '')
        tickCount++
        paintPane(true)
      }, 100)
    } else {
      spinner.start()
      tick = setInterval(() => {
        const u = session.usage
        const t = u.prompt + u.completion - before.prompt - before.completion
        if (t > 0) spinner.update(`${fmt(t)} tok`)
      }, 1000)
    }
    tick.unref?.()
    try {
      const res = await session.send(toSend, { signal: generating.signal })
      if (res.blocked) {
        stdout.write(`${C.y}  blocked: ${res.reason}${C.x}\n`)
      } else if (res.exhausted) {
        stdout.write(`\n${C.y}  · turn budget exhausted without a final answer${C.x}\n`)
      }
      stdout.write('\n')
    } catch (e) {
      const aborted = e?.name === 'AbortError' || generating.signal.aborted
      if (!aborted) stdout.write(`\n${C.r}  error: ${e?.message ?? e}${C.x}\n`)
      else stdout.write('\n')
    } finally {
      clearInterval(tick)
      spinner.stop()
      paintPane()
      generating = null
      if (!closing) rl.resume()
    }

    const u = session.usage
    const spent = (u.prompt + u.completion) - (before.prompt + before.completion)
    statusCache = renderStatusLine({
      settings, sessionId: session.sessionId, cwd, model: session.model, usage: u,
    })
    if (pane.enabled) {
      // The pane already carries seat, mode, turns and totals; repeating them
      // after every turn is noise. Only the per-turn cost is new.
      stdout.write(`${C.dim}  ${spent > 0 ? `+${fmt(spent)} tok · ` : ''}`
        + `${spinner.elapsed().toFixed(1)}s${C.x}\n\n`)
    } else {
      const status = renderStatusLine({
        settings, sessionId: session.sessionId, cwd, model: session.model, usage: session.usage,
      })
      stdout.write(`${C.dim}  ${status || `${session.model}  ${session.turns} turn(s)`}`
        + `${spent > 0 ? `  +${fmt(spent)} tok` : ''}  ${spinner.elapsed().toFixed(1)}s${C.x}\n\n`)
    }
    paintPane()
    prompt()
  }

  pane.stop()
  stdout.write(`${C.dim}  session ${session.sessionId.slice(0, 8)} · ${session.turns} turn(s)\n`
    + `  ${session.transcriptPath}${C.x}\n`)
  return 0
}
