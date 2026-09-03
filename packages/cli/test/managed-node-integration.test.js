import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Explicit opt-in uses an already installed, hash-selected Node. It never
// downloads packages, opens a camera, configures an executor or dispatches work.
const configDir = process.env.PHYSICAL_MANAGED_TEST_CONFIG
const installedRoot = process.env.PHYSICAL_EXECUTION_TEST_PACKAGE_ROOT
if (configDir && !isAbsolute(configDir)) throw new Error('Managed test config must be absolute')
if (installedRoot && !isAbsolute(installedRoot)) throw new Error('Installed package root must be absolute')
const source = installedRoot ? pathToFileURL(join(installedRoot, 'src') + '/') : new URL('../src/', import.meta.url)
const { managedNodeEnvironment } = await import(new URL('commands/setup-node.js', source))
const { startNodeSupervisor } = await import(new URL('harness/node-supervisor.js', source))
const { createExecutionClient } = await import(new URL('physical/execution-client.js', source))
const { createCameraPreviewClient } = await import(new URL('physical/camera-preview-client.js', source))

test('installed managed Node reuses its verified environment, discovers without execution and leaves camera idle', {
  skip: !configDir, timeout: 60000,
}, async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^PHYSICAL_NODE_/i.test(key) && key.toUpperCase() !== 'TINYEDGE_PHYSICAL_NODE_URL'))
  env.PYTHONPATH = join(configDir, 'untrusted-developer-source')
  const managed = await managedNodeEnvironment({ config: { configDir }, env,
    authorize() { assert.fail('existing selection must not require installing anything') } })
  assert.equal(managed.PYTHONPATH, undefined)
  assert.equal(managed.PHYSICAL_NODE_EXECUTION_MODE, 'discovery')
  let host
  try {
    host = await startNodeSupervisor({ env: managed })
    const origin = host.environment.TINYEDGE_PHYSICAL_NODE_URL
    const token = host.environment.PHYSICAL_NODE_EXECUTION_TOKEN
    const cameraToken = host.environment.PHYSICAL_NODE_CAMERA_TOKEN
    assert.notEqual(token, cameraToken)
    const execution = createExecutionClient({ baseUrl: origin, token })
    assert.equal((await execution.status()).mode, null)
    assert.deepEqual((await execution.runs()).runs, [])
    const camera = createCameraPreviewClient({ baseUrl: origin, token: cameraToken })
    const status = await camera.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.captureSessionId, null)
    assert.equal(status.latestFrameId, null)
    assert.equal(status.physicalExecutionAuthorized, false)
    assert.equal(status.rawFramePersisted, false)
    await host.dispose()
    await assert.rejects(fetch(`${origin}/v2/physical/execution/status`, { signal: AbortSignal.timeout(1000) }))
  } finally { await host?.dispose() }
})
