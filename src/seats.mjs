/**
 * Seat awareness.
 *
 * WHY THIS EXISTS, AND WHY A GENERIC ENGINE CANNOT HAVE IT. Serge's whole model
 * story is a roster of named seats in litellm.yaml — `local-coder`,
 * `cloud-brain`, `search-fast` — each with its own provider, rate limit and
 * fallback chain. A generic engine sends `model: <string>` and finds out from a
 * 400 whether that string meant anything.
 *
 * Reading the roster costs one file parse at startup and buys three things:
 *
 *   1. A typo fails in 40ms with the correct spelling, instead of surfacing as
 *      a router error mid-turn that reads like an outage.
 *   2. `--doctor` and `--seats` can show what is actually available, which is
 *      otherwise only discoverable by reading YAML by hand.
 *   3. The engine never has to duplicate the routing table to be useful about
 *      it — it reads the same file the router reads, so the two cannot drift.
 *
 * Deliberately READ-ONLY. Routing, fallback and rate limiting stay the router's
 * job; an engine that starts making those decisions creates a second table that
 * disagrees with the first. This only ever answers "does that seat exist, and
 * what is behind it".
 *
 * Fails OPEN: no litellm.yaml, or one this cannot parse, means seat checking is
 * skipped. A convenience that refuses to run the engine is not a convenience.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, cliName } from './config.mjs'

/**
 * The parsed roster, keyed by the file's identity rather than by time.
 *
 * WHY. `checkSeat(name)` defaults its second argument to `loadSeats()`, so every
 * call that does not pass a roster re-reads and re-scans litellm.yaml — 49KB
 * here. `createSession` validates one seat per agent in a loop over the brain's
 * 16 agents, which made session start do sixteen full reads of the same file:
 * 13.5ms measured, against 0.8ms for one read and sixteen lookups. Textbook I/O
 * inside a loop, and it sits on the path before the first frame is drawn.
 *
 * Keyed on mtime AND size, not on a flag: `--seats` must tell the truth right
 * after you edit the router config, and a cache that only invalidates on
 * restart would quietly answer from a file that no longer exists on disk.
 * `statSync` costs one syscall and does not read the file.
 *
 * The cached Map is SHARED. Every reader here treats it as read-only; anything
 * that needs to mutate a roster must copy it first.
 */
let cached = null

/**
 * Minimal scan for the two keys that matter. Not a YAML parser: the file is 50KB
 * of comments and nested provider config, and all this needs is the seat names
 * and what each points at.
 */
export function loadSeats(path = null) {
  const p = path || join(configDir(), 'litellm.yaml')
  let st
  try { st = statSync(p) } catch { return null }   // absent — fail open, as before
  if (cached && cached.p === p && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.seats
  }
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return null
  }

  const seats = new Map()
  let current = null
  // `algo_check` reads the `.exec()` calls below as I/O inside a loop (N+1).
  // They are `RegExp.exec` over one line of YAML: pure CPU, O(1) per line, so
  // the scan is linear in the file. The real I/O in this function is the single
  // readFileSync above, which is what the memo exists to stop repeating.
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]
    let m = /^\s*-?\s*model_name:\s*(\S+)/.exec(line)
    if (m) { current = m[1]; if (!seats.has(current)) seats.set(current, {}); continue }
    if (!current) continue
    m = /^\s*model:\s*(\S+)/.exec(line)
    if (m && !seats.get(current).model) { seats.get(current).model = m[1]; continue }
    m = /^\s*rpm:\s*(\d+)/.exec(line)
    if (m && !seats.get(current).rpm) seats.get(current).rpm = Number(m[1])
  }
  const result = seats.size ? seats : null
  cached = { p, mtimeMs: st.mtimeMs, size: st.size, seats: result }
  return result
}

/** Drop the memo — for tests, and for anything that rewrites litellm.yaml. */
export function forgetSeats() { cached = null }

/**
 * Levenshtein, capped — only ever run against a roster of ~25 short strings.
 *
 * `algo_check` prices this O(n²) and `checkSeat` O(n³), and both are correct
 * arithmetic over the wrong n. The bounds: seat NAMES, ~24 characters, against a
 * roster of ~25, and only on the path where the name was not found — a hit
 * returns from the Map before any of this runs. Worst case ~15k character
 * comparisons, once, to spell a typo back at you.
 */
function distance(a, b) {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 4) return 99
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]
}

/**
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkSeat(name, seats = loadSeats()) {
  if (!seats) return { ok: true }                 // no roster — nothing to check against
  if (seats.has(name)) return { ok: true }

  const near = [...seats.keys()]
    .map((s) => ({ s, d: distance(name, s) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.s)

  return {
    ok: false,
    reason: `unknown seat "${name}"`
      + (near.length ? `. Did you mean: ${near.join(', ')}?` : '')
      + `\n  ${seats.size} seats are configured; run \`${cliName()} --seats\` to list them.`,
  }
}

/** Rendered roster for --seats and --doctor. */
export function renderSeats(seats = loadSeats()) {
  if (!seats) return '  (no litellm.yaml found — seat checking is off)'
  const rows = [...seats.entries()].sort(([a], [b]) => a.localeCompare(b))
  const w = Math.max(...rows.map(([n]) => n.length))
  return rows
    .map(([n, v]) => `  ${n.padEnd(w)}  ${v.model || '?'}${v.rpm ? `  (rpm ${v.rpm})` : ''}`)
    .join('\n')
}
