import { readFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const read = {
  name: 'Read',
  description: 'Read a file from disk. Returns contents with 1-indexed line numbers.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file.' },
      offset: { type: 'number', description: '1-indexed line to start at.' },
      limit: { type: 'number', description: 'Maximum lines to return (default 2000).' },
    },
    required: ['file_path'],
  },
  run(input, ctx) {
    const p = isAbsolute(input.file_path ?? '') ? input.file_path : resolve(ctx.cwd, input.file_path ?? '')
    if (!existsSync(p)) return { content: `File does not exist: ${p}`, isError: true }
    if (statSync(p).isDirectory()) return { content: `${p} is a directory, not a file`, isError: true }

    const lines = readFileSync(p, 'utf8').split('\n')
    const start = Math.max(1, Number(input.offset) || 1)
    const limit = Math.max(1, Number(input.limit) || 2000)
    const slice = lines.slice(start - 1, start - 1 + limit)
    if (!slice.length) return { content: `(no lines at offset ${start}; file has ${lines.length})`, isError: false }

    return {
      content: slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n'),
      isError: false,
    }
  },
}
