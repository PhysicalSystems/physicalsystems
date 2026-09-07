import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { planReleaseRequest, publishedCommit, releaseChanges, registryJson, inspectReleaseRequest } from '../scripts/release-request.mjs'

const base = { current: '0.2.5', published: '0.2.5', previousPreview: '0.2.4', changed: true }
test('one manual run generates the next registry patch while main may retain an older template', () => {
  assert.deepEqual(planReleaseRequest(base), { action: 'publish', version: '0.2.6' })
  assert.deepEqual(planReleaseRequest({ ...base, published: '0.2.6' }), { action: 'publish', version: '0.2.7' })
  assert.deepEqual(planReleaseRequest({ ...base, changed: false }), { action: 'noop', version: '0.2.5' })
  assert.deepEqual(planReleaseRequest({ ...base, published: '0.2.6', changed: false }), { action: 'noop', version: '0.2.6' })
  assert.deepEqual(planReleaseRequest({ ...base, requested: '0.3.0' }), { action: 'publish', version: '0.3.0' })
  assert.deepEqual(planReleaseRequest({ ...base, current: '0.2.6', previousPreview: '0.2.5', mode: 'publish' }), { action: 'publish', version: '0.2.6' })
})
test('occupied, conflicting, malformed and explicit unpublished requests fail closed', () => {
  for (const requested of ['0.2.4', '0.02.6', '0.3.0-rc', '0.3.0\n', '$(id)']) {
    assert.throws(() => planReleaseRequest({ ...base, requested }))
  }
  assert.throws(() => planReleaseRequest({ ...base, mode: 'publish' }), /already published/)
  assert.throws(() => planReleaseRequest({ ...base, current: '0.2.6', mode: 'publish' }), /previous preview/)
  assert.throws(() => planReleaseRequest({ ...base, current: '0.3.0', requested: '0.2.6' }), /older than the source template/)
  assert.throws(() => planReleaseRequest({ ...base, mode: 'unsafe' }), /mode/)
})
test('change detection includes product/build inputs and identifies separately released backend changes', () => {
  assert.deepEqual(releaseChanges(['packages/cli/src/cli.js', 'test/example.mjs', 'README.md']), { changed: true, backend: [] })
  assert.deepEqual(releaseChanges(['test/example.mjs', 'release/README.md']), { changed: false, backend: [] })
  assert.deepEqual(releaseChanges(['packages/runtime/src/kernel.py']), { changed: false, backend: ['runtime'] })
  assert.deepEqual(releaseChanges(['packages/runtime/tests/test_kernel.py']), { changed: false, backend: [] })
})
test('registry provenance must bind the exact distribution, digest, main workflow and unique source commit', () => {
  const sha = 'a'.repeat(40)
  const metadata = { name: 'physicalsystems', version: '0.2.5', dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } }
  const statement = {
    subject: [{ name: 'pkg:npm/physicalsystems@0.2.5', digest: { sha512: Buffer.alloc(64, 1).toString('hex') } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: { buildDefinition: {
      externalParameters: { workflow: { ref: 'refs/heads/main', repository: 'https://github.com/PhysicalSystems/physicalsystems', path: '.github/workflows/npm-release.yml' } },
      resolvedDependencies: [{ uri: 'git+https://github.com/PhysicalSystems/physicalsystems@refs/heads/main', digest: { gitCommit: sha } }],
    } },
  }
  const bundle = () => ({ attestations: [{ predicateType: statement.predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }] })
  assert.equal(publishedCommit(metadata, bundle()), sha)
  statement.subject[0].digest.sha512 = '0'.repeat(128)
  assert.throws(() => publishedCommit(metadata, bundle()), /digest/)
  statement.subject[0].digest.sha512 = Buffer.alloc(64, 1).toString('hex')
  statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/unreviewed'
  assert.throws(() => publishedCommit(metadata, bundle()), /workflow/)
})

test('registry failures, redirects and oversized responses never become permission to bump or publish', async () => {
  for (const status of [301, 401, 404, 429, 500]) {
    await assert.rejects(registryJson('physicalsystems/preview', { fetchImpl: async () => new Response('{}', { status }) }), /lookup failed/)
  }
  assert.equal(await registryJson('physicalsystems/9.0.0', { allowMissing: true,
    fetchImpl: async () => new Response('{}', { status: 404 }) }), null)
  await assert.rejects(registryJson('physicalsystems/preview', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      return new Response('x'.repeat(2 * 1024 * 1024 + 1))
    },
  }), /Oversized/)
})

test('registry decisions bind an available source ancestor and reject occupied versions', async (t) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'ps-auto-release-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const checkout = path.join(temporary, 'source')
  await fs.cp(fileURLToPath(new URL('../', import.meta.url)), checkout, { recursive: true,
    filter: (source) => !['.git', 'node_modules', 'release-artifacts', 'candidate-artifacts', 'verification-evidence'].includes(path.basename(source)) })
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-b', 'main', '--quiet')
  git('config', 'gc.auto', '0')
  git('config', 'maintenance.auto', 'false')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'release@example.test')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '--quiet', '-m', 'reviewed main fixture')
  const descriptor = JSON.parse(await fs.readFile(path.join(checkout, 'release/product.json')))
  const current = descriptor.product.version
  const baseline = git('rev-parse', 'HEAD')
  const metadata = { name: 'physicalsystems', version: current, dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } }
  const statement = {
    subject: [{ name: `pkg:npm/physicalsystems@${current}`, digest: { sha512: Buffer.alloc(64, 1).toString('hex') } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: { buildDefinition: {
      externalParameters: { workflow: { ref: 'refs/heads/main', repository: 'https://github.com/PhysicalSystems/physicalsystems', path: '.github/workflows/npm-release.yml' } },
      resolvedDependencies: [{ uri: 'git+https://github.com/PhysicalSystems/physicalsystems@refs/heads/main', digest: { gitCommit: baseline } }],
    } },
  }
  let occupied = false
  const readJson = async (suffix, options) => {
    if (suffix === 'physicalsystems/preview') return metadata
    if (suffix.startsWith('-/npm/')) return { attestations: [{ predicateType: statement.predicateType,
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }] }
    assert.equal(options.allowMissing, true)
    return occupied ? { name: 'physicalsystems' } : null
  }
  assert.equal((await inspectReleaseRequest(checkout, { readJson })).action, 'noop')
  await fs.appendFile(path.join(checkout, 'packages/cli/src/cli.js'), '\n// release input fixture\n')
  git('add', 'packages/cli/src/cli.js')
  git('commit', '--quiet', '-m', 'new product input')
  assert.equal((await inspectReleaseRequest(checkout, { readJson })).action, 'publish')
  occupied = true
  await assert.rejects(inspectReleaseRequest(checkout, { readJson }), /already exists/)
  occupied = false
  statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40)
  await assert.rejects(inspectReleaseRequest(checkout, { readJson }), /available ancestor/)
  statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = baseline
  assert.equal(git('status', '--porcelain'), '')
})
