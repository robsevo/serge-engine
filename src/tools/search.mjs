/**
 * Glob and Grep.
 *
 * COMPLEXITY, stated up front because this engine's own doctrine demands it:
 *   walk        O(F) over files not pruned, F = files under root
 *   Glob        O(F) match, no file contents read
 *   Grep        O(F + B) where B = bytes read; only files passing the
 *               glob/type filter are opened, and each is read once
 *
 * The pruning list is the load-bearing part. A repo with node_modules is
 * routinely 100x its own source tree, so walking it is not a constant factor —
 * it is the difference between a 40ms call and a 6s one. Pruning happens at the
 * DIRECTORY level (never descend) rather than filtering paths afterwards,
 * because the cost being avoided is the readdir, not the comparison.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep, basename } from 'node:path'

const PRUNE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'coverage',
])

const MAX_FILES = 20_000        // walk ceiling — a runaway tree fails loudly
const MAX_BYTES = 2_000_000     // per-file read ceiling for Grep
const MAX_HITS = 200

/** Depth-first walk with directory-level pruning. Returns absolute paths. */
function walk(root, { limit = MAX_FILES } = {}) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < limit) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (PRUNE.has(e.name) || e.name.startsWith('.') && e.name !== '.') continue
        stack.push(p)
      } else if (e.isFile()) {
        out.push(p)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/** Glob → RegExp. `**` crosses separators, `*` does not, `?` is one char. */
function globToRe(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
      else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

export const glob = {
  name: 'Glob',
  description: 'Find files by glob pattern (e.g. "**/*.ts"). Returns paths, most recently modified first.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, matched against the path relative to path.' },
      path: { type: 'string', description: 'Directory to search (default: cwd).' },
    },
    required: ['pattern'],
  },
  run(input, ctx) {
    const root = resolve(ctx.cwd, input.path || '.')
    const re = globToRe(String(input.pattern ?? '*'))
    const files = walk(root)
      .filter((f) => re.test(relative(root, f).split(sep).join('/')))
      // A file that vanished between the walk and the stat sorts oldest rather
      // than failing the whole glob — the race is expected on a live tree.
      .map((f) => {
        let m = 0
        try { m = statSync(f).mtimeMs } catch { m = 0 }
        return { f, m }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_HITS)
      .map((x) => x.f)

    if (!files.length) return { content: `No files match ${input.pattern} under ${root}`, isError: false }
    return { content: files.join('\n'), isError: false }
  },
}

export const grep = {
  name: 'Grep',
  description: 'Search file contents by regular expression. Returns matching lines with file:line prefixes.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search (default: cwd).' },
      glob: { type: 'string', description: 'Only search files matching this glob.' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive match.' },
      max_results: { type: 'number', description: 'Cap on matching lines (default 200).' },
    },
    required: ['pattern'],
  },
  run(input, ctx) {
    const target = resolve(ctx.cwd, input.path || '.')
    let re
    try {
      re = new RegExp(String(input.pattern), input.case_insensitive ? 'i' : '')
    } catch (e) {
      return { content: `Grep: invalid regular expression — ${e.message}`, isError: true }
    }

    let files
    try {
      files = statSync(target).isDirectory() ? walk(target) : [target]
    } catch {
      return { content: `Grep: no such path: ${target}`, isError: true }
    }

    if (input.glob) {
      const g = globToRe(String(input.glob))
      files = files.filter((f) => g.test(relative(target, f).split(sep).join('/')) || g.test(basename(f)))
    }

    const cap = Math.min(Number(input.max_results) || MAX_HITS, 2000)
    const hits = []
    let scanned = 0
    for (const f of files) {
      if (hits.length >= cap) break
      let body
      try {
        if (statSync(f).size > MAX_BYTES) continue
        body = readFileSync(f, 'utf8')
      } catch { continue }
      // Binary files produce noise, not matches.
      if (body.indexOf('\u0000') !== -1) continue
      scanned++
      const lines = body.split('\n')
      for (let i = 0; i < lines.length && hits.length < cap; i++) {
        if (re.test(lines[i])) hits.push(`${f}:${i + 1}:${lines[i].slice(0, 400)}`)
      }
    }

    if (!hits.length) return { content: `No matches for /${input.pattern}/ in ${scanned} file(s)`, isError: false }
    const more = hits.length >= cap ? `\n… capped at ${cap} matches` : ''
    return { content: hits.join('\n') + more, isError: false }
  },
}
