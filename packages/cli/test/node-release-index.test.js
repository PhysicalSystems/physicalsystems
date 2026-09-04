import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkBundledNodeReleaseIndex } from '../../../scripts/check-node-release-index.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('the product pins the published discovery fix for all six targets without changing Runtime', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('metadata validation must not download'))
  const directory = path.resolve(import.meta.dirname, '../src/physical')
  assert.deepEqual(await checkBundledNodeReleaseIndex(directory, { expectedRelease: '0.2.1' }), {
    entries: 6,
    selectors: ['linux-x64:3.10', 'linux-x64:3.11', 'linux-x64:3.12',
      'win32-x64:3.10', 'win32-x64:3.11', 'win32-x64:3.12'],
  })
  const index = JSON.parse(await fs.readFile(path.join(directory, 'node-releases.json'), 'utf8'))
  for (const entry of index.releases) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'node-releases', entry.manifest), 'utf8'))
    assert.equal(manifest.runtimeVersion, '0.2.0')
    const node = manifest.artifacts.find((artifact) => artifact.name === 'physicalsystems-node')
    assert.equal(node.version, '0.2.1')
    assert.equal(node.bytes, 201845)
    assert.equal(node.sha256, '6d0d41e5bb371cf8d135edf3a85019653f2da58e173d637dedebe6a9171c8b5f')
    const runtime = manifest.artifacts.find((artifact) => artifact.name === 'tinyedge-runtime')
    assert.equal(runtime.version, '0.2.0')
    assert.equal(runtime.sha256, '4d25fcfa055bf54faf69591e4a14bec89dc7f8d086b2bed6bf19912041403937')
  }
})

async function fixture(t) {
  // Windows runners may expose TEMP through an 8.3 alias. Canonicalize only
  // the test base; keep the release gate's production no-link checks intact.
  const base = await fs.realpath(tmpdir())
  const directory = await fs.mkdtemp(path.join(base, 'ps-node-release-gate-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(base))
    assert.ok(path.basename(directory).startsWith('ps-node-release-gate-'))
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
    await fs.rm(directory, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(directory, 'node-releases'))
  const index = { contractVersion: 'physicalsystems-node-index-v1', releases: [] }
  const manifests = new Map()
  for (const python of ['3.10', '3.12']) {
    // Synthetic metadata only. These URLs are never fetched, and this fixture
    // makes no claim that its wheel bytes exist or are qualified for Ubuntu.
    const artifacts = ['physicalsystems-node', 'tinyedge-runtime'].map((name) => {
      const filename = `${name.replaceAll('-', '_')}-0.2.0-py3-none-any.whl`
      return { name, version: '0.2.0', filename, sha256: sha(name), bytes: name.length,
        url: `https://files.pythonhosted.org/synthetic-test-fixture/${filename}` }
    })
    const manifest = { contractVersion: 'physicalsystems-node-install-v1', release: '0.2.0',
      distribution: 'physicalsystems-node', runtimeVersion: '0.2.0', platform: 'linux-x64', python, artifacts }
    const filename = `linux-x64-python-${python.replace('.', '-')}.json`
    manifests.set(filename, manifest)
    index.releases.push({ platform: 'linux-x64', python, manifest: filename, sha256: '' })
  }
  async function write() {
    for (const entry of index.releases) {
      if (!manifests.has(entry.manifest)) continue
      const raw = JSON.stringify(manifests.get(entry.manifest), null, 2) + '\n'
      entry.sha256 = sha(raw) // Raw bytes, deliberately not canonical JSON.
      await fs.writeFile(path.join(directory, 'node-releases', entry.manifest), raw)
    }
    await fs.writeFile(path.join(directory, 'node-releases.json'), JSON.stringify(index))
  }
  await write()
  return { directory, index, manifests, write }
}

test('publication gate accepts both required hashed metadata entries without downloading', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('release gate must not download'))
  const { directory } = await fixture(t)
  assert.deepEqual(await checkBundledNodeReleaseIndex(directory), {
    entries: 2, selectors: ['linux-x64:3.10', 'linux-x64:3.12'],
  })
})

test('the consolidated publication gate rejects historical backend bytes for any selector', async (t) => {
  const item = await fixture(t)
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory, { expectedRelease: '0.2.1' }), /requires Node 0\.2\.1/)
  for (const manifest of item.manifests.values()) {
    manifest.release = '0.2.1'
    const node = manifest.artifacts.find((artifact) => artifact.name === 'physicalsystems-node')
    node.version = '0.2.1'
    node.filename = node.filename.replace('0.2.0', '0.2.1')
    node.url = node.url.replace('0.2.0', '0.2.1')
  }
  await item.write()
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory, { expectedRelease: '0.2.1' }), /all six approved/)
  assert.equal([...item.manifests.values()].every((manifest) => manifest.runtimeVersion === '0.2.0'), true)
})

test('removing Windows or Python 3.11 support cannot make the downloadable product pass', async (t) => {
  const source = path.resolve(import.meta.dirname, '../src/physical')
  for (const removed of ['win32-x64:3.12', 'linux-x64:3.11']) {
    const item = await fixture(t)
    const index = JSON.parse(await fs.readFile(path.join(source, 'node-releases.json'), 'utf8'))
    index.releases = index.releases.filter((entry) => `${entry.platform}:${entry.python}` !== removed)
    for (const entry of index.releases) await fs.copyFile(path.join(source, 'node-releases', entry.manifest), path.join(item.directory, 'node-releases', entry.manifest))
    await fs.writeFile(path.join(item.directory, 'node-releases.json'), JSON.stringify(index))
    await assert.rejects(checkBundledNodeReleaseIndex(item.directory, { expectedRelease: '0.2.1' }), /all six approved/)
  }
})

test('empty source-candidate index is intentionally not publishable', async (t) => {
  const item = await fixture(t)
  item.index.releases = []
  await item.write()
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /nonempty/)
})

test('publication requires both Ubuntu Python selectors', async (t) => {
  const item = await fixture(t)
  item.index.releases.pop()
  await item.write()
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /Python 3\.10 and 3\.12/)
})

test('index entries reject extra fields, wrong types, unsupported platforms and path traversal', async (t) => {
  for (const change of [(entry) => { entry.extra = true }, (entry) => { entry.python = 3.12 },
    (entry) => { entry.platform = 'linux-arm64' }, (entry) => { entry.manifest = '../escape.json' },
    (entry) => { entry.sha256 = 'latest' }]) {
    const item = await fixture(t)
    change(item.index.releases[0])
    await fs.writeFile(path.join(item.directory, 'node-releases.json'), JSON.stringify(item.index))
    await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /Invalid bundled/)
  }
})

test('duplicate selectors or manifest filenames cannot shadow another release', async (t) => {
  for (const duplicate of ['selector', 'manifest']) {
    const item = await fixture(t)
    if (duplicate === 'selector') item.index.releases.push({ ...item.index.releases[0], manifest: 'other.json' })
    else item.index.releases[1].manifest = item.index.releases[0].manifest
    await fs.writeFile(path.join(item.directory, 'node-releases.json'), JSON.stringify(item.index))
    await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /Duplicate/)
  }
})

test('hash mismatch and index/manifest selector mismatch are publication failures', async (t) => {
  const item = await fixture(t)
  const entry = item.index.releases[0]
  await fs.appendFile(path.join(item.directory, 'node-releases', entry.manifest), ' ')
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /checksum mismatch/)
  item.manifests.get(entry.manifest).python = '3.11'
  await item.write()
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /selector does not match/)
  item.manifests.get(entry.manifest).python = entry.python
  item.manifests.get(entry.manifest).platform = 'win32-x64'
  await item.write()
  await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /selector does not match/)
})

test('placeholder and localhost artifact URLs never pass the publication gate', async (t) => {
  for (const host of ['files.invalid', 'files.test', 'files.example.com', 'example.org',
    'example.net', 'files.example', 'localhost', 'localhost.localdomain', '127.0.0.1', '[::1]', 'files.test.']) {
    const item = await fixture(t)
    const artifact = item.manifests.values().next().value.artifacts[0]
    artifact.url = `https://${host}/${artifact.filename}`
    await item.write()
    await assert.rejects(checkBundledNodeReleaseIndex(item.directory), /placeholder or local hosts/)
  }
})
