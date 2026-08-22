/**
 * The interactive session.
 *
 * A conversation that keeps going: history persists across prompts, the same
 * hooks fire on every turn, and the loop only ends when you end it.
 *
 * WHY `readline` AND NOT A TUI FRAMEWORK. A full-screen TUI means a rendering
 * library, which means a dependency tree in a process that can read your
 * filesystem and run shell commands. Node's `readline` is in the standard
 * library and gives the things that actually matter in a REPL: line editing,
 * history, tab completion, and correct terminal signal handling. What it does
 * not give — panes, mouse, a status bar that redraws — is not worth a supply
 * chain.
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
import { providerConfig, loadSettings, configDir } from './config.mjs'
import { loadSeats, checkSeat, renderSeats } from './seats.mjs'
import { MODES } from './permissions.mjs'
import { loadCommands, expandCommand } from './brain.mjs'
import { createSpinner } from './spinner.mjs'
import { renderStatusLine } from './statusline.mjs'
import { renderStartup } from './startup.mjs'

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
  let streaming = false

  // The spinner owns the screen until the first token, then gets out of the way.
  // Notices and tool lines have to clear it too, or they print into its row.
  const say = (line) => {
    const wasActive = spinner.active
    if (wasActive) spinner.stop()
    stdout.write(line)
    if (wasActive && !streaming) spinner.start()
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
    onNotice: (m) => say(`${C.dim}  · ${m}${C.x}\n`),
    onTool: (name, input) => {
      const arg = input?.command || input?.file_path || input?.pattern
        || input?.query || input?.name || ''
      say(`${C.dim}  ⚒ ${name}${arg ? `  ${String(arg).replace(/\s+/g, ' ').slice(0, 68)}` : ''}${C.x}\n`)
    },
  })

  stdout.write(renderStartup({
    seats,
    baseUrl: providerConfig(settings).baseUrl,
    cwd,
    model: session.model,
    mode: session.mode,
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

  // readline's own SIGINT handling would kill the process. Take it over so a
  // Ctrl+C can mean "stop this turn" without meaning "throw away the session".
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
    spinner.start()
    const tick = setInterval(() => {
      const u = session.usage
      const t = u.prompt + u.completion - before.prompt - before.completion
      if (t > 0) spinner.update(`${fmt(t)} tok`)
    }, 1000)
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
      generating = null
      if (!closing) rl.resume()
    }

    const status = renderStatusLine({
      settings, sessionId: session.sessionId, cwd, model: session.model, usage: session.usage,
    })
    const u = session.usage
    const spent = (u.prompt + u.completion) - (before.prompt + before.completion)
    stdout.write(`${C.dim}  ${status || `${session.model}  ${session.turns} turn(s)`}`
      + `${spent > 0 ? `  +${fmt(spent)} tok` : ''}  ${spinner.elapsed().toFixed(1)}s${C.x}\n\n`)
    prompt()
  }

  stdout.write(`${C.dim}  session ${session.sessionId.slice(0, 8)} · ${session.turns} turn(s)\n`
    + `  ${session.transcriptPath}${C.x}\n`)
  return 0
}
