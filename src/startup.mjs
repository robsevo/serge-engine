/**
 * The startup screen.
 *
 * A wordmark, then one boxed panel: who is answering, which seats are wired,
 * where the router points, and where you are. It exists because the first
 * question on every launch is "is this pointing where I think it is" — and a
 * wall of dim key/value lines answers that slower than a panel you can take in
 * at a glance.
 *
 * The seat rows come from the router roster, so this cannot claim a model the
 * router is not actually configured to use. If `litellm.yaml` is absent the rows
 * degrade to the seat names rather than inventing anything.
 *
 * Width adapts to the terminal and the content; nothing here assumes 80 columns.
 * Colour degrades to plain text when stdout is not a TTY, so a piped launch does
 * not emit escape sequences.
 */
import { homedir } from 'node:os'

/** Block wordmark. Five rows so it reads at a glance without dominating. */
const WORDMARK = [
  '███████ ███████ ██████   ██████  ███████',
  '██      ██      ██   ██ ██       ██     ',
  '███████ █████   ██████  ██   ███ █████  ',
  '     ██ ██      ██   ██ ██    ██ ██     ',
  '███████ ███████ ██   ██  ██████  ███████',
]

/** Blue gradient, lightest at the top — 256-colour, which every modern term has. */
const GRADIENT = [39, 33, 32, 26, 25]

/**
 * Seat roles serge's own startup screen shows. Names are the brain's, not ours:
 * these three are the hive — the workhorse, its independent reviewer, and the
 * expensive seat kept for the hard 10%.
 */
const ROLES = [
  ['Code', 'local-coder'],
  ['Review', 'qwen-coder'],
  ['Brain', 'cloud-brain'],
]

/** `gemini/gemini-3.1-flash-lite` -> `Gemini 3.1 Flash Lite`. */
function prettyModel(id) {
  if (!id) return null
  // `:free` / `:nitro` are OpenRouter routing suffixes, not part of the name.
  const tail = (id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id).split(':')[0]
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bGpt\b/i, 'GPT')
    .replace(/\bOss\b/i, 'OSS')
}

function shortenPath(p) {
  const h = homedir()
  if (p === h) return '~'
  return p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p
}

/** Printable width, ignoring escape sequences. */
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length

export function renderStartup({
  seats = null, baseUrl = '', cwd = '', model = '', mode = '',
  commands = 0, skills = 0, agents = 0, mcp = '', resumed = null,
  color = true, width = 0,
} = {}) {
  const c = color
    ? { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', cy: '\x1b[36m',
        x: '\x1b[0m', grad: (i) => `\x1b[38;5;${GRADIENT[i]}m` }
    : { dim: '', b: '', g: '', y: '', cy: '', x: '', grad: () => '' }

  const out = []
  out.push('')
  WORDMARK.forEach((row, i) => out.push(`  ${c.grad(i)}${row}${c.x}`))
  out.push('')

  // ── panel rows ────────────────────────────────────────────────────────────
  const rows = []
  const add = (label, value) => rows.push([label, value])

  add('Provider', `${c.cy}Serge${c.x} ${c.dim}·${c.x} ${c.cy}Hive${c.x}`)

  const seatRows = ROLES.map(([role, seat]) => {
    const hit = seats?.get?.(seat)
    const pretty = prettyModel(hit?.model) || seat
    return `${c.b}${role}${c.x} ${c.dim}·${c.x} ${pretty}`
  })
  add('Models', seatRows[0])
  for (const r of seatRows.slice(1)) add('', r)

  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')
  const local = /^(localhost|127\.0\.0\.1)/.test(host)
  add('Endpoint', `${local ? 'local' : host} ${c.dim}→${c.x} cloud`)
  add('Dir', shortenPath(cwd))

  const brain = [
    commands && `${commands} cmd`,
    skills && `${skills} skills`,
    agents && `${agents} agents`,
    mcp && `mcp ${mcp}`,
  ].filter(Boolean).join(`${c.dim} · ${c.x}`)
  // NOT "Brain" — that is already a seat role two rows up, and repeating it
  // reads as though the panel is describing the same thing twice.
  if (brain) add('Loaded', brain)
  if (resumed) add('Session', `${c.g}${resumed}${c.x}`)

  // ── frame ─────────────────────────────────────────────────────────────────
  const LABEL_W = 10
  const bodies = rows.map(([l, v]) => `  ${c.dim}${l.padEnd(LABEL_W)}${c.x}${v}`)
  const status = `  ${c.g}●${c.x} ${mode === 'fullAccess' ? `${c.y}yolo${c.x} ` : ''}`
    + `${c.dim}ready${c.x}     ${c.dim}type${c.x} ${c.cy}/help${c.x} ${c.dim}to begin${c.x}`

  const term = width || process.stdout.columns || 80
  const inner = Math.min(
    Math.max(...bodies.concat([status]).map(visible), 44) + 2,
    Math.max(term - 4, 40),
  )
  // A value wider than the frame — a deep cwd is the usual one — must be cut,
  // not allowed to push the right border off the line. Elide the MIDDLE so both
  // useful ends survive: the top of the path and the directory you are in.
  const pad = (line) => {
    const w = visible(line)
    if (w <= inner) return line + ' '.repeat(inner - w)
    const over = w - inner + 1
    const head = Math.max(14, Math.floor((w - over) / 2))
    return `${line.slice(0, head)}…${line.slice(head + over)}`
  }
  const bar = (l, m, r) => `  ${c.dim}${l}${'─'.repeat(inner)}${r}${c.x}`.replace('─'.repeat(inner) + r, '─'.repeat(inner) + r)

  out.push(bar('┌', '', '┐'))
  for (const b of bodies) out.push(`  ${c.dim}│${c.x}${pad(b)}${c.dim}│${c.x}`)
  out.push(bar('├', '', '┤'))
  out.push(`  ${c.dim}│${c.x}${pad(status)}${c.dim}│${c.x}`)
  out.push(bar('└', '', '┘'))
  out.push('')
  return out.join('\n')
}
