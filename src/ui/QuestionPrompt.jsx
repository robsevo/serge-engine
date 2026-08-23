import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

/**
 * AskUserQuestion's prompt.
 *
 * Shaped like the permission prompt on purpose: a decision is a decision, and
 * two visually different ways to answer one would make the interface feel like
 * two programs. Numbers as well as arrows, because reaching for a number is
 * faster when the options are already numbered on screen.
 */
const BLUE = '#6EB4E6'

export function QuestionPrompt({ question, header, options, onAnswer }) {
  const [sel, setSel] = useState(0)

  useInput((ch, key) => {
    const n = options.length
    if (key.escape) { onAnswer(null); return }
    if (key.upArrow) { setSel((s) => (s - 1 + n) % n); return }
    if (key.downArrow) { setSel((s) => (s + 1) % n); return }
    if (key.return) { onAnswer(options[sel].label); return }
    const d = Number(ch)
    if (Number.isInteger(d) && d >= 1 && d <= n) onAnswer(options[d - 1].label)
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={BLUE} paddingX={1}>
      {header ? <Text color={BLUE} bold>{header}</Text> : null}
      <Text>{question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((o, i) => (
          <Box key={o.label + i}>
            <Text color={i === sel ? BLUE : undefined} bold={i === sel}>
              {(i === sel ? ' ❯ ' : '   ') + `${i + 1}. ${o.label}`}
            </Text>
            {o.description ? <Text dimColor>{'  — ' + o.description.slice(0, 60)}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text dimColor>{'  ↑↓ or 1-' + options.length + ' to choose · enter to confirm · esc to dismiss'}</Text>
    </Box>
  )
}
