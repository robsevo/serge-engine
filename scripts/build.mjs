#!/usr/bin/env node
/**
 * Build = copy src/ to dist/.
 *
 * install.sh only requires that `node dist/cli.mjs --version` answers, and the
 * source is already plain ESM that Node runs directly, so there is nothing to
 * bundle.
 */
import { cpSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
cpSync(join(root, 'src'), dist, { recursive: true })
chmodSync(join(dist, 'cli.mjs'), 0o755)
console.log('✓ built dist/cli.mjs')
