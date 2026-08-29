/**
 * How much of the live region is allowed on screen.
 *
 * THE BUG THIS EXISTS TO PREVENT — measured, not guessed. Ink writes an ordinary
 * frame as `eraseLines(n) + frame`, but the moment a frame is TALLER THAN THE
 * VIEWPORT it takes a different path (ink.js:756 `shouldClearTerminalForFrame`,
 * `nextOutputHeight > viewportRows`) and writes instead:
 *
 *     clearTerminal + fullStaticOutput + frame
 *
 * `clearTerminal` is `ESC[2J ESC[3J ESC[H` — erase the screen, erase the
 * SCROLLBACK, home the cursor — and `fullStaticOutput` is every committed row of
 * the whole session replayed from the top. On the 80ms animation tick that runs
 * while a turn is in flight, that is once every 80ms.
 *
 * That is the flicker, and it is also why the view jumps to the top of the
 * terminal: it literally is the top, redrawn. Ink then clears once more on the
 * way back down (`isLeavingFullscreen`), which is the jump at the end of a turn.
 *
 * Measured on a 110x32 pty with a stubbed session (tests/live-region.test.mjs):
 *
 *     reply lines   16   17   18   20   24   30   40
 *     clearTerminal  0    0    1    2    4    7   12
 *
 * 18 lines. Not a pathological reply — a short one. The fix is not to make the
 * clear cheaper, it is to never hand Ink a frame that is taller than the
 * viewport, which is what this module computes.
 */

/** Rows the chrome below the live region always occupies while a turn runs. */
// spinner 2 · mascot+identity 5 · rule 1 · input 1 · rule 1 · status 2, plus the
// newline Ink appends. Measured at 13 on the pty harness; 14 keeps a row of
// slack so a one-row miscount cannot put us back over the edge.
export const CHROME_ROWS = 14

/** Rows a logical line takes once the terminal has wrapped it. */
export function rowsFor(line, width) {
  const w = Math.max(1, width | 0)
  // Array.from, not .length: an emoji or CJK glyph is one column-pair, and
  // counting UTF-16 code units over-estimates rather than under-estimates —
  // which is the safe direction for a budget.
  const n = Array.from(String(line ?? '')).length
  return n === 0 ? 1 : Math.ceil(n / w)
}

/**
 * The last `maxRows` rows of `text`, whole lines where possible.
 *
 * @returns {{text: string, hidden: number}} `hidden` counts the logical lines
 *   dropped off the top — the caller says so on screen rather than silently
 *   showing a fragment as though it were the whole reply.
 */
export function tailToRows(text, maxRows, width) {
  const s = String(text ?? '')
  if (maxRows <= 0) return { text: '', hidden: s ? s.split('\n').length : 0 }
  const lines = s.split('\n')

  let rows = 0
  let i = lines.length
  while (i > 0) {
    const r = rowsFor(lines[i - 1], width)
    if (rows + r > maxRows) break
    rows += r
    i--
  }

  // Nothing fit — one line is on its own taller than the whole budget. Show its
  // tail rather than nothing: a wrapped paragraph mid-stream is the common case
  // here, and an empty live region reads as a hang.
  if (i === lines.length) {
    const last = lines[lines.length - 1]
    const keep = Math.max(1, maxRows * Math.max(1, width | 0))
    const chars = Array.from(last)
    return {
      text: chars.length > keep ? chars.slice(chars.length - keep).join('') : last,
      hidden: lines.length - 1,
    }
  }

  return { text: lines.slice(i).join('\n'), hidden: i }
}

/**
 * Rows available to the streaming reply, after everything else in the live
 * region has taken its share.
 */
export function liveBudget({ rows, todoRows = 0, promptRows = 0 }) {
  return Math.max(0, (rows || 24) - CHROME_ROWS - todoRows - promptRows)
}
