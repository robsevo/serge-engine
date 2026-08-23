#!/usr/bin/env node
/**
 * Markdown rendering for assistant prose.
 *
 * Written after `**Model & Provider Freedom**` reached a user's screen with the
 * asterisks intact. Renders on a pty because the bugs worth catching are
 * layout bugs — Ink trimming a marker's trailing space at a wrap boundary
 * turned `• Autonomous` into `•Autonomous`, which no string-level test sees.
 *
 * Run:  node tests/markdown.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const probe = join(here, 'fixtures', 'markdown-probe.mjs')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

function draw(md, cols = 60) {
  // The width has to be set ON THE PTY with stty. Ink reads
  // process.stdout.columns from the terminal device and ignores $COLUMNS, so
  // passing it in the environment silently left every case at the default 80 —
  // which is why the first version of this suite still passed with the wrap
  // bug present.
  const r = spawnSync('script', ['-qec', `stty cols ${cols} rows 40; node ${probe}`, '/dev/null'], {
    encoding: 'utf8', timeout: 20_000, cwd: join(here, '..'),
    env: { ...process.env, MD: md },
  })
  return { raw: r.stdout || '', plain: (r.stdout || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') }
}

const bold = draw('**Model Freedom** is the point')
ok('bold marks are gone', !/\*\*/.test(bold.plain), bold.plain.slice(0, 70))
ok('bold text survives', /Model Freedom/.test(bold.plain))
ok('bold is actually styled', /\x1b\[1m/.test(bold.raw))

const code = draw('use `litellm.yaml` for that')
ok('backticks are gone', !/`/.test(code.plain))
ok('code text survives', /litellm\.yaml/.test(code.plain))

const it = draw('this is *emphasis* here')
ok('italic marks are gone', !/\*/.test(it.plain))
ok('italic is styled', /\x1b\[3m/.test(it.raw))

const h = draw('## A Heading\nbody text')
ok('heading marks are gone', !/#/.test(h.plain))
ok('heading text survives', /A Heading/.test(h.plain))

// The bug this suite exists for: a wrapped bullet lost the space after its
// marker, because Ink trims trailing whitespace at a line boundary.
const long = 'a'.repeat(40) + ' ' + 'b'.repeat(40)
const bul = draw(`- **Label**: ${long}\n- second item`, 50)
ok('bullets render as a bullet', /•/.test(bul.plain))
ok('the dash marker is gone', !/^\s*-\s/m.test(bul.plain))
ok('a wrapped bullet keeps its space', !/•\S/.test(bul.plain),
   (bul.plain.match(/•\S.{0,30}/) || [''])[0])

const num = draw('1. first\n2. second')
ok('ordered numbers are kept', /1\./.test(num.plain) && /2\./.test(num.plain))
ok('ordered items keep their space', !/\d\.\S/.test(num.plain))

// A fence is verbatim: a model showing you a literal ** means it.
const fence = draw('```\nkeep **these** marks\n```')
ok('fenced code keeps its marks', /\*\*these\*\*/.test(fence.plain), fence.plain.slice(0, 70))
ok('the fence itself is not printed', !/```/.test(fence.plain))

const rule = draw('above\n---\nbelow')
ok('a horizontal rule is drawn', /─{5,}/.test(rule.plain))

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
