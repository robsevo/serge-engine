#!/usr/bin/env node
/**
 * WebFetch, WebSearch, and the SSRF guard underneath them.
 *
 * The guard is the part that matters. These tools take a URL chosen by the
 * model — which can come from a prompt, or from a page the model just read —
 * so a missing check is a path from "summarise this link" to the cloud metadata
 * endpoint. Every hole below is one a real scanner tries.
 *
 * Runs offline by default against a local server; the two live checks are
 * skipped unless SERGE_WEB_LIVE=1, so the suite stays deterministic in CI.
 *
 * Run:  node tests/web.test.mjs
 *       SERGE_WEB_LIVE=1 node tests/web.test.mjs
 */
import { createServer } from 'node:http'
import { checkUrl, safeFetch } from '../src/net.mjs'
import { htmlToText, focus, WebFetch, WebSearch } from '../src/tools/web.mjs'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/* ── the SSRF guard ───────────────────────────────────────────────────── */
console.log('── SSRF guard ──')

const REFUSE = [
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata endpoint'],
  ['http://127.0.0.1:4000/v1/models', 'loopback (the local router)'],
  ['http://[::1]/', 'IPv6 loopback'],
  ['http://10.1.2.3/', 'private 10/8'],
  ['http://172.16.5.5/', 'private 172.16/12'],
  ['http://192.168.0.1/', 'private 192.168/16'],
  ['http://100.100.0.1/', 'carrier-grade NAT'],
  ['http://0.0.0.0/', 'this-network'],
  ['http://[fe80::1]/', 'IPv6 link-local'],
  ['http://[fd00::1]/', 'IPv6 unique-local'],
  // Both spellings: the URL parser rewrites the dotted form to hex, so a guard
  // that only knows the readable one lets the readable one through.
  ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback, dotted'],
  ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback, hex'],
  ['http://[::ffff:a9fe:a9fe]/', 'IPv4-mapped metadata endpoint'],
  ['file:///etc/passwd', 'file: scheme'],
  ['gopher://example/', 'non-http scheme'],
  ['not-a-url', 'malformed URL'],
]
for (const [url, why] of REFUSE) {
  const r = await checkUrl(url)
  ok(`refuses ${why}`, r.ok === false, r.ok ? 'ALLOWED' : '')
}

// A public IP literal must still work — over-blocking makes the tool useless.
const pub = await checkUrl('http://[::ffff:808:808]/')
ok('allows a public IPv4-mapped address', pub.ok === true, pub.reason)

/* ── the fetch path ───────────────────────────────────────────────────── */
console.log('\n── fetch ──')

// A local server standing in for the internet. It is reached by IP literal
// because the guard would (correctly) refuse "localhost".
let hits = 0
const server = createServer((req, res) => {
  hits++
  if (req.url === '/redirect-to-metadata') {
    // The classic bypass: a public URL that 302s somewhere private.
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    return res.end()
  }
  if (req.url === '/loop') {
    res.writeHead(302, { location: '/loop' })
    return res.end()
  }
  if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('x'.repeat(200_000))
  }
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"a":1,"b":[2,3]}')
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><head><title>Hi</title><script>var x=1</script></head>'
    + '<body><h1>Heading</h1><p>First para.</p><ul><li>one</li><li>two</li></ul>'
    + '<p>Caf&eacute; &amp; more &#8212; done.</p></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// safeFetch must refuse this server too — it IS loopback. That is the point:
// the guard does not have an exception for "our own test".
const local = await safeFetch(`http://127.0.0.1:${port}/`)
ok('safeFetch refuses loopback even in a test', local.ok === false)

// So the fetch path is exercised through the parts that do not need a socket.
const before = hits
await safeFetch(`http://127.0.0.1:${port}/redirect-to-metadata`)
ok('a blocked host is never even contacted', hits === before, `server saw ${hits - before} request(s)`)

/* ── HTML extraction ──────────────────────────────────────────────────── */
console.log('\n── html → text ──')

const h = htmlToText('<html><head><title>Hi</title><script>var x=1</script>'
  + '<style>p{color:red}</style></head><body><h1>Heading</h1><p>First para.</p>'
  + '<ul><li>one</li><li>two</li></ul><p>Caf&eacute; &amp; more &#8212; done.</p></body></html>')
ok('title is extracted', h.title === 'Hi', h.title)
ok('script contents are dropped', !/var x=1/.test(h.text), h.text.slice(0, 60))
ok('style contents are dropped', !/color:red/.test(h.text))
ok('prose survives', /First para\./.test(h.text))
ok('entities are decoded', /Café & more — done\./.test(h.text), h.text.slice(-50))
ok('list items are separated', /one/.test(h.text) && /two/.test(h.text) && !/onetwo/.test(h.text))
ok('heading is not welded to the body', !/HeadingFirst/.test(h.text), h.text.slice(0, 40))
ok('no tags remain', !/<[a-z]/i.test(h.text))
// A code point outside Unicode must not take the whole page down with it.
ok('a malformed entity does not throw', htmlToText('a &#99999999999; b').text.includes('a'))

/* ── focus ────────────────────────────────────────────────────────────── */
console.log('\n── focus ──')

const short = focus('tiny page', 'anything', 1000)
ok('short text is returned whole', short.text === 'tiny page' && short.trimmed === false)

const nav = 'nav home about contact login signup menu footer'
const meat = 'The rate limit is 100 requests per minute on the development plan.'
const filler = Array.from({ length: 40 }, (_, i) => `Unrelated paragraph ${i} about gardening and weather.`)
const page = [nav, ...filler.slice(0, 20), meat, ...filler.slice(20)].join('\n\n')
const f = focus(page, 'rate limit requests per minute', 400)
ok('focus keeps the relevant paragraph', f.text.includes('rate limit is 100'), f.text.slice(0, 90))
ok('focus reports that it trimmed', f.trimmed === true)
ok('focus respects the limit', f.text.length <= 400, `${f.text.length} chars`)

// Document order matters: reordering by score hands the model a page that
// contradicts its own structure.
const ordered = focus(['aaa alpha', 'bbb beta', 'ccc alpha beta'].join('\n\n') + '\n\n' + filler.join('\n\n'),
  'alpha beta', 200)
const iA = ordered.text.indexOf('aaa'); const iC = ordered.text.indexOf('ccc')
ok('kept paragraphs stay in document order', iA === -1 || iC === -1 || iA < iC)

/* ── tool contracts ───────────────────────────────────────────────────── */
console.log('\n── tool contracts ──')

for (const t of [WebFetch, WebSearch]) {
  ok(`${t.name} has the registry shape`,
     typeof t.name === 'string' && typeof t.description === 'string'
     && t.parameters?.type === 'object' && typeof t.run === 'function')
}
ok('WebFetch rejects an empty url', (await WebFetch.run({ url: '' })).isError === true)
ok('WebFetch refuses SSRF through the tool', (await WebFetch.run({ url: 'http://169.254.169.254/' })).isError === true)
ok('WebFetch refuses file:', (await WebFetch.run({ url: 'file:///etc/passwd' })).isError === true)
ok('WebSearch rejects a one-character query', (await WebSearch.run({ query: 'x' })).isError === true)

// Missing key must NAME the variable — a model told only "search failed"
// retries forever.
const savedKey = process.env.TAVILY_API_KEY
const savedAlt = process.env.SERGE_TAVILY_API_KEY
delete process.env.TAVILY_API_KEY
delete process.env.SERGE_TAVILY_API_KEY
const noKey = await WebSearch.run({ query: 'anything at all' })
ok('WebSearch names the missing variable', /TAVILY_API_KEY/.test(noKey.content), noKey.content.slice(0, 70))
ok('WebSearch says WebFetch still works', /WebFetch/.test(noKey.content))
if (savedKey) process.env.TAVILY_API_KEY = savedKey
if (savedAlt) process.env.SERGE_TAVILY_API_KEY = savedAlt

/* ── live (opt-in) ────────────────────────────────────────────────────── */
if (process.env.SERGE_WEB_LIVE === '1') {
  console.log('\n── live ──')
  // Not example.org: the IANA example domains do not resolve on every network
  // (they do not here), so the check failed on the sandbox rather than on the
  // tool. SERGE_WEB_LIVE_URL overrides it for a network with its own rules.
  const liveUrl = process.env.SERGE_WEB_LIVE_URL || 'https://help.tavily.com/articles/3240802908-rate-limits'
  const r = await WebFetch.run({ url: liveUrl, prompt: 'rate limits' })
  ok('live WebFetch returns page text', !r.isError && /HTTP 200/.test(r.content), String(r.content).slice(0, 90))
  if (process.env.TAVILY_API_KEY) {
    const s = await WebSearch.run({ query: 'what is an OpenAI-compatible API' })
    ok('live WebSearch returns results', !s.isError && /https?:\/\//.test(s.content), String(s.content).slice(0, 80))
  } else {
    console.log('  skip  live WebSearch — no TAVILY_API_KEY')
  }
} else {
  console.log('\n  (live checks skipped — set SERGE_WEB_LIVE=1 to run them)')
}

server.close()
const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
