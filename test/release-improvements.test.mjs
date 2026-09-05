import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { watchRelease } from '../scripts/watch-release.mjs'
import { parseReleaseArguments } from '../scripts/release.mjs'
import { planVersionUpdate, prepareReleaseVersion, requireNewVersion } from '../scripts/prepare-release-version.mjs'
import { runConcurrentChecks } from '../packages/cli/scripts/concurrent-checks.js'

test('watch follows the same receipt to evidence completion and stops on errors', async () => {
  let polls = 0, sleeps = 0
  const output = []
  const complete = await watchRelease(async () => ({
    stages: [{ component: 'npm', status: ++polls === 3 ? 'success' : 'running', url: 'https://example.test/run/1' }],
    workflowVerificationComplete: polls === 3,
  }), { print: (line) => output.push(line), sleep: async () => { sleeps++ } })
  assert.equal(complete.workflowVerificationComplete, true)
  assert.equal(polls, 3)
  assert.equal(sleeps, 2)
  assert.equal(output.filter((line) => line.startsWith('npm: running')).length, 1)
  let attempts = 0
  await assert.rejects(watchRelease(async () => { attempts++; throw new Error('Failed run') }), /Failed run/)
  assert.equal(attempts, 1)
  const controller = new AbortController()
  controller.abort()
  await watchRelease(async () => { throw new Error('Cancelled watch must not resume') }, {
    signal: controller.signal, print() {},
  })
  await assert.rejects(watchRelease(async () => ({ stages: [], workflowVerificationComplete: false }), {
    print() {}, sleep: async () => {}, maxPolls: 2,
  }), /time limit/)
})

test('watch accepts only an existing receipt argument; version rejects downgrades and malformed versions', () => {
  assert.throws(() => parseReleaseArguments(['watch', '--output', process.cwd(), '--component', 'node']), /only/)
  for (const next of ['0.2.2', '0.1.9', '0.2.3-preview', '0.02.3', 'garbage']) {
    assert.throws(() => requireNewVersion('0.2.2', next))
  }
  requireNewVersion('0.2.2', '0.3.0')
})

test('version preparation changes product roots and guards while preserving every backend and dependency pin', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const descriptor = JSON.parse(await fs.readFile(path.join(root, 'release/product.json'), 'utf8'))
  const parts = descriptor.product.version.split('.')
  parts[2] = String(Number(parts[2]) + 1)
  const next = parts.join('.')
  const plan = await planVersionUpdate(root, next)
  const before = JSON.parse(plan.originals.get('release/product.json'))
  const after = JSON.parse(plan.updates.get('release/product.json'))
  assert.deepEqual(after.components, before.components)
  assert.deepEqual(after.toolchain, before.toolchain)
  assert.equal(after.product.version, next)
  assert.equal(after.previousTags.preview, before.product.version)
  assert.equal(after.previousTags.latest, before.previousTags.latest)
  assert.equal(plan.updates.get('packages/cli/package-lock.json'), plan.updates.get('packages/cli/npm-shrinkwrap.json'))
  const oldLock = JSON.parse(plan.originals.get('packages/cli/package-lock.json'))
  const newLock = JSON.parse(plan.updates.get('packages/cli/package-lock.json'))
  newLock.version = oldLock.version
  newLock.packages[''].version = oldLock.packages[''].version
  assert.deepEqual(newLock, oldLock)
  assert.ok(plan.updates.get('.github/workflows/npm-release.yml').includes(`preview: '${before.product.version}'`))
  assert.ok(plan.updates.get('.github/workflows/npm-release.yml').includes(`RELEASE_VERSION: ${next}`))
})

test('version command regenerates a consistent checkout and refuses a dirty tree', async (t) => {
  const fixture = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'ps-version-'))
  t.after(() => fs.rm(fixture, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../', import.meta.url))
  await fs.cp(root, fixture, { recursive: true, filter: (source) => ![
    '.git', 'node_modules', 'candidate-artifacts', 'release-artifacts', 'verification-evidence',
  ].includes(path.basename(source)) })
  const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' })
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Release test', '-c', 'user.email=release@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
  const descriptor = JSON.parse(await fs.readFile(path.join(fixture, 'release/product.json'), 'utf8'))
  const parts = descriptor.product.version.split('.')
  parts[2] = String(Number(parts[2]) + 1)
  const next = parts.join('.')
  await prepareReleaseVersion(fixture, next, { print() {} })
  execFileSync(process.execPath, ['scripts/release.mjs', 'check'], { cwd: fixture })
  execFileSync(process.execPath, ['scripts/legal/sbom.mjs', '--check'], { cwd: fixture, stdio: 'pipe' })
  const changes = git('diff', '--name-only')
  assert.match(changes, /EXPORT-PROVENANCE.json/)
  assert.doesNotMatch(changes, /packages\/runtime\/|packages\/pi-runtime\/|node-releases/)
  await assert.rejects(prepareReleaseVersion(fixture, '9.0.0'), /clean checkout/)
  // A broken reviewed inventory makes generation fail after file updates.
  // Verify that failure restores both source inputs and generated evidence.
  const inventory = path.join(fixture, 'scripts/legal/reviewed-inventory.mjs')
  await fs.appendFile(inventory, '\nthrow new Error("fixture generation failure")\n')
  git('add', '.')
  git('-c', 'user.name=Release test', '-c', 'user.email=release@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'broken fixture')
  await assert.rejects(prepareReleaseVersion(fixture, '9.0.0'), /restored original release files/)
  assert.equal(git('status', '--porcelain'), '')
})

const check = (code, phase, timeout = 5000) => ({ command: process.execPath, args: ['-e', code], phase, timeout, env: process.env })
test('concurrent checks preserve output order and drain other children before reporting failure', async () => {
  const messages = []
  const output = await runConcurrentChecks([
    check("setTimeout(() => console.log('first'), 100)", 'first'),
    check("console.log('second')", 'second'),
  ], { print: (line) => messages.push(line) })
  assert.deepEqual(output, ['first', 'second'])
  assert.match(messages[0], /Starting first/)
  assert.match(messages[1], /Starting second/)
  const failed = []
  await assert.rejects(runConcurrentChecks([
    check('process.exit(2)', 'failure'),
    check('setTimeout(() => {}, 150)', 'drain'),
  ], { print: (line) => failed.push(line) }), /failure/)
  assert.ok(failed.some((line) => line.startsWith('Completed drain')))
  await assert.rejects(runConcurrentChecks([check('setInterval(() => {}, 1000)', 'timeout', 100)], { print() {} }), /timeout/)
})
