#!/usr/bin/env node
/**
 * probe.mjs — the observer wired into every hook slot of a throwaway SERGE_HOME.
 *
 * The harness cannot ask an engine "do you fire PreToolUse?" and believe the
 * answer. So it doesn't ask: it installs this as a real hook and records what
 * actually arrives on stdin. Everything the report says is a transcript of
 * observed subprocess invocations.
 *
 * argv: <EventName> <logPath> [mode]
 *   mode "block" → exercises the deny path (exit 2 + stderr), used by the
 *                  control-protocol scenario.
 *
 * The log path is passed as an ARGUMENT, never read from the environment: an
 * engine is free to scrub the env it hands to hooks, and a probe that silently
 * wrote nowhere would look exactly like an engine that never fired the event.
 */
import { appendFileSync } from 'node:fs'

const [, , event, logPath, mode = 'record'] = process.argv

if (!event || !logPath) {
  process.stderr.write('probe.mjs: need <EventName> <logPath>\n')
  process.exit(1)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })

// An engine that fires the hook but never closes stdin would hang the turn.
// Record that as its own finding rather than blocking forever.
const bail = setTimeout(() => finish('stdin-never-closed'), 10_000)

process.stdin.on('end', () => finish(null))

function finish(stallReason) {
  clearTimeout(bail)
  let payload = null
  let parseError = null
  try {
    payload = raw.trim() ? JSON.parse(raw) : null
    if (payload === null && !stallReason) parseError = 'empty stdin'
  } catch (e) {
    parseError = String(e && e.message)
  }

  try {
    appendFileSync(logPath, JSON.stringify({
      event,
      mode,
      at: Date.now(),
      stallReason,
      parseError,
      rawBytes: raw.length,
      // Keys are what the report grades; values can contain session content, so
      // only small scalars are kept verbatim.
      keys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
      payload: payload && typeof payload === 'object' ? redact(payload) : null,
    }) + '\n')
  } catch {
    // A probe that cannot write must not take the engine down with it.
  }

  if (mode === 'block') {
    process.stderr.write(`serge-engine conformance: denied ${event} by probe\n`)
    process.exit(2)
  }
  if (mode === 'blockjson') {
    // The form the REAL gates use — path-reality-gate, vague-delete-gate,
    // gate-on-constitution-edit and tool-dedupe-guard all deny like this and
    // never exit 2. An engine that only honours exit codes ignores all four.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: 'serge-engine conformance: denied via hookSpecificOutput',
      },
    }))
    process.exit(0)
  }
  process.exit(0)
}

/**
 * Keep shape and small scalars; replace bulk text with a length marker.
 *
 * STRUCTURAL keys are never truncated. They are the contract itself — a
 * redacted transcript_path is indistinguishable from a missing one, and the
 * harness would report a working engine as broken (it did, first run).
 */
const STRUCTURAL = new Set([
  'transcript_path', 'cwd', 'session_id', 'hook_event_name',
  'tool_name', 'source', 'trigger', 'stop_hook_active', 'permission_mode',
])

function redact(o, depth = 0, key = null) {
  if (depth > 3) return '<deep>'
  if (Array.isArray(o)) return o.slice(0, 8).map((v) => redact(v, depth + 1))
  if (o && typeof o === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(o)) out[k] = redact(v, depth + 1, k)
    return out
  }
  if (typeof o === 'string' && !STRUCTURAL.has(key)) {
    return o.length > 120 ? `<str:${o.length}>` : o
  }
  return o
}
