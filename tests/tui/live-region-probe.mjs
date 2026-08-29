/**
 * Mount the REAL App with a stubbed session, stream a reply of a known line
 * count, and count the clear-terminal frames Ink emits.
 *
 * Driven by tests/tui/live-region.py, which owns the pty and its size. Nothing
 * here talks to a model or a router — the session is a stub, so the only thing
 * under test is what Ink writes.
 */
import React from 'react'
import { render } from 'ink'
import { App } from '../../dist/ui/App.js'

const LINES = Number(process.env.PROBE_LINES || 40)
const CHUNK_MS = Number(process.env.PROBE_CHUNK_MS || 40)

// -- instrument stdout ---------------------------------------------------
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
let clears = 0
let writes = 0
let bytes = 0
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : String(chunk)
  writes++
  bytes += s.length
  let i = 0
  while ((i = s.indexOf(CLEAR, i)) !== -1) { clears++; i += CLEAR.length }
  return realWrite(chunk, ...rest)
}

const usage = { prompt: 1000, completion: 500 }
const session = {
  mode: 'default',
  sessionId: 'probe0000-0000-0000',
  model: 'probe/model',
  usage,
  contextChars: 40000,
  turns: 0,
  ui: null,
  async send(text, { signal } = {}) {
    const ui = session.ui
    ui.onTool('Bash', { command: 'echo hello' })
    ui.onToolResult('Bash', 'hello', false)
    for (let n = 0; n < LINES; n++) {
      if (signal?.aborted) break
      ui.onToken(`line ${String(n).padStart(3, '0')} - streamed reply body text\n`)
      await new Promise((r) => setTimeout(r, CHUNK_MS))
    }
    return {
      text: Array.from({ length: LINES }, (_, n) =>
        `line ${String(n).padStart(3, '0')} - streamed reply body text`).join('\n'),
    }
  },
}

const app = render(
  React.createElement(App, {
    session,
    settings: {},                 // no statusLine -> no spawnSync
    cwd: '/home/probe/work',
    version: '0.4.0',
    commands: new Map(),
    seats: [],
    mcp: null,
    sessions: [],
    onExit: () => {},
  }),
  // Mirror ink-repl.mjs exactly — a probe rendered with different options is
  // testing a configuration nobody ships.
  { exitOnCtrlC: false, incrementalRendering: true },
)

process.on('SIGTERM', () => {
  realWrite(`\n@@PROBE clears=${clears} writes=${writes} bytes=${bytes}\n`)
  try { app.unmount() } catch {}
  setTimeout(() => process.exit(0), 50)
})
