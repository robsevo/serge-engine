import React from 'react'
import { Box, Text } from 'ink'
import { Clawd } from './Clawd.jsx'

/**
 * SergeBar — ported from serge's `components/SergeBar.tsx`.
 *
 * The routing identity stacked beside Clawd: name and version, the hive mode
 * with its effort level, and the working directory. `flex-start` keeps the
 * wordmark on Clawd's top row rather than floating to his middle.
 */
export function SergeBar({ version, effort, cwd, pose, feetFrame, isLoading }) {
  return (
    <Box flexDirection="row" gap={2} alignItems="flex-start" paddingX={1} marginTop={1}>
      <Clawd pose={pose} feetFrame={feetFrame} />
      <Box flexDirection="column">
        <Text>
          <Text bold color="#6EB4E6">Serge</Text>
          <Text dimColor> v{version}</Text>
        </Text>
        <Text dimColor>Hive-mode{effort ? ` with ${effort} effort` : ''}</Text>
        <Text dimColor>{cwd}</Text>
        {isLoading ? <Text dimColor>thinking…</Text> : null}
      </Box>
    </Box>
  )
}
