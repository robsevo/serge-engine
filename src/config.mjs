/**
 * Config resolution. Serge's whole isolation story rests on CLAUDE_CONFIG_DIR:
 * the launcher sets it to ~/.serge so a Serge install never collides with a
 * real Claude Code install on the same machine. Honour it or the two share
 * settings, memory and transcripts.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * The only version literal in the engine; five copies used to disagree.
 * Read from package.json because that is what a release bumps.
 * `../package.json` resolves the same from src/ and dist/.
 * Falls back instead of throwing — a version is not worth failing a session for.
 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
      || '0.0.0-unknown'
  } catch {
    return '0.0.0-unknown'
  }
}

export const VERSION = readVersion()

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.serge')
}

export function loadSettings() {
  const p = join(configDir(), 'settings.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    // A broken settings.json must not be silently treated as "no settings" —
    // that would disable every hook the user thinks is protecting them.
    process.stderr.write(`serge-engine: settings.json is not valid JSON (${e.message})\n`)
    process.exit(1)
  }
}

export function projectsDir() {
  const d = join(configDir(), 'projects')
  mkdirSync(d, { recursive: true })
  return d
}

/**
 * The project directory name for a cwd.
 *
 * This has to match serge's own sanitizePath (src/utils/cachePaths.ts) byte for
 * byte, and it did not: serge turns EVERY non-alphanumeric character into '-',
 * including the leading '/', while this engine only mapped the separators and
 * then stripped the leading '-'. So `/home/u/programs` was written here as
 * `home-u-programs` and looked for by serge as `-home-u-programs`.
 *
 * That is not cosmetic. Resume is a single stat of one path — there is no
 * fallback scan — so a slug that differs by one character is a conversation
 * that cannot be resumed, reported as "No conversation found with session ID".
 * The brain's hooks (memory-load.sh, recap.sh, progress-load.sh) recompute the
 * same key in bash to find a project's transcript and memory, so a third
 * spelling would have silently pointed those at nothing as well.
 *
 * The rule, stated once: every byte outside [a-zA-Z0-9] becomes '-'. Nothing is
 * stripped, lowercased, or collapsed — two adjacent separators stay two dashes,
 * which is why serge's own dirs contain runs like `--`.
 */
const MAX_SANITIZED_LENGTH = 200

/** serge's djb2 (src/utils/hash.ts), reproduced so long paths agree too. */
function djb2Hash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i) | 0
  return hash
}

export function slugFor(cwd) {
  const s = String(cwd)
  const sanitized = s.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  // Truncating alone would collide two deep paths sharing a 200-char prefix.
  // The hash is of the ORIGINAL path, as serge computes it.
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(s)).toString(36)}`
}

/**
 * The slug this engine wrote before the fix above. Nothing writes here any
 * more; it exists so sessions already on disk stay listable and resumable.
 * Renaming those directories instead would be a destructive migration of the
 * user's history to fix a bug they can otherwise just... not notice.
 */
export function legacySlugFor(cwd) {
  return String(cwd).replace(/[/\\]/g, '-').replace(/^-/, '') || 'root'
}

/** Where this cwd's transcripts are written. */
export function projectDirFor(cwd) {
  return join(projectsDir(), slugFor(cwd))
}

/**
 * The pre-fix directory for this cwd, or null when it is the same one.
 * Read-only: callers must merge it in, never write to it.
 */
export function legacyProjectDirFor(cwd) {
  const legacy = legacySlugFor(cwd)
  return legacy === slugFor(cwd) ? null : join(projectsDir(), legacy)
}

/** Router endpoint. The launcher exports these; defaults match serge's. */
export function providerConfig(settings = {}) {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1').replace(/\/$/, ''),
    apiKey: process.env.OPENAI_API_KEY || 'sk-noop',
    model: process.env.OPENAI_MODEL || settings.model || 'local-coder',
  }
}
