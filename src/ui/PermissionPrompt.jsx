import React from 'react'
import { Box, Text, useInput } from 'ink'

/**
 * The permission prompt.
 *
 * `ask` means "a human could answer this". The engine resolves an unanswerable
 * ask to a refusal, which is right headless and wrong with someone sitting at
 * the terminal — and until this existed the TUI passed no `onAsk` at all, so
 * every ask fell through to that refusal. The visible symptom was Serge unable
 * to run a single Bash command interactively in default mode.
 *
 * Three answers, because two is not enough: `yes` for this call, `no`, and
 * `always` for every call of this tool for the rest of the session — the last
 * is what stops a ten-step task asking ten times.
 */
const BLUE = '#6EB4E6'

export function PermissionPrompt({ tool, input, reason, onAnswer }) {
  useInput((ch, key) => {
    const c = String(ch || '').toLowerCase()
    if (key.escape || c === 'n') { onAnswer('no'); return }
    if (c === 'y' || key.return) { onAnswer('yes'); return }
    if (c === 'a') { onAnswer('always'); return }
  })

  const subject = String(
    input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? '',
  ).replace(/\s+/g, ' ').slice(0, 96)

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={BLUE} paddingX={1}>
      <Box>
        <Text color={BLUE} bold>{tool}</Text>
        {subject ? <Text>{'  ' + subject}</Text> : null}
      </Box>
      {reason ? <Text dimColor>{String(reason).split('\n')[0].slice(0, 96)}</Text> : null}
      <Box marginTop={1}>
        <Text color={BLUE}>{'y'}</Text><Text dimColor>{' allow once   '}</Text>
        <Text color={BLUE}>{'a'}</Text><Text dimColor>{' allow every ' + tool + ' this session   '}</Text>
        <Text color={BLUE}>{'n'}</Text><Text dimColor>{' decline (esc)'}</Text>
      </Box>
    </Box>
  )
}
