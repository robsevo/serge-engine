#!/usr/bin/env node
/**
 * Build: copy the plain-ESM sources to dist/, then compile the JSX.
 *
 * `.mjs` is what Node already runs, so it is copied untouched. Only the Ink
 * components need a transform, and esbuild does that in one pass — bundling
 * them would inline React and Ink into the output for no benefit, since both
 * are real dependencies resolved at runtime.
 */
import {
  cpSync, rmSync, mkdirSync, chmodSync, readdirSync, statSync, unlinkSync,
  readFileSync, writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
cpSync(join(root, 'src'), dist, { recursive: true })

/** Every .jsx under a directory, recursively. */
function jsxIn(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...jsxIn(p))
    else if (name.endsWith('.jsx')) out.push(p)
  }
  return out
}

/** Every emitted .js/.mjs under a directory, recursively. */
function allJs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...allJs(p))
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p)
  }
  return out
}

const entries = jsxIn(join(root, 'src'))
if (entries.length) {
  await build({
    entryPoints: entries,
    outdir: dist,
    outbase: join(root, 'src'),
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    bundle: false,
    logLevel: 'error',
  })
  // esbuild emits .js beside the copied .jsx. Drop the sources, then rewrite
  // every `./Thing.jsx` specifier to `./Thing.js` so the emitted modules resolve.
  for (const f of jsxIn(dist)) unlinkSync(f)
  for (const f of allJs(dist)) {
    const src = readFileSync(f, 'utf8')
    const fixed = src.replace(/(from\s+['"][^'"]+)\.jsx(['"])/g, '$1.js$2')
    if (fixed !== src) writeFileSync(f, fixed)
  }
}

chmodSync(join(dist, 'cli.mjs'), 0o755)
console.log(`✓ built dist/cli.mjs${entries.length ? ` + ${entries.length} components` : ''}`)
