/**
 * The real PromptInput on a pty; prints SUBMITTED:<json> whenever it submits.
 *
 * Driven by tests/tui/paste-check.py, which owns the pty and feeds it either a
 * bare chunk (what piped input looks like) or a bracketed-paste-wrapped one
 * (what a terminal sends once the app has asked for ESC[?2004h). Nothing here
 * talks to a model.
 */
import React from 'react'
import { render, Box, Text } from 'ink'
import { PromptInput } from '../../dist/ui/PromptInput.js'

const out = process.stdout.write.bind(process.stdout)

function Harness() {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, 'paste probe'),
    React.createElement(PromptInput, {
      onSubmit: (t) => out(`\nSUBMITTED:${JSON.stringify(t)}\n`),
      onCycleMode: () => {},
      onInterrupt: () => {},
      onStop: () => {},
      busy: false,
      history: [],
      commands: new Map(),
    }),
  )
}

const app = render(React.createElement(Harness), {
  exitOnCtrlC: false,
  incrementalRendering: true,
})
process.on('SIGTERM', () => { try { app.unmount() } catch {} ; setTimeout(() => process.exit(0), 60) })
