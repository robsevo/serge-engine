/**
 * TodoWrite — the visible plan for the current turn.
 *
 * The brain's doctrine is built on stated plans: gates check that work was
 * planned before it was written, and `continue-on-unfinished` fires when a turn
 * ends mid-plan. Without a todo list that state lives only in prose, where
 * nothing can read it — so "the turn ended mid-plan" was a judgement about
 * paragraphs rather than a fact about a list.
 *
 * The list is SESSION state, not turn state: a plan that vanished between turns
 * would make every multi-turn task look abandoned.
 */

const STATES = ['pending', 'in_progress', 'completed']

/** One list per session id, so two sessions in one process do not share a plan. */
const lists = new Map()

export function getTodos(sessionId = 'default') {
  return lists.get(sessionId) ?? []
}

export function setTodos(sessionId, todos) {
  lists.set(sessionId, todos)
}

export function clearTodos(sessionId) {
  lists.delete(sessionId)
}

const MARK = { pending: '☐', in_progress: '▶', completed: '☑' }

export function renderTodos(todos) {
  if (!todos.length) return '(no todos)'
  return todos.map((t) => `${MARK[t.status] ?? '☐'} ${t.content}`).join('\n')
}

export const todoWrite = {
  name: 'TodoWrite',
  description:
    'Record the plan for the work in progress, as a list of steps with a status each. '
    + 'Write the whole list every time — this replaces the previous one rather than appending. '
    + 'Use it for anything with more than about three steps, mark exactly one step in_progress '
    + 'while you work on it, and mark it completed as soon as it is done rather than in a batch '
    + 'at the end: a list updated only at the end records history, not progress.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step is, in the imperative.' },
            status: { type: 'string', enum: STATES, description: 'pending, in_progress, or completed' },
            activeForm: { type: 'string', description: 'Present-tense form shown while it is running.' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },

  run(input, ctx) {
    const raw = input?.todos
    if (!Array.isArray(raw)) return { content: 'TodoWrite requires a todos array.', isError: true }

    const todos = []
    for (const [i, t] of raw.entries()) {
      const content = String(t?.content ?? '').trim()
      if (!content) return { content: `TodoWrite: todo ${i + 1} has no content.`, isError: true }
      const status = String(t?.status ?? 'pending')
      if (!STATES.includes(status)) {
        return {
          content: `TodoWrite: todo ${i + 1} has status "${status}" — expected ${STATES.join(', ')}.`,
          isError: true,
        }
      }
      todos.push({ content, status, activeForm: String(t?.activeForm ?? '').trim() || content })
    }

    // More than one in_progress means the list no longer says what is being
    // worked on, which is the only question it exists to answer.
    const running = todos.filter((t) => t.status === 'in_progress')
    if (running.length > 1) {
      return {
        content: `TodoWrite: ${running.length} steps are in_progress at once — exactly one may be. `
          + `In progress: ${running.map((t) => JSON.stringify(t.content)).join(', ')}`,
        isError: true,
      }
    }

    const sessionId = ctx?.sessionId ?? 'default'
    const prev = getTodos(sessionId)
    setTodos(sessionId, todos)
    ctx?.onTodos?.(todos)

    const done = todos.filter((t) => t.status === 'completed').length
    const justFinished = todos.filter(
      (t) => t.status === 'completed'
        && prev.find((p) => p.content === t.content && p.status !== 'completed'),
    )

    return {
      content: `${renderTodos(todos)}\n\n${done}/${todos.length} done`
        + (justFinished.length ? ` · completed: ${justFinished.map((t) => t.content).join(', ')}` : ''),
    }
  },
}
