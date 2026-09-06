import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createTinyEdgePiExtension } from '../src/pi-extension.js'
import { normalizePhysicalCapabilityCatalog, normalizePhysicalRouteReceipt } from '../src/physical/route-contracts.js'
import { status } from './fixtures/execution.js'

const toolName = 'inspect_physical_setup'
const routeFixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url), 'utf8'))
function setup(t, options = {}) {
  const pi = { tools: new Map(), commands: new Map(), handlers: new Map(), activeTools: [],
    registerTool(tool) { this.tools.set(tool.name, tool) }, registerCommand(name, value) { this.commands.set(name, value) },
    on(name, value) { this.handlers.set(name, value) }, getActiveTools() { return this.activeTools }, setActiveTools(value) { this.activeTools = value } }
  const calls = { clients: 0, cameras: 0, servers: 0, status: 0, routes: 0, discoveries: 0 }
  const forbidden = () => assert.fail('Setup inspection cannot invoke an execution action or read run history')
  const client = { async status() { calls.status++; return status },
    runs: forbidden, run: forbidden, receipt: forbidden, snapshot: forbidden,
    prepare: forbidden, approve: forbidden, stop: forbidden, reconcile: forbidden }
  const notices = []
  const physicalClient = { origin: 'http://127.0.0.1:8876',
    inspect() { calls.discoveries++; assert.fail('Setup inspection must not refresh discovery') },
    async capabilities() { return normalizePhysicalCapabilityCatalog(routeFixture.catalog) },
    async previewCapability() { calls.routes++; return normalizePhysicalRouteReceipt(routeFixture.selected) } }
  createTinyEdgePiExtension({ standalone: true, env: {},
    createPhysicalNodeClientImpl: () => physicalClient,
    createExecutionClientImpl: () => { calls.clients++; return client },
    createCameraPreviewClientImpl: () => { calls.cameras++; assert.fail('Setup inspection cannot construct camera access') },
    createWorkcellServerImpl: () => { calls.servers++; assert.fail('Setup inspection cannot create a browser server') },
    ...options,
  })(pi)
  const ctx = { mode: 'tui', model: { provider: 'test', id: 'test' }, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify(message, level) { notices.push({ message, level }) }, setWidget() {}, setHeader() {} } }
  t.after(() => pi.handlers.get('session_shutdown')?.())
  return { pi, ctx, calls, client, physicalClient, notices,
    async inspect(args = {}, signal) {
      assert.ok(pi.tools.has(toolName), 'Harness needs a read-only setup inspection tool')
      return JSON.parse((await pi.tools.get(toolName).execute('setup', args, signal)).content[0].text)
    } }
}

async function propose(h) {
  const { contractVersion: _version, ...params } = routeFixture.request
  await h.pi.tools.get('inspect_physical_capabilities').execute('catalog', {})
  await h.pi.tools.get('preview_physical_capability').execute('route', params)
}

test('terminal and browser followups retain only historical setup evidence while execution eligibility is retired', async t => {
  let host
  const h = setup(t, { createCameraPreviewClientImpl: () => undefined,
    createWorkcellServerImpl: async ({ host: value }) => { host = value; return { openUrl: 'http://127.0.0.1:19000/#synthetic', async close() {} } },
    openWorkcellBrowser: async () => {}, submitWorkcellIntent: () => {}, canSubmitWorkcellIntent: () => true })
  await propose(h)
  const initial = await h.inspect()
  assert.equal(initial.implementations.length, 2)
  await h.pi.commands.get('workcell').handler('', h.ctx)
  h.pi.handlers.get('before_agent_start')({ prompt: 'What is missing for this proposal?' }, h.ctx)
  let result = await h.inspect()
  assert.equal(result.sources.route.receiptDigest, initial.sources.route.receiptDigest)
  assert.equal(result.sources.route.relationship, 'retired')
  assert.deepEqual(result.implementations, initial.implementations)
  assert.equal(host.snapshot().workflow.routeReceipt, null)
  assert.equal(host.snapshot().execution.canPrepare, false)
  assert.equal(result.physicalExecutionAuthorized, false)
  h.pi.handlers.get('agent_settled')()
  await host.submitIntent('Explain those setup gaps again.')
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain those setup gaps again.' }, h.ctx)
  result = await h.inspect()
  assert.equal(result.sources.route.relationship, 'retired')
  assert.equal(result.implementations.length, 2)
  assert.equal(host.snapshot().workflow.routeReceipt, null)
  assert.equal(host.snapshot().execution.canPrepare, false)
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  assert.match(h.notices.at(-1).message, /retired/)
  assert.equal(h.calls.routes, 1)
  assert.equal(h.calls.discoveries, 0)
})

test('refresh errors and a new Harness session clear retired setup evidence', async t => {
  const h = setup(t)
  await propose(h)
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  assert.equal((await h.inspect()).implementations.length, 2)
  h.physicalClient.inspect = async () => { throw Error('synthetic discovery failure') }
  await assert.rejects(h.pi.tools.get('inspect_physical_system').execute('refresh', {}), /synthetic discovery failure/)
  let result = await h.inspect()
  assert.equal(result.implementations.length, 0)
  assert.equal(result.sources.route.receiptDigest, null)
  await propose(h)
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  await h.pi.handlers.get('session_start')({}, h.ctx)
  result = await h.inspect()
  assert.equal(result.implementations.length, 0)
  assert.equal(result.sources.route.receiptDigest, null)
})

test('conversation reset makes an in-flight setup read stale before a later retired-context read', async t => {
  const h = setup(t)
  await propose(h)
  let settle
  h.client.status = () => new Promise(resolve => { settle = resolve })
  const pending = h.inspect()
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  settle(status)
  const result = await pending
  assert.equal(result.inspection.status, 'stale')
  assert.equal(result.implementations.length, 0)
  h.client.status = async () => status
  assert.equal((await h.inspect()).sources.route.relationship, 'retired')
})

test('simulated camera invalidation clears retained setup instead of treating it as another conversation', async t => {
  let host
  const h = setup(t, { createCameraPreviewClientImpl: () => ({ async start() { throw Error('synthetic camera unavailable') } }),
    createWorkcellServerImpl: async ({ host: value }) => { host = value; return { openUrl: 'http://127.0.0.1:19000/#synthetic', async close() {} } },
    openWorkcellBrowser: async () => {} })
  await propose(h)
  await h.pi.commands.get('workcell').handler('', h.ctx)
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  assert.equal((await h.inspect()).implementations.length, 2)
  h.pi.handlers.get('agent_settled')()
  await assert.rejects(host.cameraAction('start', {}), /not confirmed/)
  const result = await h.inspect()
  assert.equal(result.implementations.length, 0)
  assert.equal(result.sources.route.relationship, 'none')
  assert.equal(host.snapshot().workflow.routeReceipt, null)
  assert.equal(host.snapshot().execution.canPrepare, false)
})

test('new catalog and failed new route requests replace retired proposal evidence', async t => {
  const h = setup(t)
  await propose(h)
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  await h.pi.tools.get('inspect_physical_capabilities').execute('new-catalog', {})
  assert.equal((await h.inspect()).implementations.length, 0)
  await propose(h)
  h.pi.handlers.get('before_agent_start')({ prompt: 'Explain setup.' }, h.ctx)
  h.physicalClient.previewCapability = async () => { throw Error('synthetic route rejected') }
  const { contractVersion: _version, ...params } = routeFixture.request
  await assert.rejects(h.pi.tools.get('preview_physical_capability').execute('new-route', params), /synthetic route rejected/)
  const result = await h.inspect()
  assert.equal(result.implementations.length, 0)
  assert.equal(result.sources.route.receiptDigest, null)
})

test('setup tool is standalone, lazy, status-only and cannot gain execution or camera authority', async t => {
  const h = setup(t)
  assert.equal(h.calls.clients, 0)
  const value = await h.inspect()
  assert.equal(value.physicalExecutionAuthorized, false)
  assert.equal(h.calls.clients, 1)
  assert.equal(h.calls.status, 1)
  assert.equal(h.calls.discoveries, 0)
  assert.equal(h.calls.routes, 0)
  assert.equal(h.calls.cameras, 0)
  assert.equal(h.calls.servers, 0)
  assert.equal(h.pi.handlers.get('tool_call')({ toolName }), undefined)
  assert.deepEqual(h.pi.tools.get(toolName).parameters, { type: 'object', additionalProperties: false, properties: {} })
  for (const name of ['prepare_physical_run', 'approve_physical_run', 'execute_physical_capability', 'stop_physical_run', 'commission_physical_device', 'bash', 'read']) {
    assert.equal(h.pi.tools.has(name), false)
    assert.equal(h.pi.handlers.get('tool_call')({ toolName: name }).block, true)
  }
})

test('setup tool description distinguishes missing evidence and digest scopes for the model', t => {
  const h = setup(t)
  const description = h.pi.tools.get(toolName).description
  assert.match(description, /Not exposed, unverified or unavailable does not mean absent or missing/)
  assert.match(description, /explicit missing status or missing reason code/)
  assert.match(description, /routing envelope.*executable artifact.*different scopes need not match/)
  assert.match(description, /Node enforces exact bindings/)
  assert.equal(h.calls.clients, 0)
})

test('physical-setup reports cached context without discovery, routing or browser startup', async t => {
  const h = setup(t)
  assert.ok(h.pi.commands.has('physical-setup'), 'Operator needs an explicit read-only setup report')
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  assert.equal(h.calls.status, 1)
  assert.equal(h.calls.discoveries, 0)
  assert.equal(h.calls.routes, 0)
  assert.equal(h.calls.cameras, 0)
  assert.equal(h.calls.servers, 0)
  assert.match(h.notices.at(-1).message, /setup/i)
  assert.match(h.notices.at(-1).message, /unverified|not inspected/i)
  assert.doesNotMatch(h.notices.at(-1).message, /Physical execution is ready|all requirements passed/i)
})

test('setup command and model reader preserve a selected route and reuse the same host status client', async t => {
  const h = setup(t)
  const { contractVersion: _version, ...params } = routeFixture.request
  await h.pi.tools.get('preview_physical_capability').execute('route', params)
  const before = await h.inspect()
  assert.equal(before.sources.route.receiptDigest, routeFixture.selected.receiptDigest)
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  for (const candidate of routeFixture.selected.decision.candidates) {
    assert.ok(h.notices.at(-1).message.includes(candidate.implementation_id))
    for (const code of candidate.rejection_codes) assert.ok(h.notices.at(-1).message.includes(code), code)
  }
  assert.ok(h.notices.at(-1).message.includes(routeFixture.selected.observedAt))
  assert.ok(h.notices.at(-1).message.includes(routeFixture.selected.evaluatedAt))
  assert.match(h.notices.at(-1).message, /seconds before report/)
  const after = await h.inspect()
  assert.deepEqual(after.sources.route, before.sources.route)
  assert.equal(h.calls.clients, 1)
  assert.equal(h.calls.status, 3)
  assert.equal(h.calls.routes, 1, 'reporting cannot route or invalidate the previous route')
  assert.equal(h.calls.discoveries, 0)
  assert.equal(h.calls.servers, 0)
})

test('setup command rejects arguments before reading and tool independently rejects schema expansion', async t => {
  const h = setup(t)
  assert.ok(h.pi.commands.has('physical-setup'))
  await h.pi.commands.get('physical-setup').handler('--commission', h.ctx)
  assert.deepEqual(h.notices.at(-1), { message: 'Usage: /physical-setup', level: 'warning' })
  const result = await h.inspect({ path: '/private/test-fixture', approve: true })
  assert.equal(result.inspection.status, 'invalid_request')
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.equal(JSON.stringify(result).includes('/private/test-fixture'), false)
  assert.equal(h.calls.clients, 0)
  assert.equal(h.calls.status, 0)
})

test('operator report treats service failure as unverified inventory and hides private errors', async t => {
  const h = setup(t)
  h.client.status = async () => { throw Error('private synthetic token /private/setup.json') }
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  const message = h.notices.at(-1).message
  assert.match(message, /Configuration inventory · unverified/)
  assert.doesNotMatch(message, /private synthetic|\/private\/setup|configurations 0\/0/)
  assert.match(message, /readiness remains unverified/)
})

test('operator report preserves catalog blockers, undated catalog limits and undetected device status', async t => {
  const catalog = structuredClone(routeFixture.catalog)
  catalog.capabilities = Array.from({ length: 33 }, (_, index) => ({ ...catalog.capabilities[0],
    capabilityId: `capability-${index}`, availableForRouting: false, reasonCodes: [`catalog-block-${index}`] }))
  const snapshot = { contractVersion: 'experimental-physical-node-state-v1', physicalExecutionAuthorized: false,
    discoveryBindingDigest: `sha256:${'d'.repeat(64)}`, discovery: { observedAt: '2026-09-02T17:00:00Z', snapshotDigest: `sha256:${'d'.repeat(64)}`,
      devices: [{ deviceId: 'undetected-device', detected: false, adapterStatus: 'available' }] } }
  const h = setup(t, { createPhysicalNodeClientImpl: () => ({ origin: 'http://127.0.0.1:8876',
    async inspect() { return snapshot }, async capabilities() { return normalizePhysicalCapabilityCatalog(catalog) } }) })
  await h.pi.tools.get('inspect_physical_system').execute('discovery', {})
  await h.pi.tools.get('inspect_physical_capabilities').execute('catalog', {})
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  const message = h.notices.at(-1).message
  assert.match(message, /Catalog evidence · cached · observation time not reported/)
  assert.match(message, /Capability capability-0 · typed routing unavailable · catalog-block-0/)
  assert.match(message, /Capability catalog list truncated/)
  assert.doesNotMatch(message, /catalog-block-32/)
  assert.match(message, /undetected-device · not_observed/)
  assert.match(message, /2026-09-02T17:00:00Z \(\d+ seconds before report\)/)
})

test('early unavailable operator report does not manufacture null observation times', async t => {
  const h = setup(t)
  await h.pi.handlers.get('session_shutdown')()
  await h.pi.commands.get('physical-setup').handler('', h.ctx)
  const message = h.notices.at(-1).message
  assert.match(message, /Physical setup · disposed/)
  assert.doesNotMatch(message, /Observed null|observed null|generated null|expires null/)
  assert.match(message, /observation time not reported/)
  assert.equal(h.calls.clients, 0)
})

test('setup inspection is absent from the cloud extension', t => {
  const h = setup(t, { standalone: false, cloudEnabled: false })
  assert.equal(h.pi.tools.has(toolName), false)
  assert.equal(h.pi.commands.has('physical-setup'), false)
  assert.equal(h.calls.clients, 0)
})

test('shutdown retires the setup reader without extra reads or actions', async t => {
  const h = setup(t)
  await h.inspect()
  await h.pi.handlers.get('session_shutdown')()
  const count = h.calls.status
  const result = await h.inspect()
  assert.equal(result.inspection.status, 'disposed')
  assert.equal(h.calls.status, count)
})

test('cancelled setup reads do not construct the execution client', async t => {
  const h = setup(t)
  const controller = new AbortController()
  controller.abort()
  const result = await h.inspect({}, controller.signal)
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(h.calls.clients, 0)
  assert.equal(h.calls.status, 0)
})

test('cancelled setup read retains ownership until the underlying status request settles', { timeout: 2000 }, async t => {
  const h = setup(t)
  const controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  let settle
  h.client.status = () => {
    started()
    return new Promise(resolve => { settle = resolve })
  }
  const pending = h.inspect({}, controller.signal)
  await ready
  controller.abort()
  const result = await pending
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.equal((await h.inspect()).inspection.status, 'busy')
  settle(status)
  await new Promise(resolve => setImmediate(resolve))
  h.client.status = async () => status
  assert.notEqual((await h.inspect()).inspection.status, 'busy')
})
