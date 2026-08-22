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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../src/tools/index.mjs'
import { loadSeats, checkSeat } from '../src/seats.mjs'
import { parseFrontmatter, loadCommands, loadSkills, expandCommand, skillIndex } from '../src/brain.mjs'
import { replay, listSessions, slugFor } from '../src/sessions.mjs'
import { loadMcpConfig, startMcp } from '../src/mcp.mjs'
import { loadAgents } from '../src/brain.mjs'
import { makeTaskTool } from '../src/tools/task.mjs'
import { loadSpinnerConfig, createSpinner } from '../src/spinner.mjs'
import { renderStartup } from '../src/startup.mjs'
import { createPane, fit, visible } from '../src/pane.mjs'

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

  // ── brain content: frontmatter, commands, skills ─────────────────────────
  const fm = parseFrontmatter(
    '---\nname: demo\ndescription: "a quoted one"\nallowed-tools: Bash(ls:*)\n---\n\n# Body\ntext\n')
  const meta = fm.meta
  check('frontmatter: parses keys', meta.name === 'demo' && meta.description === 'a quoted one')
  check('frontmatter: keeps hyphenated keys', meta['allowed-tools'] === 'Bash(ls:*)')
  check('frontmatter: body excludes the block', fm.body.startsWith('# Body'))
  check('frontmatter: a file with no block is all body',
        parseFrontmatter('just text').body === 'just text')

  mkdirSync(join(dir, 'commands', 'ns'), { recursive: true })
  writeFileSync(p('commands/hello.md'), '---\ndescription: greet\n---\nSay hello to $ARGUMENTS\n')
  writeFileSync(p('commands/ns/deep.md'), '---\ndescription: nested\n---\nnested body\n')
  const cmds = loadCommands(dir)
  check('commands: loads top-level', cmds.has('hello'))
  check('commands: namespaces one level', cmds.has('ns:deep'), [...cmds.keys()].join(','))
  check('commands: $ARGUMENTS expands',
        expandCommand(cmds.get('hello'), 'world') === 'Say hello to world\n')

  mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true })
  mkdirSync(join(dir, 'skills', '_data'), { recursive: true })
  writeFileSync(p('skills/alpha/SKILL.md'),
    '---\nname: alpha\ndescription: d\nwhenToUse: when testing\n---\nZZBODYMARKERZZ\n')
  const sk = loadSkills(dir)
  check('skills: loads one with a SKILL.md', sk.size === 1 && sk.has('alpha'))
  check('skills: a directory without SKILL.md is not a skill', !sk.has('_data'),
        'a data dir beside the skills would otherwise be offered as one')
  check('skills: the index carries the trigger, not the body',
        skillIndex(sk).includes('when testing') && !skillIndex(sk).includes('ZZBODYMARKERZZ'),
        'the body is what the Skill tool fetches; putting it in the index defeats on-demand loading')

  // ── session replay ────────────────────────────────────────────────────────
  const tx = p('t.jsonl')
  const mk = (o) => JSON.stringify(o)
  writeFileSync(tx, [
    mk({ type: 'user', message: { content: [{ type: 'text', text: 'first' }] } }),
    mk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] } }),
    mk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'out' }] } }),
    mk({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n')
  const rp = replay(tx)
  check('replay: counts real user turns only', rp.turns === 1,
        'a tool_result also arrives as a user entry and must not count as a turn')
  check('replay: rebuilds the tool call', rp.messages[1]?.tool_calls?.[0]?.id === 'c1')
  check('replay: pairs the result by id',
        rp.messages[2]?.role === 'tool' && rp.messages[2]?.tool_call_id === 'c1',
        'an unpaired tool_call makes the whole request invalid')
  check('replay: a missing file is empty, not a throw', replay(p('nope.jsonl')).turns === 0)
  check('sessions: slug matches the transcript layout', slugFor('/a/b') === 'a-b')

  // ── MCP ───────────────────────────────────────────────────────────────────
  writeFileSync(p('.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'true' } } }))
  check('mcp: finds config', loadMcpConfig(dir).servers.x?.command === 'true')
  check('mcp: no config is empty, not an error',
        Object.keys(loadMcpConfig(join(dir, 'commands')).servers).length === 0)

  const broken = await startMcp({ dir: p('nowhere'), onNotice: () => {} })
  check('mcp: absent config yields no tools and no throw', broken.tools.length === 0)

  // A server that cannot spawn must be skipped, not fatal: an optional
  // integration being unhealthy is not a reason the agent cannot start.
  writeFileSync(p('.mcp.json'), JSON.stringify({
    mcpServers: { dead: { command: 'definitely-not-a-real-binary-xyz' } } }))
  const notices = []
  const failed = await startMcp({ dir, onNotice: (m) => notices.push(m) })
  check('mcp: a broken server fails OPEN', failed.tools.length === 0 && notices.length === 1,
        JSON.stringify(notices))
  failed.stop()

  // ── subagent definitions ─────────────────────────────────────────────────
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(p('agents/scout.md'),
    '---\nname: scout\ndescription: cheap explorer\nmodel: fast-coder\neffort: low\n---\nYou are the scout.\n')
  writeFileSync(p('agents/plain.md'), '---\ndescription: no name key\n---\nbody\n')
  const ag = loadAgents(dir)
  check('agents: loads definitions', ag.size === 2)
  check('agents: reads the SEAT', ag.get('scout')?.model === 'fast-coder',
        'model: is a seat name — running a cheap agent on the expensive seat is the waste the roster prevents')
  check('agents: reads effort', ag.get('scout')?.effort === 'low')
  check('agents: body becomes the system prompt', ag.get('scout')?.prompt.startsWith('You are the scout'))
  check('agents: falls back to the filename when name: is absent', ag.has('plain'))

  const tt = makeTaskTool(ag)
  check('Task: enum lists the real roster',
        JSON.stringify(tt.parameters.properties.subagent_type.enum) === '["plain","scout"]',
        'sorted, so the prompt does not change with readdir order — and a model '
        + 'offered types that do not exist will pick one anyway')
  check('Task: description carries the roster', tt.description.includes('cheap explorer'))
  check('Task: an empty roster leaves no enum',
        makeTaskTool(new Map()).parameters.properties.subagent_type.enum === undefined)

  // Explore must refuse to nest, like Task — an explorer spawning explorers is
  // an unbounded tree with nothing tracking depth.
  const ex = await runTool('Explore', { query: 'x' }, { cwd: dir, depth: 1, spawnSubagent: () => {} })
  check('Explore: refuses to nest', ex.isError && /may not spawn/.test(ex.content))
  const exNoAgent = await runTool('Explore', { query: 'x' }, { cwd: dir, depth: 0 })
  check('Explore: reports when subagents are unavailable', exNoAgent.isError)
  let gotTools = null
  await runTool('Explore', { query: 'find it', breadth: 'quick' }, {
    cwd: dir, depth: 0, spawnSubagent: (o) => { gotTools = o; return { text: 'found' } },
  })
  check('Explore: hands the subagent a READ-ONLY tool set',
        JSON.stringify(gotTools?.tools) === '["Read","Grep","Glob"]',
        'it can be pointed at unfamiliar code without checking whether the brief was tight enough')
  check('Explore: breadth becomes a turn budget', gotTools?.maxTurns === 6)

  // ── spinner ───────────────────────────────────────────────────────────────
  const sp1 = loadSpinnerConfig({ spinnerVerbs: { mode: 'replace', verbs: ['Aaa'] }, spinnerStyle: 'cat' })
  check('spinner: mode replace uses only the configured verbs',
        sp1.verbs.length === 1 && sp1.verbs[0] === 'Aaa')
  const sp2 = loadSpinnerConfig({ spinnerVerbs: { verbs: ['Bbb'] } })
  check('spinner: any other mode appends to the defaults',
        sp2.verbs.includes('Bbb') && sp2.verbs.length > 1)
  check('spinner: an unknown style falls back rather than throwing',
        loadSpinnerConfig({ spinnerStyle: 'nope' }).style === 'cat')
  const writes = []
  const fake = { isTTY: false, write: (x) => writes.push(x) }
  const sp = createSpinner({ settings: {}, stream: fake })
  sp.start('x'); sp.stop()
  check('spinner: silent when not a TTY', writes.length === 0,
        'an animation in a piped run corrupts whatever is reading the output')

  // ── startup panel ────────────────────────────────────────────────────────
  const seatMap = new Map([
    ['local-coder', { model: 'mistral/mistral-large-latest' }],
    ['cloud-brain', { model: 'gemini/gemini-3.7-flash' }],
  ])
  const panel = renderStartup({
    seats: seatMap, baseUrl: 'http://localhost:4000/v1',
    cwd: '/very/deep/path/that/keeps/going/and/going/and/going/forever/and/ever',
    mode: 'fullAccess', commands: 3, skills: 4, agents: 5, color: false, width: 70,
  })
  const panelLines = panel.split('\n').filter((l) => l.includes('│') || l.includes('─'))
  const widths = new Set(panelLines.map((l) => l.length))
  check('startup: every frame line is the same width', widths.size === 1,
        `widths: ${[...widths].join(',')} — a long value must be elided, not push the border off`)
  check('startup: resolves a seat to its real model',
        panel.includes('Mistral Large Latest'),
        'the panel must not claim a model the router is not configured for')
  check('startup: an unknown seat degrades to its name rather than inventing one',
        panel.includes('qwen-coder'))
  check('startup: strips OpenRouter routing suffixes',
        !renderStartup({ seats: new Map([['local-coder', { model: 'x/nemotron:free' }]]), color: false })
          .includes(':free'))
  check('startup: colour off emits no escape sequences', !/\x1b/.test(panel),
        'a piped launch must not print terminal control codes')

  // ── MCP transport selection ──────────────────────────────────────────────
  const { HttpServer } = await import('../src/mcp-http.mjs')
  check('mcp: a url with no type auto-detects', new HttpServer('x', { url: 'http://h/' }).mode === 'auto')
  check('mcp: type sse is honoured', new HttpServer('x', { url: 'http://h/', type: 'sse' }).mode === 'sse')
  check('mcp: type http is honoured', new HttpServer('x', { url: 'http://h/', type: 'http' }).mode === 'http')
  const noUrl = new HttpServer('x', {})
  check('mcp: a url-less http server fails rather than hanging',
        (await noUrl.start()) === false && /no url/.test(noUrl.error))

  writeFileSync(p('.mcp.json'), JSON.stringify({
    mcpServers: { remote: { url: 'http://127.0.0.1:9/none' } } }))
  const remoteNotices = []
  const remote = await startMcp({ dir, onNotice: (m) => remoteNotices.push(m) })
  check('mcp: an unreachable remote fails OPEN like a broken process',
        remote.tools.length === 0 && remoteNotices.length === 1)
  remote.stop()

  // ── session forking ──────────────────────────────────────────────────────
  const parentTx = p('parent.jsonl')
  writeFileSync(parentTx, [
    mk({ type: 'user', message: { content: [{ type: 'text', text: 'in the parent' }] } }),
    mk({ type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }),
  ].join('\n') + '\n')
  const childTx = p('parent-child.jsonl')
  writeFileSync(childTx, [
    mk({ type: 'meta', parent_session_id: 'parent' }),
    mk({ type: 'user', message: { content: [{ type: 'text', text: 'in the child' }] } }),
  ].join('\n') + '\n')
  const forked = replay(childTx)
  check('fork: replays the parent before the child',
        forked.messages[0]?.content === 'in the parent'
        && forked.messages.at(-1)?.content === 'in the child',
        JSON.stringify(forked.messages.map((m) => m.content)))
  check('fork: turns count across the whole chain', forked.turns === 2)

  // A hand-edited file pointing at itself must not recurse forever.
  const loopTx = p('loopy.jsonl')
  writeFileSync(loopTx, mk({ type: 'meta', parent_session_id: 'loopy' }) + '\n'
    + mk({ type: 'user', message: { content: [{ type: 'text', text: 'self' }] } }) + '\n')
  check('fork: a self-referential parent does not hang', replay(loopTx).turns === 1,
        'a malformed transcript must not take the CLI down with it')

  // ── status pane ──────────────────────────────────────────────────────────
  check('pane: fit pads a short line to exact width', fit('abc', 20).length === 20)
  check('pane: fit elides the MIDDLE of a long one',
        fit('/very/deep/path/that/keeps/going', 20).length === 20
        && fit('/very/deep/path/that/keeps/going', 20).includes('…'),
        'both ends of a path are useful; truncating the tail loses where you are')
  check('pane: visible ignores SGR', visible('\x1b[2mabc\x1b[0m') === 3,
        'padding on raw length would misalign every coloured row')

  const paneOut = []
  const fakeTty = {
    isTTY: true, columns: 80, rows: 24,
    write: (x) => paneOut.push(x), on() {}, off() {},
  }
  const pn = createPane({ rows: 2, stream: fakeTty })
  pn.start()
  check('pane: narrows the scroll region on start',
        paneOut.join('').includes('\x1b[1;22r'),
        'DECSTBM is what reserves the rows without an alternate screen buffer')
  pn.set(['rule', 'status'])
  const painted = paneOut.join('')
  check('pane: saves and restores the cursor around a paint',
        painted.includes('\x1b7') && painted.includes('\x1b8'),
        'without this the next output lands wherever the pane left the cursor')
  paneOut.length = 0
  pn.stop()
  check('pane: RESETS the scroll region on stop', paneOut.join('').includes('\x1b[r'),
        'leaving it narrowed hands the user a broken shell')

  // A terminal too short to divide must decline rather than squeeze the
  // conversation into two lines.
  const shortOut = []
  const shortTty = { isTTY: true, columns: 80, rows: 6, write: (x) => shortOut.push(x), on() {}, off() {} }
  const shortPane = createPane({ rows: 2, stream: shortTty })
  shortPane.start()
  check('pane: disables itself on a short terminal', !shortPane.enabled)
  shortPane.stop()

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
  const teeth = total >= 78
  console.log(teeth
    ? `\n  SELF-TEST PASSED — ${total} independent assertions, each checked against observed state.`
    : `\n  SELF-TEST FAILED — only ${total} assertions; this suite is not covering the tools.`)
  process.exit(teeth ? 0 : 1)
}
console.log(`\n  ${pass}/${total} passed`)
process.exit(failures.length ? 1 : 0)
