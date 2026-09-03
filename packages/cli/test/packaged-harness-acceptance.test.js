import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { acceptanceEnvironment, acceptanceRecord, createAcceptanceEnvironment, verifyManagedSupervisor } from '../scripts/check-managed-harness.mjs'

// Synthetic protocol fixtures only: no subprocess Node, installer, network or
// camera is opened by these tests. Real-byte acceptance is a separate PTY job.
const release = { digest: 'a'.repeat(64) }

function fixture({ mode = null, configurations = [], runs = [], camera = {}, selected = release, host = true,
  configuredMode = 'discovery' } = {}) {
  const calls = []
  const hostEnvironment = { TINYEDGE_PHYSICAL_NODE_URL: 'http://127.0.0.1:40123',
    PHYSICAL_NODE_EXECUTION_TOKEN: 'e'.repeat(48), PHYSICAL_NODE_CAMERA_TOKEN: 'c'.repeat(48) }
  const options = {
    release, configDir: '/isolated-test-config', environment: { PHYSICAL_NODE_EXECUTION_MODE: configuredMode },
    startNodeSupervisor: async ({ env }) => {
      calls.push(['start', env])
      return host ? { environment: hostEnvironment, dispose: async () => { calls.push(['dispose']) } } : null
    },
    selectedNodeRelease: async () => selected,
    createExecutionClient: (options) => {
      calls.push(['execution', options])
      return { status: async () => ({ mode, configurations, physicalExecutionAuthorized: false }), runs: async () => ({ runs }) }
    },
    createCameraPreviewClient: (options) => {
      calls.push(['camera', options])
      return { status: async () => ({ phase: 'idle', captureSessionId: null, latestFrameId: null,
        physicalExecutionAuthorized: false, rawFramePersisted: false, ...camera }) }
    },
  }
  return { options, calls, hostEnvironment }
}

test('acceptance isolates host/config/simulation and Python overrides without mutating caller env', () => {
  const env = { PATH: '/bin', TINYEDGE_CONFIG_DIR: '/fresh', PHYSICAL_NODE_EXECUTABLE: '/other',
    physical_node_execution_mode: 'simulation', PHYSICAL_NODE_EXECUTION_CONFIG: '/physical',
    PHYSICAL_NODE_EXECUTION_TOKEN: 'secret', TINYEDGE_PHYSICAL_NODE_URL: 'http://127.0.0.1:9999',
    PYTHONPATH: '/source', PythonHome: '/elsewhere', VIRTUAL_ENV: '/venv', NODE_OPTIONS: '--import=untrusted' }
  const before = structuredClone(env)
  assert.deepEqual(acceptanceEnvironment(env), { PATH: '/bin', TINYEDGE_CONFIG_DIR: '/fresh' })
  assert.deepEqual(env, before)
})

test('acceptance markers distinguish empty index from a pinned managed release without credentials', () => {
  assert.deepEqual(acceptanceRecord(null), { contractVersion: 'physicalsystems-harness-acceptance-v1', kind: 'source-only', manifestDigest: null, nodeOrigin: null })
  assert.equal(acceptanceRecord(release).kind, 'managed')
  assert.equal(acceptanceRecord(release).manifestDigest, release.digest)
  assert.throws(() => acceptanceRecord({ digest: 'not-a-digest' }))
  assert.equal(acceptanceRecord(release, 'http://127.0.0.1:40123').nodeOrigin, 'http://127.0.0.1:40123')
  for (const origin of ['https://elsewhere.test', 'http://localhost:40123', 'http://127.0.0.1:65536', 'http://secret@127.0.0.1:40123', 'http://127.0.0.1:40123/path']) {
    assert.throws(() => acceptanceRecord(release, origin))
  }
  assert.throws(() => acceptanceRecord(null, 'http://127.0.0.1:40123'))
})

test('fresh acceptance isolates the default Node registry and rejects an existing config directory', async (t) => {
  const base = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'ps-acceptance-'))
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    assert.ok(path.basename(root).startsWith('ps-acceptance-'))
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
    await fs.rm(root, { recursive: true, force: true })
  })
  const configDir = path.join(root, 'fresh')
  const original = { TINYEDGE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: '/operator-registry', HOME: '/operator-home' }
  const isolated = await createAcceptanceEnvironment(original)
  assert.equal(isolated.XDG_CONFIG_HOME, path.join(configDir, 'xdg'))
  assert.deepEqual(await fs.readdir(isolated.XDG_CONFIG_HOME), [])
  assert.equal(isolated.HOME, original.HOME)
  assert.equal(original.XDG_CONFIG_HOME, '/operator-registry')
  await assert.rejects(createAcceptanceEnvironment(original), { code: 'EEXIST' })
  await assert.rejects(createAcceptanceEnvironment({ TINYEDGE_CONFIG_DIR: 'relative' }), /isolated absolute/)
})

test('managed acceptance observes discovery, independent idle camera status and preserves owned disposal', async () => {
  const { options, calls, hostEnvironment } = fixture()
  const host = await verifyManagedSupervisor(options)
  assert.equal(host.environment, hostEnvironment)
  assert.equal(calls.find(([kind]) => kind === 'execution')[1].token, hostEnvironment.PHYSICAL_NODE_EXECUTION_TOKEN)
  assert.equal(calls.find(([kind]) => kind === 'camera')[1].token, hostEnvironment.PHYSICAL_NODE_CAMERA_TOKEN)
  await host.dispose()
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'execution', 'camera', 'dispose'])
})

for (const [name, change, reason] of [
  ['missing managed host', { host: false }, /requires a managed Node/],
  ['wrong selected manifest', { selected: { digest: 'b'.repeat(64) } }, /exact bundled manifest/],
  ['simulation supervisor', { configuredMode: 'simulation' }, /discovery-only/],
  ['physical execution status', { mode: 'physical' }, /must not configure/],
  ['configured executor', { configurations: [{}] }, /no execution configurations/],
  ['existing run', { runs: [{}] }, /no physical runs/],
  ['capturing camera', { camera: { phase: 'capturing' } }, /never start camera/],
  ['capture session', { camera: { captureSessionId: 'session' } }, /capture session/],
  ['captured frame', { camera: { latestFrameId: 'frame' } }, /capture frames/],
]) {
  test(`managed acceptance rejects ${name} and cleans up its owned host`, async () => {
    const { options, calls } = fixture(change)
    await assert.rejects(verifyManagedSupervisor(options), reason)
    assert.equal(calls.filter(([kind]) => kind === 'dispose').length, change.host === false ? 0 : 1)
  })
}

test('empty-index candidate observes null supervisor and does not claim managed readiness', async () => {
  const { options, calls } = fixture({ host: false, selected: null })
  assert.equal(await verifyManagedSupervisor({ ...options, release: null }), null)
  assert.deepEqual(calls.map(([kind]) => kind), ['start'])
  await assert.rejects(verifyManagedSupervisor({ ...fixture().options, release: null }), /must not acquire/)
  await assert.rejects(verifyManagedSupervisor({ ...fixture({ host: false }).options, release: null }), /must not reuse/)
})

test('Linux PTY transcript consent/readiness regressions (no actual PTY or hardware)', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync('python3', ['-I', '-B', fileURLToPath(new URL('./test_packaged_harness_transcript.py', import.meta.url))], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
