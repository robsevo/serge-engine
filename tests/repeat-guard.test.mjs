#!/usr/bin/env node
/**
 * The repeated-call guard.
 *
 * Written from a real session: "hey serge whats up?" produced
 * `Glob {"pattern":"*"}` three times against $HOME, each one a full model
 * round-trip on a slow seat. The engine served identical bytes each time and
 * said nothing, so the model had no signal it was going in circles.
 *
 * Drives the REAL provider against a local OpenAI-compatible server rather than
 * injecting a fake `complete`, so the loop, the streaming parser and the guard
 * are all on the path under test — and no seam exists in production code that
 * only tests use.
 *
 * Run:  node tests/repeat-guard.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const cwd = mkdtempSync(join(tmpdir(), 'serge-repeat-'))
writeFileSync(join(cwd, 'a.txt'), 'hello')

// The model asks for the SAME Glob three times, then answers.
const script = [
  { tool: { id: 't1', name: 'Glob', args: { pattern: '*' } } },
  { tool: { id: 't2', name: 'Glob', args: { pattern: '*' } } },
  { tool: { id: 't3', name: 'Glob', args: { pattern: '*' } } },
  { text: 'done' },
]
let step = 0
// The tool messages of the LAST request. The conversation is re-sent whole
// each time, so the final request carries all three results in order — while
// deduping across requests would collapse results 2 and 3, which are byte-
// identical by design (same output, same flag).
let lastToolResults = []

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    try {
      const msgs = JSON.parse(body).messages || []
      const tools = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content))
      if (tools.length) lastToolResults = tools
    } catch { /* the assertions will show it */ }

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
const port = server.address().port

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
process.env.OPENAI_API_KEY = 'sk-test'
process.env.CLAUDE_CONFIG_DIR = cwd          // an empty brain: no hooks, no skills

const { createSession } = await import('../src/loop.mjs')
const session = createSession({ cwd, model: 'test-seat', permissionMode: 'fullAccess' })
const res = await session.send('list the files')
server.close()

ok('the turn completed', /done/.test(res.text || ''), JSON.stringify(res).slice(0, 120))
ok('all three Globs ran', lastToolResults.length === 3, `saw ${lastToolResults.length}`)

const flagged = lastToolResults.filter((c) => /REPEATED CALL/.test(c))
ok('the first call is NOT flagged', !/REPEATED CALL/.test(lastToolResults[0] ?? ''),
   (lastToolResults[0] ?? '').slice(0, 80))
ok('both repeats ARE flagged', flagged.length === 2, `flagged ${flagged.length} of 3`)
ok('the flag says what to do instead', /use what you already have|change the call/.test(flagged[0] ?? ''))
ok('the real result survives the flag', /a\.txt/.test(flagged[0] ?? ''), (flagged[0] ?? '').slice(0, 90))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
