import React from 'react'
import { Box, Text } from 'ink'

/**
 * The current plan, shown above the input while any step is unfinished.
 *
 * Hidden once everything is complete: a finished list is history, and the live
 * region is for what still needs doing. It stays out of <Static> so it updates
 * in place rather than printing a fresh copy on every change.
 *
 * BOUNDED, because this is live-region height and live-region height is what
 * tips Ink into wiping the terminal on every animation frame (see ui/live.mjs).
 * A fourteen-step plan on a 24-row terminal would do it on its own, before the
 * reply had streamed a single word.
 */
const BLUE = '#6EB4E6'
const MARK = { pending: '☐', in_progress: '▶', completed: '☑' }

/** Most steps shown at once; the rest are counted. */
export const TODO_MAX = 8

/** Which steps are on screen — completed ones drop off first, oldest first. */
export function visibleTodos(todos, max = TODO_MAX) {
  if (!todos?.length) return []
  if (todos.length <= max) return todos
  // Keep the open work: a completed step is a step you no longer have to read.
  const open = todos.filter((t) => t.status !== 'completed')
  if (open.length >= max) return open.slice(0, max)
  const done = todos.filter((t) => t.status === 'completed')
  return [...done.slice(done.length - (max - open.length)), ...open]
}

/**
 * Rows this component will occupy — the caller budgets the live region against
 * it, so the two must agree. Kept next to the render for exactly that reason.
 */
export function todoRowsFor(todos, max = TODO_MAX) {
  if (!todos?.length) return 0
  if (!todos.some((t) => t.status !== 'completed')) return 0
  const shown = visibleTodos(todos, max).length
  return 1 /* marginTop */ + shown + (todos.length > shown ? 1 : 0)
}

export function Todos({ todos, max = TODO_MAX }) {
  if (!todos?.length) return null
  const open = todos.filter((t) => t.status !== 'completed')
  if (!open.length) return null

  const shown = visibleTodos(todos, max)
  const hidden = todos.length - shown.length

  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((t, i) => {
        const done = t.status === 'completed'
        const active = t.status === 'in_progress'
        return (
          <Box key={t.content + i}>
            <Text color={active ? BLUE : undefined} dimColor={done}>
              {`  ${MARK[t.status] ?? '☐'} `}
            </Text>
            <Text color={active ? BLUE : undefined} bold={active} dimColor={done}
              strikethrough={done} wrap="truncate-end">
              {t.content}
            </Text>
          </Box>
        )
      })}
      {hidden ? <Text dimColor>{`    … ${hidden} more step(s)`}</Text> : null}
    </Box>
  )
}
