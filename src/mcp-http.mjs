/**
 * MCP over HTTP — Streamable HTTP (current) and SSE (legacy).
 *
 * Two transports, because the ecosystem is mid-migration and configs in the wild
 * use both:
 *
 *   Streamable HTTP  one URL. POST JSON-RPC to it; the reply is either a JSON
 *                    body or an SSE stream carrying the response. A session id
 *                    arrives in `Mcp-Session-Id` and must be echoed on every
 *                    later request.
 *   SSE (legacy)     GET the URL for an event stream. The server's first event
 *                    names a separate endpoint to POST to; every response then
 *                    arrives back on the original stream.
 *
 * WHICH ONE, AND WHY IT AUTO-DETECTS. `type` in the config settles it when
 * present. When it is absent — which is common, since the field is newer than
 * the transports — we try Streamable HTTP and fall back to SSE on the failures
 * that specifically mean "this is an older server": 404 and 405. Guessing wrong
 * would otherwise present as a dead server for a reason the user cannot see.
 *
 * As with stdio, everything fails open and everything is bounded. A remote
 * server is one more thing that can be down, slow, or lying about its content
 * type; none of those are reasons the agent should refuse to start.
 */

const HANDSHAKE_TIMEOUT_MS = Number(process.env.SERGE_MCP_HANDSHAKE_MS || 15_000)
const CALL_TIMEOUT_MS = Number(process.env.SERGE_MCP_CALL_MS || 120_000)
const PROTOCOL_VERSION = '2024-11-05'

/** Parse an SSE byte stream into {event, data} records. */
async function* sseEvents(body, signal) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let sep
      // Records are separated by a blank line; a record may span several reads.
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = 'message'
        const data = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trim())
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

export class HttpServer {
  constructor(name, spec) {
    this.name = name
    this.spec = spec
    this.url = spec.url
    this.headers = { ...(spec.headers || {}) }
    this.mode = spec.type === 'sse' ? 'sse' : (spec.type === 'http' ? 'http' : 'auto')
    this.sessionId = null
    this.postUrl = null          // SSE only: where messages go
    this.nextId = 1
    this.pending = new Map()
    this.tools = []
    this.error = null
    this.abort = new AbortController()
  }

  async start() {
    if (!this.url) { this.error = 'no url in config'; return false }
    try {
      if (this.mode === 'sse') await this.#openSse()
      else if (this.mode === 'http') await this.#initHttp()
      else {
        try { await this.#initHttp(); this.mode = 'http' } catch (e) {
          // 404/405 is what an SSE-only server answers to a POST. Anything else
          // is a real failure and should not be masked by a second attempt.
          if (!/\b(404|405)\b/.test(e.message)) throw e
          await this.#openSse(); this.mode = 'sse'
        }
      }
      const res = await this.#request('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
      this.tools = Array.isArray(res?.tools) ? res.tools : []
      return true
    } catch (e) {
      this.error = e.message
      this.stop()
      return false
    }
  }

  // ── Streamable HTTP ────────────────────────────────────────────────────────
  async #initHttp() {
    const r = await this.#post({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'serge-engine', version: VERSION },
      },
    }, HANDSHAKE_TIMEOUT_MS)
    if (r.error) throw new Error(r.error.message || 'initialize failed')
    // Notification: no id, no response expected.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 5000)
      .catch(() => {})
  }

  async #post(msg, timeoutMs) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(msg),
        signal: ctl.signal,
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${res.statusText}`)
      if (!msg.id) return {}                      // a notification has no reply

      const ct = res.headers.get('content-type') || ''
      if (ct.includes('text/event-stream')) {
        // The response rides an SSE stream; take the first record whose id matches.
        for await (const ev of sseEvents(res.body, ctl.signal)) {
          let parsed
          try { parsed = JSON.parse(ev.data) } catch { continue }
          if (parsed.id === msg.id) return parsed
        }
        throw new Error(`${this.name}: stream ended without a reply`)
      }
      return await res.json()
    } finally {
      clearTimeout(t)
    }
  }

  // ── legacy SSE ─────────────────────────────────────────────────────────────
  async #openSse() {
    const res = await fetch(this.url, {
      headers: { accept: 'text/event-stream', ...this.headers },
      signal: this.abort.signal,
    })
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${res.statusText}`)

    // The endpoint event must arrive before anything can be sent, so the caller
    // waits on it rather than racing the first request.
    let resolveEndpoint
    const gotEndpoint = new Promise((resolve, reject) => {
      resolveEndpoint = resolve
      setTimeout(() => reject(new Error(`${this.name}: no endpoint event`)), HANDSHAKE_TIMEOUT_MS)
    })

    ;(async () => {
      try {
        for await (const ev of sseEvents(res.body, this.abort.signal)) {
          if (ev.event === 'endpoint') {
            this.postUrl = new URL(ev.data, this.url).toString()
            resolveEndpoint()
            continue
          }
          let msg
          try { msg = JSON.parse(ev.data) } catch { continue }
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(msg.error.message || 'error'))
          else p.resolve(msg.result)
        }
      } catch { /* stream closed */ } finally { this.#failAll(new Error('stream closed')) }
    })()

    await gotEndpoint
    await this.#sseRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'serge-engine', version: VERSION },
    }, HANDSHAKE_TIMEOUT_MS)
    await this.#ssePost({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})
  }

  async #ssePost(msg) {
    const r = await fetch(this.postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(msg),
      signal: this.abort.signal,
    })
    if (!r.ok) throw new Error(`${this.name}: POST ${r.status}`)
  }

  #sseRequest(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.#ssePost({ jsonrpc: '2.0', id, method, params })
        .catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e) })
    })
  }

  #failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  async #request(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    if (this.mode === 'sse') return this.#sseRequest(method, params, timeoutMs)
    const r = await this.#post({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs)
    if (r.error) throw new Error(r.error.message || JSON.stringify(r.error))
    return r.result
  }

  async call(tool, args) {
    const res = await this.#request('tools/call', { name: tool, arguments: args ?? {} })
    const parts = Array.isArray(res?.content) ? res.content : []
    const text = parts
      .map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'unknown'} content]`))
      .join('\n')
    return { content: text || '(no content)', isError: Boolean(res?.isError) }
  }

  stop() {
    this.#failAll(new Error('client shutting down'))
    try { this.abort.abort() } catch { /* already aborted */ }
  }
}
