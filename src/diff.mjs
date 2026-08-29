/**
 * Line diffs for the edit tools.
 *
 * WHY THIS EXISTS. Edit, MultiEdit and Write returned a sentence — "applied 3
 * edit(s) to /path (4 replacement(s))" — and that sentence was the ONLY thing
 * either front-end had to show. So a session that rewrote a file put nothing on
 * screen about what it rewrote, and the reader's choice was to trust it or go
 * read the file. Every comparable tool shows the change; this is what it needs.
 *
 * Trim-then-LCS rather than plain LCS over the whole file. An Edit touches a few
 * lines of a file that may be thousands long, so the common prefix and suffix
 * are almost the entire input; stripping them first turns an O(n·m) table over
 * the file into one over the changed region. The guard below is what makes that
 * safe as a promise rather than a hope: if the middle is still large, the diff
 * degrades to "this block replaced that block" instead of allocating a table
 * proportional to the file squared.
 */

/** Above this many changed lines on either side, stop building an LCS table. */
const LCS_LIMIT = 400

/**
 * @param {string} before
 * @param {string} after
 * @param {{context?: number}} [opts]  unchanged lines kept around each change
 * @returns {{lines: Array<{type:'add'|'del'|'ctx'|'gap', text:string, n?:number}>,
 *            added: number, removed: number}}
 */
export function diffLines(before, after, { context = 3 } = {}) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')

  // Common prefix / suffix. These are unchanged by construction, so they never
  // enter the table — only the window between them does.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  const ops = midA.length > LCS_LIMIT || midB.length > LCS_LIMIT
    ? [...midA.map((t) => ({ type: 'del', text: t })), ...midB.map((t) => ({ type: 'add', text: t }))]
    : lcsOps(midA, midB)

  // Re-attach `context` lines of the untouched head and tail so a change reads
  // in place rather than as a floating fragment.
  const preCtx = a.slice(Math.max(0, head - context), head)
  const postCtx = a.slice(a.length - tail, a.length - tail + context)

  const lines = []
  if (head > context) lines.push({ type: 'gap', text: `@@ ${head - context} unchanged line(s) above @@` })
  for (const [i, t] of preCtx.entries()) lines.push({ type: 'ctx', text: t, n: head - preCtx.length + i + 1 })
  lines.push(...ops.map((o, i) => ({ ...o, n: head + i + 1 })))
  for (const [i, t] of postCtx.entries()) lines.push({ type: 'ctx', text: t, n: a.length - tail + i + 1 })
  if (tail > context) lines.push({ type: 'gap', text: `@@ ${tail - context} unchanged line(s) below @@` })

  return {
    lines,
    added: ops.filter((o) => o.type === 'add').length,
    removed: ops.filter((o) => o.type === 'del').length,
  }
}

/** Classic LCS backtrack, over the trimmed window only. */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  // (n+1)*(m+1) Int32 cells; both dimensions are capped by LCS_LIMIT above.
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < n) { out.push({ type: 'del', text: a[i] }); i++ }
  while (j < m) { out.push({ type: 'add', text: b[j] }); j++ }
  return out
}

/**
 * What the front-ends actually render: a bounded window over the diff.
 *
 * Bounded because a Write of a 2000-line file is a legitimate call, and its
 * diff is 2000 rows of scrollback nobody asked for. The head of a change is
 * where the information is; the count carries the rest.
 */
export function summarize(diff, { maxLines = 24 } = {}) {
  const shown = diff.lines.slice(0, maxLines)
  return {
    lines: shown,
    hidden: Math.max(0, diff.lines.length - shown.length),
    added: diff.added,
    removed: diff.removed,
  }
}

/** The same window, as ANSI text, for the readline front-end. */
export function renderDiffText(diff, { maxLines = 24, color = true } = {}) {
  const g = color ? '\x1b[32m' : ''
  const r = color ? '\x1b[31m' : ''
  const d = color ? '\x1b[2m' : ''
  const x = color ? '\x1b[0m' : ''
  const s = summarize(diff, { maxLines })
  const out = s.lines.map((l) => {
    if (l.type === 'add') return `     ${g}+ ${l.text}${x}`
    if (l.type === 'del') return `     ${r}- ${l.text}${x}`
    if (l.type === 'gap') return `     ${d}${l.text}${x}`
    return `     ${d}  ${l.text}${x}`
  })
  if (s.hidden) out.push(`     ${d}… ${s.hidden} more diff line(s)${x}`)
  return out.join('\n')
}
