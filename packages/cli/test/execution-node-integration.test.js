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
const { createExecutionInspector } = await import(new URL('harness/execution-inspection.js', source))

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
    for command in sys.stdin:
        if command.strip() != "metrics":
            break
        print(json.dumps({"commands": context.provider.command_count,
            "runs": len(service.list_runs()["runs"]), "mode": context.provider.mode}), flush=True)
finally:
    server.shutdown()
    server.server_close()
    service.close()
`

test('opt-in real Node HTTP registry/router/SQLite service completes one explicitly approved simulated invocation', { skip: !python || !nodeSource, timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'physical-execution-http-test-'))
  const token = randomBytes(32).toString('base64url')
  const child = spawn(python, ['-u', '-c', helper, directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: [nodeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PHYSICAL_NODE_EXECUTION_TOKEN: token } })
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
    const onData = (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) return reject(new Error('Synthetic Node startup exceeded its bound'))
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        child.stdout.off('data', onData)
        try { resolve(JSON.parse(buffer.slice(0, newline))) } catch { reject(new Error('Invalid synthetic Node startup metadata')) }
      }
    }
    child.stdout.on('data', onData)
  })
  // Read the fake's command counter independently of HTTP receipts. This
  // control channel exists only in the isolated simulation helper above.
  const metrics = async () => {
    const response = new Promise((resolve, reject) => {
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString()
        if (buffer.length > 1024) {
          child.stdout.off('data', onData)
          reject(new Error('Synthetic Node metrics exceeded their bound'))
        } else if (buffer.includes('\n')) {
          child.stdout.off('data', onData)
          try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) }
          catch { reject(new Error('Invalid synthetic Node metrics')) }
        }
      }
      child.stdout.on('data', onData)
    })
    child.stdin.write('metrics\n')
    return response
  }
  const physical = createPhysicalNodeClient({ baseUrl: startup.origin })
  const catalog = await physical.capabilities()
  assert.equal(catalog.physicalExecutionAuthorized, false)
  const route = await physical.previewCapability(startup.routeRequest)
  assert.equal(route.decision.decision_status, 'selected')
  const httpCalls = [], readCalls = []
  const client = createExecutionClient({ baseUrl: startup.origin, token,
    fetchImpl(url, options) {
      // Record only method/path: no credentials or request bodies in evidence.
      httpCalls.push({ method: options.method, path: new URL(url).pathname })
      return fetch(url, options)
    } })
  let currentRoute = route, generation = 0, assistantBusy = false, selectedInBrowser = true
  const controller = createExecutionController({ client, currentRoute: () => currentRoute, canPrepare: () => !assistantBusy })
  const readOnlyClient = Object.freeze(Object.fromEntries(['status', 'runs', 'run', 'receipt', 'snapshot'].map((method) =>
    [method, (...args) => { readCalls.push({ method, identity: args[0] ?? null }); return client[method](...args) }])))
  const inspector = createExecutionInspector({ client: readOnlyClient,
    getContext: () => ({ generation, route: currentRoute, selectedRun: selectedInBrowser ? controller.snapshot().run : null }) })
  t.after(() => inspector.dispose())
  t.after(() => controller.dispose())
  const inspectWithoutDispatch = async (args, expectedMetrics) => {
    const firstHttp = httpCalls.length, firstRead = readCalls.length
    const result = await inspector.inspect(args)
    const requests = httpCalls.slice(firstHttp)
    assert.ok(requests.length >= 2)
    assert.ok(requests.every(({ method }) => method === 'GET'), 'inspection must not issue an execution action')
    assert.ok(readCalls.slice(firstRead).some(({ method }) => method === 'status'))
    assert.ok(readCalls.slice(firstRead).some(({ method }) => method === 'runs'))
    assert.deepEqual(await metrics(), expectedMetrics, 'inspection must not create a run or dispatch a simulated command')
    assert.equal(result.physicalExecutionAuthorized, false)
    return result
  }
  await controller.refresh()
  assert.equal(controller.snapshot().canPrepare, true)
  const configuration = controller.snapshot().configurations[0]
  assistantBusy = true
  assert.equal(controller.snapshot().canPrepare, false)
  const availability = await inspectWithoutDispatch({}, { commands: 0, runs: 0, mode: 'simulation' })
  assert.equal(availability.inspection.status, 'available')
  assert.equal(availability.service.mode, 'simulation')
  assert.equal(availability.configurationAvailability.status, 'matching')
  assert.equal(availability.configurationAvailability.matchingConfigurations[0].configurationId, configuration.configurationId)
  assert.equal(availability.configurationAvailability.matchingConfigurations[0].configurationDigest, configuration.configurationDigest)
  assert.equal(availability.selectedRun, null)
  assert.equal(availability.receipt.status, 'not_requested')
  assistantBusy = false
  await controller.action('prepare', { configurationId: configuration.configurationId, expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest })
  const prepared = controller.snapshot().run
  assert.equal(prepared.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(prepared.mode, 'simulation')
  assert.equal(controller.snapshot().canApprove, true)
  const preparation = await inspectWithoutDispatch({}, { commands: 0, runs: 1, mode: 'simulation' })
  assert.equal(preparation.inspection.status, 'available', JSON.stringify(preparation.inspection))
  assert.equal(preparation.selectedRun.runId, prepared.runId)
  assert.equal(preparation.selectedRun.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(preparation.selectedRun.mode, 'simulation')
  assert.equal(preparation.selectedRun.outcomeStatus, null)
  assert.equal(controller.snapshot().run.approval.approvedAt, null)
  assert.equal(httpCalls.filter(({ method }) => method === 'POST').length, 1)
  await controller.action('approve', { runId: prepared.runId, expectedRunDigest: prepared.runDigest, approvalDigest: prepared.approval.digest, approved: true })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !['VERIFIED_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN', 'BLOCKED'].includes(controller.snapshot().run.phase)) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    await controller.refresh()
  }
  assert.equal(controller.snapshot().run.phase, 'VERIFIED_SUCCESS')
  assert.equal(controller.snapshot().run.outcome.status, 'VERIFIED_SUCCESS')
  assert.equal(controller.snapshot().run.mode, 'simulation')
  const completed = controller.snapshot().run
  const success = await inspectWithoutDispatch({ runId: prepared.runId }, { commands: 3, runs: 1, mode: 'simulation' })
  assert.equal(success.inspection.status, 'available')
  assert.equal(success.selectedRun.runId, prepared.runId)
  assert.equal(success.selectedRun.phase, 'VERIFIED_SUCCESS')
  assert.equal(success.selectedRun.mode, 'simulation')
  assert.equal(success.selectedRun.outcomeStatus, 'VERIFIED_SUCCESS')
  assert.equal(success.selectedRun.routeRelationship, 'current')
  assert.equal(success.selectedRun.currentConfiguration, 'exact')
  assert.equal(success.receipt.status, 'verified')
  assert.equal(success.receipt.runId, prepared.runId)
  assert.equal(success.receipt.runDigest, completed.runDigest)
  assert.equal(success.receipt.snapshotDigest, completed.snapshotDigest)
  assert.equal(success.receipt.configurationSnapshotDigest, configuration.configurationDigest)
  assert.equal(success.receipt.evidenceDigest, completed.outcome.evidenceDigest)
  assert.equal(success.receipt.preparation.preconditions, 'met')
  assert.equal(success.receipt.verification.verified, 'met')
  assert.equal(success.receipt.verification.mode, 'simulation')
  assert.equal(success.receipt.historical, true)
  assert.equal(success.receipt.verification.historical, true)
  for (const digest of [configuration.configurationDigest, completed.outcome.evidenceDigest]) {
    assert.ok(readCalls.some(({ method, identity }) => method === 'snapshot' && identity === digest))
  }
  await controller.action('receipt', { runId: prepared.runId })
  assert.equal(controller.snapshot().receipt.runId, prepared.runId)
  assert.equal(controller.snapshot().receipt.configurationSnapshotDigest, configuration.configurationDigest)
  assert.equal(controller.snapshot().receipt.evidenceDigest, controller.snapshot().run.outcome.evidenceDigest)
  assert.equal(controller.snapshot().receipt.preparation.preconditions, 'met')
  assert.equal(controller.snapshot().receipt.verification.verified, 'met')
  assert.equal(controller.snapshot().receipt.verification.mode, 'simulation')
  assert.equal(controller.snapshot().receipt.verification.historical, true)
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)

  // A follow-up conversation turn retires route context. The exact advertised
  // run remains inspectable as historical evidence without preparing/rerouting.
  currentRoute = null; selectedInBrowser = false; generation += 1
  controller.contextChanged()
  const historical = await inspectWithoutDispatch({ runId: prepared.runId }, { commands: 3, runs: 1, mode: 'simulation' })
  assert.equal(historical.inspection.status, 'available')
  assert.equal(historical.configurationAvailability.status, 'missing_route')
  assert.equal(historical.selectedRun.runId, prepared.runId)
  assert.equal(historical.selectedRun.phase, 'VERIFIED_SUCCESS')
  assert.equal(historical.selectedRun.routeRelationship, 'no_route')
  assert.equal(historical.receipt.status, 'verified')
  assert.equal(historical.receipt.runDigest, completed.runDigest)
  assert.equal(historical.receipt.historical, true)
  assert.equal(controller.snapshot().canPrepare, false)
  assert.deepEqual(httpCalls.filter(({ method }) => method === 'POST').map(({ path }) => path),
    ['/v2/physical/execution/runs:prepare', `/v2/physical/execution/runs/${prepared.runId}:approve`])
  t.diagnostic(`Read-only inspection passed before preparation, while awaiting approval, after success and after route retirement; ${readCalls.length} GET facade calls, 1 simulated invocation, 3 simulated commands, 0 inspection actions.`)
})
