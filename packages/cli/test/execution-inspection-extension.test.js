import assert from 'node:assert/strict'
import test from 'node:test'
import { createTinyEdgePiExtension } from '../src/pi-extension.js'
import { status, route } from './fixtures/execution.js'

const toolName = 'inspect_physical_execution'
function setup(t, options = {}) {
  const pi = { tools: new Map(), commands: new Map(), handlers: new Map(), activeTools: [],
    registerTool(tool) { this.tools.set(tool.name, tool) }, registerCommand(name, value) { this.commands.set(name, value) },
    on(name, value) { this.handlers.set(name, value) }, getActiveTools() { return this.activeTools }, setActiveTools(value) { this.activeTools = value } }
  const calls = { clients: 0, cameras: 0, servers: 0, methods: [] }
  const read = name => async () => { calls.methods.push(name); return name === 'status' ? status : { contractVersion: 'physicalsystems-run-list-v1', runs: [], physicalExecutionAuthorized: false } }
  const client = { status: read('status'), runs: read('runs'),
    run() { throw Error('No run exists') }, receipt() { throw Error('No receipt exists') }, snapshot() { throw Error('No snapshot exists') },
    prepare() { assert.fail('A model read cannot prepare') }, approve() { assert.fail('A model read cannot approve') },
    stop() { assert.fail('A model read cannot stop') }, reconcile() { assert.fail('A model read cannot reconcile') } }
  let host
  createTinyEdgePiExtension({ standalone: true, env: {},
    createPhysicalNodeClientImpl: () => ({ origin: 'http://127.0.0.1:8876', async inspect() { throw Error('No physical discovery requested') }, async previewCapability() { return route } }),
    createExecutionClientImpl: () => { calls.clients++; return client },
    createCameraPreviewClientImpl: () => { calls.cameras++; return undefined },
    createWorkcellServerImpl: async ({ host: value }) => { calls.servers++; host = value; return { openUrl: 'http://127.0.0.1:19000/#synthetic-test-only', async close() {} } },
    openWorkcellBrowser: async () => {}, ...options,
  })(pi)
  const ctx = { mode: 'tui', model: { provider: 'test', id: 'test' }, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify() {}, setWidget() {}, setHeader() {} } }
  t.after(() => pi.handlers.get('session_shutdown')?.())
  return { pi, ctx, calls, client, host: () => host,
    async inspect(args = {}) { assert.ok(pi.tools.has(toolName), 'Harness needs a read-only execution inspection tool'); return JSON.parse((await pi.tools.get(toolName).execute('inspect', args)).content[0].text) } }
}

test('assistant can inspect execution before opening the browser without creating a camera or action authority', async t => {
  const h = setup(t)
  assert.equal(h.calls.clients, 0, 'host client is lazy until read or browser use')
  assert.equal(h.calls.servers, 0)
  const value = await h.inspect()
  assert.equal(value.service.mode, 'simulation')
  assert.equal(value.service.availability, 'available')
  assert.equal(value.physicalExecutionAuthorized, false)
  assert.equal(h.calls.clients, 1)
  assert.equal(h.calls.cameras, 0)
  assert.equal(h.calls.servers, 0)
  assert.ok(h.calls.methods.every(name => ['status', 'runs'].includes(name)))
  assert.equal(h.pi.handlers.get('tool_call')({ toolName }), undefined)
  for (const name of ['prepare_physical_run', 'approve_physical_run', 'execute_physical_capability', 'stop_physical_run', 'reconcile_physical_run', 'bash', 'read']) {
    assert.equal(h.pi.tools.has(name), false)
    assert.equal(h.pi.handlers.get('tool_call')({ toolName: name }).block, true)
  }
})

test('read-only inspection and operator browser reuse one host execution client', async t => {
  const h = setup(t)
  await h.inspect()
  await h.pi.commands.get('workcell').handler('', h.ctx)
  await h.inspect()
  assert.equal(h.calls.clients, 1)
  assert.equal(h.calls.servers, 1)
  assert.equal(h.calls.cameras, 1, 'only explicit browser creation constructs its inert preview client')
  assert.equal(h.host().snapshot().physicalExecutionAuthorized, false)
})

test('inspection is absent from the cloud extension and never loads execution credentials there', async t => {
  const h = setup(t, { standalone: false, cloudEnabled: false })
  assert.equal(h.pi.tools.has(toolName), false)
  assert.equal(h.calls.clients, 0)
})

test('unknown model arguments cannot invoke execution or expose a private error', async t => {
  const h = setup(t)
  assert.ok(h.pi.tools.has(toolName))
  const result = await h.inspect({ runId: 'run-' + 'f'.repeat(32), approved: true, token: 'not-an-accepted-field' })
  assert.equal(result.inspection.status, 'invalid_request')
  assert.equal(result.selectedRun, null)
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.equal(JSON.stringify(result).includes('not-an-accepted-field'), false)
  assert.equal(h.calls.methods.length, 0)
})

test('session shutdown retires the inspection reader without mutating runs', async t => {
  const h = setup(t)
  await h.inspect()
  await h.pi.handlers.get('session_shutdown')()
  const count = h.calls.methods.length
  const result = await h.inspect()
  assert.equal(result.inspection.status, 'disposed')
  assert.equal(h.calls.methods.length, count)
})
