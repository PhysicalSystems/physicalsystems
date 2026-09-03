// Source-only acceptance instrumentation. All installer, supervisor, CLI and
// interactive Harness implementations are loaded from the freshly installed npm
// package; this file is not shipped and never authorizes software installation.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CONTRACT = 'physicalsystems-harness-acceptance-v1'

export function acceptanceEnvironment(environment) {
  // A developer's external host, executor, simulation or selected Python must
  // not turn a fresh-install test into reuse of a different running service.
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(PHYSICAL_|TINYEDGE_PHYSICAL_|PYTHON)/i.test(name)
      && !/^(VIRTUAL_ENV|NODE_OPTIONS)$/i.test(name)))
}

export function acceptanceRecord(release, nodeOrigin = null) {
  assert.ok(release === null || /^[a-f0-9]{64}$/.test(release.digest), 'Acceptance requires an exact bundled manifest digest')
  assert.ok(nodeOrigin === null || (release && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(nodeOrigin)
    && Number(new URL(nodeOrigin).port) <= 65535), 'Acceptance requires the owned loopback origin')
  return { contractVersion: CONTRACT, kind: release ? 'managed' : 'source-only', manifestDigest: release?.digest ?? null, nodeOrigin }
}

export async function createAcceptanceEnvironment(environment) {
  const isolated = acceptanceEnvironment(environment)
  const configDir = isolated.TINYEDGE_CONFIG_DIR
  assert.ok(configDir && path.isAbsolute(configDir), 'Acceptance requires an isolated absolute config directory')
  // Exclusive creation rejects previous installations. Node's default registry
  // lives under XDG_CONFIG_HOME, not execution-data; isolate that as well without
  // changing HOME or reading a real operator registry.
  await fs.mkdir(configDir, { mode: 0o700 })
  isolated.XDG_CONFIG_HOME = path.join(configDir, 'xdg')
  await fs.mkdir(isolated.XDG_CONFIG_HOME, { mode: 0o700 })
  return isolated
}

export async function verifyManagedSupervisor({ environment, release, configDir, startNodeSupervisor,
  selectedNodeRelease, createExecutionClient, createCameraPreviewClient }) {
  const host = await startNodeSupervisor({ env: environment })
  try {
    if (!release) {
      assert.ok(host === null, 'An empty-index source candidate must not acquire an external or simulated Node')
      assert.equal(await selectedNodeRelease(configDir), null, 'A source-only acceptance must not reuse a selected installation')
      return null
    }
    assert.ok(host, 'A bundled release requires a managed Node, not just a rendered Harness')
    assert.equal(environment.PHYSICAL_NODE_EXECUTION_MODE, 'discovery', 'Fresh managed startup must be discovery-only')
    const selected = await selectedNodeRelease(configDir)
    assert.equal(selected?.digest, release.digest, 'Installed selection must match the exact bundled manifest')
    const origin = host.environment.TINYEDGE_PHYSICAL_NODE_URL
    const token = host.environment.PHYSICAL_NODE_EXECUTION_TOKEN
    const cameraToken = host.environment.PHYSICAL_NODE_CAMERA_TOKEN
    assert.ok(token && cameraToken && token !== cameraToken, 'Discovery must use distinct private status and camera credentials')
    const execution = createExecutionClient({ baseUrl: origin, token })
    const status = await execution.status()
    assert.equal(status.mode, null, 'Managed discovery must not configure an executor or simulation')
    assert.deepEqual(status.configurations, [], 'Managed discovery must have no execution configurations')
    assert.equal(status.physicalExecutionAuthorized, false)
    assert.deepEqual((await execution.runs()).runs, [], 'Fresh managed discovery must have no physical runs')
    const camera = await createCameraPreviewClient({ baseUrl: origin, token: cameraToken }).status()
    assert.equal(camera.phase, 'idle', 'Acceptance must never start camera capture')
    assert.equal(camera.captureSessionId, null, 'Acceptance must not own a capture session')
    assert.equal(camera.latestFrameId, null, 'Acceptance must not capture frames')
    assert.equal(camera.physicalExecutionAuthorized, false)
    assert.equal(camera.rawFramePersisted, false)
    return host
  } catch (error) {
    await host?.dispose()
    throw error
  }
}

function emit(stage, record) {
  // Only this fixed non-secret record is written; never log host.environment.
  process.stdout.write(`\nPHYSICAL_SYSTEMS_ACCEPTANCE_${stage} ${JSON.stringify(record)}\n`)
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 1, 'Usage: check-managed-harness.mjs ABSOLUTE_INSTALLED_PACKAGE_ROOT')
  assert.ok(path.isAbsolute(argv[0]), 'Installed package root must be absolute')
  const root = await fs.realpath(argv[0])
  const environment = await createAcceptanceEnvironment(process.env)
  const configDir = environment.TINYEDGE_CONFIG_DIR
  const source = pathToFileURL(path.join(root, 'src') + path.sep)
  const { runCli } = await import(new URL('cli.js', source))
  const { harnessCommand } = await import(new URL('commands/harness.js', source))
  const { createConfig } = await import(new URL('config.js', source))
  const { bundledNodeRelease, selectedNodeRelease } = await import(new URL('physical/node-installation.js', source))
  const { startNodeSupervisor } = await import(new URL('harness/node-supervisor.js', source))
  const { createExecutionClient } = await import(new URL('physical/execution-client.js', source))
  const { createCameraPreviewClient } = await import(new URL('physical/camera-preview-client.js', source))
  const release = await bundledNodeRelease({ env: environment })
  const record = acceptanceRecord(release)
  emit('EXPECTED', record)
  let observed = false
  const code = await runCli([], {
    config: createConfig(environment),
    // Preserve bare CLI dispatch and the real Harness. Its existing seam only
    // observes the real supervisor after the default installer/consent path.
    harnessCommand: (options) => harnessCommand({ ...options, env: environment,
      startNodeSupervisorImpl: async ({ env }) => {
        assert.equal(observed, false, 'Acceptance expects exactly one supervisor startup')
        const host = await verifyManagedSupervisor({ environment: env, release, configDir,
          startNodeSupervisor, selectedNodeRelease, createExecutionClient, createCameraPreviewClient })
        observed = true
        emit('READY', acceptanceRecord(release, host?.environment.TINYEDGE_PHYSICAL_NODE_URL ?? null))
        return host
      },
    }),
  })
  assert.equal(code, 0, 'Bare Harness dispatch must exit cleanly')
  assert.ok(observed, 'Bare Harness dispatch must reach the real supervisor')
  // Pi currently uses process.exit on interactive quit, so this return path is
  // not a shutdown witness. The PTY parent independently checks listener closure
  // after the Harness exits (the Node's owned stdin then receives EOF).
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Do not dump request objects, tokens or the child environment on failure.
    console.error(`Packaged Harness acceptance failed: ${error.message.split('\n')[0]}`)
    process.exitCode = 1
  })
}
