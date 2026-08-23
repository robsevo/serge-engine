import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Static, useApp, useStdout } from 'ink'
import { Messages } from './Messages.jsx'
import { SergeBar } from './SergeBar.jsx'
import { StatusBar } from './StatusBar.jsx'
import { Spinner } from './Spinner.jsx'
import { PromptInput } from './PromptInput.jsx'
import { PermissionPrompt } from './PermissionPrompt.jsx'
import { Rule } from './Rule.jsx'
import { POSES } from './Clawd.jsx'
import { renderStatusLine } from '../statusline.mjs'
import { MODES } from '../permissions.mjs'
import { loadSpinnerConfig } from '../spinner.mjs'
import { dispatch } from '../commands.mjs'

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
  const [stream, setStream] = useState('')
  const streamBuf = useRef('')
  const history = useRef([])
  const idRef = useRef(0)
  const abortRef = useRef(null)
  const startRef = useRef(0)
  const { exit } = useApp()

  const verbs = useRef(loadSpinnerConfig(settings).verbs)
  const verb = useRef(verbs.current[0])

  const push = useCallback((row) => {
    setDone((prev) => [...prev, { ...row, id: ++idRef.current }])
  }, [])

  const refreshStatus = useCallback(() => {
    setStatus(renderStatusLine({
      settings, sessionId: session.sessionId, cwd,
      model: session.model, usage: session.usage,
    }) || session.model)
    setCtx(Math.min(99, Math.round((session.contextChars / COMPACT_AT) * 100)))
  }, [session, settings, cwd])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // One timer drives the whole animation: mascot pose, feet, spinner and clock.
  // 80ms because that is the braille spinner's own tick — a slower interval
  // aliases it and the spin visibly stutters. The eyes run at 120ms off the
  // same elapsed clock rather than a second timer, which is what keeps the two
  // cadences independent without two intervals fighting for renders.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      setFrame((f) => {
        if (f % 88 === 0) verb.current = verbs.current[Math.floor(Math.random() * verbs.current.length)]
        return f + 1
      })
      setElapsed((Date.now() - startRef.current) / 1000)
      // Flush whatever arrived since the last tick, in one render.
      if (streamBuf.current !== stream) setStream(streamBuf.current)
    }, 80)
    return () => clearInterval(t)
  }, [busy, stream])

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

    setBusy(true)
    streamBuf.current = ''
    setStream('')
    startRef.current = Date.now()
    setFrame(0)
    setElapsed(0)
    setTokens('')
    const before = session.usage
    abortRef.current = new AbortController()
    try {
      const res = await session.send(text, { signal: abortRef.current.signal })
      if (res.blocked) push({ kind: 'notice', text: `blocked: ${res.reason}`, tone: 'warn' })
      else if (res.text) push({ kind: 'text', text: res.text })
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
  }, [session, push, refreshStatus, seats, mcp, commands, sessions, onExit, exit])

  // The session reports into the transcript through these.
  useEffect(() => {
    session.ui = {
      onTool(name, input) {
        if (QUIET_TOOLS.has(name)) return
        const a = String(input?.command || input?.file_path || input?.pattern
          || input?.query || input?.name || '').replace(/\s+/g, ' ').slice(0, 68)
        push({ kind: 'tool', name, args: a, done: true })
      },
      onToolResult(name, content, isError) {
        if (QUIET_TOOLS.has(name) && !isError) return
        const lines = String(content ?? '').trim().split('\n').filter((l) => l.trim())
        push({
          kind: 'result',
          text: (lines[0] ?? '(no output)').replace(/\s+/g, ' ').slice(0, 66),
          extra: lines.length > 1 ? `${lines.length - 1} line${lines.length === 2 ? '' : 's'}` : '',
          isError,
        })
      },
      onNotice(m, kind = 'user') {
        // Gate feedback is addressed to the model; a marker says one fired.
        if (kind === 'model') { push({ kind: 'result', text: `${String(m).split(':')[0]} — sent back` }); return }
        push({ kind: 'notice', text: m })
      },
      onTokens(n) { setTokens(n) },
      onToken(chunk) { streamBuf.current += chunk },
      onAsk(q) {
        return new Promise((resolve) => setAsk({ ...q, resolve }))
      },
    }
  }, [session, push])

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

  return (
    <Box flexDirection="column">
      <Static items={done}>{(m) => <Messages key={m.id} items={[m]} />}</Static>
      {busy && stream ? <Messages items={[{ id: 'stream', kind: 'text', text: stream }]} /> : null}
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
        onCycleMode={cycleMode}
        onInterrupt={interrupt}
        busy={busy}
        history={history.current}
        commands={commands}
      />
      <Rule />
      <StatusBar status={status} mode={mode} ctx={ctx} />
    </Box>
  )
}
