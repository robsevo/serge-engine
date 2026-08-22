import React from 'react'
import { Box, Text } from 'ink'

/**
 * The thinking indicator.
 *
 * Two dots pulse three frames out of phase — the family serge names in
 * `constants/figures.ts` (· ∘ ○ ◎ ◉ ●) — beside the braille spinner, the cat,
 * and whichever verb is current.
 */
const PULSE = ['·', '∘', '○', '◎', '◉', '●']
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Only characters that exist in essentially every terminal font: the katakana
// mouth rendered as a replacement box in the user's, and a broken glyph
// animating four times a second is worse than no animation.
const CAT = ['(=^·ω·^=)', '(=^·o·^=)', '(=^·ω·^=)', '(=^·-·^=)']

export function Spinner({ frame, verb, seconds, tokens }) {
  const a = PULSE[frame % PULSE.length]
  const b = PULSE[(frame + 3) % PULSE.length]
  const cat = CAT[Math.floor(frame / 3) % CAT.length]
  const dot = DOTS[frame % DOTS.length]
  return (
    <Box marginTop={1}>
      <Text color="#6EB4E6">{`${a} ${b} `}</Text>
      <Text color="yellow">{`${dot} ${cat} ${verb}… ${seconds}s`}</Text>
      {tokens ? <Text dimColor>{` · ${tokens}`}</Text> : null}
    </Box>
  )
}
