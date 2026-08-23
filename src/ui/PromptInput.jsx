import React, { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { complete } from '../commands.mjs'

const BLUE = '#6EB4E6'
const MAX_ROWS = 8

/**
 * The line itself: prompt marker, text, block cursor.
 *
 * ONE Text node, with the marker and the cursor NESTED inside it. This was four
 * SIBLING Text nodes in a row <Box>, and Ink wraps each sibling independently:
 * once the line was wide enough to wrap, the character sitting on the break was
 * consumed and the space after `❯` was trimmed away. At 40 columns
 * `…nintendo switch with…` drew as `…nintendo switc` / `with…` — the h gone from
 * the screen while still present in state, so retyping never brought it back and
 * only a resize (which makes Ink clear and replay) restored it.
 *
 * Pure on purpose: the keyboard lives in PromptInput, so this can be rendered at
 * any width with any cursor position — see tests/prompt-wrap.test.mjs.
 */
export function PromptLine({ value, cursor }) {
  const c = Math.min(cursor, value.length)
  return (
    <Box>
      <Text wrap="wrap">
        <Text color={BLUE}>{'❯ '}</Text>
        {value.slice(0, c)}
        <Text inverse>{value[c] ?? ' '}</Text>
        {value.slice(c + 1)}
      </Text>
    </Box>
  )
}

/**
 * The input line, and the command menu that opens under it.
 *
 * A small line editor rather than a full one: printable characters, backspace,
 * word-delete, home/end, and history. Ink owns the keyboard, so readline cannot
 * also be running — the two would fight over stdin.
 *
 * The menu opens as soon as the line is a bare `/…` with no space in it yet.
 * Once you type a space you are writing the command's ARGUMENT, and the menu
 * has nothing left to offer, so it closes and gives ↑↓ back to history.
 */
export function PromptInput({ onSubmit, onCycleMode, onInterrupt, busy, history, commands }) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [histIdx, setHistIdx] = useState(-1)
  const [sel, setSel] = useState(0)

  // Menu state is derived from the text, never stored: a second source of truth
  // for "is the menu open" is a source of truth that can disagree with the line.
  const query = value.startsWith('/') && !value.includes(' ') ? value.slice(1) : null
  const matches = useMemo(
    () => (query === null ? [] : complete(query, commands)),
    [query, commands],
  )
  const open = query !== null && matches.length > 0
  const pick = matches[Math.min(sel, matches.length - 1)]

  const set = (v, c = v.length) => { setValue(v); setCursor(c); setSel(0) }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onInterrupt(); return }
    if (key.shift && key.tab) { onCycleMode(); return }
    if (busy) return                       // keystrokes during a turn are ignored

    // Escape closes the menu by clearing the line's command-ness, not by a flag.
    if (key.escape) { if (open) set(''); return }

    if (open && key.tab) { set('/' + pick.name + ' '); return }
    if (open && (key.upArrow || key.downArrow)) {
      const n = matches.length
      setSel((s) => (key.upArrow ? (s - 1 + n) % n : (s + 1) % n))
      return
    }

    // Enter arrives two ways. A person typing produces `key.return` with empty
    // input; anything piping into the process delivers a whole line at once —
    // `"ab\n"` with key.return FALSE — so the newline has to be found in the
    // text as well, or scripted input never submits.
    const nl = input.indexOf('\n') >= 0 ? input.indexOf('\n') : input.indexOf('\r')
    if (key.return || nl >= 0) {
      // Enter on an OPEN menu completes rather than submits — the name under the
      // cursor is what you were choosing, and submitting the half-typed prefix
      // instead would run the wrong command or none at all.
      if (open && (value.slice(1) !== pick.name)) { set('/' + pick.name + ' '); return }
      const head = nl >= 0 ? input.slice(0, nl) : ''
      const text = (value.slice(0, cursor) + head + value.slice(cursor)).trim()
      setValue(''); setCursor(0); setHistIdx(-1); setSel(0)
      if (text) onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setValue(value.slice(0, cursor - 1) + value.slice(cursor))
      setCursor(cursor - 1)
      setSel(0)
      return
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return }
    if (key.upArrow) {
      const i = Math.min(history.length - 1, histIdx + 1)
      if (i < 0) return
      setHistIdx(i); set(history[history.length - 1 - i] ?? '')
      return
    }
    if (key.downArrow) {
      const i = histIdx - 1
      setHistIdx(i)
      set(i < 0 ? '' : (history[history.length - 1 - i] ?? ''))
      return
    }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') { set(value.slice(cursor), 0); return }
    if (key.ctrl || key.meta) return

    setValue(value.slice(0, cursor) + input + value.slice(cursor))
    setCursor(cursor + input.length)
    setSel(0)
  })

  const c = Math.min(cursor, value.length)
  // A long catalogue scrolls with the selection instead of printing 40 rows and
  // pushing the input off the screen.
  const top = Math.max(0, Math.min(sel - MAX_ROWS + 1, matches.length - MAX_ROWS))
  const shown = matches.slice(top, top + MAX_ROWS)
  const below = matches.length - (top + shown.length)
  const width = Math.max(...matches.map((m) => m.name.length), 8) + 2

  return (
    <Box flexDirection="column">
      <PromptLine value={value} cursor={c} />
      {open ? (
        <Box flexDirection="column" marginTop={0}>
          {shown.map((m, i) => {
            const active = top + i === Math.min(sel, matches.length - 1)
            return (
              // Keyed on source+name, not name: a brain command that shadows
              // a built-in appears TWICE by design (so you can see why your
              // file never runs), and two rows keyed `cost` make React drop
              // one and warn.
              <Box key={m.source + ':' + m.name}>
                <Text color={active ? BLUE : undefined} bold={active}>
                  {(active ? ' ❯ ' : '   ') + ('/' + m.name).padEnd(width)}
                </Text>
                <Text dimColor>{m.description.slice(0, 62)}</Text>
              </Box>
            )
          })}
          {below > 0 ? (
            // Counts what is actually still BELOW the window, so the number
            // falls as you scroll. Guarding on the LIST being long enough to
            // scroll rather than on anything actually being hidden printed
            // "… 0 more" at the bottom of the list.
            <Text dimColor>{`   … ${below} more`}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
