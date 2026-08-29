import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Static, useApp, useStdout } from 'ink'
import { Messages } from './Messages.jsx'
import { SergeBar } from './SergeBar.jsx'
import { StatusBar } from './StatusBar.jsx'
import { Spinner } from './Spinner.jsx'
import { PromptInput, MAX_INPUT_ROWS } from './PromptInput.jsx'
import { PermissionPrompt } from './PermissionPrompt.jsx'
import { QuestionPrompt } from './QuestionPrompt.jsx'
import { Todos, todoRowsFor, TODO_MAX } from './Todos.jsx'
import { Queued, queuedRowsFor } from './Queued.jsx'
import { Rule } from './Rule.jsx'
import { POSES } from './Clawd.jsx'
import { renderStatusLineAsync } from '../statusline.mjs'
import { MODES } from '../permissions.mjs'
import { loadSpinnerConfig } from '../spinner.mjs'
import { dispatch, parseCommand } from '../commands.mjs'
import { tailToRows, liveBudget } from './live.mjs'

/** Tools whose calls are the agent's own plumbing, not work the reader follows. */
const QUIET_TOOLS = new Set(['Skill'])
const CYCLE = ['default', 'acceptEdits', 'plan', 'fullAccess']
const COMPACT_AT = Number(process.env.SERGE_COMPACT_AT || 400_000)

export function App({ session, settings, cwd, version, commands, seats, mcp, sessions, onExit }) {
  // Completed rows go in <Static>: Ink writes them once and never touches them
  // again, so the transcript scrolls normally and only the live region redraws.
  const [done, setDone] = useState([])
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState(0)
  const [mode, setMode] = useState(session.mode)
  const [status, setStatus] = useState('')
  const [ctx, setCtx] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [tokens, setTokens] = useState('')
  // The reply as it arrives. Tokens land in a ref and are flushed to state on
  // the animation tick — a setState per token re-renders the whole tree
  // hundreds of times a second, which is what made a turn feel like it froze
  // rather than typed.
  // The permission question currently on screen, and the resolver that the
  // engine's `onAsk` is awaiting. Holding the resolver in state is what lets a
  // keypress far away in the component tree answer a promise the loop is
  // blocked on.
  const [ask, setAsk] = useState(null)
  const [question, setQuestion] = useState(null)
  const [todos, setTodos] = useState([])
  // Typed during a turn, not yet handed to the loop. Mirrors session.pending
  // rather than owning it: the loop drains that array on its own schedule, so a
  // copy the UI kept would go stale the moment it did.
  const [queued, setQueued] = useState([])
  const [stream, setStream] = useState('')
  const streamBuf = useRef('')
  const thinkChars = useRef(0)
  const [thinking, setThinking] = useState(0)
  const history = useRef([])
  const idRef = useRef(0)
  const abortRef = useRef(null)
  // submit calls itself to pick up a queue the turn never got to, and a
  // useCallback cannot name itself.
  const submitRef = useRef(null)
  const startRef = useRef(0)
  const { exit } = useApp()

  // Re-render on resize.
  //
  // Ink's own resize handler calls onRender, but the React tree it renders is
  // identical, so the output string matches what it last wrote and log-update
  // skips the write. The rules then keep the width they were drawn at: a
  // 129-column rule left on a 95-column terminal wraps into 95 + 34, which is
  // the doubled-rule overlap you see after dragging the window.
  //
  // Bumping state makes the frame genuinely different, so it is actually
  // written. `Rule` reads stdout.columns at render time, so one bump is enough
  // for every width-dependent component.
  // A resize renders ONE deliberately over-tall frame, then returns to normal.
  //
  // Ink already knows how to repaint correctly — ink.js:768 writes
  // `clearTerminal + fullStaticOutput + outputToRender`, wiping the screen and
  // replaying the entire transcript at the new width. It just only takes that
  // path when a frame overflows the viewport (ink.js:104), which this one never
  // does. Making one frame overflow on purpose is how you ask for it.
  //
  // Everything else fails for the same underlying reason: Ink's erase counts
  // STRING lines, not terminal rows (log-update.js:47), so once a reflow has
  // wrapped a line nobody — Ink or caller — knows how many rows are really on
  // screen. Serge's own Ink fork reaches this conclusion too and full-resets on
  // any width change (log-update.ts:138).
  // Driven by a COUNTER, not a boolean. setRepaint(true) while already true is
  // a React no-op — no re-render, so the effect that clears it never re-ran and
  // the spacer stuck on screen as a permanent gap. Dragging a window fires many
  // resize events, so that state was reached immediately.
  const [cols, setCols] = useState(process.stdout.columns || 80)
  // Rows matter as much as columns now: the live region is budgeted against
  // them, and a budget computed from a stale height is the bug it prevents.
  const [rows, setRows] = useState(process.stdout.rows || 24)
  // How tall the input has grown. It is one row until something multi-line is
  // pasted into it, and it is part of the live region either way — so the budget
  // below has to know, or a pasted stack trace puts the frame back over the
  // viewport and Ink starts wiping the terminal again.
  const [inputRows, setInputRows] = useState(1)
  const [resizeTick, setResizeTick] = useState(0)
  const [tall, setTall] = useState(false)

  useEffect(() => {
    const onResize = () => {
      setCols(process.stdout.columns || 80)
      setRows(process.stdout.rows || 24)
      setResizeTick((n) => n + 1)
    }
    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize) }
  }, [])

  useEffect(() => {
    if (!resizeTick) return
    setTall(true)
    // Long enough that Ink, which throttles renders, actually writes the tall
    // frame — reverting in the same tick collapses both into one render and no
    // clear happens at all. The cleanup makes a burst of resize events
    // re-arm rather than pile up.
    const t = setTimeout(() => setTall(false), 60)
    return () => clearTimeout(t)
  }, [resizeTick])

  const verbs = useRef(loadSpinnerConfig(settings).verbs)
  const verb = useRef(verbs.current[0])

  const push = useCallback((row) => {
    setDone((prev) => [...prev, { ...row, id: ++idRef.current }])
  }, [])

  /**
   * Commit whatever prose has streamed so far and start the live buffer over.
   *
   * Two bugs in one. The buffer was NEVER cleared inside a turn, so a turn with
   * five tool calls held all five preambles in the live region at once, growing
   * without bound — which is precisely the height that makes Ink wipe the
   * terminal on every frame (ui/live.mjs). And only the FINAL text was ever
   * pushed to <Static>, so every one of those preambles vanished when the turn
   * ended: text you watched arrive, gone from the transcript.
   *
   * Called at the boundaries where prose is finished by definition — a tool
   * call, a gate sending the turn back — so the committed copy is a whole
   * message, not a fragment, and `renderMarkdown` sees a complete fence.
   */
  const flushStream = useCallback(() => {
    const text = streamBuf.current.trim()
    streamBuf.current = ''
    setStream('')
    if (text) push({ kind: 'text', text })
  }, [push])

  // Awaited, never spawnSync. The status line is a shell script the brain owns,
  // it is allowed five seconds, and a synchronous spawn spends every one of them
  // with the event loop stopped — no frames, no timers, no keystrokes. The
  // context meter does not wait on it: that number is ours and is instant.
  const refreshStatus = useCallback(() => {
    setCtx(Math.min(99, Math.round((session.contextChars / COMPACT_AT) * 100)))
    renderStatusLineAsync({
      settings, sessionId: session.sessionId, cwd,
      model: session.model, usage: session.usage,
    }).then((line) => setStatus(line || session.model))
  }, [session, settings, cwd])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // One timer drives the whole animation: mascot pose, feet, spinner and clock.
  // 80ms because that is the braille spinner's own tick — a slower interval
  // aliases it and the spin visibly stutters. The eyes run at 120ms off the
  // same elapsed clock rather than a second timer, which is what keeps the two
  // cadences independent without two intervals fighting for renders.
  //
  // The dependency list is [busy] and must stay [busy]. It used to also carry
  // `stream` and `thinking`, which this very interval sets — so every flushed
  // chunk changed a dep, tore the interval down and built a new one. While a
  // reasoning seat streamed, that happened continuously: the 80ms clock never
  // completed a period, frames landed at whatever irregular cadence the chunks
  // arrived at, and the whole dynamic region — spinner, bar, and the input line
  // under them — repainted out of step with itself. That is the flicker.
  //
  // Reading the buffers through refs is what makes [busy] correct: a ref is not
  // a dependency. The two setters are then safe to call unconditionally,
  // because React bails out of a re-render when the next value is Object.is-equal
  // to the current one — so an idle tick still costs no paint.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      setFrame((f) => {
        if (f % 88 === 0) verb.current = verbs.current[Math.floor(Math.random() * verbs.current.length)]
        return f + 1
      })
      setElapsed((Date.now() - startRef.current) / 1000)
      // Flush whatever arrived since the last tick, in one render.
      setStream(streamBuf.current)
      setThinking(thinkChars.current)
    }, 80)
    return () => clearInterval(t)
  }, [busy])

  const submit = useCallback(async (text) => {
    history.current.push(text)
    push({ kind: 'user', text })

    // A slash command is answered here, by the same dispatcher the readline
    // front-end uses. Only a brain-authored command becomes a prompt; the rest
    // never reach the model, which is the point — `/cost` is a question about
    // the session, and asking the model would spend the tokens it reports.
    const cmd = dispatch(text, { session, seats, mcp, commands, sessions })
    if (cmd) {
      if (cmd.exit) { onExit?.(); exit(); return }
      if (cmd.unknown) {
        push({ kind: 'notice', text: `unknown command /${cmd.unknown} — try /help`, tone: 'warn' })
        return
      }
      if (cmd.lines) {
        push({ kind: 'text', text: cmd.lines.join('\n'), tone: cmd.tone })
        if (cmd.mode) setMode(cmd.mode)
        if (cmd.cleared) setDone([])
        refreshStatus()
        return
      }
      if (cmd.prompt) { text = cmd.prompt }   // a brain command: send its body
    }

    // Armed BEFORE the busy state is shown rather than after the yield below.
    // Escape has to be live for exactly as long as the spinner is, and a
    // controller that does not exist yet cannot be aborted. Created after the
    // yield, there was a window covering the brain's ~488ms of
    // UserPromptSubmit hooks in which an interrupt found no controller and
    // fell through to the quit path — pressing escape early closed the
    // session instead of stopping the turn.
    abortRef.current = new AbortController()
    setBusy(true)
    streamBuf.current = ''
    setStream('')
    thinkChars.current = 0
    setThinking(0)
    startRef.current = Date.now()

    // Let Ink PAINT the busy state before the blocking work starts.
    //
    // runHooks uses spawnSync, and the brain wires 17 hooks to UserPromptSubmit
    // — measured at 488ms of blocked event loop. setBusy(true) only schedules a
    // React update; without this yield, session.send() blocks in the same tick
    // and the spinner never appears until the hooks are done. Pressing Enter
    // froze for half a second and then caught up, which is exactly what a
    // blocked render loop looks like from the outside.
    //
    // A macrotask, not a microtask: React flushes and Ink writes the frame on
    // the way through, and neither happens if we only await a resolved promise.
    await new Promise((resolve) => setTimeout(resolve, 0))
    setFrame(0)
    setElapsed(0)
    setTokens('')
    const before = session.usage
    try {
      const res = await session.send(text, { signal: abortRef.current.signal })
      if (res.blocked) push({ kind: 'notice', text: `blocked: ${res.reason}`, tone: 'warn' })
      else if (res.text) push({ kind: 'text', text: res.text })
      // A turn CAN end with no words: the model ran tools, the last round
      // produced only a tool call, and `final` stayed empty. Printing nothing
      // for that is why it reads as a freeze — the spinner stops, "Done" appears,
      // and the screen looks exactly like a turn that answered off-screen. Say
      // what happened instead.
      // Exhaustion already announced itself through onNotice, so this is only
      // for the quiet case: a turn that simply stopped having anything to say.
      else if (!res.exhausted) push({
        kind: 'notice',
        text: 'the turn ended without a reply — it ran tools and then stopped. '
          + 'Ask it to summarise what it found, or say what you wanted.',
        tone: 'warn',
      })
      // The live region held the same text while it streamed; clearing it here
      // (after the committed copy is pushed) is what hands the reply over to
      // scrollback. Clearing earlier makes it flicker out and back in.
      streamBuf.current = ''
      setStream('')
      const u = session.usage
      const spent = (u.prompt + u.completion) - (before.prompt + before.completion)
      push({ kind: 'done', seconds: (Date.now() - startRef.current) / 1000, spent })
    } catch (e) {
      if (!abortRef.current.signal.aborted) {
        push({ kind: 'notice', text: `error: ${e?.message ?? e}`, tone: 'error' })
      }
    } finally {
      setBusy(false)
      streamBuf.current = ''
      setStream('')
      abortRef.current = null
      refreshStatus()
    }

    // A message still queued now is one the turn never got to.
    //
    // The loop drains its own queue while it runs and refuses to finish while
    // anything is in it, so reaching here with a non-empty queue means the turn
    // did not finish: escape, an error, or forty rounds without an answer. The
    // message was still sent by a person, so it becomes the next turn rather
    // than sitting in a list nothing will read again.
    const carried = session.takePending()
    setQueued([])
    if (carried.length) await submitRef.current?.(carried.map((c) => c.text).join('\n\n'))
  }, [session, push, refreshStatus, seats, mcp, commands, sessions, onExit, exit])

  useEffect(() => { submitRef.current = submit }, [submit])

  /**
   * Enter while a turn is running.
   *
   * Returns whether the line was taken. The input keeps a line it could not
   * queue rather than clearing it — being told why it did not go beats watching
   * a sentence you just typed disappear.
   */
  const queue = useCallback((text) => {
    // A slash command is a question about the SESSION, not a message for the
    // model, and none of them can be answered while the loop owns the session:
    // `/clear` would drop the history the turn is still writing into, `/cost`
    // answered three tool calls later is a number about a different moment, and
    // `/model` would swap the seat mid-conversation. Refused here rather than
    // parked, so it is clear nothing is waiting to happen.
    if (parseCommand(text)) {
      push({
        kind: 'notice',
        text: 'commands do not queue — press escape to stop the turn, then run it',
        tone: 'warn',
      })
      return false
    }
    history.current.push(text)
    session.enqueue(text)
    setQueued(session.pending)
    return true
  }, [session, push])

  // The session reports into the transcript through these.
  useEffect(() => {
    session.ui = {
      onTool(name, input) {
        // Prose that arrived before a tool call is finished prose — commit it
        // before the tool row lands so the two stay in the order they happened.
        flushStream()
        if (QUIET_TOOLS.has(name)) return
        const a = String(input?.command || input?.file_path || input?.pattern
          || input?.query || input?.name || '').replace(/\s+/g, ' ').slice(0, 68)
        push({ kind: 'tool', name, args: a, done: true })
      },
      onToolResult(name, content, isError, diff = null) {
        if (QUIET_TOOLS.has(name) && !isError) return
        const lines = String(content ?? '').trim().split('\n').filter((l) => l.trim())
        push({
          kind: 'result',
          text: (lines[0] ?? '(no output)').replace(/\s+/g, ' ').slice(0, 66),
          extra: lines.length > 1 ? `${lines.length - 1} line${lines.length === 2 ? '' : 's'}` : '',
          isError,
        })
        // The change itself, under the one-line summary. Edit/Write/MultiEdit
        // used to report "applied 3 edit(s)" and nothing else, so a session that
        // rewrote your files showed you none of what it wrote.
        if (diff?.lines?.length) push({ kind: 'diff', diff })
      },
      onNotice(m, kind = 'user') {
        // A gate bouncing the turn back ends the message that preceded it, the
        // same way a tool call does — commit it rather than letting the next
        // attempt's text pile up on top of it in the live region.
        flushStream()
        // Gate feedback is addressed to the model; a marker says one fired.
        if (kind === 'model') { push({ kind: 'result', text: `${String(m).split(':')[0]} — sent back` }); return }
        push({ kind: 'notice', text: m })
      },
      onTokens(n) { setTokens(n) },
      onToken(chunk) { streamBuf.current += chunk },
      // Counted, never shown. A reasoning seat can think for a long time before
      // it writes anything; without a sign of life the turn reads as frozen.
      // The text itself stays out of the UI — it is not the answer.
      onReasoning(chunk) { thinkChars.current += chunk.length },
      onAsk(q) {
        return new Promise((resolve) => setAsk({ ...q, resolve }))
      },
      onQuestion(q) {
        return new Promise((resolve) => setQuestion({ ...q, resolve }))
      },
      onTodos(t) { setTodos(t) },
      // The loop has taken the queued messages and put them to the model.
      //
      // They land in the transcript HERE — at the point they were handed over,
      // not the point they were typed. That is where the model actually read
      // them, so it is where its answer to them begins; placing them earlier
      // would show a reply arriving before the message it answers.
      onInterject(texts) {
        flushStream()
        for (const t of texts) push({ kind: 'user', text: t })
        setQueued(session.pending)
      },
    }
  }, [session, push, flushStream])

  const cycleMode = useCallback(() => {
    const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
    session.mode = next
    setMode(next)
  }, [mode, session])

  const interrupt = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); return }
    onExit?.()
    exit()
  }, [exit, onExit])

  // Escape's contract is deliberately narrower than ctrl-c's: stop the turn,
  // never quit. Ctrl-c on an idle prompt is a request to leave; escape on an
  // idle prompt is not, so it must not inherit interrupt()'s exit half.
  const stop = useCallback(() => { abortRef.current?.abort() }, [])

  // How much of the streaming reply may be on screen.
  //
  // This is the whole fix for the flicker. Ink switches to
  // `clearTerminal + replay the entire transcript` the moment a frame is taller
  // than the viewport (ui/live.mjs has the measurements), and the streaming
  // reply was the only thing in the live region with no ceiling — so every reply
  // longer than ~18 lines wiped the screen and redrew from the top, once per
  // 80ms animation tick. Keeping the frame inside the viewport is what stops it;
  // nothing else can, because Ink counts string lines and the terminal counts
  // rows, and after a wrap neither side knows the other's number.
  //
  // The tail is what you want anyway: it is the part still being written. The
  // whole reply lands in scrollback intact the moment the turn commits it.
  const todoRows = todoRowsFor(todos)
  // CHROME_ROWS already counts ONE row for the input, so only the extra rows a
  // multi-line value adds come out of the streaming reply's share.
  const inputMax = Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor((rows - 12) / 2)))
  const extraInputRows = Math.max(0, Math.min(inputRows, inputMax + 1) - 1)
  // A prompt waiting on you outranks prose you can read afterwards.
  const promptRows = question ? 8 + (question.options?.length ?? 0) : ask ? 8 : 0
  // The queue is live-region height too, and height is the whole game here.
  const queuedRows = queuedRowsFor(queued)
  const budget = liveBudget({ rows, todoRows, promptRows: promptRows + extraInputRows + queuedRows })
  const measure = Math.max(24, Math.min(96, cols - 3))
  const live = busy && stream && budget >= 3
    ? tailToRows(stream, budget - 1, measure)
    : null

  return (
    <Box flexDirection="column">
      {/* The over-tall frame: one render past the viewport, which is what makes
          Ink clear and replay everything. It is on screen for a single tick. */}
      {tall ? <Box height={rows + 1} /> : null}
      <Static items={done}>{(m) => <Messages key={m.id} items={[m]} />}</Static>
      {live ? (
        <Messages items={[{
          id: 'stream', kind: 'text', text: live.text, truncated: live.hidden,
        }]} />
      ) : null}
      <Todos todos={todos} />
      <Queued pending={queued} />
      {question ? (
        <QuestionPrompt
          question={question.question}
          header={question.header}
          options={question.options}
          onAnswer={(a) => { const r = question.resolve; setQuestion(null); r(a) }}
        />
      ) : null}
      {ask ? (
        <PermissionPrompt
          tool={ask.tool}
          input={ask.input}
          reason={ask.reason}
          onAnswer={(a) => { const r = ask.resolve; setAsk(null); r(a) }}
        />
      ) : null}
      {busy ? (
        <Spinner
          elapsedMs={elapsed * 1000}
          verb={verb.current}
          seconds={Math.floor(elapsed)}
          tokens={tokens}
          thinking={thinking}
        />
      ) : null}
      <SergeBar
        version={version}
        effort={settings.effortLevel || ''}
        cwd={cwd}
        pose={busy ? POSES[Math.floor(frame / 6) % POSES.length] : 'default'}
        feetFrame={busy ? Math.floor(frame / 3) : 0}
        isLoading={busy}
      />
      <Rule />
      <PromptInput
        onSubmit={submit}
        onQueue={queue}
        onCycleMode={cycleMode}
        onInterrupt={interrupt}
        onStop={stop}
        busy={busy}
        history={history.current}
        commands={commands}
        maxRows={inputMax}
        onHeight={setInputRows}
      />
      <Rule />
      <StatusBar status={status} mode={mode} ctx={ctx} />
    </Box>
  )
}
