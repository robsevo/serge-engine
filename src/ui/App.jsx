import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Static, useApp, useStdout } from 'ink'
import { Messages } from './Messages.jsx'
import { SergeBar } from './SergeBar.jsx'
import { StatusBar } from './StatusBar.jsx'
import { Spinner } from './Spinner.jsx'
import { PromptInput } from './PromptInput.jsx'
import { POSES } from './Clawd.jsx'
import { renderStatusLine } from '../statusline.mjs'
import { MODES } from '../permissions.mjs'
import { loadSpinnerConfig } from '../spinner.mjs'

/** Tools whose calls are the agent's own plumbing, not work the reader follows. */
const QUIET_TOOLS = new Set(['Skill'])
const CYCLE = ['default', 'acceptEdits', 'plan', 'fullAccess']
const COMPACT_AT = Number(process.env.SERGE_COMPACT_AT || 400_000)

export function App({ session, settings, cwd, version, commands, onExit }) {
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

  // One timer drives the whole animation: pose, feet, spinner and clock.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      setFrame((f) => {
        if (f % 70 === 0) verb.current = verbs.current[Math.floor(Math.random() * verbs.current.length)]
        return f + 1
      })
      setElapsed((Date.now() - startRef.current) / 1000)
    }, 100)
    return () => clearInterval(t)
  }, [busy])

  const submit = useCallback(async (text) => {
    history.current.push(text)
    push({ kind: 'user', text })
    setBusy(true)
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
      const u = session.usage
      const spent = (u.prompt + u.completion) - (before.prompt + before.completion)
      push({ kind: 'done', seconds: (Date.now() - startRef.current) / 1000, spent })
    } catch (e) {
      if (!abortRef.current.signal.aborted) {
        push({ kind: 'notice', text: `error: ${e?.message ?? e}`, tone: 'error' })
      }
    } finally {
      setBusy(false)
      abortRef.current = null
      refreshStatus()
    }
  }, [session, push, refreshStatus])

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
      {busy ? (
        <Spinner
          frame={frame}
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
      <PromptInput
        onSubmit={submit}
        onCycleMode={cycleMode}
        onInterrupt={interrupt}
        busy={busy}
        history={history.current}
      />
      <StatusBar status={status} mode={mode} ctx={ctx} />
    </Box>
  )
}
