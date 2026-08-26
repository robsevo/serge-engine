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
import { loadSettings, providerConfig, configDir, cliName, VERSION } from './config.mjs'
import { loadSeats, checkSeat, renderStartup } from './seats-startup.mjs'
import { loadCommands, expandCommand } from './brain.mjs'
import { listSessions } from './sessions.mjs'
import { reapAll } from './background.mjs'
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
    onReasoning: (t) => session.ui?.onReasoning?.(t),
    // Without this the loop sees no `onAsk` and resolves every ask to a
    // refusal — correct headless, wrong with a person at the terminal.
    onAsk: (q) => session.ui?.onAsk?.(q) ?? Promise.resolve('no'),
    onQuestion: (q) => session.ui?.onQuestion?.(q) ?? Promise.resolve(null),
    onTodos: (t) => session.ui?.onTodos?.(t),
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
  // Resize is handled inside the App (ui/App.jsx) by triggering Ink's own
  // full-repaint path, which replays the whole transcript. Erasing by hand from
  // out here cannot work: Ink counts STRING lines, not terminal rows
  // (log-update.js:47), so after a reflow neither Ink nor a caller knows how
  // many rows are actually on screen without re-deriving the wrapping.
  //
  // Serge's own Ink fork reaches the same conclusion in log-update.ts:138 —
  // "we could figure out how to not reset here but that would involve
  // predicting the current layout after the viewport change ... resizing is a
  // rare enough event that it's not practically a big issue." It full-resets.

  await app.waitUntilExit()

  // Kill anything still running in the background. A dev server whose parent is
  // gone is a leak the user finds later with `ps`, holding a port nothing
  // appears to own.
  const reaped = reapAll()
  if (reaped) stdout.write(`\x1b[2m  stopped ${reaped} background job(s)\x1b[0m\n`)
  // The FULL session id, and the command that resumes it. An 8-character
  // prefix reads like an id you can use and is not one you can paste — and a
  // transcript path is not a way back into the conversation. Printed on every
  // exit, including Ctrl+C, because that is the exit you did not plan for.
  // A session with no turns has an empty transcript — there is nothing to
  // resume and nothing worth reporting. Printing the id and path but silently
  // omitting the resume line is the confusing middle: it looks like the feature
  // broke rather than like there was nothing to offer.
  if (session.turns === 0) {
    stdout.write('\x1b[2m  no turns — nothing to resume\x1b[0m\n')
  } else {
    // Named for the binary the user actually typed, not for this engine. Under
    // a second install — `sergio` drives the same engine against ~/.sergio —
    // printing "serge --resume <id>" sends them to the OTHER install, which
    // looks in a different transcript store and answers "No conversation
    // found" for a session that is sitting right there.
    const resumeCmd = `${cliName()} --resume ${session.sessionId}`
    stdout.write(
      `\x1b[2m  session ${session.sessionId} · ${session.turns} turn(s)\n`
      + `  ${session.transcriptPath}\x1b[0m\n`
      + `\x1b[2m  to resume:\x1b[0m \x1b[38;2;110;180;230m${resumeCmd}\x1b[0m\n`)
  }
  return 0
}
