#!/usr/bin/env node
/**
 * TodoWrite and AskUserQuestion.
 *
 * The invariants worth pinning are the ones that make each tool honest: a todo
 * list with two steps in_progress no longer answers the only question it exists
 * to answer, and an AskUserQuestion that picks its own answer when nobody is
 * there is a tool that lies about what the user decided.
 *
 * Run:  node tests/todo-ask.test.mjs
 */
import { todoWrite, getTodos, clearTodos, renderTodos } from '../src/tools/todo.mjs'
import { askUserQuestion } from '../src/tools/ask.mjs'

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

/* ── TodoWrite ────────────────────────────────────────────────────────── */
console.log('── TodoWrite ──')

const ctx = { sessionId: 's1' }
clearTodos('s1')

const r1 = todoWrite.run({ todos: [
  { content: 'read the config', status: 'completed' },
  { content: 'add the flag', status: 'in_progress' },
  { content: 'write a test', status: 'pending' },
] }, ctx)
ok('a valid list is accepted', !r1.isError, r1.content)
ok('it reports progress', /1\/3 done/.test(r1.content), r1.content)
ok('it is stored on the session', getTodos('s1').length === 3)
ok('another session is unaffected', getTodos('s2').length === 0)

// The one rule that keeps the list meaningful.
const two = todoWrite.run({ todos: [
  { content: 'a', status: 'in_progress' },
  { content: 'b', status: 'in_progress' },
] }, ctx)
ok('two in_progress steps are refused', two.isError === true, two.content.slice(0, 70))
ok('the refusal names both', /"a"/.test(two.content) && /"b"/.test(two.content))
ok('a refused write does not overwrite the list', getTodos('s1').length === 3)

ok('a bad status is refused', todoWrite.run({ todos: [{ content: 'x', status: 'doing' }] }, ctx).isError === true)
ok('an empty content is refused', todoWrite.run({ todos: [{ content: '  ', status: 'pending' }] }, ctx).isError === true)
ok('a non-array is refused', todoWrite.run({ todos: 'nope' }, ctx).isError === true)
ok('zero in_progress is fine', !todoWrite.run({ todos: [{ content: 'a', status: 'pending' }] }, ctx).isError)

// The list REPLACES rather than appends — otherwise it grows forever.
todoWrite.run({ todos: [{ content: 'only one', status: 'pending' }] }, ctx)
ok('a write replaces the previous list', getTodos('s1').length === 1, String(getTodos('s1').length))

// Newly-completed steps are called out, so progress is visible without diffing.
todoWrite.run({ todos: [{ content: 'finish me', status: 'pending' }] }, ctx)
const done = todoWrite.run({ todos: [{ content: 'finish me', status: 'completed' }] }, ctx)
ok('newly completed steps are named', /completed: finish me/.test(done.content), done.content)

ok('render marks each state', /☑/.test(renderTodos([{ content: 'a', status: 'completed' }]))
   && /▶/.test(renderTodos([{ content: 'b', status: 'in_progress' }]))
   && /☐/.test(renderTodos([{ content: 'c', status: 'pending' }])))

let notified = null
todoWrite.run({ todos: [{ content: 'ping', status: 'pending' }] },
  { sessionId: 's1', onTodos: (t) => { notified = t } })
ok('the UI is notified', Array.isArray(notified) && notified.length === 1)

// The nudge must be ONE-SHOT. Without a guard, a model that declines to close
// the list is an infinite loop — the turn can never end.
import { readFileSync } from 'node:fs'
import { fileURLToPath as _f } from 'node:url'
import { dirname as _d, join as _j } from 'node:path'
const loopSrc = readFileSync(_j(_d(_f(import.meta.url)), '..', 'src', 'loop.mjs'), 'utf8')
ok('the todo nudge is guarded by a one-shot flag', /!todoNudged/.test(loopSrc))
ok('the flag is set before continuing', /todoNudged = true/.test(loopSrc))
ok('it only fires after work was done', /&& turn > 0/.test(loopSrc),
   'without this a turn that never touched the list gets nudged')
ok('it tells the model not to redo the work', /redo the work you just did/.test(loopSrc))

/* ── AskUserQuestion ──────────────────────────────────────────────────── */
console.log('\n── AskUserQuestion ──')

const OPTS = [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }]

// Headless: it must refuse AND not invent an answer.
const headless = await askUserQuestion.run({ question: 'Which database?', options: OPTS }, {})
ok('headless refuses', headless.isError === true)
ok('headless does NOT pick an answer', !/user chose/i.test(headless.content), headless.content.slice(0, 60))
ok('headless lists the options so the model can assume one', /Postgres/.test(headless.content) && /SQLite/.test(headless.content))
ok('headless tells it to continue, not stop', /continue|assumed/i.test(headless.content))

ok('one option is refused', (await askUserQuestion.run({ question: 'q?', options: [{ label: 'only' }] }, {})).isError === true)
ok('no question is refused', (await askUserQuestion.run({ options: OPTS }, {})).isError === true)

let seen = null
const answered = await askUserQuestion.run(
  { question: 'Which database?', header: 'DB', options: OPTS },
  { onQuestion: async (q) => { seen = q; return 'SQLite' } },
)
ok('interactive returns the choice', /user chose: SQLite/.test(answered.content), answered.content)
ok('the prompt got the options', seen?.options?.length === 2)
ok('the header is truncated to fit', typeof seen.header === 'string' && seen.header.length <= 12)

const dismissed = await askUserQuestion.run({ question: 'q?', options: OPTS }, { onQuestion: async () => null })
ok('a dismissed question is an error, not a choice', dismissed.isError === true, dismissed.content)

const many = await askUserQuestion.run(
  { question: 'q?', options: [1,2,3,4,5,6].map((n) => ({ label: 'opt' + n })) },
  { onQuestion: async (q) => { seen = q; return q.options[0].label } },
)
ok('more than 4 options is capped at 4', seen.options.length === 4, String(seen.options.length))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
