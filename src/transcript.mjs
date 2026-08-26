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
import { projectDirFor } from './config.mjs'

export class Transcript {
  constructor(sessionId, cwd, parent = null) {
    this.sessionId = sessionId
    // Mirrors serge's layout: one directory per project, slugified from cwd.
    // The slug rule lives in config.mjs because sessions.mjs has to spell it
    // the same way to find this file again — and once did not.
    this.path = join(projectDirFor(cwd), `${sessionId}.jsonl`)
    mkdirSync(dirname(this.path), { recursive: true })
    // Lineage marker, written before anything else. A fork does NOT copy its
    // parent's entries — it points at them. Copying would double every byte of
    // a long conversation per branch and leave two records that can disagree
    // after an edit; a pointer keeps one source of truth and makes the branch
    // structure visible to anything reading the directory.
    if (parent) {
      this.parent = parent
      this.#append({ type: 'meta', parent_session_id: parent })
    }
  }

  #append(entry) {
    appendFileSync(this.path, JSON.stringify({ ...entry, uuid: randomUUID(), timestamp: new Date().toISOString() }) + '\n')
  }

  /** A REAL user prompt — the thing that starts a turn. */
  userPrompt(text) {
    this.#append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  /**
   * Provider usage in the shape the brain's statusline reads.
   *
   * It looks for `message.usage.{input,output}_tokens` straight out of this
   * file, so omitting it makes a working session report `tok 0/0` forever — the
   * numbers exist, they just never reach the one thing that shows them.
   */
  #usage(u) {
    return u ? { usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
    } } : {}
  }

  assistantText(text, usage = null) {
    this.#append({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }], ...this.#usage(usage) },
    })
  }

  /** calls: [{id, name, input}] */
  assistantToolUse(calls, usage = null) {
    this.#append({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        ...this.#usage(usage),
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
