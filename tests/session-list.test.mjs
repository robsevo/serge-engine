#!/usr/bin/env node
/**
 * Listing sessions must not cost every byte the directory has ever recorded.
 *
 * `algo_check bigo` called `listSessions` O(n⁴). The exponent was noise — the
 * outer loop runs over at most two directories — but the shape underneath it was
 * real: every transcript in the directory was read AND JSON-parsed in full,
 * twice each (once in `summarize`, once for `parentOf` on the very next line,
 * under a docstring promising not to load the file twice), and only then sorted
 * by mtime and cut down to `limit`. So drawing twenty rows at startup paid for
 * every session the directory had ever held.
 *
 * The sort only needs mtime, and `statSync` returns mtime without opening the
 * file. Stat everything, sort on that, then read the survivors — one read each.
 * The cost stops depending on how much history exists.
 *
 * What must NOT change is the answer: same sessions, same order, empty ones
 * still filtered out, forks still resolvable by parent id.
 *
 * Run:  node tests/session-list.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'serge-list-'))
process.env.CLAUDE_CONFIG_DIR = home
const { listSessions, findSession } = await import('../src/sessions.mjs')
const { projectDirFor } = await import('../src/config.mjs')

const CWD = join(home, 'work')
const dir = projectDirFor(CWD)
mkdirSync(dir, { recursive: true })

const id = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`

/** One transcript: `turns` user prompts, some bulk, optionally a fork marker. */
function writeSession(n, { turns = 3, bulk = 40, parent = null, mtime = null } = {}) {
  const lines = []
  if (parent) lines.push(JSON.stringify({ type: 'meta', parent_session_id: parent }))
  for (let t = 0; t < turns; t++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt ${n}.${t}` } }))
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(bulk) }] },
    }))
  }
  const p = join(dir, `${id(n)}.jsonl`)
  writeFileSync(p, lines.join('\n') + '\n')
  if (mtime) utimesSync(p, mtime / 1000, mtime / 1000)
  return p
}

/* ── the answer ───────────────────────────────────────────────────────── */

const base = Date.now() - 100 * 60_000
for (let i = 0; i < 40; i++) writeSession(i, { turns: 1 + (i % 4), mtime: base + i * 60_000 })
// Noise the filter must drop: no user turns, no fork marker.
writeSession(90, { turns: 0 })
// A fork with no turns of its own is NOT noise — its parent makes it resumable.
writeSession(91, { turns: 0, parent: id(39), mtime: base + 41 * 60_000 })

{
  const rows = listSessions(CWD, 20)
  ok('returns exactly `limit` rows when there are more', rows.length === 20, String(rows.length))
  ok('newest first', rows.every((r, i) => i === 0 || rows[i - 1].mtime >= r.mtime))
  ok('the newest really is first', rows[0].id === id(91), rows[0].id)
  ok('an empty session is filtered out', !rows.some((r) => r.id === id(90)))
  ok('a fork with no turns is KEPT — its parent makes it resumable',
     rows.some((r) => r.id === id(91) && r.parent === id(39)))
  ok('turn counts survive', rows.find((r) => r.id === id(39))?.turns === 1 + (39 % 4),
     String(rows.find((r) => r.id === id(39))?.turns))
  ok('previews survive', /^prompt 39\./.test(rows.find((r) => r.id === id(39))?.preview ?? ''),
     rows.find((r) => r.id === id(39))?.preview)
}
{
  const all = listSessions(CWD, 500)
  ok('a limit above the count returns everything non-empty', all.length === 41, String(all.length))
  ok('and still drops the empty one', !all.some((r) => r.id === id(90)))
}
{
  ok('limit 0 returns nothing', listSessions(CWD, 0).length === 0)
  ok('an unknown cwd is empty, not a throw', listSessions(join(home, 'nowhere'), 20).length === 0)
}
{
  ok('findSession(latest) agrees with the listing',
     findSession(CWD, null)?.id === listSessions(CWD, 1)[0].id)
  ok('findSession by full id works', findSession(CWD, id(7))?.id === id(7))
  ok('findSession by prefix works', findSession(CWD, id(7).slice(0, 8))?.id === id(7))
  ok('findSession on an unknown id is null', findSession(CWD, 'deadbeef') === null)
}

/* ── the cost ─────────────────────────────────────────────────────────── */
{
  // 200 more transcripts, each substantial. The listing asks for 20 either way,
  // so a listing whose cost tracks the size of the STORE is the bug; one whose
  // cost tracks `limit` is the fix.
  const t0 = process.hrtime.bigint()
  listSessions(CWD, 20)
  const small = Number(process.hrtime.bigint() - t0) / 1e6

  for (let i = 100; i < 300; i++) {
    writeSession(i, { turns: 30, bulk: 2_000, mtime: base - (i * 60_000) })   // OLDER than the first 40
  }

  const t1 = process.hrtime.bigint()
  const rows = listSessions(CWD, 20)
  const big = Number(process.hrtime.bigint() - t1) / 1e6

  console.log(`        41 transcripts: ${small.toFixed(1)}ms → 241 transcripts (+12MB): ${big.toFixed(1)}ms`)
  // Every one of the 200 is older than every one of the first 40, so none may
  // appear — which is also why none of them should have been read at all.
  const olderIds = new Set(Array.from({ length: 200 }, (_, i) => id(100 + i)))
  ok('none of the 200 older transcripts is in the answer',
     !rows.some((r) => olderIds.has(r.id)))
  ok('adding 200 older transcripts does not multiply the cost', big < small * 4 + 25,
     `${small.toFixed(1)}ms → ${big.toFixed(1)}ms`)
  ok('and the answer is unchanged', rows[0].id === id(91) && rows.length === 20, rows[0].id)
}

rmSync(home, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
