import React from 'react'
import { Box, Text } from 'ink'

/**
 * The transcript — ported from serge's message components.
 *
 *   AssistantToolUseMessage  BLACK_CIRCLE, tool name BOLD, args parenthesised
 *   MessageResponse          every result prefixed '  └  '
 *
 * BLACK_CIRCLE is '⏺' on darwin and '●' elsewhere: the former aligns better
 * vertically but is not usually supported on Windows/Linux.
 */
const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

/** A submitted prompt, banded so a turn has a visible start. */
function UserMessage({ text }) {
  return (
    <Box>
      <Text backgroundColor="#2A2A2A">{` ❯ ${text} `}</Text>
    </Box>
  )
}

function ToolUse({ name, args, done, isError }) {
  return (
    <Box flexDirection="row">
      <Box minWidth={2}>
        <Text color={isError ? 'red' : done ? 'green' : undefined} dimColor={!done}>
          {BLACK_CIRCLE}
        </Text>
      </Box>
      <Text bold wrap="truncate-end">{name}</Text>
      {args ? <Text wrap="truncate-end">({args})</Text> : null}
    </Box>
  )
}

function ToolResult({ text, extra, isError }) {
  return (
    <Box flexDirection="row">
      <Text dimColor={!isError} color={isError ? 'red' : undefined}>{'  └  '}</Text>
      <Text dimColor wrap="truncate-end">{text}</Text>
      {extra ? <Text dimColor>{`   +${extra}`}</Text> : null}
    </Box>
  )
}

function AssistantText({ text }) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}><Text>{BLACK_CIRCLE}</Text></Box>
      <Box flexGrow={1}><Text>{text}</Text></Box>
    </Box>
  )
}

function Notice({ text, tone }) {
  const color = tone === 'warn' ? 'yellow' : tone === 'error' ? 'red' : undefined
  return <Text color={color} dimColor={!color}>{text}</Text>
}

function Done({ seconds }) {
  return (
    <Box marginTop={1}>
      <Text color="green">✓</Text>
      <Text dimColor>{` Done · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`}</Text>
    </Box>
  )
}

/** One row per entry; the kind decides which component renders it. */
export function Messages({ items }) {
  return (
    <Box flexDirection="column">
      {items.map((m) => {
        const key = m.id
        if (m.kind === 'user') return <UserMessage key={key} text={m.text} />
        if (m.kind === 'tool') return <ToolUse key={key} {...m} />
        if (m.kind === 'result') return <ToolResult key={key} {...m} />
        if (m.kind === 'text') return <AssistantText key={key} text={m.text} />
        if (m.kind === 'done') return <Done key={key} seconds={m.seconds} />
        return <Notice key={key} text={m.text} tone={m.tone} />
      })}
    </Box>
  )
}
