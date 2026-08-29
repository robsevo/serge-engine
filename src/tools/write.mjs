import { resolvePath } from '../paths.mjs'
import { diffLines } from '../diff.mjs'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export const write = {
  name: 'Write',
  description: 'Write content to a file, creating or overwriting it.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file.' },
      content: { type: 'string', description: 'Full content to write.' },
    },
    required: ['file_path', 'content'],
  },
  run(input, ctx) {
    const p = resolvePath(ctx.cwd, input.file_path)
    if (typeof input.content !== 'string') return { content: 'Write: content must be a string', isError: true }
    const existed = existsSync(p)
    // Read BEFORE the write, and only when there is something to read: an
    // overwrite whose diff is computed against the file it just wrote shows
    // nothing changed, which is the one thing that is certainly false.
    let src = ''
    if (existed) { try { src = readFileSync(p, 'utf8') } catch { src = '' } }
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, input.content)
    return {
      content: `${existed ? 'Updated' : 'Created'} ${p} (${input.content.length} bytes)`,
      isError: false,
      diff: { file: p, ...diffLines(src, input.content) },
    }
  },
}
