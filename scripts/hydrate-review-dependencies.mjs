#!/usr/bin/env node
// CI only: reuse the bundled JS dependency closure from this run's candidate,
// rather than resolving/bootstrap-packing the same runtime on every runner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const [directory, expectedCommit, ...extra] = process.argv.slice(2)
assert.ok(directory && expectedCommit && !extra.length, 'Provide candidate directory and exact source SHA')
assert.match(expectedCommit, /^[a-f0-9]{40}$/)
const manifest = JSON.parse(readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'))
assert.equal(manifest.commit, expectedCommit)
const artifact = manifest.artifacts.find((item) => item.key === 'physicalsystems')
assert.ok(artifact && /^[a-z0-9.-]+\.tgz$/.test(artifact.filename))
const archive = path.resolve(directory, artifact.filename)
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), artifact.sha256)
const target = path.join(root, 'packages/cli')
assert.equal(existsSync(path.join(target, 'node_modules')), false, 'Do not overwrite an existing dependency tree')
const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split(/\r?\n/)
assert.ok(entries.some((name) => name.startsWith('package/node_modules/')))
assert.ok(entries.every((name) => name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..')), 'Unexpected archive path')
const types = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split(/\r?\n/)
assert.ok(types.every((line) => line.startsWith('-') || line.startsWith('d')), 'Candidate archives must not contain links or special files')
execFileSync('tar', ['-xf', archive, '-C', target, '--strip-components=1', 'package/node_modules'], { stdio: 'inherit' })
console.log('Reused the exact candidate dependency closure; no npm resolution or runtime rebuild')
