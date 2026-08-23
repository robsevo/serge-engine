/**
 * How a path written by the model becomes a real path.
 *
 * One place, because the rule was previously repeated in six tools and the
 * permission layer, and they had already drifted: none of the tools expanded
 * `~`, so `~/.serge/skills` resolved to `<cwd>/~/.serge/skills` — a directory
 * that cannot exist. Observed 2026-08-23 as
 * "No files match * under /home/ovrsv/~/.serge/skills".
 *
 * `~` is a SHELL convenience, not a filesystem one, so nothing expands it for a
 * process that was handed the string directly. A model writing `~/x` means the
 * home directory every time, and the literal reading is never useful.
 *
 * The permission layer must resolve the SAME way. If a tool expanded `~` and
 * the checker did not, a deny rule on `/home/u/.ssh` would silently fail to
 * match a call written as `~/.ssh`.
 */
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * @param {string} cwd   the session's working directory
 * @param {string} p     a path as written by the model
 * @returns {string}     an absolute, normalised path
 */
export function resolvePath(cwd, p) {
  const s = String(p ?? '')
  if (!s) return resolve(cwd)
  // `~` alone, or `~/...`. NOT `~user/...` — resolving another account's home
  // would be a guess, and `~foo` is a legal directory name.
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return resolve(homedir(), s.slice(2))
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s)
}
