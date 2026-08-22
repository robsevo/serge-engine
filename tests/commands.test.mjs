#!/usr/bin/env node
/**
 * Slash commands.
 *
 * The point of this suite is the pair of properties that broke before it
 * existed: every command `/` OFFERS must actually dispatch (an offered name
 * that answers "unknown command" is worse than not offering it), and a plain
 * prompt must never be mistaken for a command.
 */
import { catalog, complete, dispatch, parseCommand, BUILTINS } from '../src/commands.mjs'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const brain = new Map([
  ['review', { name: 'review', description: 'review the diff', body: 'Review: $ARGUMENTS' }],
  ['help', { name: 'help', description: 'a brain file shadowing a built-in', body: 'x' }],
])

// A stub session: /cost, /model and friends only read these.
const session = {
  model: 'local-coder', mode: 'default', turns: 3, transcriptPath: '/t/x.jsonl',
  usage: { prompt: 1200, completion: 340, requests: 4 },
  skills: new Map([['api', { name: 'api', description: 'API work' }]]),
  agents: new Map([['explore', { name: 'explore', description: 'search', model: '' }]]),
  clear() { this.cleared = true },
}
const ctx = { session, seats: new Map(), mcp: null, commands: brain, sessions: [] }

// ── parsing ────────────────────────────────────────────────────────────────
ok('a plain prompt is not a command', parseCommand('how do I sort this?') === null)
ok('a bare slash mid-sentence is not a command', parseCommand('use and/or here') === null)
// A leading `/` is taken as a command even when it looks like a path — the
// menu shows nothing matching, and submitting says "unknown command /etc".
// Guessing that a path is a prompt would make `/` unpredictable.
ok('a leading path parses as a command name', parseCommand('/etc/passwd is a file')?.name === 'etc/passwd')
ok('/help parses', parseCommand('/help')?.name === 'help')
ok('an argument is kept whole', parseCommand('/model  gpt 4 ')?.arg === 'gpt 4')
ok('leading space still parses', parseCommand('  /cost')?.name === 'cost')

// ── completion ─────────────────────────────────────────────────────────────
ok('bare / offers everything', complete('', brain).length === BUILTINS.length + brain.size)
ok('a prefix narrows', complete('mo', brain).every((c) => c.name.includes('mo')))
ok('prefix hits rank first', complete('mo', brain)[0].name === 'model')
ok('brain commands are offered', complete('rev', brain).some((c) => c.name === 'review'))
ok('no match is empty, not everything', complete('zzzz', brain).length === 0)
ok('completion is case-insensitive', complete('HEL', brain).some((c) => c.name === 'help'))

// A shadowed brain command is listed and MARKED, not silently dropped.
const shadow = catalog(brain).filter((c) => c.name === 'help')
ok('a shadowed name appears twice', shadow.length === 2, `saw ${shadow.length}`)
ok('the shadowed one says so', shadow.some((c) => /shadowed/.test(c.description)))

// The menu renders one row per entry, so entries must be distinguishable by
// something. Keying on the NAME alone shipped a React duplicate-key warning the
// moment a brain published its own /cost — the shadow case two asserts above
// says is deliberate. source+name is the identity.
const keys = catalog(brain).map((c) => c.source + ':' + c.name)
ok('catalogue entries have unique identities', new Set(keys).size === keys.length,
   `dupes: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`)
const names = catalog(brain).map((c) => c.name)
ok('and names alone are NOT unique — which is why', new Set(names).size !== names.length)

// ── every offered command dispatches ───────────────────────────────────────
// This is the property that matters: `/` must not advertise a dead name.
const dead = []
for (const c of catalog(brain)) {
  const r = dispatch('/' + c.name, ctx)
  if (!r || r.unknown) dead.push(c.name)
}
ok('every offered command dispatches', dead.length === 0, `dead: ${dead.join(', ')}`)

// ── dispatch behaviour ─────────────────────────────────────────────────────
ok('a non-command returns null', dispatch('just a question', ctx) === null)
ok('/help returns lines', (dispatch('/help', ctx).lines || []).length > 0)
ok('/nope is unknown, not a crash', dispatch('/nope', ctx).unknown === 'nope')
ok('/exit asks to exit', dispatch('/exit', ctx).exit === true)
ok('/quit is /exit', dispatch('/quit', ctx).exit === true)
ok('/cost reports real usage', /1k in/.test(dispatch('/cost', ctx).lines.join(' ')))
ok('/mode with no arg reports', dispatch('/mode', ctx).lines[0].includes('default'))
ok('/mode rejects an unknown mode', dispatch('/mode banana', ctx).tone === 'error')
ok('a rejected mode does not take effect', session.mode === 'default')
ok('/mode plan takes effect', dispatch('/mode plan', ctx).mode === 'plan' && session.mode === 'plan')
ok('/clear clears the session', dispatch('/clear', ctx).cleared === true && session.cleared)
ok('/skills lists a skill', dispatch('/skills', ctx).lines.some((l) => l.includes('api')))
ok('/agents lists an agent', dispatch('/agents', ctx).lines.some((l) => l.includes('explore')))
ok('/mcp with none says so', /no MCP/.test(dispatch('/mcp', ctx).lines[0]))
ok('/resume with none says so', /no earlier/.test(dispatch('/resume', ctx).lines[0]))

// A brain command becomes a PROMPT, not output — that is the whole difference.
const r = dispatch('/review the auth diff', ctx)
ok('a brain command returns a prompt', typeof r.prompt === 'string')
ok('its $ARGUMENTS expand', r.prompt.includes('the auth diff'), r.prompt)
ok('a built-in beats a brain file of the same name', !dispatch('/help', ctx).prompt)

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
