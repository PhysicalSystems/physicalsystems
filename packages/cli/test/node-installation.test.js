import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installManagedNode, installationEnvironment, readNodeInstallManifest, selectedNodeRelease, selectManagedNode, validateNodeInstallManifest } from '../src/physical/node-installation.js'
import { approveNodeSetup, managedNodeEnvironment, parseSetupNodeArgs } from '../src/commands/setup-node.js'

const sha = (value) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const artifacts = ['physicalsystems-node', 'tinyedge-runtime', 'numpy', 'opencv-python-headless'].map((name) => {
    const version = name === 'opencv-python-headless' ? '4.13.0.92' : name === 'numpy' ? '2.2.6' : '0.2.0'
    const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`
    return { name, version, filename, sha256: sha(name), bytes: Buffer.byteLength(name), url: `https://files.example.test/${filename}` }
  })
  const manifest = { contractVersion: 'physicalsystems-node-install-v1', release: '0.2.0', distribution: 'physicalsystems-node', runtimeVersion: '0.2.0', platform: `${process.platform}-${process.arch}`, python: '3.12', artifacts }
  return { manifest, digest: sha(JSON.stringify(manifest)) }
}
async function temporary(t) {
  // Windows runners may expose TEMP through an 8.3 alias. Use its canonical
  // base so ordinary fixtures still exercise the production no-link checks.
  const base = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'ps-ni-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(base))
    assert.ok(path.basename(root).startsWith('ps-ni-'))
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}
async function fakeInstaller(t, { missingLauncher = false, wrongProbe = false, failInstall = false, failNative = false } = {}) {
  const root = await temporary(t), releases = fixture(), commands = []
  const wheelhouse = path.join(root, 'wheelhouse')
  await fs.mkdir(wheelhouse)
  for (const item of releases.manifest.artifacts) await fs.writeFile(path.join(wheelhouse, item.filename), item.name)
  const run = async (command, args, options) => {
    commands.push({ command, args, options })
    if (args.includes('-c') && args.some((arg) => arg.includes('import numpy,cv2,tinyedge_runtime'))) {
      if (failNative) throw new Error('synthetic missing native library')
      return ''
    }
    if (args.includes('-c')) return JSON.stringify({ version: '3.12', implementation: 'CPython', executable: path.join(root, 'python') })
    if (args.includes('venv')) {
      const destination = args.at(-1)
      const bin = path.join(destination, process.platform === 'win32' ? 'Scripts' : 'bin')
      await fs.mkdir(bin, { recursive: true, mode: 0o700 })
      if (!missingLauncher) await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'physicalsystems-node.exe' : 'physicalsystems-node'), 'fake console launcher', { mode: 0o700 })
      return ''
    }
    if (args.includes('install') && failInstall) throw new Error('synthetic install failure')
    if (args.includes('--installation-info')) return JSON.stringify({ contractVersion: 'physicalsystems-node-installation-v1', distribution: 'physicalsystems-node', version: wrongProbe ? '0.1.0' : '0.2.0', runtimeVersion: '0.2.0', protocols: ['physicalsystems-node-ready-v1'] })
    return ''
  }
  return { root, commands, options: { ...releases, configDir: path.join(root, 'config'), wheelhouse, run, authorize: async () => true, fetchImpl() { assert.fail('offline wheelhouse must not use network') } } }
}

test('manifest requires an exact bounded wheel closure and accepts real four-part OpenCV versions', () => {
  const { manifest } = fixture()
  assert.deepEqual(validateNodeInstallManifest(manifest), manifest)
  for (const change of [(m) => m.artifacts.pop() && m.artifacts.pop() && m.artifacts.pop(), (m) => m.artifacts.push(m.artifacts[0]), (m) => { m.extra = true },
    (m) => { m.artifacts[0].filename = '../escape.whl' }, (m) => { m.artifacts[0].url = 'http://example.test/a.whl' },
    (m) => { m.artifacts[0].url += '?token=secret' }, (m) => { m.artifacts[0].bytes = 1e12 }, (m) => { m.artifacts[0].sha256 = 'latest' }]) {
    const broken = structuredClone(manifest); change(broken)
    assert.throws(() => validateNodeInstallManifest(broken))
  }
})

test('raw local manifest hash is verified before interpreting or downloading anything', async (t) => {
  const root = await temporary(t), manifest = fixture().manifest
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
  const filename = path.join(root, 'manifest.json')
  await fs.writeFile(filename, bytes)
  const loaded = await readNodeInstallManifest(filename, sha(bytes))
  assert.deepEqual(loaded.manifestBytes, bytes)
  await assert.rejects(readNodeInstallManifest(filename, '0'.repeat(64)), /checksum mismatch/)
  await assert.rejects(readNodeInstallManifest(filename, 'latest'), /SHA-256/)
})

test('declining setup or incompatible Python leaves no managed installation directory', async (t) => {
  const item = await fakeInstaller(t)
  await assert.rejects(installManagedNode({ ...item.options, authorize: async () => false }), /not approved/)
  await assert.rejects(fs.stat(item.options.configDir), { code: 'ENOENT' })
  const manifest = { ...item.options.manifest, python: '3.11' }
  await assert.rejects(installManagedNode({ ...item.options, manifest, digest: sha(JSON.stringify(manifest)) }), /Python\/platform/)
  assert.equal(item.commands.some(({ args }) => args.includes('venv')), false)
})

test('offline install uses exact hashed wheels, isolated Python, successful probe and durable reuse', async (t) => {
  const item = await fakeInstaller(t)
  const result = await installManagedNode(item.options)
  assert.equal(result.reused, false)
  const install = item.commands.find(({ args }) => args.includes('install'))
  for (const flag of ['-I', '--isolated', '--no-index', '--no-deps', '--only-binary=:all:', '--require-hashes', '--no-cache-dir']) assert.ok(install.args.includes(flag))
  const requirementBytes = await fs.readFile(install.args.at(-1), 'utf8')
  assert.equal(requirementBytes.match(/--hash=sha256:/g).length, 4)
  assert.equal(requirementBytes.includes('https:'), false)
  await selectManagedNode(item.options.configDir, result.digest)
  const selected = await selectedNodeRelease(item.options.configDir)
  assert.deepEqual(selected.manifest, item.options.manifest)
  const again = await installManagedNode({ ...item.options, ...selected, authorize() { assert.fail('reusing verified installation needs no reinstall consent') } })
  assert.equal(again.reused, true)
  assert.equal(again.executable, result.executable)
  assert.equal(item.commands.filter(({ args }) => args.includes('venv')).length, 1)
})

test('wheel tamper, failed installation, bad probe, missing native library or launcher never activate a receipt', async (t) => {
  for (const failure of ['tamper', 'failInstall', 'wrongProbe', 'failNative', 'missingLauncher']) {
    const item = await fakeInstaller(t, { [failure]: true })
    if (failure === 'tamper') await fs.writeFile(path.join(item.options.wheelhouse, item.options.manifest.artifacts[0].filename), 'tamper')
    await assert.rejects(installManagedNode(item.options))
    const managed = path.join(item.options.configDir, 'node-installations')
    assert.equal((await fs.readdir(managed)).some((name) => name.endsWith('.json')), false)
    assert.equal((await fs.readdir(managed)).includes('setup.lock'), false)
    if (failure === 'tamper') assert.equal(item.commands.some(({ args }) => args.includes('venv')), false)
  }
})

test('Windows long paths fail before consent, Python or installation mutation', { skip: process.platform !== 'win32' }, async (t) => {
  const item = await fakeInstaller(t)
  const configDir = path.join(item.root, 'long-configuration-directory-'.repeat(4))
  await assert.rejects(installManagedNode({ ...item.options, configDir,
    authorize() { assert.fail('invalid path must fail before consent') } }), /TINYEDGE_CONFIG_DIR.*shorter/)
  assert.equal(item.commands.length, 0)
  await assert.rejects(fs.stat(configDir), { code: 'ENOENT' })
})

test('a concurrent/interrupted setup lock is not stolen or deleted', async (t) => {
  const item = await fakeInstaller(t), managed = path.join(item.options.configDir, 'node-installations')
  await fs.mkdir(managed, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(managed, 'setup.lock'), 'existing-owner')
  await assert.rejects(installManagedNode(item.options), /active or interrupted/)
  assert.equal(await fs.readFile(path.join(managed, 'setup.lock'), 'utf8'), 'existing-owner')
})

test('a damaged selected installation is not silently reinstalled or replaced', async (t) => {
  const item = await fakeInstaller(t), result = await installManagedNode(item.options)
  await fs.unlink(result.executable)
  await assert.rejects(installManagedNode({ ...item.options, authorize() { assert.fail('must not repair') } }), { code: 'ENOENT' })
  assert.equal(item.commands.filter(({ args }) => args.includes('venv')).length, 1)
})

test('setup process environment contains no provider, Python path, pip index or execution credentials', () => {
  const env = installationEnvironment({ PATH: '/bin', HOME: '/home/operator', OPENAI_API_KEY: 'secret', PHYSICAL_NODE_EXECUTION_TOKEN: 'token', PYTHONPATH: '/malicious', PIP_INDEX_URL: 'https://private', VIRTUAL_ENV: '/other', arbitrary: 'no' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'PIP_CONFIG_FILE', 'PYTHONNOUSERSITE'])
})

test('managed startup cannot shadow the verified package through ambient Python settings', async (t) => {
  const item = await fakeInstaller(t)
  const result = await installManagedNode(item.options)
  await selectManagedNode(item.options.configDir, result.digest)
  const env = { PATH: 'operator-path', PYTHONPATH: 'shadow-source', PythonHome: 'other-python', PYTHONUSERBASE: 'other-packages', VIRTUAL_ENV: 'other-env', OPENAI_API_KEY: 'provider-for-harness' }
  const managed = await managedNodeEnvironment({ config: { configDir: item.options.configDir }, env,
    install: (options) => installManagedNode({ ...options, run: item.options.run }) })
  assert.equal(managed.PHYSICAL_NODE_EXECUTABLE, result.executable)
  assert.equal(managed.PHYSICAL_NODE_EXECUTION_MODE, 'discovery')
  assert.equal(managed.PYTHONNOUSERSITE, '1')
  for (const name of ['PYTHONPATH', 'PythonHome', 'PYTHONUSERBASE', 'VIRTUAL_ENV']) assert.equal(managed[name], undefined)
  assert.equal(env.PYTHONPATH, 'shadow-source')
  assert.equal(managed.OPENAI_API_KEY, 'provider-for-harness')
})

test('CLI consent/options are explicit and unknown or incomplete switches reject', async () => {
  assert.deepEqual(parseSetupNodeArgs(['--yes']), { yes: true })
  for (const args of [['--yes', '--yes'], ['--manifest', '/x'], ['--sha256', 'abc'], ['--wheelhouse', '/x'], ['--run'], ['--python']]) assert.throws(() => parseSetupNodeArgs(args))
  await assert.rejects(approveNodeSetup({ release: '0.2.0', bytes: 1 }, { input: {}, output: {} }), /operator consent/)
  assert.equal(await approveNodeSetup({ release: '0.2.0', bytes: 1 }, { yes: true }), true)
})

test('explicit external node/executable bypasses setup and an unpublished index invents no release', async () => {
  for (const env of [{ PHYSICAL_NODE_EXECUTABLE: '/chosen/node' }, { TINYEDGE_PHYSICAL_NODE_URL: 'http://127.0.0.1:8876' }]) {
    assert.equal(await managedNodeEnvironment({ config: {}, env, loadSelected() { assert.fail('override bypasses installation') } }), env)
  }
  const env = {}
  assert.equal(await managedNodeEnvironment({ config: {}, env, loadSelected: async () => null, loadBundled: async () => null, install() { assert.fail('no released bytes') } }), env)
})
