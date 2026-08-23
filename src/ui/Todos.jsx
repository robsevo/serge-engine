import React from 'react'
import { Box, Text } from 'ink'

/**
 * The current plan, shown above the input while any step is unfinished.
 *
 * Hidden once everything is complete: a finished list is history, and the live
 * region is for what still needs doing. It stays out of <Static> so it updates
 * in place rather than printing a fresh copy on every change.
 */
const BLUE = '#6EB4E6'
const MARK = { pending: '☐', in_progress: '▶', completed: '☑' }

export function Todos({ todos }) {
  if (!todos?.length) return null
  const open = todos.filter((t) => t.status !== 'completed')
  if (!open.length) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {todos.map((t, i) => {
        const done = t.status === 'completed'
        const active = t.status === 'in_progress'
        return (
          <Box key={t.content + i}>
            <Text color={active ? BLUE : undefined} dimColor={done}>
              {`  ${MARK[t.status] ?? '☐'} `}
            </Text>
            <Text color={active ? BLUE : undefined} bold={active} dimColor={done}
              strikethrough={done}>
              {t.content}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
