import React from 'react'
import { Box, Text } from 'ink'

/**
 * Clawd — ported from serge's `components/LogoV2/Clawd.tsx`.
 *
 * Three rows on a fixed 9-column footprint so nothing jiggles horizontally as
 * the pose changes: a head that sways with the gaze, a face, and feet that
 * shuffle while a turn is in flight.
 *
 * Head uses only quadrant and full blocks (▛ █ ▜) — NOT the ▐/▌ half-blocks,
 * which don't render in some terminal fonts and made the head look broken.
 */
const HEAD = '▛███▜'
const FEET_INDENT = '  '
const FEET_FRAMES = ['▘▘ ▝▝', '▘  ▝ ', '▘▘   ', '▘    ', '    ', '    ▘', '   ▘▘']

const FRAMES = {
  default: { lead: 2, face: '▝▜████▛▘' },
  'look-left': { lead: 1, face: '▝▜████▛▘' },
  'look-right': { lead: 3, face: '▝▜████▛▘' },
  blink: { lead: 2, face: '▝▜████▛▘' },
}

/** Poses cycled while a turn runs: a look around, then a blink. */
export const POSES = ['default', 'look-left', 'default', 'look-right', 'default', 'blink']

export function Clawd({ pose = 'default', feetFrame = 0, color = '#5A96DC' }) {
  const f = FRAMES[pose] ?? FRAMES.default
  const n = FEET_FRAMES.length
  const feet = FEET_INDENT + FEET_FRAMES[((feetFrame % n) + n) % n]

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={color}>{' '.repeat(f.lead) + HEAD}</Text>
      <Text color={color}>{f.face}</Text>
      <Text color={color}>{feet}</Text>
    </Box>
  )
}
