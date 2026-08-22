/**
 * Context compaction.
 *
 * WHY A THRESHOLD AND NOT A TOKEN COUNT: an exact count needs the model's
 * tokenizer, which differs per seat behind the router — the engine deliberately
 * does not know which model answered. Characters are a stable proxy, and the
 * consequence of being wrong is compacting slightly early, which is cheap. The
 * consequence of the alternative — running until the provider rejects the
 * request — is losing the turn.
 *
 * WHAT IS PRESERVED: the first user message (the task never stops being the
 * task) and the last KEEP_RECENT messages (the working set). Everything between
 * is replaced by one summary. Tool results are the bulk of what gets dropped,
 * which is correct: their conclusions are in the assistant messages that
 * followed them, and the transcript on disk keeps the originals for any gate
 * that wants to re-read them.
 */
const KEEP_RECENT = 6

export function shouldCompact(messages, limitChars) {
  return size(messages) > limitChars && messages.length > KEEP_RECENT + 2
}

export function size(messages) {
  let n = 0
  for (const m of messages) {
    n += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
  }
  return n
}

/**
 * @returns {Promise<{messages:Array, summary:string, droppedChars:number}>}
 */
export async function compact({ messages, complete, provider }) {
  const head = messages[0]
  const tail = messages.slice(-KEEP_RECENT)
  const middle = messages.slice(1, messages.length - KEEP_RECENT)
  if (!middle.length) return { messages, summary: '', droppedChars: 0 }

  const before = size(messages)

  const rendered = middle.map((m) => {
    const role = m.role
    if (m.tool_calls) {
      return `[${role} called: ${m.tool_calls.map((c) => c.function?.name).join(', ')}]`
    }
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    return `[${role}] ${body.slice(0, 1500)}`
  }).join('\n')

  let summary
  try {
    const res = await complete({
      ...provider,
      messages: [{
        role: 'user',
        content:
          'Summarise the following portion of an agent session so work can continue without it.\n'
          + 'Preserve: decisions made, files changed and how, commands run and their outcomes, '
          + 'facts discovered, and anything still unfinished. Drop: narration, repetition, and '
          + 'tool output whose conclusion you have already stated.\n'
          + 'Be specific — a summary that says "explored the codebase" has destroyed the context '
          + 'it was meant to preserve.\n\n' + rendered,
      }],
      tools: [],
    })
    summary = res.text?.trim()
  } catch (e) {
    summary = ''
  }

  // A failed summary must not silently delete the middle of the session.
  if (!summary) return { messages, summary: '', droppedChars: 0, failed: true }

  const next = [head, { role: 'user', content: `[Earlier in this session]\n${summary}` }, ...tail]
  return { messages: next, summary, droppedChars: before - size(next) }
}
