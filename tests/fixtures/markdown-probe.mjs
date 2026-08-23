/** Renders one markdown document through the real renderer, on a pty. */
import React from 'react'
import { render, Box, Text } from 'ink'
import { renderMarkdown } from '../../dist/ui/markdown.js'

const DOC = process.env.MD || ''
// Mirrors AssistantText's real shape: a 2-column marker beside a flexGrow
// column. Rendering the markdown at full width instead — which the first
// version of this probe did — never reproduces the wrap the layout causes, so
// the suite passed with the wrap bug present.
const app = render(
  React.createElement(Box, { flexDirection: 'row' },
    React.createElement(Box, { minWidth: 2 }, React.createElement(Text, null, '\u25cf')),
    React.createElement(Box, { flexGrow: 1, flexDirection: 'column' }, renderMarkdown(DOC))))
setTimeout(() => { app.unmount(); process.exit(0) }, 300)
