/**
 * Clawd — Serge's mascot, ported from the original.
 *
 * Three rows, fixed 9-column footprint so nothing jiggles horizontally as the
 * pose changes: a swaying head, a face whose eyes shift or blink, and feet that
 * shuffle while a turn is in flight.
 *
 * The head deliberately uses only quadrant and full blocks (▛ █ ▜) — the ▐/▌
 * half-blocks vanish entirely in some terminal fonts, which made the head look
 * broken rather than merely different.
 */

const HEAD = '▛███▜'
const FEET_INDENT = '  '
const FEET_FRAMES = ['▘▘ ▝▝', '▘  ▝ ', '▘▘   ', '▘    ', '    ', '    ▘', '   ▘▘']

/** Each pose is the head's leading offset (the sway) plus the face row. */
const FRAMES = {
  default: { lead: 2, face: '▝▜████▛▘' },
  'look-left': { lead: 1, face: '▝▜████▛▘' },
  'look-right': { lead: 3, face: '▝▜████▛▘' },
  blink: { lead: 2, face: '▝▜████▛▘' },
}

/** Poses cycled while a turn runs — a look around, then a blink. */
export const MOTION = ['default', 'look-left', 'default', 'look-right', 'default', 'blink']

/**
 * @returns {string[]} three rows, already coloured unless `color` is false.
 */
export function clawd({ pose = 'default', feetFrame = 0, color = true, rgb = [90, 150, 220] } = {}) {
  const f = FRAMES[pose] ?? FRAMES.default
  const n = FEET_FRAMES.length
  const feet = FEET_INDENT + FEET_FRAMES[((feetFrame % n) + n) % n]
  const paint = color ? (s) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m` : (s) => s
  return [
    paint(' '.repeat(f.lead) + HEAD),
    paint(f.face),
    paint(feet),
  ]
}
