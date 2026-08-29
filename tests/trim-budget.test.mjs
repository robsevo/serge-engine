#!/usr/bin/env node
/**
 * Resume-path trimming: same answer as the naive version, in linear time.
 *
 * `algo_check bigo` flagged the original `trimToBudget` twice — a `.splice(0,…)`
 * inside a loop, and a nested loop — and both were real:
 *
 *   - the loop CONDITION was `size() > maxChars`, and `size()` is a full reduce
 *     over the history that re-runs `JSON.stringify` on every `tool_calls`
 *     array it passes. Called once per dropped exchange, over B bytes: O(k·B).
 *   - the body did `messages.splice(0, cut)`, which re-indexes the array: O(k·n).
 *
 * On the resume path, where B is large by definition — a history small enough
 * not to need trimming never enters the loop at all.
 *
 * The rewrite prices each message once, keeps a running total, advances a cursor
 * that never goes backwards, and splices ONE time. The checker still calls it
 * O(n²) because it sees a loop inside a loop; it cannot see that the inner
 * cursor is monotonic across outer iterations, so the inner loop advances at
 * most n times IN TOTAL. That refutation is what the timing below is for — a
 * quadratic implementation cannot hold a flat per-element cost as n grows.
 *
 * The equivalence check matters more than the timing: this decides what history
 * a resumed session sees, and cutting in the wrong place makes the provider
 * reject the whole conversation.
 *
 * Run:  node tests/trim-budget.test.mjs
 */
let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/** The implementation as it was, kept here as the oracle. */
function trimNaive(messages, maxChars) {
  const size = () => messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0)
      + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)
  let dropped = 0
  while (size() > maxChars && messages.length > 2) {
    let cut = 1
    while (cut < messages.length && messages[cut].role !== 'user') cut++
    if (cut >= messages.length) break
    messages.splice(0, cut)
    dropped += cut
  }
  return dropped
}

/** The implementation now, copied from src/sessions.mjs. */
function trimFast(messages, maxChars) {
  const cost = messages.map((m) =>
    (typeof m.content === 'string' ? m.content.length : 0)
    + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0))
  let total = 0
  for (const c of cost) total += c
  let cut = 0
  while (total > maxChars && messages.length - cut > 2) {
    let next = cut + 1
    while (next < messages.length && messages[next].role !== 'user') next++
    if (next >= messages.length) break
    for (let i = cut; i < next; i++) total -= cost[i]
    cut = next
  }
  if (cut) messages.splice(0, cut)
  return cut
}

/** A history shaped like a real one: user → assistant(+tool_calls) → tool ×k. */
function history(turns, bodyChars = 200, seed = 1) {
  const out = []
  let r = seed
  const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let t = 0; t < turns; t++) {
    out.push({ role: 'user', content: 'u'.repeat(bodyChars) })
    const calls = 1 + Math.floor(rnd() * 3)
    out.push({
      role: 'assistant',
      content: rnd() < 0.5 ? 'a'.repeat(bodyChars) : null,
      tool_calls: Array.from({ length: calls }, (_, i) => ({
        id: `c${t}_${i}`, type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'x'.repeat(40) }) },
      })),
    })
    for (let i = 0; i < calls; i++) {
      out.push({ role: 'tool', tool_call_id: `c${t}_${i}`, content: 'r'.repeat(bodyChars) })
    }
  }
  return out
}

/* ── equivalence: the answer must not change ──────────────────────────── */

let mismatch = null
for (const turns of [0, 1, 2, 3, 7, 40]) {
  for (const budget of [0, 1, 100, 900, 5_000, 50_000, 10_000_000]) {
    const a = history(turns, 120, turns + budget)
    const b = a.map((m) => ({ ...m }))
    const da = trimNaive(a, budget)
    const db = trimFast(b, budget)
    if (da !== db || JSON.stringify(a) !== JSON.stringify(b)) {
      mismatch = `turns=${turns} budget=${budget}: dropped ${da} vs ${db}, left ${a.length} vs ${b.length}`
      break
    }
  }
  if (mismatch) break
}
ok('identical result to the original, across 42 shapes', mismatch === null, mismatch ?? '')

{
  // The invariant the whole function exists for: what is left must start on a
  // user message, or be short enough that nothing was cut.
  const m = history(30, 200, 9)
  trimFast(m, 4_000)
  ok('the surviving history starts at a turn boundary',
     m.length <= 2 || m[0].role === 'user', m[0]?.role)
}
{
  // An assistant message with tool_calls MUST keep its tool replies, or the
  // provider rejects the conversation.
  const m = history(30, 200, 4)
  trimFast(m, 6_000)
  const ids = new Set()
  for (const x of m) if (x.role === 'assistant' && x.tool_calls) for (const c of x.tool_calls) ids.add(c.id)
  for (const x of m) if (x.role === 'tool') ids.delete(x.tool_call_id)
  ok('no tool_call is left without its reply', ids.size === 0, [...ids].join(','))
}
{
  const m = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
  const n = trimFast(m, 0)
  ok('a two-message history is never cut to nothing', n === 0 && m.length === 2)
}
{
  const m = []
  ok('an empty history is handled', trimFast(m, 0) === 0 && m.length === 0)
}
{
  // No user message after index 0 — there is no clean boundary to cut on.
  const m = [{ role: 'user', content: 'x'.repeat(999) },
    { role: 'assistant', content: 'y'.repeat(999) },
    { role: 'tool', content: 'z'.repeat(999) }]
  const before = m.length
  ok('a history with no later turn boundary is kept whole',
     trimFast(m, 10) === 0 && m.length === before)
}

/* ── cost: per-element work must not grow with n ──────────────────────── */

const timeOf = (fn, msgs, budget) => {
  const t0 = process.hrtime.bigint()
  fn(msgs, budget)
  return Number(process.hrtime.bigint() - t0) / 1e6
}

// Keep ~10% of the history in every case, so k grows with n — which is the
// case the old shape was quadratic in.
const rows = []
for (const turns of [200, 400, 800, 1600]) {
  const budget = Math.round(turns * 0.1 * 900)
  const slow = timeOf(trimNaive, history(turns, 200, 3), budget)
  const fast = timeOf(trimFast, history(turns, 200, 3), budget)
  rows.push({ turns, slow, fast })
  console.log(`        ${String(turns).padStart(5)} turns   was ${slow.toFixed(1).padStart(7)}ms   now ${fast.toFixed(2).padStart(6)}ms`)
}

const grew = (k) => rows[rows.length - 1][k] / Math.max(rows[0][k], 0.001)
// n went up 8×. Linear work grows ~8×; quadratic grows ~64×. The threshold sits
// between them with room for noise on a loaded machine.
ok('the original grows faster than linearly in n', grew('slow') > 16,
   `${grew('slow').toFixed(1)}× for 8× the input`)
ok('the rewrite does not', grew('fast') < 16,
   `${grew('fast').toFixed(1)}× for 8× the input`)
ok('and it is faster at every size measured',
   rows.every((r) => r.fast <= r.slow),
   rows.map((r) => `${r.turns}:${r.fast.toFixed(2)}vs${r.slow.toFixed(1)}`).join(' '))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
