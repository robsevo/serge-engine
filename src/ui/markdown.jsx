import React from 'react'
import { Box, Text } from 'ink'

/**
 * Just enough markdown for assistant prose.
 *
 * Not a parser — a renderer for the handful of marks a model actually emits in
 * a chat reply. Before this, `**Model & Provider Freedom**` reached the screen
 * with its asterisks intact, which is worse than no markdown at all: the marks
 * are noise the reader has to skip, and the emphasis they encode is lost.
 *
 * Deliberately NOT supported: tables, images, block quotes, nested lists. Each
 * would need real layout, and a half-rendered table reads worse than its
 * source. Those pass through as written.
 */

const BLUE = '#6EB4E6'

/** Split a line into styled runs: **bold**, *italic*, `code`, ~~strike~~. */
function inline(text, keyPrefix) {
  // One pass, one regex — alternation rather than sequential replaces, so a
  // `**bold**` inside a `` `code span` `` is not re-processed. Order matters:
  // ** must be tried before *, or the italic rule eats the first asterisk.
  const RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|\*[^*\n]+\*|\b_[^_\n]+_\b)/g
  const out = []
  let last = 0
  let m
  let i = 0
  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) out.push(<Text key={`${keyPrefix}-t${i++}`}>{text.slice(last, m.index)}</Text>)
    const tok = m[0]
    if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(<Text key={`${keyPrefix}-b${i++}`} bold>{tok.slice(2, -2)}</Text>)
    } else if (tok.startsWith('`')) {
      out.push(<Text key={`${keyPrefix}-c${i++}`} color={BLUE}>{tok.slice(1, -1)}</Text>)
    } else if (tok.startsWith('~~')) {
      out.push(<Text key={`${keyPrefix}-s${i++}`} strikethrough>{tok.slice(2, -2)}</Text>)
    } else {
      out.push(<Text key={`${keyPrefix}-i${i++}`} italic>{tok.slice(1, -1)}</Text>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(<Text key={`${keyPrefix}-t${i++}`}>{text.slice(last)}</Text>)
  return out.length ? out : [<Text key={`${keyPrefix}-t0`}>{text}</Text>]
}

/**
 * @param {string} text  the assistant's reply, as markdown
 * @returns {React.ReactNode[]} one node per line
 */
export function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const nodes = []
  let inFence = false

  lines.forEach((raw, n) => {
    const key = `md${n}`

    // Fenced code: everything between ``` is verbatim, marks included. A model
    // showing you a literal `**` in a snippet means it.
    if (/^\s*```/.test(raw)) { inFence = !inFence; return }
    if (inFence) {
      nodes.push(<Text key={key} color={BLUE}>{'  ' + raw}</Text>)
      return
    }

    if (!raw.trim()) { nodes.push(<Text key={key}> </Text>); return }

    // Headings render as bold rather than larger — a terminal has one size, so
    // the # would just be leftover syntax.
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) { nodes.push(<Text key={key} bold color={BLUE}>{h[2]}</Text>); return }

    // A horizontal rule is a rule, not three literal dashes.
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      nodes.push(<Text key={key} dimColor>{'─'.repeat(40)}</Text>)
      return
    }

    // Bullets: the marker is normalised to a real bullet, indentation kept so
    // nesting still reads.
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (b) {
      nodes.push(
        <Box key={key}>
          {/* The gap after the marker comes from `minWidth`, not from a space
              inside the Text. Ink trims trailing whitespace at a wrap boundary,
              so `'• '` rendered as `•Autonomous` on any line that wrapped. */}
          <Box flexShrink={0} minWidth={b[1].length + 2}>
            <Text color={BLUE}>{b[1] + '\u2022'}</Text>
          </Box>
          <Box flexGrow={1}><Text>{inline(b[2], key)}</Text></Box>
        </Box>,
      )
      return
    }

    // Ordered lists keep their own numbers — renumbering would contradict a
    // model that deliberately wrote "3." to continue an earlier list.
    const o = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw)
    if (o) {
      nodes.push(
        <Box key={key}>
          <Box flexShrink={0} minWidth={o[1].length + o[2].length + 1}>
            <Text color={BLUE}>{o[1] + o[2]}</Text>
          </Box>
          <Box flexGrow={1}><Text>{inline(o[3], key)}</Text></Box>
        </Box>,
      )
      return
    }

    nodes.push(<Text key={key}>{inline(raw, key)}</Text>)
  })

  return nodes
}
