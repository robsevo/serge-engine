#!/usr/bin/env node
/**
 * Reasoning seats stream their thinking in a separate field.
 *
 * The provider read only `delta.content`. On a reasoning seat that meant the
 * whole thinking phase produced no callback at all — the turn looked frozen —
 * and a turn that reasoned more than it wrote came back empty often enough that
 * the Stop hook had to bounce it. That is the "wait, or ask it again" stall.
 *
 * Run:  node tests/reasoning.test.mjs
 */
import { createServer } from 'node:http'
import { complete } from '../src/provider.mjs'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`
const delta = (d) => sse({ choices: [{ delta: d }] })

let script = []
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of script) res.write(chunk)
  res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
  res.end('data: [DONE]\n\n')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`

const run = async () => {
  let think = '', toks = ''
  const r = await complete({
    baseUrl: base, apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    onToken: (t) => { toks += t },
    onReasoning: (t) => { think += t },
  })
  return { r, think, toks }
}

// A real Mistral/Magistral stream: both field names, carrying the SAME text.
script = [
  delta({ role: 'assistant' }),
  delta({ reasoning_content: 'let me think. ', reasoning: 'let me think. ' }),
  delta({ reasoning_content: '17*20=340. ', reasoning: '17*20=340. ' }),
  delta({ content: '391' }),
]
let { r, think, toks } = await run()
ok('reasoning is captured', r.reasoning === 'let me think. 17*20=340. ', JSON.stringify(r.reasoning))
ok('it is NOT doubled by the duplicate field', r.reasoning.length === 25, `${r.reasoning.length} chars`)
ok('onReasoning fires during thinking', think.length === 25, `${think.length}`)
ok('visible text is only the content', r.text === '391', JSON.stringify(r.text))
// The whole point: reasoning must never reach the transcript as the answer.
ok('reasoning does NOT reach onToken', toks === '391', JSON.stringify(toks))

// The blank-turn case: reasoned, wrote nothing. Previously indistinguishable
// from a dead turn; now the caller can tell the difference.
script = [delta({ reasoning_content: 'thinking hard' })]
;({ r, think } = await run())
ok('a reason-only turn still reports its reasoning', r.reasoning === 'thinking hard')
ok('and reports empty text honestly', r.text === '', JSON.stringify(r.text))
ok('so a blank turn is distinguishable from a dead one', r.reasoning.length > 0 && r.text.length === 0)

// Only `reasoning`, no `reasoning_content` — some providers send just one.
script = [delta({ reasoning: 'only-one-field' }), delta({ content: 'hi' })]
;({ r } = await run())
ok('the single-field form works too', r.reasoning === 'only-one-field' && r.text === 'hi')

// A seat with no reasoning at all must be unaffected.
script = [delta({ content: 'plain' })]
;({ r, think } = await run())
ok('a non-reasoning seat is unchanged', r.text === 'plain' && r.reasoning === '' && think === '')

server.close()
const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
