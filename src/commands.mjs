/**
 * Slash commands: the catalogue, and one dispatcher both renderers share.
 *
 * There are two front-ends (Ink and readline) and there must not be two answers
 * to "what does /model do" — a command added to one and forgotten in the other
 * is a silent capability gap, which is exactly what happened before this module
 * existed: the Ink TUI had no slash handling at all and sent `/help` to the
 * model as if it were a question.
 *
 * So `dispatch` returns DATA — lines of text, a prompt to send, or an exit —
 * and each renderer paints it. Nothing here writes to stdout.
 */
import { MODES } from './permissions.mjs'
import { checkSeat, renderSeats } from './seats.mjs'
import { expandCommand } from './brain.mjs'
import { cliName } from './config.mjs'

/**
 * Built-in commands, in the order `/` offers them: what you reach for most
 * first, housekeeping after, leaving last.
 */
export const BUILTINS = [
  { name: 'help', description: 'What Serge can do, and the keys that do it' },
  { name: 'model', description: 'Show the current seat, or move to another' },
  { name: 'mode', description: 'Show or set the permission mode' },
  { name: 'seats', description: 'Every seat on the router, and which are reachable' },
  { name: 'skills', description: 'Skills the brain has published' },
  { name: 'agents', description: 'Subagents available to the Agent tool' },
  { name: 'mcp', description: 'Connected MCP servers and their tool counts' },
  { name: 'cost', description: 'Tokens and requests spent this session' },
  { name: 'resume', description: 'Sessions you can pick up again' },
  { name: 'clear', description: 'Forget the conversation, keep the transcript' },
  { name: 'exit', description: 'Leave' },
]

/**
 * Everything `/` can complete: built-ins plus whatever the brain publishes.
 *
 * A brain command that shadows a built-in name is kept and marked, rather than
 * silently dropped — the user wrote that file and needs to see why it never
 * runs. Built-ins win at dispatch, so the marking is the only warning there is.
 */
export function catalog(brainCommands = new Map()) {
  const builtinNames = new Set(BUILTINS.map((b) => b.name))
  const brain = [...brainCommands.values()]
    .map((c) => ({
      name: c.name,
      description: builtinNames.has(c.name)
        ? `(shadowed by the built-in) ${c.description || ''}`.trim()
        : (c.description || 'a command from the brain'),
      source: 'brain',
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...BUILTINS.map((b) => ({ ...b, source: 'builtin' })), ...brain]
}

/**
 * Commands whose names start with `prefix` (the text after the `/`).
 *
 * Prefix hits rank above interior hits so typing `mo` offers `model` before
 * `common-mode` — the name you were most likely reaching for is first.
 */
export function complete(prefix, brainCommands = new Map()) {
  const all = catalog(brainCommands)
  if (!prefix) return all
  const p = prefix.toLowerCase()
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(p))
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(p) && c.name.toLowerCase().includes(p))
  return [...starts, ...contains]
}

/**
 * Split a submitted line into a command and its argument.
 * @returns {{name:string, arg:string}|null} null when the line is not a command.
 */
export function parseCommand(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('/')) return null
  const [head, ...rest] = text.split(/\s+/)
  return { name: head.slice(1), arg: rest.join(' ').trim() }
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export const HELP_LINES = [
  'Ask for anything; Serge reads, edits, runs and verifies.',
  '',
  '  /help /model /mode /seats /skills /agents /mcp /cost /resume /clear /exit',
  '  /  — see every command, ↑↓ to choose, tab or enter to pick',
  '',
  '  shift+tab   cycle permission mode      ctrl+c   interrupt a turn',
  '  ↑ ↓         history                    ctrl+c×2 exit',
]

/**
 * Run a slash command.
 *
 * @returns {{lines:string[]}}   text to show
 *        | {prompt:string}      a brain command expanded into a prompt to send
 *        | {exit:true}
 *        | {unknown:string}     no such command — the renderer says so
 *        | null                 not a slash command at all
 */
export function dispatch(line, ctx = {}) {
  const parsed = parseCommand(line)
  if (!parsed) return null
  const { name, arg } = parsed
  const { session, seats, mcp, commands = new Map(), sessions = [] } = ctx

  switch (name) {
    case 'help':
      return { lines: HELP_LINES }

    case 'seats':
      return { lines: (renderSeats(seats) || '  (no router roster)').split('\n') }

    case 'model': {
      if (!arg) return { lines: [`  ${session.model}`] }
      const v = checkSeat(arg, seats)
      if (!v.ok) return { lines: [`  ${v.reason}`], tone: 'error' }
      session.model = arg
      return { lines: [`  seat → ${arg}`], tone: 'ok' }
    }

    case 'mode': {
      if (!arg) return { lines: [`  ${session.mode}`] }
      if (!MODES.includes(arg)) {
        return { lines: [`  unknown mode "${arg}" — expected: ${MODES.join(', ')}`], tone: 'error' }
      }
      session.mode = arg
      return { lines: [`  mode → ${arg}`], tone: 'ok', mode: arg }
    }

    case 'clear':
      session.clear()
      return { lines: ['  conversation cleared (the transcript still has it)'], tone: 'ok', cleared: true }

    case 'cost': {
      const u = session.usage
      return {
        lines: [
          `  ${session.turns} turn(s) · ${u.requests} request(s)`,
          `  ${fmt(u.prompt)} in · ${fmt(u.completion)} out · ${fmt(u.prompt + u.completion)} total`,
          `  ${session.transcriptPath}`,
        ],
      }
    }

    case 'skills': {
      if (!session.skills?.size) return { lines: ['  (no skills in this config dir)'] }
      return {
        lines: [
          ...[...session.skills.values()].map((s) =>
            `  ${s.name.padEnd(22)}${(s.whenToUse || s.description || '').replace(/\s+/g, ' ').slice(0, 78)}`),
          '  the model loads one itself with the Skill tool',
        ],
      }
    }

    case 'agents': {
      if (!session.agents?.size) return { lines: ['  (no agents/ in this config dir)'] }
      return {
        lines: [...session.agents.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((a) => `  ${a.name.padEnd(18)}${(a.model || 'session seat').padEnd(16)}`
            + `${(a.description || '').replace(/\s+/g, ' ').slice(0, 58)}`),
      }
    }

    case 'mcp':
      return {
        lines: mcp?.servers?.length
          ? mcp.servers.map((s) => `  ${s.name}  ${s.tools} tool(s)`)
          : ['  (no MCP servers configured or reachable)'],
      }

    case 'resume': {
      if (!sessions.length) return { lines: ['  (no earlier sessions)'] }
      return {
        lines: [
          ...sessions.slice(0, 10).map((s) =>
            `  ${String(s.id).slice(0, 8)}  ${String(s.turns ?? 0).padStart(3)} turn(s)  ${(s.preview || '').slice(0, 56)}`),
          `  start with: ${cliName()} --resume <id>`,
        ],
      }
    }

    case 'exit':
    case 'quit':
      return { exit: true }

    default: {
      // A brain-authored command expands into a prompt and is sent as one.
      const brainCmd = commands.get?.(name)
      if (brainCmd) return { prompt: expandCommand(brainCmd, arg), name }
      return { unknown: name }
    }
  }
}
