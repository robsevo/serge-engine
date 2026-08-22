import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

/**
 * The input line.
 *
 * A small line editor rather than a full one: printable characters, backspace,
 * word-delete, home/end, and history. Ink owns the keyboard, so readline cannot
 * also be running — the two would fight over stdin.
 */
export function PromptInput({ onSubmit, onCycleMode, onInterrupt, busy, history }) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [histIdx, setHistIdx] = useState(-1)

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onInterrupt(); return }
    if (key.shift && key.tab) { onCycleMode(); return }
    if (busy) return                       // keystrokes during a turn are ignored

    // Enter arrives two ways. A person typing produces `key.return` with empty
    // input; anything piping into the process delivers a whole line at once —
    // `"ab\n"` with key.return FALSE — so the newline has to be found in the
    // text as well, or scripted input never submits.
    const nl = input.indexOf('\n') >= 0 ? input.indexOf('\n') : input.indexOf('\r')
    if (key.return || nl >= 0) {
      const head = nl >= 0 ? input.slice(0, nl) : ''
      const text = (value.slice(0, cursor) + head + value.slice(cursor)).trim()
      setValue(''); setCursor(0); setHistIdx(-1)
      if (text) onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setValue(value.slice(0, cursor - 1) + value.slice(cursor))
      setCursor(cursor - 1)
      return
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return }
    if (key.upArrow) {
      const i = Math.min(history.length - 1, histIdx + 1)
      if (i < 0) return
      setHistIdx(i); setValue(history[history.length - 1 - i] ?? ''); setCursor(999)
      return
    }
    if (key.downArrow) {
      const i = histIdx - 1
      setHistIdx(i)
      const v = i < 0 ? '' : (history[history.length - 1 - i] ?? '')
      setValue(v); setCursor(v.length)
      return
    }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') { setValue(value.slice(cursor)); setCursor(0); return }
    if (key.ctrl || key.meta || key.escape) return

    setValue(value.slice(0, cursor) + input + value.slice(cursor))
    setCursor(cursor + input.length)
  })

  const c = Math.min(cursor, value.length)
  return (
    <Box>
      <Text color="#6EB4E6">{'❯ '}</Text>
      <Text>{value.slice(0, c)}</Text>
      <Text inverse>{value[c] ?? ' '}</Text>
      <Text>{value.slice(c + 1)}</Text>
    </Box>
  )
}
