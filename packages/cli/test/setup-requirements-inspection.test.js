import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSetupInspector } from '../src/harness/setup-inspection.js'
import { createSetupRequirementsClient } from '../src/physical/setup-client.js'
import { normalizeSetupRequirements } from '../src/physical/setup-contracts.js'
import { normalizePhysicalCapabilityCatalog, normalizePhysicalRouteReceipt } from '../src/physical/route-contracts.js'
import { setupRequirements, setupRequirement, setupAt, setupHash } from './fixtures/setup-requirements.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url)))
const instant = Date.parse(setupAt)
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function context() {
  return { generation: 1, capabilityCatalog: normalizePhysicalCapabilityCatalog(structuredClone(fixture.catalog)),
    routeReceipt: normalizePhysicalRouteReceipt(structuredClone(fixture.selected)), routeRelationship: 'current' }
}
function harness(t, options = {}) {
  let current = context(), now = instant, reads = 0, statuses = 0
  let report = setupRequirements({ registryDigest: current.capabilityCatalog.registryDigest })
  report.implementations[0].workcellId = current.routeReceipt.workcellId
  const service = { contractVersion: 'physicalsystems-execution-status-v1', availability: 'available', mode: 'physical', reason: null,
    configurations: [], physicalExecutionAuthorized: false }
  const inspector = createSetupInspector({ getContext: () => current, now: () => now, readTimeoutMs: options.timeout || 1000,
    client: { status() { statuses++; return options.statusRead ? options.statusRead() : service } },
    requirementsClient: options.legacy ? undefined : { requirements() { reads++; return options.read ? options.read() : { status: 'available', report } } } })
  t.after(() => inspector.dispose())
  return { inspector, get report() { return report }, get service() { return service }, get current() { return current },
    get reads() { return reads }, get statuses() { return statuses }, setReport(value) { report = value },
    setContext(value) { current = value }, setNow(value) { now = value } }
}

test('implementation requirements are additive read-only evidence and cannot replace route or create authority', async t => {
  const h = harness(t)
  const route = h.current.routeReceipt
  const result = await h.inspector.inspect({})
  assert.equal(h.reads, 1); assert.equal(h.statuses, 1)
  assert.equal(result.implementationSetup.status, 'available')
  assert.deepEqual(result.implementationSetup.report, h.report)
  assert.equal(h.current.routeReceipt, route)
  assert.equal(result.sources.route.receiptDigest, route.receiptDigest)
  assert.equal(result.physicalReadiness, 'unverified'); assert.equal(result.physicalExecutionAuthorized, false)
  assert.equal(result.implementationSetup.report.implementations[0].requirements[0].state, 'unverified')
  assert.equal(result.implementationSetup.report.implementations[0].requirements[0].evidence.sourceUpdatedAt, null)
  assert.match(result.limitations.join(' '), /Present does not mean physically validated/)
})

test('status-only legacy callers perform no new request and keep their previous setup explanation', async t => {
  const h = harness(t, { legacy: true })
  const result = await h.inspector.inspect()
  assert.deepEqual(result.implementationSetup, { status: 'not_inspected', report: null })
  assert.equal(h.reads, 0); assert.equal(h.statuses, 1)
  assert.equal(result.implementations.length, 2)
})

test('unsupported, unavailable and invalid requirements remain distinct while preserving cached blockers', async t => {
  for (const status of [404, 503, 200]) {
    const client = createSetupRequirementsClient({ baseUrl: 'http://127.0.0.1:8876', token: 'synthetic-setup-credential-00000000000000',
      fetchImpl: async () => Response.json({ private: 'PRIVATE-RESPONSE', physicalExecutionAuthorized: true }, { status }) })
    const h = harness(t, { read: () => client.requirements() })
    const result = await h.inspector.inspect()
    assert.equal(result.implementationSetup.status, ({ 404: 'unsupported', 503: 'unavailable', 200: 'invalid' })[status])
    assert.equal(result.implementationSetup.report, null)
    assert.equal(result.implementations.length, 2)
    assert.equal(result.implementations[1].checks.find(row => row.id === 'artifacts').status, 'missing')
    assert.equal(JSON.stringify(result).includes('PRIVATE-RESPONSE'), false)
  }
})

test('requirements for a different registry or service mode cannot be mixed into the cached proposal', async t => {
  for (const mismatch of ['registry', 'mode']) {
    const h = harness(t)
    if (mismatch === 'registry') h.report.registryDigest = setupHash('f')
    else h.report.mode = 'simulation'
    const result = await h.inspector.inspect()
    assert.equal(result.implementationSetup.status, 'context_mismatch')
    assert.equal(result.implementationSetup.report, null)
    assert.equal(result.sources.route.receiptDigest, h.current.routeReceipt.receiptDigest)
  }
})

test('registry-entry and routing-envelope digests are not compared as the same scope', async t => {
  const h = harness(t)
  h.report.implementations[0].bindings.push({ scope: 'registry-implementation', id: 'a-waypoint', digest: setupHash('f') })
  assert.notEqual(setupHash('f'), h.current.routeReceipt.decision.selected_implementation_digest)
  const result = await h.inspector.inspect()
  assert.equal(result.implementationSetup.status, 'available')
  assert.match(result.limitations.join(' '), /registry-implementation identifies the stored registry entry/)
})

test('expired and future report clocks cannot appear current, and earlier Node expiry bounds the result', async t => {
  for (const offset of [-30_000, 1]) {
    const h = harness(t); h.report.inspectedAt = new Date(instant + offset).toISOString()
    const result = await h.inspector.inspect()
    assert.deepEqual(result.implementationSetup, { status: 'expired', report: null })
  }
  const h = harness(t); h.report.inspectedAt = new Date(instant - 29_000).toISOString()
  const result = await h.inspector.inspect()
  assert.equal(result.implementationSetup.status, 'available')
  assert.equal(result.inspection.expiresAt, new Date(instant + 1000).toISOString())
})

test('retired conversation context can explain requirements without reactivating the proposal', async t => {
  const h = harness(t); h.setContext({ ...h.current, routeRelationship: 'retired' })
  const result = await h.inspector.inspect()
  assert.equal(result.sources.route.relationship, 'retired')
  assert.equal(result.implementationSetup.status, 'available')
  assert.equal(result.physicalExecutionAuthorized, false)
})

test('discovery profile guidance is explicitly unregistered and simulation metadata is never physical evidence', async t => {
  const h = harness(t)
  h.setContext({ generation: 1 })
  h.report.mode = 'discovery'; h.report.registryDigest = null; h.report.registryUpdatedAt = null
  h.report.implementations[0].implementationId = null; h.report.implementations[0].registeredImplementation = false
  h.report.implementations[0].configurationId = null
  const discovery = await h.inspector.inspect()
  assert.equal(discovery.implementationSetup.report.implementations[0].registeredImplementation, false)
  const k = harness(t); k.report.mode = 'simulation'; k.service.mode = 'simulation'
  const simulated = await k.inspector.inspect()
  assert.equal(simulated.implementationSetup.report.mode, 'simulation')
  assert.equal(simulated.physicalReadiness, 'unverified')
  assert.equal(simulated.implementationSetup.report.implementations[0].requirements[0].evidence.mode, 'unknown')
})

test('cancellation retains ownership until both status and requirements settle, discarding every late report', async t => {
  const status = deferred(), requirements = deferred()
  const h = harness(t, { statusRead: () => status.promise, read: () => requirements.promise })
  const abort = new AbortController(), pending = h.inspector.inspect({}, { signal: abort.signal })
  assert.equal(h.reads, 1); assert.equal(h.statuses, 1)
  abort.abort()
  assert.equal((await pending).inspection.reasonCode, 'inspection_cancelled')
  assert.equal((await h.inspector.inspect()).inspection.status, 'busy')
  status.resolve(h.service); await tick()
  assert.equal((await h.inspector.inspect()).inspection.status, 'busy')
  requirements.resolve({ status: 'available', report: h.report }); await tick()
  assert.equal((await h.inspector.inspect()).implementationSetup.status, 'available')
})

test('timeout and context change cannot publish late requirements or start duplicate reads', async t => {
  const pending = deferred(), h = harness(t, { timeout: 10, read: () => pending.promise })
  const timed = await h.inspector.inspect()
  assert.equal(timed.inspection.reasonCode, 'inspection_timeout')
  assert.equal(timed.implementationSetup.report, null)
  assert.equal((await h.inspector.inspect()).inspection.status, 'busy')
  assert.equal(h.reads, 1)
  h.setContext({ ...h.current, generation: 2 })
  pending.resolve({ status: 'available', report: h.report }); await tick()
  const next = deferred(), k = harness(t, { read: () => next.promise })
  const inspected = k.inspector.inspect()
  k.setContext({ generation: 2 })
  next.resolve({ status: 'available', report: k.report })
  const result = await inspected
  assert.equal(result.inspection.reasonCode, 'context_changed')
  assert.equal(result.implementationSetup.report, null)
})

test('empty argument and disposal guards run before either read-only client', async t => {
  const h = harness(t)
  assert.equal((await h.inspector.inspect({ implementationId: 'injected' })).inspection.status, 'invalid_request')
  assert.equal(h.reads, 0); assert.equal(h.statuses, 0)
  h.inspector.dispose()
  assert.equal((await h.inspector.inspect()).inspection.status, 'disposed')
  assert.equal(h.reads, 0); assert.equal(h.statuses, 0)
})

test('combined report budget preserves the selected implementation and accounts for every omitted row', async t => {
  const h = harness(t), selected = h.report.implementations[0]
  h.report.implementations = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(selected),
    implementationId: index === 7 ? selected.implementationId : `alternative-${index}`, configurationId: `configuration-${index}`,
    requirements: Array.from({ length: 8 }, (_, n) => setupRequirement({ requirementId: `requirement-${n}`, reason: 'r'.repeat(260),
      procedure: { ...setupRequirement().procedure, description: 'd'.repeat(240) } })) }))
  normalizeSetupRequirements(h.report)
  const result = await h.inspector.inspect()
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024)
  assert.equal(result.implementationSetup.report.implementations[0].implementationId, selected.implementationId)
  const report = result.implementationSetup.report
  assert.ok(report.truncation.implementationsOmitted > 0, 'The fixture must actually exercise whole implementation omission')
  assert.equal(report.implementations.length + report.truncation.implementationsOmitted, 8)
  assert.equal(report.implementations.reduce((sum, row) => sum + row.requirements.length, 0) + report.truncation.requirementsOmitted, 64)
  assert.equal(report.implementations.reduce((sum, row) => sum + row.bindings.length, 0) + report.truncation.bindingsOmitted, 8)
})
