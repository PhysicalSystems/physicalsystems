import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { assembleNodeBundle } from '../../../scripts/assemble-node-bundle.mjs'
import { bundledNodeRelease, installManagedNode } from '../src/physical/node-installation.js'
import { readNodeBundle, verifyNodeBundle } from '../src/physical/node-bundle.js'
import { stageNodeBundle } from '../scripts/node-bundle-stage.js'
import { setupNodeCommand } from '../src/commands/setup-node.js'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const noNetwork = () => assert.fail('Bundled backend must not use the network')

async function fixture(t, release = '0.2.0') {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(base, 'ps-nb-'))
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    assert.equal(await fs.realpath(root), root)
    assert.ok(path.basename(root).startsWith('ps-nb-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const metadata = path.join(root, 'metadata'), wheelhouse = path.join(root, 'wheelhouse')
  await fs.mkdir(path.join(metadata, 'node-releases'), { recursive: true })
  await fs.mkdir(wheelhouse)
  const artifacts = ['physicalsystems-node', 'tinyedge-runtime'].map((name) => {
    const version = name === 'physicalsystems-node' ? release : '0.2.0'
    const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`
    return { name, version, filename, bytes: name.length, sha256: sha(name), url: `https://files.pythonhosted.org/reviewed/${filename}` }
  })
  for (const item of artifacts) await fs.writeFile(path.join(wheelhouse, item.filename), item.name)
  const selectors = new Set(['linux-x64:3.10', 'linux-x64:3.12', `${process.platform}-${process.arch}:3.12`]), releases = []
  for (const selector of selectors) {
    const [platform, python] = selector.split(':')
    const manifest = { contractVersion: 'physicalsystems-node-install-v1', release, distribution: 'physicalsystems-node', runtimeVersion: '0.2.0', platform, python, artifacts }
    const bytes = JSON.stringify(manifest, null, 2) + '\n'
    const filename = `${platform}-${python.replace('.', '')}.json`
    await fs.writeFile(path.join(metadata, 'node-releases', filename), bytes)
    releases.push({ platform, python, manifest: filename, sha256: sha(bytes) })
  }
  await fs.writeFile(path.join(metadata, 'node-releases.json'), JSON.stringify({ contractVersion: 'physicalsystems-node-index-v1', releases }))
  const packageDirectory = path.join(root, 'package')
  await fs.mkdir(packageDirectory)
  const output = path.join(packageDirectory, 'node-bundle')
  await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ physicalsystemsNodeBundle: 'node-bundle' }))
  const options = { output, directory: metadata, wheelhouse, fetchImpl: noNetwork }
  const run = async () => JSON.stringify({ version: '3.12', implementation: 'CPython', executable: path.join(root, 'python') })
  return { root, metadata, wheelhouse, packageDirectory, output, options, releases, run }
}

test('assembler consumes a local reviewed closure without PyPI and deduplicates immutable wheels', async (t) => {
  const item = await fixture(t)
  const result = await assembleNodeBundle(item.options)
  assert.equal(result.wheels, 2)
  assert.equal(result.selectors, item.releases.length)
  for (const entry of item.releases) assert.deepEqual(
    await fs.readFile(path.join(item.output, 'manifests', entry.manifest)),
    await fs.readFile(path.join(item.metadata, 'node-releases', entry.manifest)))
  const loaded = await bundledNodeRelease({ packageDirectory: item.packageDirectory, run: item.run })
  assert.equal(loaded.manifest.python, '3.12')
  assert.equal(loaded.wheelhouse, path.join(item.output, 'wheels'))
  assert.equal((await verifyNodeBundle(item.output)).wheels, 2)
  await assert.rejects(assembleNodeBundle(item.options), { code: 'EEXIST' })
})

test('missing declared bundles fail closed; unsupported platforms cannot select another wheel set', async (t) => {
  const item = await fixture(t)
  await assert.rejects(bundledNodeRelease({ packageDirectory: item.packageDirectory, run: item.run }), { code: 'ENOENT' })
  await assembleNodeBundle(item.options)
  await assert.rejects(bundledNodeRelease({ packageDirectory: item.packageDirectory,
    run: async () => JSON.stringify({ version: '3.13', implementation: 'CPython', executable: path.join(item.root, 'python') }) }), /No bundled Node release/)
})

test('bundled corrected Node 0.2.1 keeps the exact Runtime 0.2.0 closure', async (t) => {
  const item = await fixture(t, '0.2.1')
  await assembleNodeBundle(item.options)
  const release = await bundledNodeRelease({ packageDirectory: item.packageDirectory, run: item.run })
  assert.equal(release.manifest.release, '0.2.1')
  assert.equal(release.manifest.runtimeVersion, '0.2.0')
  assert.equal(release.manifest.artifacts.find((artifact) => artifact.name === 'physicalsystems-node').version, '0.2.1')
  assert.equal(release.manifest.artifacts.find((artifact) => artifact.name === 'tinyedge-runtime').version, '0.2.0')
  assert.equal((await verifyNodeBundle(item.output)).wheels, 2)
})

test('bundle descriptors reject traversal, duplicate selectors, hash mismatch and selector mismatch', async (t) => {
  const item = await fixture(t)
  await assembleNodeBundle(item.options)
  const file = path.join(item.output, 'bundle.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const change of [
    (d) => { d.releases[0].manifest = '../outside.json' },
    (d) => { d.releases.push(d.releases[0]) },
    (d) => { d.releases[0].sha256 = '0'.repeat(64) },
    (d) => { d.releases[0].platform = 'win32-arm64' },
    (d) => { d.extra = true },
  ]) {
    const broken = structuredClone(original); change(broken)
    await fs.writeFile(file, JSON.stringify(broken))
    await assert.rejects(readNodeBundle(item.output))
  }
})

test('extra, missing, changed and linked wheel payloads are rejected', async (t) => {
  const item = await fixture(t)
  await assembleNodeBundle(item.options)
  const wheels = path.join(item.output, 'wheels'), extra = path.join(wheels, 'secret.txt')
  await fs.writeFile(extra, 'not a wheel')
  await assert.rejects(verifyNodeBundle(item.output), /Unexpected or missing/)
  await fs.unlink(extra)
  const wheel = path.join(wheels, 'physicalsystems_node-0.2.0-py3-none-any.whl')
  await fs.writeFile(wheel, 'tamper')
  await assert.rejects(verifyNodeBundle(item.output), /checksum/)
  await fs.unlink(wheel)
  await assert.rejects(verifyNodeBundle(item.output), /Unexpected or missing/)
  // Hard links require no Windows administrator privilege.
  await fs.link(path.join(item.wheelhouse, path.basename(wheel)), wheel)
  await assert.rejects(verifyNodeBundle(item.output), /regular installation file/)
})

test('bundle directory junctions are rejected before wheel access', async (t) => {
  const item = await fixture(t)
  await assembleNodeBundle(item.options)
  const linked = path.join(item.root, 'linked')
  await fs.symlink(item.output, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readNodeBundle(linked), /links or junctions/)
})

test('first-run setup preserves the bundled wheelhouse and never downloads or enables hardware', async (t) => {
  const item = await fixture(t)
  await assembleNodeBundle(item.options)
  const commands = []
  const run = async (command, args) => {
    commands.push(args)
    if (args.includes('-c')) return item.run()
    if (args.includes('venv')) {
      const bin = path.join(args.at(-1), process.platform === 'win32' ? 'Scripts' : 'bin')
      await fs.mkdir(bin, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'physicalsystems-node.exe' : 'physicalsystems-node'), 'fixture', { mode: 0o700 })
    }
    if (args.includes('--installation-info')) return JSON.stringify({ contractVersion: 'physicalsystems-node-installation-v1', distribution: 'physicalsystems-node', version: '0.2.0', runtimeVersion: '0.2.0', protocols: ['physicalsystems-node-ready-v1'] })
    return ''
  }
  const result = await setupNodeCommand({ config: { configDir: path.join(item.root, 'c') }, io: { log() {} }, authorize: async () => true,
    loadBundled: () => bundledNodeRelease({ packageDirectory: item.packageDirectory, run }),
    install: (options) => installManagedNode({ ...options, run, fetchImpl: noNetwork }) })
  assert.equal(result.reused, false)
  assert.ok(commands.find((args) => args.includes('install')).includes('--no-index'))
  assert.equal(commands.some((args) => args.includes('serve-physical-node')), false)
})

test('pack staging includes exact wheels, licensing and metadata without changing source', async (t) => {
  const item = await fixture(t)
  await assembleNodeBundle(item.options)
  const source = path.join(item.root, 'source')
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true })
  const metadata = { name: 'physicalsystems', version: '0.2.0', files: ['README.md'] }
  const bytes = JSON.stringify(metadata)
  await fs.writeFile(path.join(source, 'package.json'), bytes)
  await fs.writeFile(path.join(source, 'README.md'), 'fixture')
  const stage = await stageNodeBundle(source, item.output)
  try {
    assert.equal((await verifyNodeBundle(path.join(stage.directory, 'node-bundle'))).wheels, 2)
    assert.match(await fs.readFile(path.join(stage.directory, 'BACKEND-NOTICE.txt'), 'utf8'), /proprietary evaluation preview/)
    assert.equal(JSON.parse(await fs.readFile(path.join(stage.directory, 'package.json'), 'utf8')).physicalsystemsNodeBundle, 'node-bundle')
    assert.equal(await fs.readFile(path.join(source, 'package.json'), 'utf8'), bytes)
    await assert.rejects(fs.stat(path.join(source, 'node-bundle')), { code: 'ENOENT' })
  } finally { stage.dispose() }
})
