import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  normalizePhysicalCapabilityCatalog, normalizePhysicalRouteRequest,
  normalizePhysicalRouteReceipt, physicalRouteReceiptPath,
} from '../src/physical/route-contracts.js'

// Captured from node/test_physical_routes.py make_service against Runtime
// 6650dec. Synthetic state only; no physical commissioning evidence.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url)))
const copy = (value) => structuredClone(value)
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
function resealDecision(receipt) {
  const { decision_digest: _, ...content } = receipt.decision
  receipt.decision.decision_digest = `sha256:${createHash('sha256').update(canonical(content)).digest('hex')}`
  return receipt
}

test('authentic synthetic Node envelopes normalize without implementing routing in JS', () => {
  const catalog = normalizePhysicalCapabilityCatalog(fixture.catalog)
  assert.equal(catalog.capabilities[0].capabilityId, 'transfer-container')
  assert.equal(catalog.capabilities[0].inputFields[2].maximum, 0.25)
  for (const [name, status] of [['selected', 'selected'], ['unknown', 'no_match'], ['stale', 'no_match']]) {
    const receipt = normalizePhysicalRouteReceipt(fixture[name], fixture.request)
    assert.equal(receipt.decision.decision_status, status)
    assert.equal(receipt.physicalExecutionAuthorized, false)
    assert.equal(receipt.decision.physical_execution_authorized, false)
    assert.equal(receipt.policyVersion.policyId, 'h01-qualified-waypoint-first-v1')
    assert.equal(receipt.runtimeRequest, undefined, 'raw host evidence is not model context')
    assert.ok(Object.isFrozen(receipt.decision.candidates))
  }
  assert.equal(normalizePhysicalRouteReceipt(fixture.unknown).assessmentTimestamps[0].observedMonotonicNs, null)
})

test('catalog is explicit typed data, not guessed bounds or hidden authority', () => {
  const mutations = [
    (f) => { f.unknown = true },
    (f) => { f.runtimeVersion = '0.1.0' },
    (f) => { f.physicalExecutionAuthorized = true },
    (f) => { f.capabilities[0].inputFields[2].unit = null },
    (f) => { f.capabilities[0].inputFields[2].maximum = 1e13 },
    (f) => { f.capabilities[0].inputFields[2].value_type = 'integer' },
    (f) => { f.capabilities[0].inputFields[0].unit = 'meters' },
    (f) => { f.capabilities[0].inputFields[0].required = false },
    (f) => { f.capabilities[0].preconditions[0].maximum_age_ns = 0 },
    (f) => { f.capabilities[0].preconditions[0].maximum_age_ns = 300_000_000_001 },
    (f) => { f.capabilities[0].capabilityId = 'Bad.ID' },
    (f) => { f.capabilities[0].displayName = '\x1b[2Jfake' },
  ]
  for (const mutate of mutations) {
    const value = copy(fixture.catalog); mutate(value)
    assert.throws(() => normalizePhysicalCapabilityCatalog(value), TypeError)
  }
})

test('preview accepts only exact bounded typed arguments and snapshot digests', () => {
  assert.deepEqual(normalizePhysicalRouteRequest(fixture.request).arguments, fixture.request.arguments)
  for (const mutate of [
    (f) => { f.preconditions = [] },
    (f) => { f.physicalExecutionAuthorized = true },
    (f) => { f.arguments.reverse() },
    (f) => { f.arguments.push(f.arguments[0]) },
    (f) => { f.arguments[2].value = Infinity },
    (f) => { f.arguments[2].value = 1e12 + 1 },
    (f) => { f.arguments[2].value = '0.1' },
    (f) => { f.arguments[0].value = '../station' },
    (f) => { f.expectedCatalogDigest = 'file:///tmp/catalog' },
  ]) {
    const value = copy(fixture.request); mutate(value)
    assert.throws(() => normalizePhysicalRouteRequest(value), TypeError)
  }
  assert.throws(() => physicalRouteReceiptPath('../../secret'), TypeError)
})

test('a sealed old decision cannot be attached to a new echoed invocation', () => {
  const changed = copy(fixture.request)
  changed.arguments[0].value = 'station-c'
  const receipt = copy(fixture.selected)
  assert.throws(() => normalizePhysicalRouteReceipt(receipt, changed), /requested capability invocation/)
  receipt.request = changed
  assert.throws(() => normalizePhysicalRouteReceipt(receipt, changed), /stored typed invocation/)
})

test('tampering or internally contradictory decisions fails closed', () => {
  const tampered = copy(fixture.selected)
  tampered.decision.candidates[0].provider = 'another-provider'
  assert.throws(() => normalizePhysicalRouteReceipt(tampered), /digest/)
  for (const mutate of [
    (f) => { f.decision.physical_execution_authorized = true },
    (f) => { f.decision.selected_implementation_id = 'b-learned' },
    (f) => { f.decision.candidates[0].rejection_codes = ['qualification_missing'] },
    (f) => { f.decision.selected_execution_target = null },
  ]) {
    const receipt = copy(fixture.selected); mutate(receipt); resealDecision(receipt)
    assert.throws(() => normalizePhysicalRouteReceipt(receipt), TypeError)
  }
})

test('receipt display metadata must agree with the stored request and catalog', () => {
  for (const mutate of [
    (f) => { f.extra = 'not-in-version' },
    (f) => { f.policyVersion.policyId = 'wrong-policy' },
    (f) => { f.policyVersion.contractVersion = 'unknown' },
    (f) => { f.implementations[0].qualificationStatus = 'demo_qualified' },
    (f) => { f.implementations.pop() },
    (f) => { f.runtimeRequest.invocation_digest = `sha256:${'f'.repeat(64)}` },
    (f) => { f.runtimeCatalog.workcell_id = 'different-workcell' },
    (f) => { f.evaluatedAt = '2026-02-30T17:00:00Z' },
    (f) => { f.observedAt = 'yesterday' },
    (f) => { f.evaluationMonotonicNs = '1e10' },
  ]) {
    const value = copy(fixture.selected); mutate(value)
    assert.throws(() => normalizePhysicalRouteReceipt(value), TypeError)
  }
  const large = copy(fixture.selected)
  large.evaluationMonotonicNs = '9007199254740993'
  // Decimal envelope timestamps remain lossless even after raw JSON integers
  // exceed JS precision. Receipt integrity itself is checked by the node.
  assert.equal(normalizePhysicalRouteReceipt(large).evaluationMonotonicNs, '9007199254740993')
})
