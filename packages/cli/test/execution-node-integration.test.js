import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Optional explicit installed-package target qualifies the actual npm bytes,
// not source lookalikes. This test-only switch is never an application loader.
const installedRoot = process.env.PHYSICAL_EXECUTION_TEST_PACKAGE_ROOT
if (installedRoot && !isAbsolute(installedRoot)) throw new Error('Installed test package path must be absolute')
const source = installedRoot ? pathToFileURL(join(installedRoot, 'src') + '/') : new URL('../src/', import.meta.url)
const { createPhysicalNodeClient } = await import(new URL('physical/node-client.js', source))
const { createExecutionClient } = await import(new URL('physical/execution-client.js', source))
const { createExecutionController } = await import(new URL('harness/execution-controller.js', source))

// Explicit opt-in cross-repository check. The public Harness neither imports
// Node code nor installs Python; the operator supplies the test environment.
const python = process.env.PHYSICAL_EXECUTION_TEST_PYTHON
const nodeSource = process.env.PHYSICAL_EXECUTION_TEST_NODE_SOURCE
const helper = `
import json, os, sys, threading
from tinyedge_agent.physical_execution_fakes import create_simulation_context
from tinyedge_agent.physical_node_api import create_physical_node_server
from tinyedge_agent.physical_run_store import RunStore
from tinyedge_agent.physical_runs import ConfiguredImplementation, PhysicalRunService
store = RunStore(sys.argv[1])
context = create_simulation_context(sys.argv[1])
service = PhysicalRunService(store, context.routes, [ConfiguredImplementation(context.configuration_id, "SIMULATION ONLY", context.provider, context.config)])
server = create_physical_node_server(None, candidate_discovery=context.candidate_discovery, registry=context.registry, routes=context.routes, execution_service=service, execution_token=os.environ["PHYSICAL_NODE_EXECUTION_TOKEN"], port=0)
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
print(json.dumps({"origin": "http://127.0.0.1:" + str(server.server_address[1]), "routeRequest": context.route_request()}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
`

test('opt-in real Node HTTP registry/router/SQLite service completes one explicitly approved simulated invocation', { skip: !python || !nodeSource, timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'physical-execution-http-test-'))
  const token = randomBytes(32).toString('base64url')
  const child = spawn(python, ['-u', '-c', helper, directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: [nodeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter), PHYSICAL_NODE_EXECUTION_TOKEN: token } })
  child.stderr.resume() // No raw host diagnostics or credentials enter test output.
  t.after(async () => {
    child.stdin.end('\n')
    if (child.exitCode === null) {
      try { await once(child, 'exit', { signal: AbortSignal.timeout(10000) }) }
      catch { child.kill(); await once(child, 'exit').catch(() => {}) }
    }
    await rm(directory, { recursive: true, force: true })
  })
  const startup = await new Promise((resolve, reject) => {
    let buffer = ''
    child.once('error', () => reject(new Error('Synthetic Node helper could not start')))
    child.once('exit', () => reject(new Error('Synthetic Node helper ended before ready')))
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) return reject(new Error('Synthetic Node startup exceeded its bound'))
      const newline = buffer.indexOf('\n')
      if (newline !== -1) { try { resolve(JSON.parse(buffer.slice(0, newline))) } catch { reject(new Error('Invalid synthetic Node startup metadata')) } }
    })
  })
  const physical = createPhysicalNodeClient({ baseUrl: startup.origin })
  const catalog = await physical.capabilities()
  assert.equal(catalog.physicalExecutionAuthorized, false)
  const route = await physical.previewCapability(startup.routeRequest)
  assert.equal(route.decision.decision_status, 'selected')
  const client = createExecutionClient({ baseUrl: startup.origin, token })
  const controller = createExecutionController({ client, currentRoute: () => route })
  t.after(() => controller.dispose())
  await controller.refresh()
  assert.equal(controller.snapshot().canPrepare, true)
  const configuration = controller.snapshot().configurations[0]
  await controller.action('prepare', { configurationId: configuration.configurationId, expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest })
  const prepared = controller.snapshot().run
  assert.equal(prepared.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(prepared.mode, 'simulation')
  assert.equal(controller.snapshot().canApprove, true)
  await controller.action('approve', { runId: prepared.runId, expectedRunDigest: prepared.runDigest, approvalDigest: prepared.approval.digest, approved: true })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !['VERIFIED_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN', 'BLOCKED'].includes(controller.snapshot().run.phase)) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    await controller.refresh()
  }
  assert.equal(controller.snapshot().run.phase, 'VERIFIED_SUCCESS')
  assert.equal(controller.snapshot().run.outcome.status, 'VERIFIED_SUCCESS')
  assert.equal(controller.snapshot().run.mode, 'simulation')
  await controller.action('receipt', { runId: prepared.runId })
  assert.equal(controller.snapshot().receipt.runId, prepared.runId)
  assert.equal(controller.snapshot().receipt.configurationSnapshotDigest, configuration.configurationDigest)
  assert.equal(controller.snapshot().receipt.evidenceDigest, controller.snapshot().run.outcome.evidenceDigest)
  assert.equal(controller.snapshot().receipt.preparation.preconditions, 'met')
  assert.equal(controller.snapshot().receipt.verification.verified, 'met')
  assert.equal(controller.snapshot().receipt.verification.mode, 'simulation')
  assert.equal(controller.snapshot().receipt.verification.historical, true)
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
})
