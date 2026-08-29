import React, { useState, useMemo, useEffect } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { complete } from '../commands.mjs'

const BLUE = '#6EB4E6'
const MAX_ROWS = 8

/**
 * Most rows the input itself may occupy.
 *
 * Bounded because the input is part of the LIVE region, and a live region taller
 * than the viewport is what makes Ink wipe the terminal on every frame
 * (ui/live.mjs). Pasting a 300-line stack trace must not reintroduce that, so a
 * long value is windowed onto the end and the rest is counted.
 */
export const MAX_INPUT_ROWS = 6

/** Rows `PromptLine` will draw — App budgets the live region against this, so
 *  the two have to agree. Kept beside the render for that reason. */
export function promptRowsFor(value, maxRows = MAX_INPUT_ROWS) {
  const lines = String(value ?? '').split('\n')
  if (lines.length === 1) return 1
  const shown = Math.min(lines.length, Math.max(1, maxRows))
  return shown + (lines.length > shown ? 1 : 0)
}

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
export function PromptLine({ value, cursor, maxRows = MAX_INPUT_ROWS }) {
  const c = Math.min(cursor, value.length)

  // The single-line case is left exactly as it was — one <Text>, nothing
  // nested beside it — because that shape is the fix for the wrap bug above and
  // tests/prompt-wrap.test.mjs pins it character for character.
  if (!value.includes('\n')) {
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

  // Multi-line: one <Text> per line, same nesting rule within each.
  const lines = value.split('\n')
  // Where the cursor sits, in (row, column). Each line costs its length plus the
  // newline that ended it.
  let row = 0
  let col = c
  for (const line of lines) {
    if (col <= line.length) break
    col -= line.length + 1
    row++
  }
  const cap = Math.max(1, maxRows)
  // Window onto the END, keeping the cursor's row on screen: after a paste the
  // cursor is at the end, and the end is what you are about to type against.
  const start = lines.length <= cap
    ? 0
    : Math.min(Math.max(0, row - cap + 1), lines.length - cap)
  const shown = lines.slice(start, start + cap)
  const hidden = lines.length - shown.length

  return (
    <Box flexDirection="column">
      {hidden ? <Text dimColor>{`  … ${hidden} more line(s)`}</Text> : null}
      {shown.map((line, i) => {
        const n = start + i
        // On the first VISIBLE row, not on line 0: once a long paste has
        // scrolled, line 0 is off screen and keying the marker to it left the
        // box with no marker at all — it stopped looking like an input.
        const marker = i === 0 ? '❯ ' : '  '
        if (n !== row) {
          return (
            <Text key={n} wrap="wrap">
              <Text color={BLUE}>{marker}</Text>
              {line}
            </Text>
          )
        }
        return (
          <Text key={n} wrap="wrap">
            <Text color={BLUE}>{marker}</Text>
            {line.slice(0, col)}
            <Text inverse>{line[col] ?? ' '}</Text>
            {line.slice(col + 1)}
          </Text>
        )
      })}
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
export function PromptInput({ onSubmit, onCycleMode, onInterrupt, onStop, busy, history, commands, maxRows = MAX_INPUT_ROWS, onHeight }) {
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

  /**
   * A paste is text, not a command to run it.
   *
   * Before this, pasting anything with a newline SUBMITTED THE FIRST LINE AND
   * DISCARDED THE REST. The handler below looks for a newline inside `input`
   * because piped input arrives that way, and a terminal without bracketed paste
   * mode delivers a paste through exactly the same channel — indistinguishable.
   * So pasting a six-line function and asking for a review sent one sentence and
   * threw the function away, silently, and the answer was about the sentence.
   *
   * `usePaste` turns bracketed paste mode on (ESC[?2004h), so the terminal wraps
   * pasted text in ESC[200~ … ESC[201~ and Ink routes it here instead of to
   * `useInput` — which is what finally makes the two distinguishable. The
   * newline branch in `useInput` stays exactly as it was, because piped and
   * scripted input still arrive that way and must still submit.
   *
   * Ignored while busy, matching the keystroke rule directly below: a prompt
   * half-assembled behind a running turn is the thing that guard exists to stop,
   * and paste-but-not-type would be a strange half-state to leave someone in.
   */
  usePaste((text) => {
    if (busy) return
    // CRLF from a Windows clipboard, and a trailing newline from copying whole
    // lines — the first would render as a stray character, the second as an
    // empty line under the cursor that nobody typed.
    const chunk = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    if (!chunk) return
    setValue(value.slice(0, cursor) + chunk + value.slice(cursor))
    setCursor(cursor + chunk.length)
    setSel(0)
  })

  // The live region is budgeted against this (ui/live.mjs), and only this
  // component knows how tall it is about to be.
  const rows = promptRowsFor(value, maxRows)
  useEffect(() => { onHeight?.(rows) }, [rows, onHeight])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onInterrupt(); return }
    if (key.shift && key.tab) { onCycleMode(); return }

    // Escape stops the turn, and is handled BEFORE the busy guard below.
    // That guard is right to drop ordinary typing mid-turn — a half-written
    // next prompt should not accumulate behind a running one — but it was also
    // swallowing the single key whose entire job is to reach a running turn.
    // So the only way to stop Serge was ctrl-c, which people reach for to quit,
    // not to interrupt. Escape now always interrupts while busy.
    //
    // When idle it keeps its other job: closing the command menu by clearing
    // the line's command-ness, not by a flag.
    if (key.escape) {
      if (busy) { onStop(); return }
      if (open) set('')
      return
    }

    if (busy) return                       // other keystrokes during a turn are ignored

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
    // A newline you asked for. Enter submits — that has to stay predictable, or
    // a multi-line value becomes impossible to send — so the second line needs
    // its own key. ctrl-j is what readline has always used for it.
    if (key.ctrl && (input === 'j' || input === '\n')) {
      setValue(value.slice(0, cursor) + '\n' + value.slice(cursor))
      setCursor(cursor + 1)
      setSel(0)
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
      <PromptLine value={value} cursor={c} maxRows={maxRows} />
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
