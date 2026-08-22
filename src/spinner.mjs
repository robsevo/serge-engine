/**
 * The thinking indicator.
 *
 * Reads the same `spinnerVerbs` and `spinnerStyle` the brain already configures,
 * so a Serge install looks like itself here rather than like a generic tool.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. Between sending a request and the first
 * token there is a gap — often several seconds on a free-tier seat, longer when
 * the router is failing over. With nothing on screen, that gap is
 * indistinguishable from a hang, and the honest response to a hang is Ctrl+C.
 * The spinner's real job is to say "still working, this long, this many tokens"
 * so nobody kills a turn that was about to answer.
 *
 * IT WRITES TO STDERR, deliberately. Model output goes to stdout; mixing an
 * animation into that stream corrupts anything piping or redirecting the reply.
 * It also disables itself when stderr is not a TTY, so a scripted run produces
 * clean output instead of thousands of escape sequences.
 */
import { stderr } from 'node:process'

const FALLBACK_VERBS = [
  'Thinking', 'Working', 'Considering', 'Reasoning', 'Composing', 'Weighing',
]

/** Braille dots: a smooth, single-width spinner that never wraps a line. */
const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Cat frames, matching `spinnerStyle: "cat"`. Two-phase tail and ear movement —
 * enough motion to read as alive, few enough frames to stay legible at 100ms.
 */
// Mouth only, and only from characters that are in essentially every terminal
// font. The katakana `ェ` looked right in one font and rendered as a replacement
// box in the user's — a broken glyph animating four times a second is worse than
// no animation at all.
const CAT = ['(=^·ω·^=)', '(=^·o·^=)', '(=^·ω·^=)', '(=^·-·^=)']

const STYLES = {
  cat: (i) => `${DOTS[i % DOTS.length]} ${CAT[Math.floor(i / 3) % CAT.length]}`,
  dots: (i) => DOTS[i % DOTS.length],
  none: () => '',
}

export function loadSpinnerConfig(settings = {}) {
  const sv = settings.spinnerVerbs
  let verbs = Array.isArray(sv?.verbs) ? sv.verbs.filter((v) => typeof v === 'string') : []
  // mode "replace" means the configured list stands alone; anything else appends
  // to the defaults, which is what a partial override expects.
  if (sv?.mode !== 'replace') verbs = FALLBACK_VERBS.concat(verbs)
  if (!verbs.length) verbs = FALLBACK_VERBS
  const style = STYLES[settings.spinnerStyle] ? settings.spinnerStyle : 'cat'
  return { verbs, style }
}

export function createSpinner({ settings = {}, stream = stderr, intervalMs = 100 } = {}) {
  const { verbs, style } = loadSpinnerConfig(settings)
  const render = STYLES[style]
  const live = Boolean(stream.isTTY)

  let timer = null
  let frame = 0
  let startedAt = 0
  let verb = verbs[0]
  let detail = ''
  let width = 0

  const clear = () => {
    if (!live || !width) return
    stream.write(`\r${' '.repeat(width)}\r`)
    width = 0
  }

  const paint = () => {
    if (!live) return
    const secs = Math.floor((Date.now() - startedAt) / 1000)
    // A new verb every ~7s: often enough to show progress, rarely enough that
    // the eye is not chasing a word that changes faster than it can be read.
    if (secs > 0 && secs % 7 === 0 && frame % 10 === 0) {
      verb = verbs[Math.floor(Math.random() * verbs.length)]
    }
    const line = `  ${render(frame)} ${verb}… ${secs}s${detail ? ` · ${detail}` : ''}`
    clear()
    stream.write(`\x1b[2m${line}\x1b[0m`)
    width = line.length
    frame++
  }

  return {
    get active() { return timer !== null },

    /**
     * The current frame as a string, for a caller that owns the screen.
     *
     * When a status pane is present the spinner must not write anywhere itself —
     * two things painting the same terminal race, and the loser leaves half a
     * line behind. The pane asks for a frame and places it.
     */
    frame(detailOverride = null) {
      const secs = Math.floor((Date.now() - startedAt) / 1000)
      if (secs > 0 && secs % 7 === 0 && frame % 10 === 0) {
        verb = verbs[Math.floor(Math.random() * verbs.length)]
      }
      const d = detailOverride ?? detail
      frame++
      return `${render(frame)} ${verb}… ${secs}s${d ? ` · ${d}` : ''}`
    },

    /** Advance state without drawing — for pane-driven rendering. */
    begin(initialDetail = '') {
      startedAt = Date.now()
      frame = 0
      detail = initialDetail
      verb = verbs[Math.floor(Math.random() * verbs.length)]
    },

    start(initialDetail = '') {
      if (timer || !live) { startedAt = Date.now(); detail = initialDetail; return }
      startedAt = Date.now()
      frame = 0
      detail = initialDetail
      verb = verbs[Math.floor(Math.random() * verbs.length)]
      paint()
      timer = setInterval(paint, intervalMs)
      // An unref'd timer never keeps the process alive on its own — otherwise a
      // crash mid-turn would leave the CLI hanging on a spinner nobody can see.
      timer.unref?.()
    },

    /** Live detail: token counts, the tool being run. */
    update(text) { detail = text },

    stop() {
      if (timer) { clearInterval(timer); timer = null }
      clear()
    },

    /** Seconds since start, for the turn summary. */
    elapsed() { return startedAt ? (Date.now() - startedAt) / 1000 : 0 },
  }
}
