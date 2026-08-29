import React from 'react'
import { Box, Text } from 'ink'

/**
 * Messages typed during a turn that the loop has not picked up yet.
 *
 * On screen the instant Enter is pressed, because the alternative — an input
 * that accepts the line and shows nothing — is the same "did that even do
 * anything?" the queue was built to fix, moved one step later. The wait is
 * usually a second or two; a second or two with no acknowledgement is long
 * enough to type it again.
 *
 * They LEAVE this list the moment the loop takes them. From there they are in
 * the transcript, and what became of them is the model's own answer: folded
 * into the work in flight, or added to the todo list above and waiting.
 *
 * BOUNDED, for the reason everything in the live region is bounded — a region
 * taller than the viewport is what makes Ink wipe the terminal on every
 * animation frame (see ui/live.mjs).
 */
const AMBER = '#D8A657'

/** Most messages shown at once; the rest are counted. */
export const QUEUED_MAX = 3

/**
 * Rows this component will occupy — the caller budgets the live region against
 * it, so the two must agree. Kept next to the render for exactly that reason.
 */
export function queuedRowsFor(pending, max = QUEUED_MAX) {
  if (!pending?.length) return 0
  const shown = Math.min(pending.length, max)
  return 1 /* marginTop */ + 1 /* heading */ + shown + (pending.length > shown ? 1 : 0)
}

export function Queued({ pending, max = QUEUED_MAX }) {
  if (!pending?.length) return null
  const shown = pending.slice(0, max)
  const hidden = pending.length - shown.length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={AMBER}>{`  ⋯ queued · ${pending.length} `}</Text>
        <Text dimColor>
          {pending.length === 1 ? 'message, handed over at the next step' : 'messages, handed over at the next step'}
        </Text>
      </Box>
      {shown.map((p, i) => (
        // Keyed on arrival time and position: two identical lines typed twice
        // are two messages, and keying on the text alone would collapse them.
        <Box key={`${p.at ?? 0}:${i}`}>
          <Text color={AMBER}>{'    ❯ '}</Text>
          <Text dimColor wrap="truncate-end">{p.text}</Text>
        </Box>
      ))}
      {hidden ? <Text dimColor>{`    … ${hidden} more`}</Text> : null}
    </Box>
  )
}
