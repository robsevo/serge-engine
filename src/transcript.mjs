/**
 * JSONL transcript writer.
 *
 * This is not a log. Serge's gates re-read it to check what a turn actually did
 * — claims-gate.sh walks it for tool_use/tool_result pairs, which is the only
 * reason a false "I ran the tests" claim is catchable at all. The shape below is
 * the one captured in docs/ENGINE-CONTRACT.md from a working engine.
 *
 * One rule matters more than the rest: a `user` entry carrying tool_result
 * blocks is a TOOL RESULT, not a new user prompt. Gates split "this turn" on
 * real user prompts; conflate the two and every turn looks like it started
 * fresh.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectsDir } from './config.mjs'

export class Transcript {
  constructor(sessionId, cwd) {
    this.sessionId = sessionId
    // Mirrors serge's layout: one directory per project, slugified from cwd.
    const slug = cwd.replace(/[/\\]/g, '-').replace(/^-/, '') || 'root'
    this.path = join(projectsDir(), slug, `${sessionId}.jsonl`)
    mkdirSync(dirname(this.path), { recursive: true })
  }

  #append(entry) {
    appendFileSync(this.path, JSON.stringify({ ...entry, uuid: randomUUID(), timestamp: new Date().toISOString() }) + '\n')
  }

  /** A REAL user prompt — the thing that starts a turn. */
  userPrompt(text) {
    this.#append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  assistantText(text) {
    this.#append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  }

  /** calls: [{id, name, input}] */
  assistantToolUse(calls) {
    this.#append({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      },
    })
  }

  /** results: [{id, content, isError}] — a `user` entry WITHOUT text blocks. */
  toolResults(results) {
    this.#append({
      type: 'user',
      message: {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          is_error: Boolean(r.isError),
        })),
      },
    })
  }
}
