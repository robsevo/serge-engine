#!/usr/bin/env node
/**
 * The engine honours a Stop hook that demands the turn explain itself.
 *
 * The brain's constitution already required this in two places — `communication`
 * ("everything the user needs from a turn ... lands in the final message") and
 * `completion_criteria` ("closing with a short summary: what changed ... never
 * ends a turn silently") — and nothing checked, so a turn could rewrite four
 * files and print `✓ Done · 44s`. `brain/dot-serge/explain-on-stop.sh` is the
 * check; this is the half that has to be true on the ENGINE side for it to mean
 * anything:
 *
 *   - a blocking Stop hook sends its reason to the model and RE-RUNS the turn,
 *   - the second pass carries `stop_hook_active`, so a gate that stands down on
 *     that flag can never loop,
 *   - and the answer the user finally sees is the second one.
 *
 * Runs the real loop against a scripted seat and the real hook script.
 *
 * Run:  node tests/explain-gate.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The brain sits beside the engine in two layouts: the serge-full pairing
// (../brain) and two sibling clones (../serge-brain). Neither is guaranteed —
// this repo stands alone — so a missing brain is a SKIP, not a failure.
const HOOK = [
  join(root, '..', 'brain', 'dot-serge', 'explain-on-stop.sh'),
  join(root, '..', 'serge-brain', 'dot-serge', 'explain-on-stop.sh'),
  join(process.env.HOME || '', '.serge', 'explain-on-stop.sh'),
].find((p) => existsSync(p))
if (!HOOK) {
  console.log('  skip  serge-brain is not beside this repo — nothing to test the engine against')
  console.log('\n  0/0 passed')
  process.exit(0)
}

const cwd = mkdtempSync(join(tmpdir(), 'serge-explain-'))
writeFileSync(join(cwd, 'settings.json'), JSON.stringify({
  hooks: {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `bash ${HOOK}`, timeout: 15 }] }],
  },
}))

const SHORT = 'Done.'
const REAL = 'I rewrote the handler so the three league fetches run concurrently '
  + 'instead of one after another, which turns three round trips into one. '
  + 'Nothing else in the file changed, and the response shape is identical. '
  + 'I did not touch the caching layer — that is a separate question.'

/* ── a scripted seat: Write, then a short answer, then a real one ─────── */

let script = []
let step = 0
const seen = []                       // what the model was actually sent, per call
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    try { seen.push(JSON.parse(body).messages ?? []) } catch { seen.push([]) }
    const s = script[Math.min(step++, script.length - 1)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (s.tool) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: s.tool.id, type: 'function',
        function: { name: s.tool.name, arguments: JSON.stringify(s.tool.args) } }] } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    } else {
      res.write(sse({ choices: [{ delta: { content: s.text } }] }))
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
process.env.OPENAI_API_KEY = 'sk-test'
process.env.CLAUDE_CONFIG_DIR = cwd
process.env.SERGE_NOTIFY_AFTER = '3600'

const { createSession } = await import('../src/loop.mjs')

/* ── a silent, edit-bearing turn is bounced exactly once ──────────────── */
{
  script = [
    { tool: { id: 'w1', name: 'Write', args: { file_path: join(cwd, 'route.ts'), content: 'export const x = 1\n' } } },
    { text: SHORT },
    { text: REAL },
  ]
  step = 0
  seen.length = 0
  const notices = []
  const s = createSession({
    cwd, model: 'test-seat', permissionMode: 'fullAccess',
    onNotice: (m, kind) => notices.push(`${kind}:${m}`),
  })
  const r = await s.send('make the league fetches concurrent')

  ok('the turn completed', !r.blocked, JSON.stringify(r).slice(0, 120))
  ok('the silent answer was NOT what the user got', r.text !== SHORT, r.text?.slice(0, 40))
  ok('the explanation is', r.text === REAL, r.text?.slice(0, 60))
  ok('the gate reported itself once', notices.filter((n) => /^model:stop hook/.test(n)).length === 1,
     notices.join(' | ').slice(0, 160))

  const bounced = seen[seen.length - 1].filter((m) => m.role === 'user'
    && typeof m.content === 'string' && /ended the turn with/.test(m.content))
  ok('the reason reached the model, naming the file', bounced.length === 1
     && /route\.ts/.test(bounced[0].content), bounced[0]?.content?.slice(0, 90))
  ok('the model was asked to describe, not redo',
     /do not redo the work/i.test(bounced[0]?.content ?? ''))
  ok('the file it wrote is still on disk', existsSync(join(cwd, 'route.ts')))
  ok('it took exactly one extra model call', seen.length === 3, `${seen.length} calls`)
}

/* ── it cannot loop, even if the model stays silent ───────────────────── */
{
  script = [
    { tool: { id: 'w2', name: 'Write', args: { file_path: join(cwd, 'again.ts'), content: 'y\n' } } },
    { text: SHORT },
    { text: SHORT },                  // still silent on the second pass
    { text: SHORT },
  ]
  step = 0
  seen.length = 0
  const s = createSession({ cwd, model: 'test-seat', permissionMode: 'fullAccess' })
  const r = await s.send('do it again')
  ok('a model that stays silent is not bounced forever', seen.length === 3, `${seen.length} calls`)
  ok('and the turn still ends', r.blocked === false && r.text === SHORT, JSON.stringify(r).slice(0, 80))
}

/* ── a turn that wrote nothing is never touched ───────────────────────── */
{
  script = [{ text: SHORT }]
  step = 0
  seen.length = 0
  const s = createSession({ cwd, model: 'test-seat', permissionMode: 'fullAccess' })
  const r = await s.send('what is 2 + 2')
  ok('a read-only turn may answer briefly', seen.length === 1 && r.text === SHORT,
     `${seen.length} calls, ${JSON.stringify(r.text)}`)
}

server.close()
rmSync(cwd, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
