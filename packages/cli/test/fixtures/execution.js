import { executionDigest } from '../../src/physical/execution-contracts.js'

export const digest = (character) => `sha256:${character.repeat(64)}`
export const runId = `run-${'a'.repeat(32)}`
export const instant = Date.parse('2026-09-02T20:00:00.000Z')
export const snapshot = { configuration: { configurationId: 'table-one' }, implementation: { implementationId: 'transfer-waypoints' } }
export const configuration = { configurationId: 'table-one', displayName: 'Commissioned table', capabilityId: 'transfer-container', implementationId: 'transfer-waypoints', configurationDigest: digest('c'), implementationDigest: digest('d'), mode: 'simulation' }
export const status = { contractVersion: 'physicalsystems-execution-status-v1', availability: 'available', mode: 'simulation', configurations: [configuration], reason: null, physicalExecutionAuthorized: false }
export const route = { capabilityId: 'transfer-container', receiptDigest: digest('e'), physicalExecutionAuthorized: false,
  request: { arguments: [{ name: 'source', value: 'source-one' }, { name: 'destination', value: 'destination-one' }] },
  decision: { decision_status: 'selected', selected_implementation_id: 'transfer-waypoints', selected_implementation_digest: digest('d') } }
export function makeRun(overrides = {}) {
  const value = { contractVersion: 'physicalsystems-run-v1', runId, revision: 1, phase: 'WAITING_FOR_APPROVAL', stopStatus: 'NOT_REQUESTED', mode: 'simulation',
    capabilityId: configuration.capabilityId, implementationId: configuration.implementationId, implementationDigest: configuration.implementationDigest,
    configurationId: configuration.configurationId, configurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest,
    inputs: { source: 'source-one', destination: 'destination-one' }, snapshotDigest: executionDigest(snapshot),
    approval: { digest: digest('f'), expiresAt: '2026-09-02T20:01:00.000Z', approvedAt: null },
    createdAt: '2026-09-02T20:00:00.000Z', updatedAt: '2026-09-02T20:00:00.000Z',
    events: [{ sequence: 1, type: 'prepared', at: '2026-09-02T20:00:00.000Z', detail: {} }], outcome: null, physicalExecutionAuthorized: false, ...overrides }
  value.runDigest = executionDigest(value, 'runDigest')
  return value
}
export function evolve(run, phase, options = {}) {
  return makeRun({ ...run, phase, revision: run.revision + 1,
    approval: { ...run.approval, approvedAt: ['READY', 'DISPATCHING', 'RUNNING', 'VERIFYING', 'VERIFIED_SUCCESS'].includes(phase) ? run.createdAt : run.approval.approvedAt },
    events: [...run.events, { sequence: run.events.length + 1, type: phase.toLowerCase(), at: run.updatedAt, detail: {} }], ...options })
}
export function makeReceipt(run = makeRun(), body = snapshot) {
  const receipt = { contractVersion: 'physicalsystems-run-receipt-v1', run, snapshot: body, physicalExecutionAuthorized: false }
  return { ...receipt, receiptDigest: executionDigest(receipt) }
}
