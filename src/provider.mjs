/**
 * OpenAI-compatible streaming client.
 *
 * This is the whole "not proprietary to Anthropic" story: the engine speaks
 * plain OpenAI chat-completions to whatever sits on OPENAI_BASE_URL. In a Serge
 * install that is LiteLLM on localhost:4000, fronting ~23 free-tier seats with
 * its own fallback graph. The engine does not know or care which model answered
 * — routing is the router's job, and duplicating it here is how you end up with
 * two disagreeing fallback tables.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.SERGE_REQUEST_TIMEOUT_MS || 600_000)
const MAX_ATTEMPTS = Number(process.env.SERGE_MAX_ATTEMPTS || 3)

/** Transient: worth retrying. Anything else is the request's own fault. */
function isTransient(e, status) {
  if (status) return status === 408 || status === 429 || status >= 500
  const m = String(e?.message || e)
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network/i.test(m)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Stream one completion, with a bounded retry on transient failures.
 *
 * WHY RETRY HERE. The router in front of this fans out across free-tier
 * providers, and a provider blip surfaces as a bare `fetch failed` that kills
 * the whole turn — observed 2026-08-22 mid-task, with the work already done and
 * the session lost. A completion is safe to re-issue (it costs tokens, it does
 * not mutate anything), so a transient failure should cost a second, not a turn.
 *
 * WHY NOT MORE. Retrying a 4xx re-sends a request the server already rejected on
 * its merits, and retrying forever turns one dead provider into a hang. Attempts
 * are capped and only transient classes qualify.
 *
 * Backoff is jittered: several agents retrying in lockstep is how a brownout
 * becomes an outage.
 *
 * No idempotency key, deliberately: a completion is safe to re-issue because it
 * does not mutate anything — a retry costs tokens and nothing else. That is NOT
 * true of a POST in general, which is why the architecture gate asks.
 *
 * @returns {Promise<{text:string, toolCalls:Array<{id,name,input}>, finishReason:string}>}
 */
export async function complete(opts) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await once(opts)
    } catch (e) {
      lastErr = e
      const status = e?.status
      if (attempt === MAX_ATTEMPTS || !isTransient(e, status)) throw e
      // 1s, 2s, 4s … each with up to 50% jitter.
      const base = 1000 * 2 ** (attempt - 1)
      await sleep(base / 2 + Math.random() * base)
      opts.onNotice?.(`retrying after ${status || 'network error'} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
    }
  }
  throw lastErr
}

async function once({ baseUrl, apiKey, model, messages, tools, onToken, signal }) {
  // Without this a stalled connection hangs the turn forever with no output.
  const timeout = signal ? undefined : AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // Ask for usage on the final chunk. The router classifies localhost as
      // "local" and some shims strip this, which is why a session otherwise
      // reports zero tokens forever — the numbers exist, they just are not
      // requested.
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: signal ?? timeout,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(
      `router ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`)
    err.status = res.status          // so the retry policy can classify it
    throw err
  }

  let text = ''
  let finishReason = 'stop'
  let usage = null
  const calls = new Map()          // index -> {id, name, args}

  for await (const evt of sse(res.body)) {
    if (evt === '[DONE]') break
    let chunk
    try { chunk = JSON.parse(evt) } catch { continue }

    // The usage chunk carries no choices, so it must be read before the guard.
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason

    const d = choice.delta ?? {}
    if (typeof d.content === 'string' && d.content) {
      text += d.content
      onToken?.(d.content)
    }

    // tool_calls arrive fragmented: the id and name land on the first delta for
    // an index, the arguments accumulate as a JSON string across many.
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      const cur = calls.get(i) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(i, cur)
    }
  }

  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c, n) => ({
      id: c.id || `call_${n}`,
      name: c.name,
      // A model can emit malformed JSON here. Surfacing it as an empty input
      // lets the tool report a real validation error instead of the loop dying.
      input: safeJson(c.args),
    }))

  return { text, toolCalls, finishReason, usage }
}

function safeJson(s) {
  if (!s || !s.trim()) return {}
  try { return JSON.parse(s) } catch { return { __malformed_arguments: s.slice(0, 500) } }
}

/** Minimal SSE reader over a fetch body stream. */
async function* sse(body) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let start = 0                       // where unconsumed data begins in buf
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    // Scan forward from a moving offset instead of re-slicing per line.
    // `buf = buf.slice(nl + 1)` allocated a fresh string for every line, making
    // this O(lines * bytes) — a real cost on a long token stream, which is the
    // only thing this function is ever used for.
    let nl
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      const line = buf.slice(start, nl).trim()
      start = nl + 1
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
    if (start > 0) { buf = buf.slice(start); start = 0 }   // compact once per chunk
  }
}
