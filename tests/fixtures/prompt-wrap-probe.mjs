#!/usr/bin/env node
/**
 * Renders the prompt line at a given width and prints what Ink actually drew.
 *
 * Runs against a fake stdout rather than a pty: the subject is the string Ink
 * emits, and a pty would only add a terminal's own wrapping on top of it.
 * FORCE_COLOR is left off, so the frame is plain text and can be compared
 * character for character. Imports from dist/ like the other UI probes —
 * node cannot load .jsx directly, so `npm run build` must run first.
 */
import React from 'react'
import { render } from 'ink'
import { EventEmitter } from 'node:events'
import { PromptLine } from '../../dist/ui/PromptInput.js'

const cols = Number(process.argv[2] || 40)
const value = process.argv[3] ?? '/sc:research "we have a nintendo switch with the dongle'
const cursor = process.argv[4] === undefined ? value.length : Number(process.argv[4])

class FakeOut extends EventEmitter {
  constructor() { super(); this.columns = cols; this.rows = 24; this.isTTY = true; this.frames = [] }
  write(s) { this.frames.push(s) }
}
const stdout = new FakeOut()
const stdin = new EventEmitter()
Object.assign(stdin, {
  isTTY: true, setRawMode() {}, resume() {}, pause() {}, ref() {}, unref() {}, read: () => null,
})

const app = render(
  React.createElement(PromptLine, { value, cursor }),
  { stdout, stdin, patchConsole: false },
)
await new Promise((r) => setTimeout(r, 150))
app.unmount()

const frame = stdout.frames.filter((f) => f.includes(value.slice(0, 8))).pop() || ''
const plain = frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[A-HJKSTfsu]/g, '')
const lines = plain.split('\n').filter((l, i, a) => l.length || i < a.length - 1)
console.log(JSON.stringify({
  cols,
  lines,
  // what a reader would see, with the prompt marker and wrap padding removed
  seen: lines.join(' ').replace(/^❯\s?/, '').replace(/\s+/g, ' ').trim(),
  typed: value.replace(/\s+/g, ' ').trim(),
  // Whitespace at a wrap point is consumed by the wrap -- that is correct.
  // A NON-space character going missing is the bug, so compare the dense form.
  seenDense: lines.join('').replace(/^❯/, '').replace(/\s/g, ''),
  typedDense: value.replace(/\s/g, ''),
  // Ink erases by STRING lines; the terminal shows wrapped ROWS. They must agree
  // or each redraw leaves rows behind.
  stringLines: lines.length,
  terminalRows: lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0),
}))
