import React from 'react'
import { Box, Text, useStdout } from 'ink'
import { renderMarkdown } from './markdown.jsx'

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

/**
 * Longest line of prose, in columns.
 *
 * Two reasons, and the typographic one came first: a paragraph set across 150
 * columns is genuinely hard to read — the eye loses the line on the return
 * sweep, which is why books settle near 65-90 characters.
 *
 * It also limits an ugliness that cannot be fixed properly. Finished turns are
 * committed to scrollback and never redrawn, so text wrapped at 150 columns is
 * re-broken BY THE TERMINAL when the window narrows — and terminals break
 * mid-word, where Ink breaks between words. Capping the measure means narrowing
 * to anything above this leaves the transcript untouched. Narrowing below it
 * still re-breaks; nothing short of re-rendering scrollback can prevent that,
 * and scrollback is not ours to re-render.
 */
const MAX_MEASURE = 96

function AssistantText({ text }) {
  const { stdout } = useStdout()
  // flexGrow and width fight, and flexGrow wins — the cap did nothing until
  // this became a computed width. `- 3` leaves the marker column and a right
  // margin, and `||` (not `??`) because a pty with no window size reports 0.
  const cols = stdout?.columns || process.stdout.columns || 80
  const width = Math.max(24, Math.min(MAX_MEASURE, cols - 3))
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}><Text>{BLACK_CIRCLE}</Text></Box>
      <Box flexDirection="column" width={width}>{renderMarkdown(text)}</Box>
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
