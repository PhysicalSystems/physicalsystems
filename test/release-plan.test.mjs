import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createReleasePlan, readProductRelease, validateProductRelease } from '../scripts/release-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const descriptorPath = 'release/product.json'
const indexPath = 'packages/cli/src/physical/node-releases.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = async (directory, relative) => JSON.parse(await fs.readFile(path.join(directory, relative), 'utf8'))
const writeJson = async (directory, relative, value) => fs.writeFile(path.join(directory, relative), JSON.stringify(value, null, 2) + '\n')

async function fixture(t) {
  const base = await fs.realpath(tmpdir())
  const directory = await fs.mkdtemp(path.join(base, 'ps-release-plan-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), base)
    assert.ok(path.basename(directory).startsWith('ps-release-plan-'))
    assert.equal(await fs.realpath(directory), directory)
    await fs.rm(directory, { recursive: true, force: true })
  })
  const index = await json(root, indexPath)
  const files = [descriptorPath, indexPath, 'packages/cli/package.json', 'packages/cli/package-lock.json',
    'packages/cli/npm-shrinkwrap.json', 'packages/pi-runtime/package.json',
    ...index.releases.map(({ manifest }) => `packages/cli/src/physical/node-releases/${manifest}`)]
  for (const relative of files) {
    const target = path.join(directory, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(root, relative), target)
  }
  return directory
}

async function changeManifest(directory, indexNumber, change) {
  const index = await json(directory, indexPath)
  const entry = index.releases[indexNumber]
  const relative = `packages/cli/src/physical/node-releases/${entry.manifest}`
  const manifest = await json(directory, relative)
  change(manifest)
  await writeJson(directory, relative, manifest)
  entry.sha256 = sha256(await fs.readFile(path.join(directory, relative)))
  await writeJson(directory, indexPath, index)
  const descriptor = await json(directory, descriptorPath)
  descriptor.backendIndexSha256 = sha256(await fs.readFile(path.join(directory, indexPath)))
  await writeJson(directory, descriptorPath, descriptor)
}

async function snapshot(directory, relative = '') {
  const files = []
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await snapshot(directory, name))
    else files.push([name, sha256(await fs.readFile(path.join(directory, name)))])
  }
  return files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
}

test('the product descriptor keeps independent exact identities, all six selectors and immutable pins', async () => {
  const descriptor = await readProductRelease()
  assert.deepEqual(descriptor.product, { name: 'physicalsystems', version: '0.2.3' })
  assert.equal(descriptor.components.node.version, '0.2.1')
  assert.equal(descriptor.components.runtime.version, '0.2.0')
  assert.equal(descriptor.components.piRuntime.version, '0.84.2-tinyedge.1')
  assert.equal(descriptor.components.node.wheelSha256, '6d0d41e5bb371cf8d135edf3a85019653f2da58e173d637dedebe6a9171c8b5f')
  assert.equal(descriptor.components.runtime.wheelSha256, '4d25fcfa055bf54faf69591e4a14bec89dc7f8d086b2bed6bf19912041403937')
  assert.equal(descriptor.backendIndexSha256, sha256(await fs.readFile(path.join(root, indexPath))))
  assert.deepEqual(descriptor.selectors, ['linux-x64:3.10', 'linux-x64:3.11', 'linux-x64:3.12',
    'win32-x64:3.10', 'win32-x64:3.11', 'win32-x64:3.12'])
  assert.deepEqual(descriptor.toolchain, { node: '22.19.0', npm: '11.19.0', consumerNode: '24.15.0', consumerNpm: '12.0.2' })
  const copy = validateProductRelease(descriptor)
  copy.product.version = '1.0.0'
  assert.equal(descriptor.product.version, '0.2.3')
})

test('descriptor validation rejects unknown/missing keys, ranges, alternate identities and reduced selectors', async () => {
  const original = await readProductRelease()
  const mutations = [
    (value) => { value.publish = true },
    (value) => { delete value.backendIndexSha256 },
    (value) => { value.components.node.distribution = 'other-node' },
    (value) => { value.components.runtime.version = '^0.2.0' },
    (value) => { value.components.piRuntime.name = '@other/runtime' },
    (value) => { value.product.version = 'latest' },
    (value) => { value.product.version = '01.2.3' },
    (value) => { value.components.node.wheelSha256 = 'A'.repeat(64) },
    (value) => { value.backendIndexSha256 = 'not-a-hash' },
    (value) => { value.selectors.pop() },
    (value) => { value.selectors.reverse() },
    (value) => { value.selectors[1] = value.selectors[0] },
    (value) => { value.toolchain.npm = '*' },
    (value) => { value.toolchain.registry = 'https://other.test' },
    (value) => { value.previousTags.latest = '0.2.1' },
    (value) => { value.previousTags.unreviewed = '0.2.1' },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(original)
    mutate(value)
    assert.throws(() => validateProductRelease(value))
  }
})

test('planning is deterministic, read-only and makes no registry or qualification claim', async (t) => {
  const directory = await fixture(t), before = await snapshot(directory)
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Planning must not use the network') })
  const first = await createReleasePlan(directory), second = await createReleasePlan(directory)
  assert.deepEqual(first, second)
  assert.deepEqual(await snapshot(directory), before)
  assert.equal(first.backend.action, 'reuse-pinned-artifacts')
  assert.equal(first.backend.artifactCount, 10)
  assert.equal(first.backend.selectors.length, 6)
  assert.match(first.backend.manifestDigest, /^[a-f0-9]{64}$/)
  assert.match(first.planDigest, /^[a-f0-9]{64}$/)
  assert.equal(first.publicationAuthorized, false)
  assert.equal(first.installationQualified, false)
  assert.match(first.pendingSteps.join('\n'), /Only if changing backend artifacts/)
  assert.match(first.pendingSteps.join('\n'), /separate reviewed Node export\/Runtime release/)
  assert.match(first.pendingSteps.join('\n'), /existing human environment approval/)
  assert.equal(JSON.stringify(first).includes(directory), false)
  assert.equal(JSON.stringify(first).includes(directory.replaceAll('\\', '/')), false)
})

test('a Harness-only version change does not rebuild or bump backend components', async (t) => {
  const directory = await fixture(t)
  const original = await createReleasePlan(directory)
  const descriptor = await json(directory, descriptorPath)
  const parts = descriptor.product.version.split('.')
  parts[2] = String(Number(parts[2]) + 1)
  const next = parts.join('.')
  descriptor.product.version = next
  await writeJson(directory, descriptorPath, descriptor)
  const product = await json(directory, 'packages/cli/package.json')
  product.version = next
  await writeJson(directory, 'packages/cli/package.json', product)
  const lock = await json(directory, 'packages/cli/package-lock.json')
  lock.version = lock.packages[''].version = next
  for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) await writeJson(directory, `packages/cli/${filename}`, lock)
  const updated = await createReleasePlan(directory)
  assert.equal(updated.product.version, next)
  assert.deepEqual(updated.components, original.components)
  assert.deepEqual(updated.backend, original.backend)
  assert.notEqual(updated.planDigest, original.planDigest)
})

test('same-version package and lock changes alter the plan fingerprint without claiming a source attestation', async (t) => {
  for (const relative of ['packages/cli/package.json', 'packages/pi-runtime/package.json', 'packages/cli/package-lock.json']) {
    const directory = await fixture(t), before = await createReleasePlan(directory)
    const value = await json(directory, relative)
    if (relative.endsWith('package-lock.json')) {
      value.packages['node_modules/proper-lockfile'].integrity = 'sha512-' + 'a'.repeat(86) + '=='
      await writeJson(directory, 'packages/cli/npm-shrinkwrap.json', value)
    } else value.description = 'Same version, changed package metadata'
    await writeJson(directory, relative, value)
    const after = await createReleasePlan(directory)
    assert.notEqual(after.planDigest, before.planDigest)
    assert.deepEqual(after.product, before.product)
    assert.deepEqual(after.components, before.components)
    assert.deepEqual(after.backend, before.backend)
    assert.equal(after.publicationAuthorized, false)
    assert.equal(after.installationQualified, false)
  }
})

test('descriptor/lock/package drift is rejected before any preparation', async (t) => {
  for (const [relative, change] of [
    ['packages/cli/package.json', (value) => { value.version = '9.9.9' }],
    ['packages/pi-runtime/package.json', (value) => { value.version = '9.9.9' }],
    ['packages/cli/package-lock.json', (value) => { value.packages[''].version = '9.9.9' }],
  ]) {
    const directory = await fixture(t), value = await json(directory, relative)
    change(value)
    await writeJson(directory, relative, value)
    await assert.rejects(createReleasePlan(directory), /disagrees|byte-identical/)
  }
  const directory = await fixture(t)
  const lock = await json(directory, 'packages/cli/package-lock.json')
  lock.packages['node_modules/@tinyedge/pi-runtime'].version = '9.9.9'
  for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) await writeJson(directory, `packages/cli/${filename}`, lock)
  await assert.rejects(createReleasePlan(directory), /Locked Pi installation version/)
})

test('the descriptor pins the exact index bytes and each manifest remains independently hash checked', async (t) => {
  const first = await fixture(t)
  await fs.appendFile(path.join(first, indexPath), '\n')
  await assert.rejects(createReleasePlan(first), /Backend index differs/)
  const second = await fixture(t)
  const index = await json(second, indexPath)
  await fs.appendFile(path.join(second, 'packages/cli/src/physical/node-releases', index.releases[0].manifest), '\n')
  await assert.rejects(createReleasePlan(second), /manifest checksum mismatch/)
})

test('same-version Node/Runtime wheel repins are rejected even when the manifest/index hashes are updated', async (t) => {
  for (const name of ['physicalsystems-node', 'tinyedge-runtime']) {
    const directory = await fixture(t)
    await changeManifest(directory, 0, (manifest) => { manifest.artifacts.find((artifact) => artifact.name === name).sha256 = 'a'.repeat(64) })
    await assert.rejects(createReleasePlan(directory), /immutable descriptor pin/)
  }
})

test('shared wheel identity and dependency versions must remain coherent across all selectors', async (t) => {
  const conflicting = await fixture(t)
  await changeManifest(conflicting, 1, (manifest) => { manifest.artifacts.find((artifact) => artifact.name === 'opencv-python-headless').bytes += 1 })
  await assert.rejects(createReleasePlan(conflicting), /conflicting immutable identity/)
  const versionMismatch = await fixture(t)
  await changeManifest(versionMismatch, 1, (manifest) => {
    const item = manifest.artifacts.find((artifact) => artifact.name === 'numpy')
    item.version = '1.26.3'
    item.filename = item.filename.replace('1.26.4', item.version)
    item.url = item.url.replace('1.26.4', item.version)
  })
  await assert.rejects(createReleasePlan(versionMismatch), /versions must agree/)
  const missing = await fixture(t)
  await changeManifest(missing, 0, (manifest) => { manifest.artifacts = manifest.artifacts.filter((item) => item.name !== 'numpy') })
  await assert.rejects(createReleasePlan(missing), /four-distribution closure/)
  const origin = await fixture(t)
  await changeManifest(origin, 0, (manifest) => { manifest.artifacts[0].url = manifest.artifacts[0].url.replace('files.pythonhosted.org', 'unreviewed.example.org') })
  await assert.rejects(createReleasePlan(origin), /placeholder|approved public wheel origin/)
})

test('descriptor input refuses duplicate keys, oversize files, links and non-absolute fixture roots', async (t) => {
  const duplicate = await fixture(t)
  const content = await fs.readFile(path.join(duplicate, descriptorPath), 'utf8')
  await fs.writeFile(path.join(duplicate, descriptorPath), content.replace('"name": "physicalsystems"', '"name": "unreviewed", "na\\u006de": "physicalsystems"'))
  await assert.rejects(readProductRelease(duplicate), /duplicate JSON keys/)
  const oversized = await fixture(t)
  await fs.writeFile(path.join(oversized, descriptorPath), ' '.repeat(128 * 1024 + 1))
  await assert.rejects(readProductRelease(oversized), /bounded regular/)
  const linked = await fixture(t), original = path.join(linked, descriptorPath), target = path.join(linked, 'release/pinned-copy.json')
  await fs.rename(original, target)
  await fs.link(target, original)
  await assert.rejects(readProductRelease(linked), /bounded regular/)
  await assert.rejects(readProductRelease('.'), /Source root must be absolute/)
})
