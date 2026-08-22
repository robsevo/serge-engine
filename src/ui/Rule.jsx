import React from 'react'
import { Box, Text, useStdout } from 'ink'
import { paintRule, resolvePalette } from '../startup.mjs'

/**
 * A full-width rule painted through the wordmark's gradient.
 *
 * Ink's own `borderStyle` can only take one colour, so the rule is drawn as
 * text with the gradient applied per character — the same `paintRule` the
 * splash box uses, so the two match rather than merely being similar.
 *
 * Width comes from the live terminal so a resize redraws at the right length;
 * Ink re-renders on resize, so nothing else has to listen for it.
 */
export function Rule({ palette = null }) {
  const { stdout } = useStdout()
  // `?? 80` does not catch a reported width of 0, which is what a pty with no
  // window size gives — the rule then collapsed to its 8-column floor. `||`
  // treats 0 as absent, which is the intent.
  const cols = Math.max(20, stdout?.columns || process.stdout.columns || 80)
  const stops = resolvePalette(palette).gradient
  return (
    <Box>
      <Text>{paintRule('─'.repeat(cols), stops)}</Text>
    </Box>
  )
}
