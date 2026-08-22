/**
 * A pinned status pane, using the terminal's own scroll region.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT COST. A full-screen TUI is normally built
 * one of two ways, and both charge for it:
 *
 *   alternate screen buffer   gives you the whole screen, and takes your
 *                             scrollback with it. For an agent that prints code
 *                             and diffs, losing scrollback is losing the work.
 *   a rendering framework     gives you panes, and takes a dependency tree into
 *                             a process that reads your filesystem and runs
 *                             shell commands.
 *
 * There is a third mechanism older than both. DECSTBM (`ESC [ top;bottom r`)
 * tells the terminal to scroll only part of the screen. Set it to everything but
 * the last N rows and those rows stop scrolling: output flows above them,
 * scrollback keeps working normally, and the reserved rows are ours to paint.
 * No alt-screen, no dependency, and it is in every terminal that speaks VT100.
 *
 * THE THINGS THAT GO WRONG, and what is done about each:
 *   - cursor drift: painting the pane moves the cursor, which would land the
 *     next output in the wrong place. Every paint is wrapped in save/restore
 *     (ESC 7 / ESC 8).
 *   - resize: SIGWINCH invalidates the region. It is re-established and
 *     repainted, debounced, because a drag emits a burst of them.
 *   - a terminal too short to divide: below MIN_ROWS the pane disables itself
 *     rather than squeezing the conversation into two lines.
 *   - leaving state behind: the region MUST be reset on exit, including on a
 *     crash, or the user's shell inherits a broken terminal. Teardown runs from
 *     process exit handlers, not only from the happy path.
 */
import { stdout } from 'node:process'

const MIN_ROWS = 12
const ESC = '\x1b'

const SAVE = `${ESC}7`
const RESTORE = `${ESC}8`
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`
const CLEAR_LINE = `${ESC}[2K`

const at = (row, col = 1) => `${ESC}[${row};${col}H`
const region = (top, bottom) => `${ESC}[${top};${bottom}r`
const resetRegion = `${ESC}[r`

/** Printable width, ignoring SGR sequences. */
export const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length

/** Truncate to width, eliding the middle so both ends survive. */
export function fit(s, w) {
  const n = visible(s)
  if (n <= w) return s + ' '.repeat(w - n)
  if (w < 8) return s.slice(0, w)
  const over = n - w + 1
  const head = Math.floor((n - over) / 2)
  return `${s.slice(0, head)}…${s.slice(head + over)}`
}

export function createPane({ rows = 2, stream = stdout } = {}) {
  const live = Boolean(stream.isTTY)
  let enabled = false
  let lines = []
  let installed = false
  let resizeTimer = null

  const size = () => ({
    cols: stream.columns || 80,
    rows: stream.rows || 24,
  })

  const teardown = () => {
    if (!enabled) return
    enabled = false
    const { rows: H } = size()
    // Reset the region FIRST, then clear the reserved rows — clearing while the
    // region is still narrowed can leave the bottom lines untouched.
    stream.write(`${resetRegion}${at(Math.max(1, H - rows + 1))}`)
    for (let i = 0; i < rows; i++) stream.write(`${CLEAR_LINE}\n`)
    stream.write(`${at(Math.max(1, H - rows + 1))}${SHOW}`)
  }

  const install = () => {
    const { rows: H } = size()
    if (!live || H < MIN_ROWS) { enabled = false; return }
    enabled = true
    // Scrolling area is everything above the reserved rows. Park the cursor at
    // the bottom of it so the first output appears where the user expects.
    stream.write(`${region(1, H - rows)}${at(H - rows)}`)
  }

  const paint = () => {
    if (!enabled) return
    const { cols, rows: H } = size()
    let out = SAVE + HIDE
    for (let i = 0; i < rows; i++) {
      out += at(H - rows + 1 + i) + CLEAR_LINE + fit(lines[i] ?? '', cols)
    }
    out += RESTORE + SHOW
    stream.write(out)
  }

  const onResize = () => {
    if (!enabled && live) return
    clearTimeout(resizeTimer)
    // A drag emits a burst; re-establishing the region on every one flickers.
    resizeTimer = setTimeout(() => { install(); paint() }, 60)
    resizeTimer.unref?.()
  }

  return {
    get enabled() { return enabled },

    start() {
      if (installed) return
      installed = true
      install()
      paint()
      stream.on?.('resize', onResize)
      // A crash must not leave the shell with a narrowed scroll region.
      process.once('exit', teardown)
      process.once('SIGTERM', () => { teardown(); process.exit(143) })
    },

    /** Replace the pane's contents. Cheap enough to call per token. */
    set(newLines) {
      lines = Array.isArray(newLines) ? newLines : [String(newLines)]
      paint()
    },

    stop() {
      stream.off?.('resize', onResize)
      clearTimeout(resizeTimer)
      teardown()
      installed = false
    },
  }
}
