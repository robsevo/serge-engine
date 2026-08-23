/**
 * The Ink session: startup splash, then the app.
 *
 * The splash is printed with plain writes before Ink starts, because it is a
 * one-shot banner — putting it inside the render would make Ink responsible for
 * redrawing something that never changes.
 */
import { render } from 'ink'
import React from 'react'
import { stdout } from 'node:process'
import { createSession } from './loop.mjs'
import { loadSettings, providerConfig, configDir, VERSION } from './config.mjs'
import { loadSeats, checkSeat, renderStartup } from './seats-startup.mjs'
import { loadCommands, expandCommand } from './brain.mjs'
import { listSessions } from './sessions.mjs'
import { App } from './ui/App.js'

export async function inkRepl({ cwd, model, permissionMode, mcp = null, resumeFrom = null, resumeInfo = null, forkParent = null }) {
  const settings = loadSettings()
  const seats = loadSeats()
  const commands = loadCommands()

  // The session's reporting callbacks are wired through `session.ui`, which the
  // App installs on mount — the loop starts before React does, so the hooks
  // read it lazily rather than capturing it.
  const session = createSession({
    cwd, model, permissionMode: permissionMode || 'default', mcp, resumeFrom, forkParent,
    onToken: (t) => session.ui?.onToken?.(t),
    // Without this the loop sees no `onAsk` and resolves every ask to a
    // refusal — correct headless, wrong with a person at the terminal.
    onAsk: (q) => session.ui?.onAsk?.(q) ?? Promise.resolve('no'),
    onNotice: (m, kind) => session.ui?.onNotice?.(m, kind),
    onTool: (n, i) => session.ui?.onTool?.(n, i),
    onToolResult: (n, c, e) => session.ui?.onToolResult?.(n, c, e),
  })

  stdout.write(renderStartup({
    seats,
    baseUrl: providerConfig(settings).baseUrl,
    cwd,
    commands: commands.size,
    skills: session.skills.size,
    agents: session.agents.size,
    mcp: mcp?.servers?.length ? String(mcp.servers.length) : '',
    resumed: session.resumed
      ? `${forkParent ? 'forked from' : 'resumed'} ${resumeInfo ? resumeInfo.id.slice(0, 8) : ''}`
        + ` · ${session.resumed.turns} prior turn(s)`
      : null,
    color: Boolean(stdout.isTTY),
  }))

  if (session.mode === 'fullAccess' || session.mode === 'bypassPermissions') {
    stdout.write('\x1b[33m▶ \x1b[1mauto mode\x1b[0m\x1b[33m — no confirmation prompts on this '
      + 'session; inspect risky tool calls.\x1b[0m\n')
  }

  const app = render(
    React.createElement(App, {
      session, settings, cwd, version: VERSION, commands, seats, mcp,
      sessions: listSessions(cwd, 20),
    }),
    { exitOnCtrlC: false },
  )

  // Ink clears the screen only when the terminal gets NARROWER (ink.js:281).
  // Widening leaves the old frame on screen: the terminal un-wraps lines that
  // were wrapped, so there are now fewer rows than Ink's erase count assumes,
  // and every subsequent animation frame stacks another copy of the live region
  // into scrollback. That is the repeated-mascot corruption — reproduced by
  // resizing mid-turn, five copies from three resizes.
  //
  // Clearing on ANY width change costs one redraw of a region that is about to
  // be redrawn regardless.
  let lastCols = stdout.columns
  const onResize = () => {
    if (stdout.columns === lastCols) return      // a height-only change is safe
    lastCols = stdout.columns
    // PREPENDED, so this runs BEFORE Ink's own resize handler. Ink's handler
    // repaints; clearing after it wiped the fresh frame and left the input box
    // gone, because instance.clear() also SYNCS Ink's idea of what is on screen
    // (ink.js:657) — after which Ink believes the blank screen is correct and
    // never redraws. Clearing first leaves Ink's repaint as the last write.
    app.clear()
  }
  stdout.prependListener('resize', onResize)

  try {
    await app.waitUntilExit()
  } finally {
    stdout.off('resize', onResize)
  }
  stdout.write(`\x1b[2m  session ${session.sessionId.slice(0, 8)} · ${session.turns} turn(s)\n`
    + `  ${session.transcriptPath}\x1b[0m\n`)
  return 0
}
