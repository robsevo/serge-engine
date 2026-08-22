/**
 * Loading the brain's own content: slash commands and skills.
 *
 * These are markdown files with YAML-ish frontmatter, sitting in the config dir.
 * The engine does not interpret them — it presents them:
 *
 *   commands/*.md    a prompt template. `/recap` sends that file's body as the
 *                    prompt, so the command is authored in the brain and the
 *                    engine only has to find and expand it.
 *   skills/<name>/SKILL.md  instructions loaded ON DEMAND. Only the name and
 *                    `whenToUse` line go into context up front; the body
 *                    arrives when the model asks for it through the Skill tool.
 *
 * WHY ON-DEMAND MATTERS. There are 22 skills here and their bodies run to tens
 * of thousands of tokens. Injecting them all would spend most of a context
 * window on instructions for work the turn is not doing. Injecting none would
 * mean the model never knows they exist. The index is the middle: one line each,
 * enough to decide, and the body is one tool call away.
 *
 * Frontmatter is parsed with a deliberately small reader rather than a YAML
 * dependency — these files use flat `key: value` pairs, and a parser that
 * handles anchors and multi-line flow scalars would be a supply chain for
 * nothing.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { configDir } from './config.mjs'

/** `---\nkey: value\n---\nbody` → { meta, body }. Unknown shapes degrade to no meta. */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }

  const meta = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    meta[m[1]] = v
  }
  const nl = text.indexOf('\n', end + 1)
  return { meta, body: nl === -1 ? '' : text.slice(nl + 1).trimStart() }
}

/** Every .md under a directory, one level of namespacing (`sc/analyze` → `sc:analyze`). */
function walkMarkdown(root, prefix = '') {
  const out = []
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (!prefix) out.push(...walkMarkdown(p, `${e.name}:`))
      continue
    }
    if (!e.name.endsWith('.md')) continue
    out.push({ path: p, name: prefix + basename(e.name, '.md') })
  }
  return out
}

/**
 * @returns {Map<string, {name, description, body, allowedTools, path}>}
 */
export function loadCommands(dir = null) {
  const root = join(dir || configDir(), 'commands')
  const map = new Map()
  for (const { path, name } of walkMarkdown(root)) {
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const { meta, body } = parseFrontmatter(text)
    map.set(name, {
      name,
      description: meta.description || '',
      allowedTools: meta['allowed-tools'] || '',
      body,
      path,
    })
  }
  return map
}

/**
 * @returns {Map<string, {name, description, whenToUse, path}>}
 */
export function loadSkills(dir = null) {
  const root = join(dir || configDir(), 'skills')
  const map = new Map()
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return map }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const path = join(root, e.name, 'SKILL.md')
    if (!existsSync(path)) continue
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const { meta } = parseFrontmatter(text)
    map.set(meta.name || e.name, {
      name: meta.name || e.name,
      description: meta.description || '',
      whenToUse: meta.whenToUse || '',
      path,
    })
  }
  return map
}

/** Full text of one skill, for the Skill tool. */
export function readSkill(skill) {
  try {
    const { body } = parseFrontmatter(readFileSync(skill.path, 'utf8'))
    return body
  } catch (e) {
    return `Could not read ${skill.name}: ${e.message}`
  }
}

/**
 * The one-line-per-skill index that goes into context at session start.
 *
 * `whenToUse` is the useful half — a description says what a skill is, but the
 * trigger is what lets a model decide whether this turn is one of its cases.
 */
export function skillIndex(skills) {
  if (!skills.size) return ''
  const lines = [...skills.values()].map((s) => {
    const trigger = (s.whenToUse || s.description || '').replace(/\s+/g, ' ')
    return `- ${s.name}: ${trigger.slice(0, 220)}`
  })
  return 'Skills available in this workspace. Load one with the Skill tool when the '
    + 'task matches — the body carries procedures the general answer will miss.\n\n'
    + lines.join('\n')
}

/** `$ARGUMENTS` / `$1`-style expansion for a slash command body. */
export function expandCommand(cmd, args) {
  const argv = args.trim() ? args.trim().split(/\s+/) : []
  return cmd.body
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$(\d+)/g, (_, n) => argv[Number(n) - 1] ?? '')
}
