import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const python = process.env.PHYSICAL_EXECUTION_TEST_PYTHON
const executable = process.env.PHYSICAL_EXECUTION_TEST_NODE_EXECUTABLE
const nodeSource = process.env.PHYSICAL_EXECUTION_TEST_NODE_SOURCE
const installedRoot = process.env.PHYSICAL_EXECUTION_TEST_PACKAGE_ROOT
if (installedRoot && !isAbsolute(installedRoot)) throw new Error('Installed test package path must be absolute')
const source = installedRoot ? pathToFileURL(join(installedRoot, 'src') + '/') : new URL('../src/', import.meta.url)
const { startNodeSupervisor } = await import(new URL('harness/node-supervisor.js', source))
const { createExecutionClient } = await import(new URL('physical/execution-client.js', source))

test('opt-in real Node stdio simulation starts with private ownership and shuts down without any run', {
  skip: !python || (!executable && !nodeSource), timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'physical-supervised-http-test-'))
  const env = { ...process.env, PHYSICAL_NODE_EXECUTABLE: executable || python, PHYSICAL_NODE_EXECUTION_MODE: 'simulation', PHYSICAL_NODE_EXECUTION_DATA: directory }
  delete env.PHYSICAL_NODE_EXECUTION_CONFIG; delete env.PHYSICAL_NODE_REGISTRY; delete env.PHYSICAL_NODE_CAMERA_TOKEN
  if (nodeSource) env.PYTHONPATH = [nodeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
  else delete env.PYTHONPATH
  let host
  try {
    host = await startNodeSupervisor({ env, ...(executable ? {} : { spawnImpl: (command, args, options) => spawn(command, ['-m', 'tinyedge_agent', ...args], options) }) })
    const client = createExecutionClient({ baseUrl: host.environment.TINYEDGE_PHYSICAL_NODE_URL, token: host.environment.PHYSICAL_NODE_EXECUTION_TOKEN })
    assert.equal((await client.status()).mode, 'simulation')
    assert.deepEqual((await client.runs()).runs, [])
    const origin = host.environment.TINYEDGE_PHYSICAL_NODE_URL
    await host.dispose()
    await assert.rejects(fetch(`${origin}/v2/physical/execution/status`, { signal: AbortSignal.timeout(1000) }))
  } finally {
    await host?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
