/**
 * Renders the command menu with a brain that shadows two built-ins, presses
 * `/`, and exits. Its STDERR is the subject: React writes duplicate-key
 * warnings there, and the parent test asserts it stays empty.
 */
import React from 'react'
import { render, Box } from 'ink'
import { PromptInput } from '../../dist/ui/PromptInput.js'

const brain = new Map([
  ['cost', { name: 'cost', description: 'a brain cost command' }],
  ['help', { name: 'help', description: 'a brain help command' }],
  ['recap', { name: 'recap', description: 'recap the session' }],
])

const app = render(
  React.createElement(Box, { flexDirection: 'column' },
    React.createElement(PromptInput, {
      onSubmit() {}, onCycleMode() {}, onInterrupt() {},
      busy: false, history: [], commands: brain,
    })),
  { exitOnCtrlC: false },
)
// Typed as `/cost`, not a bare `/`: the menu shows 8 rows, and with a full
// catalogue the brain's shadowing /cost sits below the fold where neither the
// duplicate key nor the marking would be exercised.
for (const ch of (process.env.PROBE_KEYS || '/cost')) process.stdin.push(ch)
setTimeout(() => { app.unmount(); process.exit(0) }, 400)
