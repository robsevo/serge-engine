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

/** Router endpoint. The launcher exports these; defaults match serge's. */
export function providerConfig(settings = {}) {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || 'http://localhost:4000/v1').replace(/\/$/, ''),
    apiKey: process.env.OPENAI_API_KEY || 'sk-noop',
    model: process.env.OPENAI_MODEL || settings.model || 'local-coder',
  }
}
