import React from 'react'
import { Box, Text } from 'ink'

/**
 * The bottom bar: the brain's own status line, then the permission mode.
 *
 * The status line is whatever `settings.statusLine.command` prints, so a Serge
 * install shows its own — this only places it.
 */
const MODE_LABEL = {
  default: 'ask before edits',
  acceptEdits: 'accept edits on',
  plan: 'plan mode — no changes',
  bypassPermissions: 'bypass permissions',
  fullAccess: 'full access — no prompts',
}

export function StatusBar({ status, mode, ctx }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text dimColor>{status}</Text>
        {ctx ? <Text dimColor>{`  ctx ${ctx}%`}</Text> : null}
      </Box>
      <Box>
        <Text color={mode === 'plan' ? 'yellow' : '#6EB4E6'}>
          {mode === 'plan' ? '⏸ ' : '▶▶ '}
        </Text>
        <Text color="#6EB4E6">{MODE_LABEL[mode] ?? mode}</Text>
        <Text dimColor> (shift+tab to cycle)</Text>
      </Box>
    </Box>
  )
}
