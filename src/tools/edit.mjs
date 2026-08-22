import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const edit = {
  name: 'Edit',
  description: 'Replace an exact string in a file. Fails if the string is absent or ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  run(input, ctx) {
    const p = isAbsolute(input.file_path ?? '') ? input.file_path : resolve(ctx.cwd, input.file_path ?? '')
    if (!existsSync(p)) return { content: `File does not exist: ${p}`, isError: true }

    const src = readFileSync(p, 'utf8')
    const { old_string: oldS, new_string: newS } = input
    if (typeof oldS !== 'string' || typeof newS !== 'string') {
      return { content: 'Edit: old_string and new_string must be strings', isError: true }
    }
    if (oldS === newS) return { content: 'Edit: old_string and new_string are identical', isError: true }

    const count = src.split(oldS).length - 1
    if (count === 0) return { content: `Edit: old_string not found in ${p}`, isError: true }
    // Ambiguity is an error, not a coin flip — silently editing the wrong one of
    // three matches is the kind of "it worked" that is discovered much later.
    if (count > 1 && !input.replace_all) {
      return { content: `Edit: old_string appears ${count} times in ${p}; pass replace_all or make it unique`, isError: true }
    }

    writeFileSync(p, input.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, newS))
    return { content: `Edited ${p} (${input.replace_all ? count : 1} replacement(s))`, isError: false }
  },
}
