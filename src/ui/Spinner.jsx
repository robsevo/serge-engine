import React from 'react'
import { Box, Text } from 'ink'

/**
 * The deliberating glyph — ported from serge's `Spinner/SpinnerGlyph.tsx`.
 *
 * Serge's own comment there is explicit that the Pusheen cat was REMOVED:
 * "The old Pusheen cat's ears/'arms' and its () body are gone — just the eyes
 * remain." What is left is a face whose eyes look around, pop wide, go
 * cross-eyed and snap-blink, beside a braille spinner.
 *
 * The two run on SEPARATE clocks — eyes at 120ms, braille at 80ms — so the eyes
 * keep flicking while the spinner turns. Sharing one clock is what makes a
 * spinner look mechanical.
 *
 * Frames are built from [frame, holdTicks] pairs so `FRAMES[tick % len]` stays
 * a plain lookup; a frame that should linger simply appears more than once.
 */
const FACE_CYCLE = [
  ['●‿●', 3],   // neutral, calm
  ['◐‿●', 2],   // glance left
  ['●‿◑', 2],   // glance right
  ['◉‿◉', 3],   // wide-eyed pop (held)
  ['●‿●', 2],   // neutral
  ['◑‿◐', 1],   // cross-eyed (quick gag)
  ['●‿●', 2],   // neutral
  ['◌‿◌', 1],   // — snappy dim blink —
  ['◔‿◌', 1],
  ['◌‿◌', 1],
  ['◌‿◔', 1],
  ['●‿●', 2],   // back to calm
]
const FACE_FRAMES = FACE_CYCLE.flatMap(([f, n]) => Array(n).fill(f))
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const FACE_MS = 120
const SPIN_MS = 80
const BLUE = '#6EB4E6'          // clawd_body — the wordmark's blue

/**
 * @param {number} elapsedMs  how long the turn has been running; the two clocks
 *   are derived from it rather than from a frame counter, so neither drifts if
 *   the render rate changes.
 */
export function Spinner({ elapsedMs = 0, verb, seconds, tokens, thinking = 0 }) {
  const eyes = FACE_FRAMES[Math.floor(elapsedMs / FACE_MS) % FACE_FRAMES.length]
  const spin = SPIN_FRAMES[Math.floor(elapsedMs / SPIN_MS) % SPIN_FRAMES.length]
  return (
    <Box marginTop={1}>
      {/* eyes (3 cols) + space + spinner (1) = 5, fixed, so the verb never jitters */}
      <Text color={BLUE}>{`${eyes} ${spin} `}</Text>
      <Text color={BLUE}>{`${verb}… ${seconds}s`}</Text>
      {/* A reasoning seat can think for many seconds before writing a word.
          The COUNT is the sign of life — the text itself is not the answer and
          does not belong on screen. */}
      {thinking ? <Text dimColor>{` · reasoning ${thinking > 999 ? (thinking / 1000).toFixed(1) + 'k' : thinking} chars`}</Text> : null}
      {tokens ? <Text dimColor>{` · ${tokens}`}</Text> : null}
    </Box>
  )
}
