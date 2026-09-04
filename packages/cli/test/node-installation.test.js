import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installManagedNode, installationEnvironment, readNodeInstallManifest, selectedNodeRelease, selectManagedNode, validateNodeInstallManifest } from '../src/physical/node-installation.js'
import { approveNodeSetup, managedNodeEnvironment, parseSetupNodeArgs } from '../src/commands/setup-node.js'

const sha = (value) => createHash('sha256').update(value).digest('hex')
function fixture(release = '0.2.0') {
  const artifacts = ['physicalsystems-node', 'tinyedge-runtime', 'numpy', 'opencv-python-headless'].map((name) => {
    const version = name === 'opencv-python-headless' ? '4.13.0.92' : name === 'numpy' ? '2.2.6' : name === 'physicalsystems-node' ? release : '0.2.0'
    const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`
    return { name, version, filename, sha256: sha(name), bytes: Buffer.byteLength(name), url: `https://files.example.test/${filename}` }
  })
  const manifest = { contractVersion: 'physicalsystems-node-install-v1', release, distribution: 'physicalsystems-node', runtimeVersion: '0.2.0', platform: `${process.platform}-${process.arch}`, python: '3.12', artifacts }
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
async function fakeInstaller(t, { missingLauncher = false, wrongProbe = false, failInstall = false, failNative = false, release = '0.2.0' } = {}) {
  const root = await temporary(t), releases = fixture(release), commands = []
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
    if (args.includes('--installation-info')) {
      const installed = JSON.parse(await fs.readFile(path.resolve(path.dirname(command), '../../manifest.json'), 'utf8'))
      return JSON.stringify({ contractVersion: 'physicalsystems-node-installation-v1', distribution: 'physicalsystems-node', version: wrongProbe ? '0.1.0' : installed.release, runtimeVersion: '0.2.0', protocols: ['physicalsystems-node-ready-v1'] })
    }
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

test('only reviewed Node 0.2.0 and 0.2.1 paired with Runtime 0.2.0 are accepted', () => {
  for (const release of ['0.2.0', '0.2.1']) assert.equal(validateNodeInstallManifest(fixture(release).manifest).release, release)
  for (const release of ['0.1.0', '0.2.2', '0.3.0', 'latest']) assert.throws(() => validateNodeInstallManifest(fixture(release).manifest), /Invalid Node installation/)
  for (const runtimeVersion of ['0.2.1', 'latest']) assert.throws(() => validateNodeInstallManifest({ ...fixture('0.2.1').manifest, runtimeVersion }), /Invalid Node installation/)
  assert.throws(() => validateNodeInstallManifest({ ...fixture().manifest, release: '0.2.1' }), /exact Node or Runtime wheel/)
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

test('downloaded setup fetches only selected fixed URLs after consent and reuse fetches nothing', async (t) => {
  const item = await fakeInstaller(t, { release: '0.2.1' }), requested = []
  let approved = false
  const options = { ...item.options, wheelhouse: undefined,
    authorize: async () => { approved = true; return true },
    fetchImpl: async (url, request) => {
      assert.equal(approved, true)
      assert.equal(request.redirect, 'error')
      assert.equal(request.credentials, 'omit')
      assert.ok(request.signal instanceof AbortSignal)
      assert.deepEqual(request.headers, { Accept: 'application/octet-stream' })
      const artifact = item.options.manifest.artifacts.find((entry) => entry.url === url)
      assert.ok(artifact, 'cannot search a registry or fetch another platform')
      requested.push(url)
      return new Response(artifact.name, { headers: { 'content-length': String(artifact.bytes) } })
    },
  }
  const first = await installManagedNode(options)
  assert.equal(first.reused, false)
  assert.deepEqual(requested, options.manifest.artifacts.map(({ url }) => url))
  const install = item.commands.find(({ args }) => args.includes('install'))
  assert.ok(install.args.includes('--no-index') && install.args.includes('--no-deps') && install.args.includes('--require-hashes'))
  const reuse = await installManagedNode({ ...options,
    authorize() { assert.fail('verified reuse cannot ask for installation again') },
    fetchImpl() { assert.fail('verified reuse cannot download') } })
  assert.equal(reuse.reused, true)
  assert.equal(reuse.executable, first.executable)
})

test('network, redirect, length, integrity and interrupted-stream failures cannot activate an update', async (t) => {
  for (const failure of ['network', 'redirect', 'length', 'truncated', 'corrupt', 'oversized', 'stream']) {
    const item = await fakeInstaller(t)
    const previous = await installManagedNode(item.options)
    await selectManagedNode(item.options.configDir, previous.digest)
    const next = fixture('0.2.1')
    const fetchImpl = async (url, request) => {
      assert.equal(request.redirect, 'error')
      const artifact = next.manifest.artifacts.find((entry) => entry.url === url)
      assert.ok(artifact)
      if (failure === 'network') throw new Error('synthetic offline connection')
      let bytes = Buffer.from(artifact.name)
      if (failure === 'corrupt') bytes.fill(120)
      if (failure === 'truncated') bytes = bytes.subarray(1)
      if (failure === 'oversized') bytes = Buffer.concat([bytes, Buffer.from('extra')])
      return { ok: true, url: failure === 'redirect' ? 'https://other.example.test/wheel.whl' : url,
        headers: new Headers(failure === 'length' ? { 'content-length': '1' } : {}),
        body: (async function* () { yield bytes; if (failure === 'stream') throw new Error('synthetic interrupted stream') })(),
      }
    }
    await assert.rejects(installManagedNode({ ...item.options, ...next, wheelhouse: undefined, fetchImpl }))
    assert.equal((await selectedNodeRelease(item.options.configDir)).digest, previous.digest, failure)
    await assert.rejects(fs.stat(path.join(item.options.configDir, 'node-installations', `${next.digest}.json`)), { code: 'ENOENT' })
    assert.equal(item.commands.filter(({ args }) => args.includes('venv')).length, 1, 'failed download must not invoke pip or create another environment')
    assert.equal((await fs.readdir(path.join(item.options.configDir, 'node-installations'))).includes('setup.lock'), false)
  }
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
    loadBundled: async () => item.options,
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

async function upgradeFixture(t, options = {}) {
  const old = await fakeInstaller(t), candidate = await fakeInstaller(t, { release: '0.2.1', ...options })
  const original = await installManagedNode(old.options)
  await selectManagedNode(old.options.configDir, original.digest)
  const selection = path.join(old.options.configDir, 'node-installations/selected.json')
  const before = await fs.readFile(selection)
  const invoke = (overrides = {}) => managedNodeEnvironment({ config: { configDir: old.options.configDir }, env: {}, io: { log() {} },
    loadBundled: async ({ python }) => {
      assert.equal(python, path.join(path.dirname(original.executable), process.platform === 'win32' ? 'python.exe' : 'python'))
      return candidate.options
    },
    install: (settings) => installManagedNode({ ...settings, run: candidate.options.run, fetchImpl: candidate.options.fetchImpl }),
    ...overrides })
  const assertOriginal = async () => {
    assert.deepEqual(await fs.readFile(selection), before)
    assert.equal((await selectedNodeRelease(old.options.configDir)).digest, original.digest)
    assert.equal(await fs.readFile(original.executable, 'utf8'), 'fake console launcher')
  }
  return { old, candidate, original, invoke, assertOriginal }
}

test('managed product updates 0.2.0 to 0.2.1 only after consent and preserves old installed bytes', async (t) => {
  const item = await upgradeFixture(t), approvals = []
  const env = await item.invoke({ authorize: async (details) => { approvals.push(details); return true } })
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].previousRelease, '0.2.0')
  assert.equal(approvals[0].release, '0.2.1')
  assert.equal((await selectedNodeRelease(item.old.options.configDir)).digest, item.candidate.options.digest)
  assert.notEqual(env.PHYSICAL_NODE_EXECUTABLE, item.original.executable)
  assert.equal(env.PHYSICAL_NODE_EXECUTION_MODE, 'discovery')
  assert.equal(await fs.readFile(item.original.executable, 'utf8'), 'fake console launcher')
  const install = item.candidate.commands.find(({ args }) => args.includes('install'))
  assert.ok(install.args.includes('--no-index'))
  assert.equal(item.candidate.commands.some(({ args }) => args.includes('serve-physical-node')), false)
})

test('declined or failed managed updates do not start the old Node or replace its selection', async (t) => {
  for (const failure of ['decline', 'failInstall']) {
    const item = await upgradeFixture(t, { failInstall: failure === 'failInstall' })
    await assert.rejects(item.invoke({ authorize: async () => failure !== 'decline' }), failure === 'decline' ? /update was not approved/ : /synthetic install failure/)
    await item.assertOriginal()
    if (failure === 'decline') assert.equal(item.candidate.commands.some(({ args }) => args.includes('venv')), false)
  }
})

test('switching to an already-installed newer backend still requires update consent', async (t) => {
  const item = await upgradeFixture(t)
  await installManagedNode({ ...item.candidate.options, configDir: item.old.options.configDir })
  let approvals = 0
  await assert.rejects(item.invoke({ authorize: async () => { approvals++; return false } }), /update was not approved/)
  assert.equal(approvals, 1)
  await item.assertOriginal()
  const installs = item.candidate.commands.filter(({ args }) => args.includes('venv')).length
  await item.invoke({ authorize: async () => { approvals++; return true } })
  assert.equal(approvals, 2)
  assert.equal(item.candidate.commands.filter(({ args }) => args.includes('venv')).length, installs)
})

test('invalid bundled metadata blocks startup without falling back to the old selection', async (t) => {
  const item = await upgradeFixture(t)
  await assert.rejects(item.invoke({ loadBundled() { throw new Error('synthetic corrupted product bundle') },
    authorize() { assert.fail('Invalid bundle must not ask for consent') } }), /corrupted product bundle/)
  await item.assertOriginal()
  assert.equal(item.candidate.commands.some(({ args }) => args.includes('venv')), false)
})

test('verified same-digest, same-version custom and newer selections are not changed or downgraded', async (t) => {
  for (const choice of ['same-digest', 'custom-digest', 'older-bundle']) {
    const release = choice === 'older-bundle' ? '0.2.1' : '0.2.0'
    const selected = await fakeInstaller(t, { release }), installed = await installManagedNode(selected.options)
    await selectManagedNode(selected.options.configDir, installed.digest)
    const selection = path.join(selected.options.configDir, 'node-installations/selected.json'), before = await fs.readFile(selection)
    const bundle = fixture(choice === 'older-bundle' ? '0.2.0' : release)
    if (choice === 'custom-digest') {
      bundle.manifest.artifacts[0].url = bundle.manifest.artifacts[0].url.replace('files.example.test', 'other.example.test')
      bundle.digest = sha(JSON.stringify(bundle.manifest))
      assert.notEqual(bundle.digest, installed.digest)
    }
    const env = await managedNodeEnvironment({ config: { configDir: selected.options.configDir }, env: {}, io: { log() {} },
      loadBundled: async () => bundle, authorize() { assert.fail('Retaining a verified selection needs no consent') },
      install: (settings) => installManagedNode({ ...settings, run: selected.options.run }) })
    assert.equal(env.PHYSICAL_NODE_EXECUTABLE, installed.executable)
    assert.deepEqual(await fs.readFile(selection), before)
    assert.equal(selected.commands.filter(({ args }) => args.includes('venv')).length, 1)
  }
})

test('damaged selected state blocks update before bundle selection or consent', async (t) => {
  for (const damage of ['manifest', 'launcher']) {
    const item = await upgradeFixture(t)
    if (damage === 'manifest') {
      const root = path.resolve(path.dirname(item.original.executable), '../..')
      await fs.writeFile(path.join(root, 'manifest.json'), '{}')
    } else await fs.unlink(item.original.executable)
    await assert.rejects(item.invoke({ loadBundled() { assert.fail('Damaged selection must not load a replacement') },
      authorize() { assert.fail('Damaged selection must not ask for repair consent') } }))
    assert.equal(item.candidate.commands.some(({ args }) => args.includes('venv')), false)
  }
})

test('configured execution never enters managed update selection', async () => {
  for (const name of ['PHYSICAL_NODE_EXECUTION_CONFIG', 'PHYSICAL_NODE_REGISTRY', 'PHYSICAL_NODE_EXECUTION_MODE']) {
    await assert.rejects(managedNodeEnvironment({ config: {}, env: { [name]: 'configured' },
      loadSelected() { assert.fail('Configured execution must not inspect managed selections') } }), /explicit PHYSICAL_NODE_EXECUTABLE/)
  }
})
