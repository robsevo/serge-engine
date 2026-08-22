/**
 * The startup screen.
 *
 * A direct port of serge's own splash so a Serge install looks like itself: the
 * ANSI-Shadow wordmark painted through a vertical gradient, then a double-ruled
 * info box whose borders run the same gradient horizontally.
 *
 * The seat rows read the live router roster rather than static labels, so the
 * box cannot claim a model `litellm.yaml` is not actually configured for.
 *
 * Palettes match the originals and are selectable with `SERGE_LOGO` (ember,
 * sunset, forest, ocean, monochrome). Colour degrades to plain text off a TTY.
 */
import { homedir } from 'node:os'

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`

const LOGO = [
  '  ███████╗ ███████╗ ██████╗   ██████╗  ███████╗',
  '  ██╔════╝ ██╔════╝ ██╔══██╗ ██╔════╝  ██╔════╝',
  '  ███████╗ █████╗   ██████╔╝ ██║  ███╗ █████╗  ',
  '  ╚════██║ ██╔══╝   ██╔══██╗ ██║   ██║ ██╔══╝  ',
  '  ███████║ ███████╗ ██║  ██║ ╚██████╔╝ ███████╗',
  '  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝  ╚═════╝  ╚══════╝',
]

export const PALETTES = {
  ember: {
    gradient: [[255, 177, 95], [255, 150, 60], [255, 122, 26], [230, 100, 10], [190, 80, 8], [145, 60, 8]],
    accent: [255, 122, 26], cream: [230, 200, 170], dim: [130, 100, 75], border: [105, 80, 60],
  },
  sunset: {
    gradient: [[255, 180, 100], [240, 140, 80], [217, 119, 87], [193, 95, 60], [160, 75, 55], [130, 60, 50]],
    accent: [240, 148, 100], cream: [220, 195, 170], dim: [120, 100, 82], border: [100, 80, 65],
  },
  forest: {
    gradient: [[170, 230, 170], [130, 205, 130], [95, 180, 95], [70, 150, 75], [55, 120, 60], [40, 90, 45]],
    accent: [120, 200, 120], cream: [200, 220, 200], dim: [100, 130, 100], border: [80, 105, 80],
  },
  ocean: {
    gradient: [[170, 220, 255], [125, 185, 240], [80, 150, 220], [55, 115, 190], [40, 85, 150], [25, 55, 110]],
    accent: [110, 180, 230], cream: [195, 215, 235], dim: [90, 115, 145], border: [70, 90, 115],
  },
  monochrome: {
    gradient: [[225, 225, 225], [195, 195, 195], [160, 160, 160], [125, 125, 125], [95, 95, 95], [70, 70, 70]],
    accent: [200, 200, 200], cream: [210, 210, 210], dim: [120, 120, 120], border: [95, 95, 95],
  },
}

const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

function gradAt(stops, t) {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]
  return lerp(stops[i], stops[i + 1], s - i)
}

/** Per-character gradient, biased by the row's vertical position. */
function paintLine(text, stops, lineT) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? lineT * 0.5 + (i / (text.length - 1)) * 0.5 : lineT
    out += rgb(...gradAt(stops, t)) + text[i]
  }
  return out + RESET
}

/** Left-to-right across the full gradient — the box rules, so they match the wordmark. */
function paintRule(text, stops) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += rgb(...gradAt(stops, text.length > 1 ? i / (text.length - 1) : 0)) + text[i]
  }
  return out + RESET
}

/** `gemini/gemini-3.1-flash-lite` -> `Gemini 3.1 Flash Lite`. */
function prettyModel(id) {
  if (!id) return null
  const tail = (id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id).split(':')[0]
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bGpt\b/i, 'GPT')
    .replace(/\bOss\b/i, 'OSS')
    .slice(0, 34)
}

export function resolvePalette(name) {
  return PALETTES[name] || PALETTES[process.env.SERGE_LOGO] || PALETTES.ocean
}

const W = 62

export function renderStartup({
  seats = null, baseUrl = '', cwd = '',
  commands = 0, skills = 0, agents = 0, mcp = '', resumed = null,
  palette = null, color = true,
} = {}) {
  const p = resolvePalette(palette)
  const { gradient: GRAD, accent: ACCENT, cream: CREAM, dim: DIMCOL, border: BORDER } = p

  // Off a TTY every colour helper becomes a no-op, so the same code path renders
  // plain text rather than a second implementation that could drift from it.
  const col = color ? rgb : () => ''
  const rst = color ? RESET : ''
  const dm = color ? DIM : ''
  const line = color ? paintLine : (t) => t
  const rule = color ? paintRule : (t) => t

  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '')
  const isLocal = /^(localhost|127\.0\.0\.1)/.test(host)
  const GREEN = [130, 175, 130]

  const out = ['']
  LOGO.forEach((row, i) => out.push(line(row, GRAD, LOGO.length > 1 ? i / (LOGO.length - 1) : 0)))
  out.push('')

  const boxRow = (content, rawLen) =>
    `${col(...BORDER)}║${rst}${content}${' '.repeat(Math.max(0, W - 2 - rawLen))}${col(...BORDER)}║${rst}`

  /** Padded key in dim, value in `c`. Returns the painted row and its raw width. */
  const lbl = (k, v, c = CREAM) => {
    const padK = k.padEnd(9)
    return [`  ${dm}${col(...DIMCOL)}${padK}${rst} ${col(...c)}${v}${rst}`, `  ${padK} ${v}`.length]
  }

  out.push(rule(`╔${'═'.repeat(W - 2)}╗`, GRAD))

  let [r, l] = lbl('Provider', 'Serge · Hive', isLocal ? GREEN : ACCENT)
  out.push(boxRow(r, l))

  const seat = (name, fallback) => prettyModel(seats?.get?.(name)?.model) || fallback
  ;[r, l] = lbl('Models', `Code · ${seat('local-coder', 'local-coder')}`)
  out.push(boxRow(r, l))
  ;[r, l] = lbl('', `Review · ${seat('qwen-coder', 'qwen-coder')}`)
  out.push(boxRow(r, l))
  ;[r, l] = lbl('', `Brain · ${seat('cloud-brain', 'cloud-brain')}`)
  out.push(boxRow(r, l))

  ;[r, l] = lbl('Endpoint', isLocal ? 'local → cloud' : host)
  out.push(boxRow(r, l))

  let dir = cwd || process.cwd()
  try { dir = dir.replace(homedir(), '~') } catch { /* keep it absolute */ }
  if (dir.length > 48) dir = `…${dir.slice(-47)}`
  ;[r, l] = lbl('Dir', dir)
  out.push(boxRow(r, l))

  const loaded = [
    commands && `${commands} cmd`,
    skills && `${skills} skills`,
    agents && `${agents} agents`,
    mcp && `mcp ${mcp}`,
  ].filter(Boolean).join(' · ')
  if (loaded) { [r, l] = lbl('Loaded', loaded); out.push(boxRow(r, l)) }
  if (resumed) { [r, l] = lbl('Session', resumed, isLocal ? GREEN : ACCENT); out.push(boxRow(r, l)) }

  out.push(rule(`╠${'═'.repeat(W - 2)}╣`, GRAD))

  const sL = 'ready'
  const sRow = `  ${col(...(isLocal ? GREEN : ACCENT))}●${rst} ${dm}${col(...DIMCOL)}${sL}${rst}`
    + `    ${dm}${col(...DIMCOL)}type ${rst}${col(...ACCENT)}/help${rst}${dm}${col(...DIMCOL)} to begin${rst}`
  out.push(boxRow(sRow, `  ● ${sL}    type /help to begin`.length))

  out.push(rule(`╚${'═'.repeat(W - 2)}╝`, GRAD))
  out.push('')
  return out.join('\n')
}
