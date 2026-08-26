/**
 * Session listing and resume.
 *
 * The transcript is already a complete record of a conversation — the gates read
 * it back to check a turn's claims — so resuming is a matter of replaying it
 * into the message shape the provider wants, not of keeping a second store that
 * could disagree with it.
 *
 * WHAT REPLAY MUST GET RIGHT. A tool call and its result are two entries that
 * refer to each other by id. Drop one, or let them cross a truncation boundary,
 * and the provider rejects the whole conversation: an assistant message with
 * `tool_calls` MUST be followed by a `tool` message for every id it names. So
 * truncation happens at TURN boundaries, never mid-exchange.
 *
 * WHAT IT DELIBERATELY DROPS. Injected hook context (`role: system` lines from
 * UserPromptSubmit) is not replayed — those hooks fire again on the next prompt,
 * and replaying the old ones would stack the same directive twice.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { projectDirFor, legacyProjectDirFor } from './config.mjs'

/** The `parent_session_id` a fork records in its first line, if any. */
function parentOf(lines) {
  for (const line of lines.slice(0, 3)) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'meta' && e.parent_session_id) return e.parent_session_id
    } catch { /* not the marker */ }
  }
  return null
}

/**
 * Every directory that may hold this cwd's transcripts, newest layout first.
 * The second entry only exists on an install that wrote sessions under the old
 * slug (see config.mjs). Listing both is what keeps a pre-fix history
 * resumable instead of appearing to have been erased by an upgrade.
 */
function projectDirs(cwd) {
  return [projectDirFor(cwd), legacyProjectDirFor(cwd)].filter((d) => d && existsSync(d))
}

/**
 * Recent sessions for a working directory, newest first.
 * @returns {Array<{id, path, mtime, turns, preview}>}
 */
export function listSessions(cwd, limit = 20) {
  const out = []
  for (const dir of projectDirs(cwd)) {
    let names
    try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')) } catch { continue }
    for (const n of names) {
      const path = join(dir, n)
      let st
      try { st = statSync(path) } catch { continue }
      const { turns, preview } = summarize(path)
      let parent = null
      try { parent = parentOf(readFileSync(path, 'utf8').split('\n')) } catch { /* unreadable */ }
      if (!turns && !parent) continue          // an empty session is noise
      out.push({ id: n.replace(/\.jsonl$/, ''), path, mtime: st.mtimeMs, turns, preview, parent })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/** First user prompt + turn count, without loading the whole file into memory twice. */
function summarize(path) {
  let turns = 0
  let preview = ''
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type !== 'user') continue
      const c = e.message?.content
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''
      if (!text) continue                      // a tool_result is not a turn
      turns++
      if (!preview) preview = text.replace(/\s+/g, ' ').slice(0, 72)
    }
  } catch { /* unreadable — reported as 0 turns and skipped */ }
  return { turns, preview }
}

/** Resolve --resume's argument: an id, a prefix, or nothing (means latest). */
export function findSession(cwd, ref = null) {
  const all = listSessions(cwd, 200)
  if (!all.length) return null
  if (!ref) return all[0]
  return all.find((s) => s.id === ref)
    || all.find((s) => s.id.startsWith(ref))
    || null
}

/**
 * Where a fork's parent transcript actually lives.
 *
 * Normally beside the fork. But a session forked out of a pre-fix directory
 * writes the new transcript under the corrected slug while still naming a
 * parent that stayed behind, so the two ends of one conversation sit in
 * sibling directories. Looking only beside the fork finds nothing, and a
 * missing parent replays as empty — the fork would quietly lose everything it
 * was forked from, which is worse than the resume bug this all started with.
 *
 * Ids are UUIDs, so widening the search to the other project directories risks
 * nothing and is only ever reached on a miss.
 */
function resolveParent(path, parentId) {
  const here = dirname(path)
  const name = `${parentId}.jsonl`
  const beside = join(here, name)
  if (existsSync(beside)) return beside
  const root = dirname(here)
  let siblings
  try { siblings = readdirSync(root) } catch { return beside }
  for (const s of siblings) {
    const candidate = join(root, s, name)
    if (candidate !== beside && existsSync(candidate)) return candidate
  }
  return beside                                // report the expected path
}

/**
 * Replay a transcript into provider messages.
 * @returns {{messages: Array, turns: number, dropped: number}}
 */
export function replay(path, { maxChars = 300_000, _seen = new Set() } = {}) {
  const messages = []
  let turns = 0
  if (!existsSync(path)) return { messages, turns, dropped: 0 }

  let lines
  try { lines = readFileSync(path, 'utf8').split('\n') } catch { return { messages, turns, dropped: 0 } }

  // A fork points at its parent instead of copying it, so the parent's messages
  // are replayed first. `_seen` stops a hand-edited cycle from recursing
  // forever — a malformed file should not hang the CLI.
  // Seed with THIS file's own id before following the pointer. Guarding only on
  // the parent still lets a self-referential file replay itself once, which
  // silently doubles the conversation instead of hanging — a quieter bug than
  // the loop it was meant to prevent.
  const selfId = basename(path, '.jsonl')
  _seen.add(selfId)
  const parentId = parentOf(lines)
  if (parentId && !_seen.has(parentId)) {
    _seen.add(parentId)
    const up = replay(resolveParent(path, parentId), { maxChars, _seen })
    messages.push(...up.messages)
    turns += up.turns
  }

  for (const line of lines) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const content = e.message?.content
    if (!Array.isArray(content)) {
      if (e.type === 'user' && typeof content === 'string') { messages.push({ role: 'user', content }); turns++ }
      continue
    }

    const texts = content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    const calls = content.filter((b) => b?.type === 'tool_use')
    const results = content.filter((b) => b?.type === 'tool_result')

    if (e.type === 'user') {
      if (results.length) {
        for (const r of results) {
          messages.push({
            role: 'tool',
            tool_call_id: r.tool_use_id,
            content: String(r.content ?? ''),
          })
        }
      } else if (texts) {
        messages.push({ role: 'user', content: texts })
        turns++
      }
      continue
    }

    if (e.type === 'assistant') {
      if (calls.length) {
        messages.push({
          role: 'assistant',
          content: texts || null,
          tool_calls: calls.map((c) => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        })
      } else if (texts) {
        messages.push({ role: 'assistant', content: texts })
      }
    }
  }

  const dropped = trimToBudget(messages, maxChars)
  return { messages, turns, dropped }
}

/**
 * Drop whole exchanges from the front until the history fits.
 *
 * Cutting mid-exchange is the failure to avoid: an assistant message carrying
 * `tool_calls` whose matching `tool` replies were trimmed away makes the whole
 * request invalid, and the error names the provider rather than the cause. So
 * the cut point is always a `user` message — the start of a turn.
 */
function trimToBudget(messages, maxChars) {
  const size = () => messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0)
      + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)

  let dropped = 0
  while (size() > maxChars && messages.length > 2) {
    let cut = 1
    while (cut < messages.length && messages[cut].role !== 'user') cut++
    if (cut >= messages.length) break          // no clean boundary — keep it whole
    messages.splice(0, cut)
    dropped += cut
  }
  return dropped
}

/** Human-readable list for `--resume` with no argument. */
export function renderSessions(sessions) {
  if (!sessions.length) return '  (no previous sessions for this directory)'
  const now = Date.now()
  return sessions.map((s, i) => {
    const age = ago(now - s.mtime)
    const branch = s.parent ? `↳${s.parent.slice(0, 4)} ` : '     '
    return `  ${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)}  ${branch}${age.padEnd(8)}`
      + `${String(s.turns).padStart(3)} turn${s.turns === 1 ? ' ' : 's'}  ${s.preview}`
  }).join('\n')
}

function ago(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
