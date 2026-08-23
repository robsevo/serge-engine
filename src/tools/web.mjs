/**
 * WebFetch and WebSearch.
 *
 * The brain references these 23 times and the `researcher` agent is unusable
 * without them — before this, "do deep research" answered `Unknown tool`.
 *
 * The division of labour is the one serge documents: WebSearch returns
 * SNIPPETS, which are not sources; WebFetch is how you actually read one. An
 * answer built from snippets alone reads like it was written off a results
 * page, because it was.
 */
import { safeFetch } from '../net.mjs'

const MAX_CHARS = 60_000          // what one fetch may put into context
const SEARCH_TIMEOUT_MS = 20_000

/* ─────────────────────────── HTML → text ─────────────────────────── */

/** Blocks whose content is markup or code, never prose. */
const DROP = /<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/**
 * Named entities.
 *
 * The accented set is GENERATED rather than hand-listed. A short hand-written
 * table looks complete until the first page of French or Spanish prose arrives
 * and `Café` comes back as `Caf&eacute;` — which is how this was found. Latin-1
 * names follow a strict pattern (letter + accent → a fixed code point), so
 * deriving them is both shorter than the literal and impossible to typo.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', middot: '·', bull: '•', dagger: '†', prime: '′', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§',
  euro: '€', pound: '£', yen: '¥', cent: '¢', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
  larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑', ne: '≠', le: '≤', ge: '≥',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', eth: 'ð', ETH: 'Ð',
  thorn: 'þ', THORN: 'Þ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å',
  ccedil: 'ç', Ccedil: 'Ç',
}

// letter → base code point for each accent family, upper then lower.
for (const [suffix, upper, lower] of [
  ['grave', { A: 192, E: 200, I: 204, O: 210, U: 217 }, { a: 224, e: 232, i: 236, o: 242, u: 249 }],
  ['acute', { A: 193, E: 201, I: 205, O: 211, U: 218, Y: 221 }, { a: 225, e: 233, i: 237, o: 243, u: 250, y: 253 }],
  ['circ',  { A: 194, E: 202, I: 206, O: 212, U: 219 }, { a: 226, e: 234, i: 238, o: 244, u: 251 }],
  ['uml',   { A: 196, E: 203, I: 207, O: 214, U: 220 }, { a: 228, e: 235, i: 239, o: 246, u: 252, y: 255 }],
  ['tilde', { A: 195, N: 209, O: 213 }, { a: 227, n: 241, o: 245 }],
]) {
  for (const [ch, cp] of Object.entries(upper)) ENTITIES[ch + suffix] = String.fromCharCode(cp)
  for (const [ch, cp] of Object.entries(lower)) ENTITIES[ch + suffix] = String.fromCharCode(cp)
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    // Exact case first: &Eacute; and &eacute; are different characters, and
    // lowercasing every name would turn É into é.
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,14});/g, (m, name) =>
      ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m)
}

function safeChar(code) {
  // A malformed entity can name a code point outside Unicode; String.fromCodePoint
  // throws on those, which would fail the whole fetch over one bad character.
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * Extract readable text from HTML.
 *
 * Deliberately not a parser. A real DOM would be a dependency, and the job here
 * is narrow: get the prose out in reading order so a model can answer from it.
 * Block-level tags become newlines so paragraphs and list items stay separated —
 * without that, headings weld onto body text and lists become one long line.
 */
export function htmlToText(html) {
  let s = String(html ?? '')

  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '').trim()

  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(DROP, ' ')
  // Links keep their text; the href is dropped. A page of "text (https://…)" is
  // mostly URL by weight, and the model already has the page's own URL.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n\n')
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)

  s = s.replace(/[ \t ]+/g, ' ')
       .replace(/ ?\n ?/g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim()

  return { title: decodeEntities(title), text: s }
}

/**
 * Trim to `limit`, keeping the parts most relevant to `prompt`.
 *
 * The head of a page is often navigation, so a plain truncation can return a
 * menu and nothing else. When the text is over budget, paragraphs are scored on
 * overlap with the prompt's distinctive words and the best ones kept IN
 * DOCUMENT ORDER — reordering by score would hand the model a page that
 * contradicts its own structure.
 */
export function focus(text, prompt, limit = MAX_CHARS) {
  if (text.length <= limit) return { text, trimmed: false }

  const terms = new Set(
    String(prompt ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g)?.filter((w) => w.length > 3) ?? [],
  )
  const paras = text.split(/\n{2,}/)
  if (!terms.size || paras.length < 4) {
    return { text: text.slice(0, limit), trimmed: true }
  }

  const scored = paras.map((p, i) => {
    const words = p.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []
    let hits = 0
    for (const w of words) if (terms.has(w)) hits++
    // Per-word, so a long paragraph does not win on length alone.
    return { i, p, score: words.length ? hits / Math.sqrt(words.length) : 0 }
  })

  const keep = new Set()
  let used = 0
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (used + s.p.length + 2 > limit) continue
    keep.add(s.i)
    used += s.p.length + 2
    if (used >= limit * 0.98) break
  }
  if (!keep.size) return { text: text.slice(0, limit), trimmed: true }

  return {
    text: scored.filter((s) => keep.has(s.i)).map((s) => s.p).join('\n\n'),
    trimmed: true,
  }
}

/* ─────────────────────────── WebFetch ─────────────────────────── */

export const WebFetch = {
  name: 'WebFetch',
  description:
    'Fetch a URL and return its readable text. This is how you actually READ a source — '
    + 'WebSearch gives you snippets, which are previews, not the page. '
    + 'The `prompt` says what you are looking for: it does not run a model, it steers which '
    + 'parts of a long page are kept. Only http and https; private and loopback addresses are refused.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      prompt: { type: 'string', description: 'What you want from this page — used to select the most relevant sections when it is too long to return whole' },
    },
    required: ['url'],
  },

  async run(input) {
    const url = String(input?.url ?? '').trim()
    if (!url) return { content: 'WebFetch requires a url.', isError: true }

    const started = Date.now()
    const res = await safeFetch(url)
    if (!res.ok && !res.body) {
      return { content: `WebFetch failed: ${res.reason}`, isError: true }
    }

    const ct = (res.contentType || '').toLowerCase()
    let title = ''
    let body = res.body ?? ''

    if (ct.includes('html') || /^\s*<(!doctype|html)\b/i.test(body)) {
      const out = htmlToText(body)
      title = out.title
      body = out.text
    } else if (ct.includes('json')) {
      // Re-indented so a minified API response is readable rather than one line.
      try { body = JSON.stringify(JSON.parse(body), null, 2) } catch { /* leave as-is */ }
    }

    const { text, trimmed } = focus(body, input?.prompt, MAX_CHARS)
    const ms = Date.now() - started

    const head = [
      `${res.url}${res.url !== url ? `  (redirected from ${url})` : ''}`,
      `HTTP ${res.status} ${res.statusText || ''} · ${ct || 'unknown type'} · ${res.bytes} bytes · ${ms}ms`,
      title ? `Title: ${title}` : '',
      // Truncation is stated, never silent: a model that does not know the page
      // was cut will answer as though it read all of it.
      res.truncated ? 'NOTE: the download hit the size cap; this is the start of the page only.' : '',
      trimmed ? 'NOTE: the page was longer than the limit — the sections most relevant to your prompt were kept, in document order.' : '',
    ].filter(Boolean).join('\n')

    if (!text.trim()) {
      return { content: `${head}\n\n(no readable text — the page may be an app shell rendered by JavaScript)` }
    }
    return { content: `${head}\n\n${text}` }
  },
}

/* ─────────────────────────── WebSearch ─────────────────────────── */

function tavilyKey() {
  return process.env.TAVILY_API_KEY || process.env.SERGE_TAVILY_API_KEY || ''
}

/** Hostname of a result, for domain filtering. */
function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase() } catch { return '' }
}

const domainMatch = (host, d) => {
  const dd = String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return host === dd || host.endsWith('.' + dd)
}

export const WebSearch = {
  name: 'WebSearch',
  description:
        'Search the web. Returns SNIPPETS — a title, URL and one-line preview per result. '
    + 'A snippet is not the source and is not enough to explain, compare or analyse anything: '
    + 'call WebFetch on the URLs worth reading. Use for information past your knowledge cutoff, '
    + 'current events, and claims worth verifying. One query answers one narrow question — for '
    + 'anything broader, search several angles and fetch the substantive sources.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never return results from these domains' },
    },
    required: ['query'],
  },

  async run(input) {
    const query = String(input?.query ?? '').trim()
    if (query.length < 2) return { content: 'WebSearch requires a query of at least 2 characters.', isError: true }

    const key = tavilyKey()
    if (!key) {
      // Named explicitly: a model told only "search failed" will retry forever.
      return {
        content: 'WebSearch is not configured: no TAVILY_API_KEY in the environment. '
          + 'Set it in the serge env file to enable web search. WebFetch works without it, '
          + 'so a known URL can still be read.',
        isError: true,
      }
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS)
    let data
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: 10,
          search_depth: 'basic',
          include_domains: input?.allowed_domains ?? undefined,
          exclude_domains: input?.blocked_domains ?? undefined,
        }),
        signal: ac.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        return { content: `WebSearch failed: HTTP ${res.status} ${res.statusText} — ${raw.slice(0, 200)}`, isError: true }
      }
      data = JSON.parse(raw)
    } catch (e) {
      if (ac.signal.aborted) return { content: `WebSearch timed out after ${SEARCH_TIMEOUT_MS}ms.`, isError: true }
      return { content: `WebSearch failed: ${e?.message ?? e}`, isError: true }
    } finally {
      clearTimeout(timer)
    }

    let results = Array.isArray(data?.results) ? data.results : []

    // The filters are re-applied locally. The provider takes them as a hint and
    // a request that returns a blocked domain anyway would otherwise silently
    // hand the model exactly what it was told to avoid.
    const allow = input?.allowed_domains ?? []
    const block = input?.blocked_domains ?? []
    if (allow.length) results = results.filter((r) => allow.some((d) => domainMatch(hostOf(r.url), d)))
    if (block.length) results = results.filter((r) => !block.some((d) => domainMatch(hostOf(r.url), d)))

    if (!results.length) {
      return { content: `No results for "${query}"${allow.length || block.length ? ' after domain filtering' : ''}.` }
    }

    const lines = results.map((r, i) => {
      const desc = String(r.content ?? r.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 260)
      return `${i + 1}. ${String(r.title ?? '(untitled)').replace(/\s+/g, ' ').slice(0, 140)}\n   ${r.url}\n   ${desc}`
    })

    const answer = typeof data?.answer === 'string' && data.answer.trim()
      ? `\nProvider summary (unverified — confirm against the sources):\n${data.answer.trim().slice(0, 600)}\n`
      : ''

    return {
      content: `${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}\n${answer}\n`
    + 'These are snippets, not sources. WebFetch the ones worth reading before answering from them.',
    }
  },
}
