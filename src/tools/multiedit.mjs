import { resolvePath } from '../paths.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * MultiEdit — several exact replacements against one file, ATOMICALLY.
 *
 * Atomicity is the whole reason this exists as its own tool rather than a loop
 * over Edit. Edits are usually interdependent (rename a symbol, then update its
 * call sites); applying three of five and failing on the fourth leaves the file
 * in a state neither the model nor the user asked for, and the model's next move
 * is to "fix" a file whose contents it no longer knows. So every edit is
 * validated and applied to an in-memory buffer, and the buffer is written once —
 * either all of it lands or the file is untouched.
 *
 * Complexity: O(E * L) where E = edits, L = file length. E is small by
 * construction; the naive scan is the right call over building an index.
 */
export const multiEdit = {
  name: 'MultiEdit',
  description: 'Apply several exact string replacements to one file atomically. Either all succeed or none are written.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file.' },
      edits: {
        type: 'array',
        description: 'Edits applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  run(input, ctx) {
    const p = resolvePath(ctx.cwd, input.file_path)
    if (!existsSync(p)) return { content: `File does not exist: ${p}`, isError: true }
    const edits = Array.isArray(input.edits) ? input.edits : null
    if (!edits || !edits.length) return { content: 'MultiEdit: edits must be a non-empty array', isError: true }

    let buf = readFileSync(p, 'utf8')
    const applied = []

    for (let i = 0; i < edits.length; i++) {
      const { old_string: oldS, new_string: newS, replace_all: all } = edits[i] ?? {}
      const where = `edit ${i + 1}/${edits.length}`

      if (typeof oldS !== 'string' || typeof newS !== 'string') {
        return { content: `MultiEdit: ${where} — old_string and new_string must be strings. Nothing written.`, isError: true }
      }
      if (oldS === newS) {
        return { content: `MultiEdit: ${where} — old_string and new_string are identical. Nothing written.`, isError: true }
      }

      const count = buf.split(oldS).length - 1
      if (count === 0) {
        // Name the likely cause: an earlier edit in this same batch may have
        // already rewritten the text this one was targeting.
        return {
          content: `MultiEdit: ${where} — old_string not found. Nothing written.`
            + (applied.length ? ` Note: ${applied.length} earlier edit(s) in this batch changed the file first; `
              + 'this edit may be targeting text one of them already replaced.' : ''),
          isError: true,
        }
      }
      if (count > 1 && !all) {
        return { content: `MultiEdit: ${where} — old_string appears ${count} times; pass replace_all or make it unique. Nothing written.`, isError: true }
      }

      buf = all ? buf.split(oldS).join(newS) : buf.replace(oldS, newS)
      applied.push(all ? count : 1)
    }

    writeFileSync(p, buf)
    return {
      content: `MultiEdit: applied ${edits.length} edit(s) to ${p} (${applied.reduce((a, b) => a + b, 0)} replacement(s))`,
      isError: false,
    }
  },
}
