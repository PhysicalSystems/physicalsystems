import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSetupInspector } from '../src/harness/setup-inspection.js'
import { executionDigest } from '../src/physical/execution-contracts.js'
import { normalizePhysicalCapabilityCatalog, normalizePhysicalRouteReceipt } from '../src/physical/route-contracts.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url)))
const hash = (letter) => `sha256:${letter.repeat(64)}`
const instant = Date.parse('2026-09-06T12:00:00Z')
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
const clone = (value) => structuredClone(value)
function context() {
  return { generation: 1, capabilityCatalog: normalizePhysicalCapabilityCatalog(clone(fixture.catalog)),
    routeReceipt: normalizePhysicalRouteReceipt(clone(fixture.selected)), snapshot: {
      contractVersion: 'experimental-physical-candidates-v1', physicalExecutionAuthorized: false,
      discoveryBindingDigest: hash('d'), discovery: { observedAt: '2026-09-02T17:00:00Z', snapshotDigest: hash('d'), providerErrors: [],
        devices: [{ deviceId: 'camera-one', adapterId: 'camera-adapter', adapterStatus: 'available', detected: true,
          driverReady: true, calibrationReady: true, ready: true, configured: true }] },
    } }
}
const status = () => ({ contractVersion: 'physicalsystems-execution-status-v1', availability: 'available', mode: 'physical', reason: null,
  configurations: [{ configurationId: 'table-one', displayName: 'Private operator label', capabilityId: 'transfer-container',
    implementationId: 'a-waypoint', configurationDigest: hash('a'), implementationDigest: hash('b'), mode: 'physical' }], physicalExecutionAuthorized: false })
function setup(t, options = {}) {
  let current = context(), clock = instant, service = status()
  const calls = []
  const client = { async status() { calls.push('status'); return options.read ? options.read() : service } }
  for (const key of ['runs', 'run', 'snapshot', 'prepare', 'approve', 'stop', 'reconcile', 'inspect', 'previewCapability', 'camera']) {
    Object.defineProperty(client, key, { get() { assert.fail(`Setup inspection accessed ${key}`) } })
  }
  const inspector = createSetupInspector({ client: Object.freeze(client), getContext: () => current, now: () => clock, readTimeoutMs: options.timeout ?? 1000 })
  t.after(() => inspector.dispose())
  return { inspector, calls, current: () => current, service: () => service,
    context(value) { current = value }, clock(value) { clock = value }, status(value) { service = value } }
}
const find = (row, id) => row.checks.find((check) => check.id === id)
function changedRoute(route, modify) {
  const value = clone(route)
  modify(value)
  value.decision.decision_digest = executionDigest(value.decision, 'decision_digest')
  return value
}

test('preflight reads status once and reports records without deriving physical readiness or authority', async (t) => {
  const h = setup(t)
  assert.deepEqual(h.calls, [])
  const result = await h.inspector.inspect()
  assert.equal(result.contractVersion, 'physicalsystems-setup-inspection-v1')
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.inspection.observedAt, new Date(instant).toISOString())
  assert.equal(result.inspection.expiresAt, new Date(instant + 5000).toISOString())
  assert.equal(result.physicalReadiness, 'unverified')
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.deepEqual(h.calls, ['status'])
  assert.equal(result.implementations.length, 2)
  assert.equal(find(result.implementations[0], 'configuration').status, 'present')
  for (const id of ['dependencies', 'calibration', 'artifacts', 'state', 'execution_target']) assert.equal(find(result.implementations[0], id).status, 'unverified', id)
  assert.equal(result.sources.route.observedAt, fixture.selected.observedAt)
  assert.equal(result.sources.catalog.observedAt, null)
  assert.equal(result.sources.route.historical, true)
  assert.deepEqual(Object.keys(h.inspector).sort(), ['dispose', 'inspect'])
})

test('rejected alternative retains its own blockers without applying them to the selected implementation', async (t) => {
  const h = setup(t), result = await h.inspector.inspect()
  const selected = result.implementations.find((row) => row.implementationId === 'a-waypoint')
  const rejected = result.implementations.find((row) => row.implementationId === 'b-learned')
  assert.equal(find(selected, 'artifacts').status, 'unverified')
  assert.deepEqual(find(selected, 'qualification').reasonCodes, [])
  assert.equal(find(rejected, 'artifacts').status, 'missing')
  assert.equal(find(rejected, 'qualification').status, 'missing')
  assert.equal(find(rejected, 'implementation').status, 'unverified')
  assert.equal(result.physicalReadiness, 'unverified')
})

test('registration and commissioning compatibility booleans cannot become driver or calibration evidence', async (t) => {
  const h = setup(t), result = await h.inspector.inspect()
  assert.equal(result.devices[0].adapterRegistration, 'present')
  assert.equal(result.devices[0].presence, 'observed')
  assert.equal(result.devices[0].driverHealth, 'unverified')
  assert.equal(result.devices[0].calibration, 'unverified')
  assert.equal(Object.hasOwn(result.devices[0], 'ready'), false)
  assert.equal(Object.hasOwn(result.devices[0], 'calibrationReady'), false)
})

test('simulation registration and qualified route metadata do not imply physical qualification', async (t) => {
  const h = setup(t), value = status()
  value.mode = 'simulation'; value.configurations[0].mode = 'simulation'; h.status(value)
  const result = await h.inspector.inspect()
  assert.equal(result.service.mode, 'simulation')
  assert.equal(result.configurations[0].mode, 'simulation')
  assert.equal(result.implementations[0].recordedQualificationStatus, 'qualified')
  assert.match(find(result.implementations[0], 'qualification').message, /record|metadata/i)
  assert.match(find(result.implementations[0], 'qualification').action, /physical|evidence/i)
  assert.equal(result.physicalReadiness, 'unverified')
  assert.match(result.limitations.join(' '), /simulation/i)
})

test('routing-envelope digest is not equated with the executable-artifact digest', async (t) => {
  const h = setup(t)
  assert.notEqual(h.current().routeReceipt.decision.selected_implementation_digest, h.service().configurations[0].implementationDigest)
  const result = await h.inspector.inspect()
  assert.equal(find(result.implementations[0], 'configuration').status, 'present')
  assert.equal(result.configurations[0].implementationDigest, hash('b'))
})

test('absent cached context and unavailable service remain unverified rather than inventing missing calibration', async (t) => {
  const h = setup(t, { read: () => { throw Error('private token file and network address') } })
  h.context({ generation: 1, snapshot: null, capabilityCatalog: null, routeReceipt: null })
  const result = await h.inspector.inspect()
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.implementations.length, 0)
  assert.equal(result.devices.length, 0)
  assert.equal(result.checks.every((check) => check.status === 'unverified'), true)
  assert.equal(JSON.stringify(result).includes('private token'), false)
})

test('service outage preserves explicitly historical cached blockers with a partial status', async (t) => {
  const h = setup(t, { read: () => Promise.reject(Error('secret')) })
  const result = await h.inspector.inspect()
  assert.equal(result.inspection.status, 'partial')
  assert.equal(result.service.availability, 'unavailable')
  assert.equal(find(result.implementations[0], 'configuration').status, 'unverified')
  assert.equal(find(result.implementations[1], 'artifacts').status, 'missing')
  assert.equal(result.sources.route.historical, true)
})

test('zero reported configurations, a mismatching registration and unreadable inventory are distinct', async (t) => {
  const h = setup(t)
  h.status({ ...status(), configurations: [] })
  let result = await h.inspector.inspect()
  assert.equal(find(result.implementations[0], 'configuration').status, 'missing')
  assert.match(find(result.implementations[0], 'configuration').message, /no .*configuration|zero/i)
  const value = status(); value.configurations[0].implementationId = 'other-implementation'; h.status(value)
  result = await h.inspector.inspect()
  assert.equal(find(result.implementations[0], 'configuration').status, 'missing')
  assert.match(find(result.implementations[0], 'configuration').message, /match/i)
  h.status({ ...status(), availability: 'unavailable', configurations: [] })
  result = await h.inspector.inspect()
  assert.equal(find(result.implementations[0], 'configuration').status, 'unverified')
})

test('candidate reasons retain missing versus mismatch and unknown code distinctions', async (t) => {
  const h = setup(t)
  const codes = ['calibration_missing', 'dependency_mismatch', 'artifact_mismatch', 'execution_target_unavailable', 'precondition_stale', 'qualification_mismatch', 'manifest_mismatch', 'future_host_blocker']
  h.context({ ...h.current(), routeReceipt: changedRoute(h.current().routeReceipt, (route) => { route.decision.candidates[1].rejection_codes = codes }) })
  const result = await h.inspector.inspect(), row = result.implementations[1]
  assert.equal(find(row, 'calibration').status, 'missing')
  assert.equal(find(row, 'dependencies').status, 'unverified')
  assert.equal(find(row, 'execution_target').status, 'missing')
  assert.equal(find(row, 'state').status, 'unverified')
  assert.deepEqual(new Set(row.checks.flatMap((check) => check.reasonCodes)), new Set(codes))
  assert.match(find(row, 'artifacts').message, /mismatch|matching/i)
})

test('request-level argument, policy and context blockers preserve their scope and actionable corrections', async (t) => {
  const h = setup(t)
  h.context({ ...h.current(), routeReceipt: changedRoute(h.current().routeReceipt, (route) => {
    route.decision.decision_status = 'no_match'; route.decision.selected_implementation_id = null
    route.decision.selected_implementation_digest = null; route.decision.selected_execution_target = null
    route.decision.candidates[0].status = 'rejected'; route.decision.candidates[0].rejection_codes = ['precondition_unknown']
    route.decision.request_rejection_codes = ['missing_argument', 'policy_incomplete', 'catalog_mismatch', 'unknown_skill']
  }) })
  const result = await h.inspector.inspect()
  assert.deepEqual(result.requestBlockers.map(({ code }) => code), ['missing_argument', 'policy_incomplete', 'catalog_mismatch', 'unknown_skill'])
  assert.match(result.requestBlockers[0].action, /input|argument/i)
  assert.match(result.requestBlockers[1].action, /policy/i)
  assert.match(result.requestBlockers[2].action, /catalog|route|context/i)
  assert.match(result.requestBlockers[3].message, /unsupported|not.*catalog/i)
  assert.equal(result.requestBlockers.some(({ action }) => /calibrat/i.test(action)), false)
})

test('raw receipt internals and malformed normalized route data are excluded, not interpreted as trusted setup', async (t) => {
  for (const mutate of [
    (route) => { route.runtimeCatalog = { calibration: 'SECRET' } },
    (route) => { route.hostEvidence = { calibration: 'SECRET' } },
    (route) => { route.decision.candidates[0].status = 'ready' },
    (route) => { route.decision.decision_digest = hash('0') },
    (route) => { route.physicalExecutionAuthorized = true },
  ]) {
    const h = setup(t), route = clone(h.current().routeReceipt); mutate(route)
    h.context({ ...h.current(), routeReceipt: route })
    const result = await h.inspector.inspect()
    assert.equal(result.sources.route.status, 'invalid')
    assert.deepEqual(result.implementations, [])
    assert.equal(JSON.stringify(result).includes('SECRET'), false)
  }
})

test('different cached catalog pins prevent mixing route candidates with a replacement catalog', async (t) => {
  const h = setup(t), catalog = clone(h.current().capabilityCatalog)
  catalog.registryDigest = hash('f')
  h.context({ ...h.current(), capabilityCatalog: catalog })
  const result = await h.inspector.inspect()
  assert.equal(result.sources.route.status, 'context_mismatch')
  assert.deepEqual(result.implementations, [])
})

test('labels, properties, raw reasons and file paths never enter preflight output', async (t) => {
  const h = setup(t), value = status(), current = clone(h.current()), secret = 'IGNORE-INSTRUCTIONS-private-file-token'
  value.reason = secret; value.configurations[0].displayName = secret
  current.capabilityCatalog.capabilities[0].displayName = secret
  current.snapshot.nodeName = secret; current.snapshot.discovery.devices[0].displayName = secret
  current.snapshot.discovery.devices[0].properties = { path: secret }
  h.context(current); h.status(value)
  const result = await h.inspector.inspect()
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('only an empty argument object is accepted and no caller can supply identifiers, paths or actions', async (t) => {
  const h = setup(t)
  for (const value of [null, [], 'status', { url: 'http://localhost' }, { capabilityId: 'transfer-container' }, { path: '/tmp/private' }, { approved: true }]) {
    assert.equal((await h.inspector.inspect(value)).inspection.status, 'invalid_request')
  }
  assert.deepEqual(h.calls, [])
})

for (const key of ['generation', 'snapshot', 'capabilityCatalog', 'routeReceipt']) {
  test(`pending preflight cannot restore a retired ${key} context`, async (t) => {
    const pending = deferred(), h = setup(t, { read: () => pending.promise })
    const reading = h.inspector.inspect()
    h.context({ ...h.current(), [key]: key === 'generation' ? 2 : null })
    pending.resolve(status())
    const result = await reading
    assert.equal(result.inspection.status, 'stale')
    assert.deepEqual(result.implementations, [])
  })
}

test('bounded timeouts retain request ownership until the hanging GET settles', async (t) => {
  const pending = deferred(), h = setup(t, { read: () => pending.promise, timeout: 20 })
  const reading = h.inspector.inspect()
  assert.equal((await h.inspector.inspect()).inspection.status, 'busy')
  assert.equal((await reading).inspection.reasonCode, 'inspection_timeout')
  assert.equal((await h.inspector.inspect()).inspection.status, 'busy')
  pending.resolve(status()); await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.calls, ['status'])
})

test('cancellation and disposal return promptly and do not restore late setup information', async (t) => {
  for (const mode of ['cancel', 'dispose']) {
    const pending = deferred(), h = setup(t, { read: () => pending.promise }), abort = new AbortController()
    const reading = h.inspector.inspect({}, { signal: abort.signal })
    if (mode === 'cancel') abort.abort(); else h.inspector.dispose()
    const result = await reading
    assert.equal(result.inspection.reasonCode, mode === 'cancel' ? 'inspection_cancelled' : 'disposed')
    assert.deepEqual(result.implementations, [])
    pending.resolve(status()); await new Promise((resolve) => setImmediate(resolve))
  }
})

test('backward or expired read clocks cannot produce apparently fresh setup evidence', async (t) => {
  for (const at of [instant - 1, instant + 5000]) {
    const pending = deferred(), h = setup(t, { read: () => pending.promise })
    const reading = h.inspector.inspect(); h.clock(at); pending.resolve(status())
    const result = await reading
    assert.equal(result.inspection.status, 'stale')
    assert.equal(result.physicalReadiness, 'unverified')
  }
})

test('large inventories are bounded with explicit totals and truncation counts', async (t) => {
  const h = setup(t), current = clone(h.current()), value = status()
  current.snapshot.discovery.devices = Array.from({ length: 40 }, (_, index) => ({ ...current.snapshot.discovery.devices[0], deviceId: `device-${index}` }))
  current.capabilityCatalog.capabilities = Array.from({ length: 40 }, (_, index) => ({ ...current.capabilityCatalog.capabilities[0], capabilityId: index ? `capability-${index}` : 'transfer-container' }))
  current.routeReceipt = changedRoute(current.routeReceipt, (route) => {
    const alternative = route.decision.candidates[1]
    route.decision.candidates = [route.decision.candidates[0], ...Array.from({ length: 19 }, (_, index) => ({ ...alternative, implementation_id: `alternative-${index}` }))]
    route.implementations = route.decision.candidates.map((candidate) => ({ implementationId: candidate.implementation_id, qualificationStatus: 'qualified' }))
  })
  value.configurations = Array.from({ length: 40 }, (_, index) => ({ ...value.configurations[0], configurationId: `configuration-${index}` }))
  h.context(current); h.status(value)
  const result = await h.inspector.inspect()
  assert.equal(result.inspection.status, 'partial')
  assert.equal(result.sources.discovery.total, 40); assert.equal(result.devices.length, 32); assert.equal(result.sources.discovery.truncated, true)
  assert.equal(result.sources.catalog.total, 40); assert.equal(result.capabilities.length, 32); assert.equal(result.sources.catalog.truncated, true)
  assert.equal(result.counts.configurations, 40); assert.equal(result.configurations.length, 32); assert.equal(result.counts.configurationTruncated, true)
  assert.equal(result.counts.implementations, 20); assert.ok(result.implementations.length > 0 && result.implementations.length <= 16); assert.equal(result.counts.implementationTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024, 'The combined report must fit the shared browser snapshot budget')
})

test('partial discovery and setup-required adapters are explicit without inferring health or calibration', async (t) => {
  const h = setup(t), current = clone(h.current())
  current.snapshot.discovery.providerErrors = [{ status: 'timeout' }]
  current.snapshot.discovery.devices[0].adapterStatus = 'setup-required'
  h.context(current)
  const result = await h.inspector.inspect()
  assert.equal(result.inspection.status, 'partial')
  assert.equal(result.sources.discovery.status, 'partial')
  assert.equal(result.devices[0].adapterRegistration, 'unverified')
  assert.equal(result.devices[0].driverHealth, 'unverified')
  assert.equal(result.devices[0].calibration, 'unverified')
})

test('missing client can explain cached records without ever reading execution history or hardware', async (t) => {
  const current = context()
  const inspector = createSetupInspector({ getContext: () => current, now: () => instant })
  t.after(() => inspector.dispose())
  const result = await inspector.inspect()
  assert.equal(result.inspection.status, 'partial')
  assert.equal(result.service.availability, 'unavailable')
  assert.equal(result.implementations.length, 2)
  assert.equal(find(result.implementations[0], 'configuration').status, 'unverified')
})

test('invalid discovery timestamps or status contracts remain partial and never expose their raw contents', async (t) => {
  const h = setup(t), current = clone(h.current())
  current.snapshot.discovery.observedAt = 'private-diagnostic-not-time'
  h.context(current); h.status({ ...status(), physicalExecutionAuthorized: true })
  const result = await h.inspector.inspect()
  assert.equal(result.sources.discovery.status, 'invalid')
  assert.equal(result.service.availability, 'unavailable')
  assert.equal(result.inspection.status, 'partial')
  assert.equal(JSON.stringify(result).includes('private-diagnostic-not-time'), false)
})

test('unavailable service cannot advertise stale configuration registrations as a current inventory', async (t) => {
  const h = setup(t)
  h.status({ ...status(), availability: 'unavailable' })
  const result = await h.inspector.inspect()
  assert.equal(result.service.configurationInventory, 'unverified')
  assert.deepEqual(result.configurations, [])
  assert.equal(result.counts.configurations, null)
  assert.equal(find(result.implementations[0], 'configuration').status, 'unverified')
})

test('legacy registered devices that were not detected do not appear as observed hardware', async (t) => {
  const h = setup(t), current = clone(h.current())
  current.snapshot.contractVersion = 'experimental-physical-node-state-v1'
  current.snapshot.discovery.devices[0].detected = false
  delete current.snapshot.discovery.devices[0].adapterStatus
  delete current.snapshot.discovery.devices[0].adapterId
  h.context(current)
  const result = await h.inspector.inspect()
  assert.equal(result.devices[0].presence, 'not_observed')
  assert.equal(result.devices[0].adapterRegistration, 'unverified')
  assert.equal(result.devices[0].driverHealth, 'unverified')
  assert.equal(result.devices[0].calibration, 'unverified')
})

test('bounded presentation preserves the actual Node selection and its matching configuration', async (t) => {
  const h = setup(t), current = clone(h.current()), value = status()
  current.routeReceipt = changedRoute(current.routeReceipt, (route) => {
    const selected = route.decision.candidates[0], alternative = route.decision.candidates[1]
    route.decision.candidates = [...Array.from({ length: 20 }, (_, index) => ({ ...alternative, implementation_id: `alternative-${index}` })), selected]
    route.implementations = route.decision.candidates.map((candidate) => ({ implementationId: candidate.implementation_id, qualificationStatus: 'qualified' }))
  })
  value.configurations = [...Array.from({ length: 40 }, (_, index) => ({ ...value.configurations[0], configurationId: `configuration-${index}`, implementationId: `alternative-${index}` })), value.configurations[0]]
  h.context(current); h.status(value)
  const result = await h.inspector.inspect()
  assert.equal(result.implementations[0].implementationId, 'a-waypoint')
  assert.equal(result.implementations[0].routingStatus, 'selected')
  assert.equal(result.configurations[0].configurationId, 'table-one')
  assert.equal(result.counts.implementationTruncated, true)
  assert.equal(result.counts.configurationTruncated, true)
  assert.equal(h.current().routeReceipt.decision.candidates.at(-1).implementation_id, 'a-waypoint', 'no cached source reordering')
})

test('explicit retained setup context describes a retired proposal without restoring a current route', async (t) => {
  const h = setup(t), current = h.current()
  h.context({ ...current, generation: 2, routeRelationship: 'retired' })
  const result = await h.inspector.inspect()
  assert.equal(result.sources.route.relationship, 'retired')
  assert.equal(result.sources.route.receiptDigest, current.routeReceipt.receiptDigest)
  assert.equal(result.sources.route.observedAt, current.routeReceipt.observedAt)
  assert.equal(result.sources.route.evaluatedAt, current.routeReceipt.evaluatedAt)
  assert.equal(result.sources.route.historical, true)
  assert.match(find(result, 'route').message, /previous proposal/)
  assert.match(find(result, 'route').action, /current capability route/)
  assert.equal(result.physicalReadiness, 'unverified')
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.deepEqual(h.calls, ['status'])
  assert.equal(h.current().routeRelationship, 'retired')
})

test('a route relationship change retires a pending setup read even when record pins are unchanged', async (t) => {
  const pending = deferred(), h = setup(t, { read: () => pending.promise })
  const reading = h.inspector.inspect()
  h.context({ ...h.current(), routeRelationship: 'retired' })
  pending.resolve(status())
  const result = await reading
  assert.equal(result.inspection.status, 'stale')
  assert.equal(result.sources.route.relationship, 'none')
  assert.deepEqual(result.implementations, [])
})

test('invalid retained-context relationship cannot label a cached proposal as current or disclose its value', async (t) => {
  for (const relation of ['none', 'ready', 'private-invalid-relation']) {
    const h = setup(t)
    h.context({ ...h.current(), routeRelationship: relation })
    const result = await h.inspector.inspect()
    assert.equal(result.sources.route.status, 'invalid')
    assert.equal(result.sources.route.relationship, 'none')
    assert.deepEqual(result.implementations, [])
    assert.equal(result.physicalReadiness, 'unverified')
    assert.equal(JSON.stringify(result).includes('private-invalid-relation'), false)
  }
})

test('model projection explicitly distinguishes unavailable detail from reported missing evidence', async (t) => {
  const h = setup(t), result = await h.inspector.inspect()
  const selected = result.implementations.find((row) => row.implementationId === 'a-waypoint')
  const alternative = result.implementations.find((row) => row.implementationId === 'b-learned')
  assert.equal(find(selected, 'qualification').status, 'present', 'the reported qualification metadata exists')
  assert.deepEqual(find(selected, 'qualification').reasonCodes, [])
  assert.equal(find(selected, 'calibration').status, 'unverified')
  assert.match(find(selected, 'qualification').message, /not exposed.*does not mean.*absent or missing/i)
  assert.match(result.limitations.join(' '), /unverified does not mean absent or missing/i)
  assert.equal(find(alternative, 'qualification').status, 'missing', 'explicit missing code remains an actionable blocker')
  assert.ok(find(alternative, 'qualification').reasonCodes.includes('qualification_missing'))
})

test('model projection explains distinct routing-envelope and executable-artifact digests without weakening exact bindings', async (t) => {
  const h = setup(t), result = await h.inspector.inspect()
  const implementation = result.implementations.find((row) => row.implementationId === 'a-waypoint')
  const configuration = result.configurations.find((row) => row.implementationId === implementation.implementationId)
  assert.notEqual(implementation.implementationDigest, configuration.implementationDigest)
  assert.equal(implementation.implementationDigest, h.current().routeReceipt.decision.selected_implementation_digest)
  assert.equal(configuration.implementationDigest, h.service().configurations[0].implementationDigest)
  assert.equal(find(implementation, 'configuration').status, 'present')
  assert.match(find(implementation, 'configuration').message, /routing envelope.*executable artifact.*need not match/i)
  assert.match(result.limitations.join(' '), /exact.*Node.*checks.*remain/i)
  assert.equal(result.physicalReadiness, 'unverified')
  assert.equal(result.physicalExecutionAuthorized, false)
})
