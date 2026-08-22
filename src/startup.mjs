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

/**
 * The wordmark: a 5x5 bitmap per letter, drawn twice — a light face and a darker
 * copy offset down-right for the drop shadow. Doing it from a bitmap rather than
 * pasted ASCII keeps the shadow exactly one cell off on both axes, which is what
 * makes it read as depth instead of as a smudge.
 */
const GLYPHS = {
  S: ['11111', '10000', '11111', '00001', '11111'],
  E: ['11111', '10000', '11110', '10000', '11111'],
  R: ['11110', '10001', '11110', '10010', '10001'],
  G: ['11111', '10000', '10011', '10001', '11111'],
}

const CELL = 2            // each bit is this many columns wide
const GAP = 1             // blank cells between letters
const FACE = 75           // light blue
const SHADOW = 24         // the darker blue behind it

function wordmark(word, color) {
  const rows = 5

  // Expand the bitmap to CHARACTER space first. The shadow is then offset by one
  // character, not one bit — offsetting in bit space moves it CELL columns and
  // it lands inside the next stroke instead of behind this one.
  const grid = []
  for (let r = 0; r < rows; r++) grid.push([])
  let x = 0
  for (const ch of word) {
    const g = GLYPHS[ch]
    if (!g) { x += 2 * CELL; continue }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < g[r].length; c++) {
        if (g[r][c] !== '1') continue
        for (let k = 0; k < CELL; k++) grid[r][x + c * CELL + k] = 1
      }
    }
    x += g[0].length * CELL + GAP * CELL
  }
  const width = x + 1

  const isFace = (r, c) => Boolean(grid[r]?.[c])
  const isShadow = (r, c) => !isFace(r, c) && Boolean(grid[r - 1]?.[c - 1])

  const out = []
  for (let r = 0; r <= rows; r++) {
    let line = ''
    let pen = 'none'
    for (let c = 0; c <= width; c++) {
      const want = isFace(r, c) ? 'face' : (isShadow(r, c) ? 'shadow' : 'none')
      if (want !== pen && color) {
        line += want === 'none' ? '\x1b[0m'
          : `\x1b[38;5;${want === 'face' ? FACE : SHADOW}m`
      }
      pen = want
      line += want === 'none' ? ' ' : '█'
    }
    out.push(line + (color ? '\x1b[0m' : ''))
  }
  return out
}

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
  // Palette lifted from the reference: sage labels, warm identity, blue frame.
  const c = color
    ? { dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m',
        label: '\x1b[38;5;108m',     // sage — the key column
        val: '\x1b[38;5;252m',       // near-white — the values
        warm: '\x1b[38;5;180m',      // tan — who is answering
        frame: '\x1b[38;5;68m',      // blue — the box
        ok: '\x1b[38;5;114m',        // green — the ready dot
        hint: '\x1b[38;5;75m' }      // light blue — /help
    : { dim: '', b: '', x: '', label: '', val: '', warm: '', frame: '', ok: '', hint: '' }

  const out = []
  out.push('')
  for (const row of wordmark('SERGE', color)) out.push(`  ${row}`)
  out.push('')

  // ── panel rows ────────────────────────────────────────────────────────────
  const rows = []
  const add = (label, value) => rows.push([label, value])

  add('Provider', `${c.warm}Serge${c.x} ${c.dim}·${c.x} ${c.warm}Hive${c.x}`)

  const seatRows = ROLES.map(([role, seat]) => {
    const hit = seats?.get?.(seat)
    const pretty = prettyModel(hit?.model) || seat
    return `${c.val}${role}${c.x} ${c.dim}·${c.x} ${c.val}${pretty}${c.x}`
  })
  add('Models', seatRows[0])
  for (const r of seatRows.slice(1)) add('', r)

  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')
  const local = /^(localhost|127\.0\.0\.1)/.test(host)
  add('Endpoint', `${c.val}${local ? 'local' : host} ${c.dim}→${c.x} ${c.val}cloud${c.x}`)
  add('Dir', `${c.val}${shortenPath(cwd)}${c.x}`)

  const brain = [
    commands && `${commands} cmd`,
    skills && `${skills} skills`,
    agents && `${agents} agents`,
    mcp && `mcp ${mcp}`,
  ].filter(Boolean).join(`${c.dim} · ${c.x}`)
  // NOT "Brain" — that is already a seat role two rows up, and repeating it
  // reads as though the panel is describing the same thing twice.
  if (brain) add('Loaded', `${c.val}${brain}${c.x}`)
  if (resumed) add('Session', `${c.ok}${resumed}${c.x}`)

  // ── frame ─────────────────────────────────────────────────────────────────
  const LABEL_W = 10
  const bodies = rows.map(([l, v]) => `  ${c.label}${l.padEnd(LABEL_W)}${c.x}${v}`)
  const status = `  ${c.ok}●${c.x} ${mode === 'fullAccess' ? `${c.warm}yolo${c.x} ` : ''}`
    + `${c.val}ready${c.x}     ${c.dim}type${c.x} ${c.hint}/help${c.x} ${c.dim}to begin${c.x}`

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
  const bar = (l, r) => `  ${c.frame}${l}${'─'.repeat(inner)}${r}${c.x}`
  const row = (body) => `  ${c.frame}│${c.x}${pad(body)}${c.frame}│${c.x}`

  out.push(bar('┌', '┐'))
  for (const b of bodies) out.push(row(b))
  out.push(bar('├', '┤'))
  out.push(row(status))
  out.push(bar('└', '┘'))
  out.push('')
  return out.join('\n')
}
