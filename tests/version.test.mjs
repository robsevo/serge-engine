#!/usr/bin/env node
/**
 * The version comes from one place.
 *
 * It used to come from five, and they disagreed: package.json said 0.0.0 while
 * config.mjs said 0.1.0, with mcp.mjs, mcp-http.mjs and startup.mjs each
 * carrying a third copy. Nothing failed — the splash, the MCP handshake and the
 * package metadata simply reported different things about the same process.
 *
 * So this is a static check as well as a behavioural one: a version literal
 * reintroduced anywhere under src/ fails here, which is the only thing that
 * stops the copies coming back one convenient edit at a time.
 *
 * Run:  node tests/version.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { VERSION } from '../src/config.mjs'
import { renderHeader } from '../src/startup.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`) }
  else { fails.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

ok('package.json has a semver version', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
ok('config.VERSION matches package.json', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`)
ok('config.VERSION is not the fallback', !/unknown/.test(VERSION), VERSION)

// Two literals cannot drift — config reads package.json. What can break is
// RESOLUTION in the built artifact: `../package.json` must resolve from dist/
// as it does from src/, or every shipped build reports the fallback.
let distVersion = null
try {
  distVersion = (await import(join(root, 'dist', 'config.mjs'))).VERSION
} catch { /* reported below */ }
ok('the BUILT artifact resolves the same version', distVersion === pkg.version,
   `dist says ${distVersion}, package.json says ${pkg.version} (run: node scripts/build.mjs)`)

// The splash is what the user reads, so it has to agree with the metadata.
const header = renderHeader({ color: false, sprite: false, cwd: '/x' })
ok('the splash shows that version', header.includes(`v${pkg.version}`), header.trim().split('\n')[0])

/** Every .mjs/.jsx under src/, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(mjs|jsx)$/.test(name)) out.push(p)
  }
  return out
}

// A version-shaped literal anywhere in src/ is a copy waiting to drift. The
// only legitimate one is config.mjs's fallback, which exists precisely so no
// other file needs one.
const offenders = []
for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    if (!/['"`]\d+\.\d+\.\d+[^'"`]*['"`]/.test(line)) return
    if (file.endsWith('config.mjs') && /unknown/.test(line)) return   // the fallback
    offenders.push(`${file.replace(root + '/', '')}:${i + 1}  ${line.trim().slice(0, 70)}`)
  })
}
ok('no version literal is restated under src/', offenders.length === 0, '\n        ' + offenders.join('\n        '))

// Guard the guard: if the scan cannot see the tree it would pass vacuously.
ok('the scan actually read the source', walk(join(root, 'src')).length > 20,
   `${walk(join(root, 'src')).length} files`)

const total = pass + fails.length
console.log(`\n  ${pass}/${total} passed`)
process.exit(fails.length ? 1 : 0)
