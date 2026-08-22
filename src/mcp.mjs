/**
 * MCP client — stdio transport, JSON-RPC 2.0.
 *
 * Reads `mcpServers` from the config dir (the same shape Claude Code uses, so
 * an existing `.mcp.json` or `.claude.json` works unchanged), spawns each
 * server, and exposes its tools to the model namespaced as
 * `mcp__<server>__<tool>`.
 *
 * EVERYTHING HERE FAILS OPEN, deliberately. An MCP server is a third-party
 * process that can be missing, slow, or broken, and none of those are reasons
 * the agent should not start. A server that fails to spawn, fails the handshake,
 * or times out is reported once and skipped; the session continues without its
 * tools. The alternative — an engine that will not run because an optional
 * integration is unhealthy — turns a nice-to-have into a single point of
 * failure.
 *
 * TIMEOUTS ON EVERY EXCHANGE. A JSON-RPC request with no reply is indistinguishable
 * from a hung turn: the model waits, the user waits, and nothing says why. Each
 * call carries its own deadline and rejects with a message naming the server.
 *
 * The framing is newline-delimited JSON, which is what the stdio transport
 * specifies. Partial reads are buffered until a newline arrives, because a
 * message larger than one pipe buffer arrives in pieces.
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'
import { HttpServer } from './mcp-http.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const HANDSHAKE_TIMEOUT_MS = Number(process.env.SERGE_MCP_HANDSHAKE_MS || 15_000)
const CALL_TIMEOUT_MS = Number(process.env.SERGE_MCP_CALL_MS || 120_000)

/** Config lookup, in the order Claude Code resolves them. */
export function loadMcpConfig(dir = null) {
  const root = dir || configDir()
  for (const f of ['.mcp.json', 'mcp.json', '.claude.json', 'settings.json']) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'))
      const servers = d.mcpServers
      if (servers && typeof servers === 'object' && Object.keys(servers).length) {
        return { servers, source: p }
      }
    } catch { /* malformed config is not a reason to refuse to start */ }
  }
  return { servers: {}, source: null }
}

class StdioServer {
  constructor(name, spec) {
    this.name = name
    this.spec = spec
    this.proc = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.tools = []
    this.error = null
  }

  async start() {
    const { command, args = [], env = {}, cwd } = this.spec
    if (!command) { this.error = 'no command in config'; return false }

    try {
      this.proc = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      this.error = `spawn failed: ${e.message}`
      return false
    }

    this.proc.on('error', (e) => { this.error = `process error: ${e.message}`; this.#failAll(e) })
    this.proc.on('exit', (code) => {
      if (this.pending.size) this.#failAll(new Error(`server exited (code ${code})`))
    })
    // A server's stderr is its own diagnostics channel, not ours. Draining it
    // matters — an unread pipe fills and blocks the process — but printing it
    // would interleave with the agent's output.
    this.proc.stderr?.resume()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk))

    try {
      await this.#request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'serge-engine', version: '0.1.0' },
      }, HANDSHAKE_TIMEOUT_MS)
      this.#notify('notifications/initialized')
      const res = await this.#request('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
      this.tools = Array.isArray(res?.tools) ? res.tools : []
      return true
    } catch (e) {
      this.error = e.message
      this.stop()
      return false
    }
  }

  #onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }   // not our framing; ignore
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  }

  #failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  #send(obj) {
    if (!this.proc?.stdin?.writable) throw new Error(`${this.name}: server is not running`)
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  #notify(method, params = {}) {
    try { this.#send({ jsonrpc: '2.0', method, params }) } catch { /* best effort */ }
  }

  #request(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.#send({ jsonrpc: '2.0', id, method, params }) }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
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
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
  }
}

/**
 * Start every configured server. Never throws.
 * @returns {{tools: Array, call: Function, stop: Function, report: string}}
 */
export async function startMcp({ dir = null, onNotice = null } = {}) {
  const { servers, source } = loadMcpConfig(dir)
  const names = Object.keys(servers)
  if (!names.length) return { tools: [], call: null, stop: () => {}, report: '', servers: [] }

  const live = []
  const failed = []
  await Promise.all(names.map(async (name) => {
    const spec = servers[name]
    // A `url` means a remote server; a `command` means a local process. The
    // config field decides the transport, so a server can be moved between them
    // without the engine caring.
    const s = spec?.url ? new HttpServer(name, spec) : new StdioServer(name, spec)
    const ok = await s.start().catch(() => false)
    if (ok) live.push(s)
    else { failed.push(`${name} (${s.error || 'unknown error'})`); s.stop() }
  }))

  for (const f of failed) onNotice?.(`mcp: ${f} — continuing without it`)

  const byQualified = new Map()
  const schemas = []
  for (const s of live) {
    for (const t of s.tools) {
      // Namespaced so two servers exposing `search` cannot collide, and so a
      // brain hook matching on tool_name can tell MCP tools from built-ins.
      const qualified = `mcp__${s.name}__${t.name}`
      byQualified.set(qualified, { server: s, tool: t.name })
      schemas.push({
        type: 'function',
        function: {
          name: qualified,
          description: t.description || `${t.name} (via ${s.name})`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      })
    }
  }

  return {
    tools: schemas,
    servers: live.map((s) => ({ name: s.name, tools: s.tools.length })),
    report: live.length || failed.length
      ? `${live.length} server(s), ${schemas.length} tool(s)`
        + (failed.length ? `, ${failed.length} unavailable` : '')
        + (source ? ` — ${source}` : '')
      : '',
    async call(qualified, args) {
      const hit = byQualified.get(qualified)
      if (!hit) return { content: `Unknown MCP tool: ${qualified}`, isError: true }
      try {
        return await hit.server.call(hit.tool, args)
      } catch (e) {
        return { content: `${qualified} failed: ${e.message}`, isError: true }
      }
    },
    stop() { for (const s of live) s.stop() },
  }
}
