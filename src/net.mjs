/**
 * Outbound HTTP for the web tools.
 *
 * The model chooses these URLs, so this is a server-side request forgery
 * surface by construction: a prompt (or a page the model just read) can name
 * `http://169.254.169.254/latest/meta-data/iam/`, `http://localhost:4000/v1`,
 * or a file on the private network, and a naive fetch would hand back cloud
 * credentials, the local router's config, or an intranet page.
 *
 * So every hop is checked against the RESOLVED address, not the hostname.
 * Checking the hostname alone is the classic hole: `evil.test` can have an A
 * record of 127.0.0.1, and a name that resolved publicly a moment ago can be
 * re-pointed between the check and the connection. Redirects are followed one
 * at a time with the same check applied to each, because a public URL that
 * 302s to the metadata endpoint is the standard bypass.
 *
 * Responses are read with a hard byte cap and a wall-clock timeout — a tool
 * that streams an endless response is a hang, and one that buffers a 2GB file
 * is an out-of-memory crash.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const MAX_BYTES = 5 * 1024 * 1024
export const TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

/**
 * Private, loopback, link-local and reserved ranges — the addresses a tool
 * reaching "the web" must never reach.
 */
function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return (
    a === 0 ||                                   // "this network"
    a === 10 ||                                  // private
    a === 127 ||                                 // loopback
    (a === 100 && b >= 64 && b <= 127) ||        // carrier-grade NAT
    (a === 169 && b === 254) ||                  // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) ||         // private
    (a === 192 && b === 168) ||                  // private
    (a === 192 && b === 0) ||                    // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) ||     // benchmarking
    a >= 224                                     // multicast + reserved
  )
}

function isBlockedIPv6(ip) {
  const s = ip.toLowerCase().split('%')[0]
  if (s === '::' || s === '::1') return true                 // unspecified, loopback
  if (s.startsWith('fe80') || s.startsWith('fec0')) return true   // link/site-local
  if (/^f[cd]/.test(s)) return true                          // unique-local
  if (s.startsWith('ff')) return true                        // multicast
  // IPv4-mapped is an IPv4 address wearing a hat, and it arrives in TWO forms:
  // the readable `::ffff:127.0.0.1`, and the hex `::ffff:7f00:1` that the URL
  // parser normalises it to. Matching only the dotted form let
  // `http://[::ffff:127.0.0.1]/` through — the parser had already rewritten it.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) return isBlockedIPv4(dotted[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return false
}

const blocked = (ip) => (isIP(ip) === 6 ? isBlockedIPv6(ip) : isBlockedIPv4(ip))

/**
 * @returns {Promise<{ok:true, address:string}|{ok:false, reason:string}>}
 */
export async function checkUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return { ok: false, reason: `not a valid URL: ${raw}` } }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // file: would read the disk through a "web" tool, bypassing the permission
    // system's workspace boundary entirely.
    return { ok: false, reason: `only http and https are allowed, not ${u.protocol}` }
  }

  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    return blocked(host)
      ? { ok: false, reason: `refusing to fetch a private or reserved address (${host})` }
      : { ok: true, address: host }
  }

  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch (e) {
    return { ok: false, reason: `cannot resolve ${host}: ${e?.code || e?.message || e}` }
  }
  if (!addrs.length) return { ok: false, reason: `${host} resolved to nothing` }

  // EVERY address must be public. A host with one public and one loopback
  // record would otherwise be a coin flip decided by resolver ordering.
  const bad = addrs.find((a) => blocked(a.address))
  if (bad) {
    return { ok: false, reason: `${host} resolves to a private or reserved address (${bad.address})` }
  }
  return { ok: true, address: addrs[0].address }
}

/**
 * Fetch with the SSRF check applied to every hop, a byte cap, and a timeout.
 *
 * @returns {Promise<{ok:boolean, status?:number, statusText?:string, url?:string,
 *   contentType?:string, body?:string, bytes?:number, truncated?:boolean, reason?:string}>}
 */
export async function safeFetch(raw, { headers = {}, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let url = raw
  const started = Date.now()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkUrl(url)
    if (!check.ok) return { ok: false, reason: check.reason }

    const left = timeoutMs - (Date.now() - started)
    if (left <= 0) return { ok: false, reason: `timed out after ${timeoutMs}ms` }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), left)
    let res
    try {
      res = await fetch(url, {
        headers: { 'user-agent': 'serge-engine', accept: 'text/html,text/plain,*/*', ...headers },
        redirect: 'manual',                    // hops are checked one at a time
        signal: ac.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      if (ac.signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs}ms` }
      return { ok: false, reason: `request failed: ${e?.message ?? e}` }
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer)
      // Resolved against the CURRENT url so a relative Location works, and the
      // loop re-checks it before connecting.
      try { url = new URL(res.headers.get('location'), url).toString() } catch {
        return { ok: false, reason: `bad redirect target from ${url}` }
      }
      continue
    }

    // Read with a cap rather than res.text(), which would buffer whatever the
    // server decides to send.
    const chunks = []
    let bytes = 0
    let truncated = false
    try {
      for await (const chunk of res.body ?? []) {
        chunks.push(chunk)
        bytes += chunk.length
        if (bytes >= maxBytes) { truncated = true; break }
      }
    } catch (e) {
      clearTimeout(timer)
      if (ac.signal.aborted) return { ok: false, reason: `timed out reading ${url}` }
      return { ok: false, reason: `read failed: ${e?.message ?? e}` }
    }
    clearTimeout(timer)

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url,
      contentType: res.headers.get('content-type') || '',
      body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
      bytes,
      truncated,
      reason: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
    }
  }
  return { ok: false, reason: `too many redirects (>${MAX_REDIRECTS}) starting at ${raw}` }
}
