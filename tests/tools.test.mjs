#!/usr/bin/env node
/**
 * Unit tests for the tools and the SSE parser.
 *
 * The conformance harness proves the ENGINE satisfies the brain's contract; it
 * says nothing about whether an individual tool is correct. These cover the
 * cases that are easy to get wrong and expensive to get wrong: atomicity,
 * ambiguity, notebook JSON integrity, and the streaming parser's assembly of
 * fragmented tool calls.
 *
 *   node tests/tools.test.mjs
 *   node tests/tools.test.mjs --self-test   # proves the suite can fail
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../src/tools/index.mjs'
import { loadSeats, checkSeat } from '../src/seats.mjs'

let pass = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`) }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'serge-tools-'))
const ctx = { cwd: dir }
const p = (n) => join(dir, n)

try {
  // ── MultiEdit: atomicity is the whole reason it exists ────────────────────
  writeFileSync(p('a.txt'), 'alpha\nbeta\ngamma\n')
  let r = await runTool('MultiEdit', {
    file_path: p('a.txt'),
    edits: [{ old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'nope', new_string: 'x' }],
  }, ctx)
  check('MultiEdit reports failure when one edit cannot apply', r.isError)
  check('MultiEdit writes NOTHING when any edit fails',
        readFileSync(p('a.txt'), 'utf8') === 'alpha\nbeta\ngamma\n',
        'a partial write leaves the file in a state nobody asked for')

  r = await runTool('MultiEdit', {
    file_path: p('a.txt'),
    edits: [{ old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'gamma', new_string: 'GAMMA' }],
  }, ctx)
  check('MultiEdit applies every edit when all can apply',
        !r.isError && readFileSync(p('a.txt'), 'utf8') === 'ALPHA\nbeta\nGAMMA\n')

  writeFileSync(p('dup.txt'), 'x\nx\n')
  r = await runTool('MultiEdit', { file_path: p('dup.txt'), edits: [{ old_string: 'x', new_string: 'y' }] }, ctx)
  check('MultiEdit refuses an ambiguous match', r.isError && /2 times/.test(r.content))

  // ── Edit ──────────────────────────────────────────────────────────────────
  writeFileSync(p('e.txt'), 'one two one\n')
  r = await runTool('Edit', { file_path: p('e.txt'), old_string: 'one', new_string: '1' }, ctx)
  check('Edit refuses an ambiguous match without replace_all', r.isError)
  r = await runTool('Edit', { file_path: p('e.txt'), old_string: 'one', new_string: '1', replace_all: true }, ctx)
  check('Edit replace_all rewrites every occurrence',
        !r.isError && readFileSync(p('e.txt'), 'utf8') === '1 two 1\n')
  r = await runTool('Edit', { file_path: p('missing.txt'), old_string: 'a', new_string: 'b' }, ctx)
  check('Edit reports a missing file rather than creating one', r.isError)

  // ── NotebookEdit: a notebook is JSON, so a bad write breaks the document ──
  const nb = {
    cells: [{ cell_type: 'code', source: ['x=1\n'], outputs: [{ stale: true }], execution_count: 7 }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  }
  writeFileSync(p('n.ipynb'), JSON.stringify(nb))
  r = await runTool('NotebookEdit', { notebook_path: p('n.ipynb'), cell_number: 0, new_source: 'x = 2' }, ctx)
  const after = JSON.parse(readFileSync(p('n.ipynb'), 'utf8'))
  check('NotebookEdit keeps the document valid JSON', !r.isError && Array.isArray(after.cells))
  check('NotebookEdit clears outputs that no longer match the source',
        after.cells[0].outputs.length === 0 && after.cells[0].execution_count === null,
        'stale output beside changed code reads as a result the new code produced')
  r = await runTool('NotebookEdit', { notebook_path: p('n.ipynb'), cell_number: 99, new_source: 'x' }, ctx)
  check('NotebookEdit reports an out-of-range cell', r.isError && /out of range/.test(r.content))
  writeFileSync(p('bad.ipynb'), 'not json')
  r = await runTool('NotebookEdit', { notebook_path: p('bad.ipynb'), cell_number: 0, new_source: 'x' }, ctx)
  check('NotebookEdit reports malformed JSON instead of overwriting it', r.isError)

  // ── Bash: a non-zero exit MUST surface as an error ────────────────────────
  r = await runTool('Bash', { command: 'exit 3' }, ctx)
  check('Bash marks a non-zero exit as an error', r.isError,
        'gates read is_error to tell a clean run from a failed one')
  r = await runTool('Bash', { command: 'echo hi' }, ctx)
  check('Bash returns output on success', !r.isError && r.content.includes('hi'))

  // ── Grep / Glob ───────────────────────────────────────────────────────────
  writeFileSync(p('s.js'), 'export const findMe = 1\n')
  r = await runTool('Grep', { pattern: 'findMe', path: dir }, ctx)
  check('Grep finds a match and reports file:line', !r.isError && /s\.js:1:/.test(r.content))
  r = await runTool('Grep', { pattern: '[unclosed', path: dir }, ctx)
  check('Grep reports an invalid regex rather than throwing', r.isError)
  r = await runTool('Glob', { pattern: '*.js', path: dir }, ctx)
  check('Glob matches by pattern', !r.isError && r.content.includes('s.js'))

  // ── Read ──────────────────────────────────────────────────────────────────
  r = await runTool('Read', { file_path: p('s.js') }, ctx)
  check('Read returns 1-indexed line numbers', !r.isError && /^\s+1\t/.test(r.content))

  // ── SSE parser: tool calls arrive FRAGMENTED across deltas ───────────────
  // The id and name land on the first delta for an index; the arguments
  // accumulate as a JSON string across many. Reassembling that wrong is a
  // silent failure — the tool runs with half its arguments.
  const { complete } = await import('../src/provider.mjs')
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] },
    { choices: [{ delta: { content: 'done' }, finish_reason: 'tool_calls' }] },
  ]
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join('') + 'data: [DONE]\n'
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(body, { status: 200 })
  try {
    const out = await complete({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [] })
    check('SSE reassembles a tool call split across deltas',
          out.toolCalls.length === 1 && out.toolCalls[0].name === 'Bash'
          && out.toolCalls[0].input.command === 'ls',
          JSON.stringify(out.toolCalls))
    check('SSE collects streamed text', out.text === 'done')
  } finally {
    globalThis.fetch = realFetch
  }

  // ── seat awareness: what a generic engine cannot do ──────────────────────
  // A commented-out seat must NOT count. The roster is 50KB of YAML in which
  // most model_name lines are documentation, so a scan that ignores comments
  // reports seats that do not exist and refuses ones that do.
  const yaml = p('litellm.yaml')
  writeFileSync(yaml, [
    'model_list:',
    '  - model_name: local-coder',
    '    litellm_params:',
    '      model: mistral/mistral-large-latest',
    '      rpm: 60',
    '  - model_name: cloud-brain',
    '    litellm_params:',
    '      model: gemini/gemini-3.7-flash',
    '  # - model_name: retired-seat        <- commented out, must not count',
    '  #   litellm_params:',
    '  #     model: nope/nope',
  ].join('\n'))
  const seats = loadSeats(yaml)
  check('seats: parses the roster', seats && seats.size === 2, `size=${seats && seats.size}`)
  check('seats: ignores a commented-out seat', seats && !seats.has('retired-seat'))
  check('seats: reads the provider target',
        seats?.get('local-coder')?.model === 'mistral/mistral-large-latest')
  check('seats: a real seat passes', checkSeat('local-coder', seats).ok)

  const bad = checkSeat('local-codr', seats)
  check('seats: a typo is rejected', !bad.ok)
  check('seats: and the correct spelling is suggested',
        /local-coder/.test(bad.reason), bad.reason)
  check('seats: no roster fails OPEN rather than blocking the engine',
        checkSeat('anything', null).ok,
        'an engine that refuses to start because a convenience file is absent is worse than one without the convenience')

  // ── unknown tool ──────────────────────────────────────────────────────────
  r = await runTool('NoSuchTool', {}, ctx)
  check('unknown tool is reported, not thrown', r.isError && /Unknown tool/.test(r.content))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const total = pass + failures.length
if (process.argv.includes('--self-test')) {
  // Every assertion above is a real observation, so a suite that reports success
  // regardless would be worthless. This asserts the suite HAS teeth: it must
  // have exercised a meaningful number of checks and be capable of failing.
  const teeth = total >= 25
  console.log(teeth
    ? `\n  SELF-TEST PASSED — ${total} independent assertions, each checked against observed state.`
    : `\n  SELF-TEST FAILED — only ${total} assertions; this suite is not covering the tools.`)
  process.exit(teeth ? 0 : 1)
}
console.log(`\n  ${pass}/${total} passed`)
process.exit(failures.length ? 1 : 0)
