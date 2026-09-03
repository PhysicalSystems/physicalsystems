import { createHash } from 'node:crypto'

export const EXECUTION_STATUS_VERSION = 'physicalsystems-execution-status-v1'
export const PHYSICAL_RUN_VERSION = 'physicalsystems-run-v1'
export const RUN_PHASES = Object.freeze(['PREPARING', 'WAITING_FOR_APPROVAL', 'READY', 'DISPATCHING', 'RUNNING', 'VERIFYING', 'VERIFIED_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED', 'BLOCKED'])
export const STOP_PHASES = Object.freeze(['NOT_REQUESTED', 'STOP_REQUESTED', 'STOP_CONFIRMED', 'STOP_UNCONFIRMED'])
const numericTokens = new WeakMap()

function fail() { throw new TypeError('Execution response failed contract validation') }
function check(value) { if (!value) fail() }
function object(value) { check(value && typeof value === 'object' && !Array.isArray(value)); return value }
export function executionFields(value, keys) {
  object(value)
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)))
  return value
}
export function executionText(value, maximum = 256) {
  check(typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value))
  return value
}
export function executionId(value) { check(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)); return value }
export function executionRunId(value) { check(typeof value === 'string' && /^run-[0-9a-f]{32}$/.test(value)); return value }
export function executionHash(value) { check(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)); return value }
function integer(value) { check(Number.isSafeInteger(value) && value >= 0); return value }
function choice(value, values) { check(values.includes(value)); return value }
function timestamp(value) {
  executionText(value, 64)
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19))
  return value
}
function boundedArray(value, maximum = 256) { check(Array.isArray(value) && value.length <= maximum); return value }
function noAuthority(value) { check(value === false) }
function mode(value) { return choice(value, ['simulation', 'physical']) }
function unique(values) { check(new Set(values).size === values.length) }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }

/** Keep wire number spelling for Python's sorted-key JSON digests (1.0 != 1).
 * Unsafe integers are rejected, never rounded into seemingly matching evidence.
 */
export function parseExecutionJson(raw) {
  return JSON.parse(raw, function (key, value, context) {
    if (typeof value === 'number') {
      check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
      if (context?.source) {
        if (!numericTokens.has(this)) numericTokens.set(this, new Map())
        numericTokens.get(this).set(key, context.source)
      }
    }
    return value
  })
}

function compareKeys(a, b) {
  const left = [...a], right = [...b]
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const delta = left[i].codePointAt(0) - right[i].codePointAt(0)
    if (delta) return delta
  }
  return left.length - right.length
}
function canonical(value, excluded, depth = 0, parent, key, maximumDepth = 16) {
  check(depth <= maximumDepth)
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
    if (Number.isInteger(value)) return JSON.stringify(value)
    return numericTokens.get(parent)?.get(String(key)) ?? JSON.stringify(value)
  }
  if (typeof value === 'string') { check(value.length <= 65536 && value.isWellFormed()); return JSON.stringify(value) }
  if (Array.isArray(value)) { boundedArray(value, 4096); return `[${value.map((item, index) => canonical(item, null, depth + 1, value, index, maximumDepth)).join(',')}]` }
  object(value)
  check(Object.keys(value).length <= 512)
  return `{${Object.keys(value).filter((name) => name !== excluded).sort(compareKeys).map((name) => {
    check(name.length <= 256 && name.isWellFormed())
    return `${JSON.stringify(name)}:${canonical(value[name], null, depth + 1, value, name, maximumDepth)}`
  }).join(',')}}`
}
export function executionDigest(value, excluded = null) { return `sha256:${createHash('sha256').update(canonical(value, excluded, 0, undefined, undefined, 20), 'utf8').digest('hex')}` }
function sealed(value, field) { check(executionHash(value[field]) === executionDigest(value, field)) }
function jsonObject(value) { object(value); check(Buffer.byteLength(canonical(value, null)) <= 512 * 1024); return value }

export function normalizeExecutionStatus(value) {
  executionFields(value, ['contractVersion', 'availability', 'mode', 'configurations', 'reason', 'physicalExecutionAuthorized'])
  check(value.contractVersion === EXECUTION_STATUS_VERSION)
  choice(value.availability, ['available', 'unavailable'])
  if (value.mode !== null) mode(value.mode)
  if (value.reason !== null) executionText(value.reason, 512)
  noAuthority(value.physicalExecutionAuthorized)
  boundedArray(value.configurations, 128).forEach((item) => {
    executionFields(item, ['configurationId', 'displayName', 'capabilityId', 'implementationId', 'configurationDigest', 'implementationDigest', 'mode'])
    executionId(item.configurationId); executionText(item.displayName)
    executionId(item.capabilityId); executionId(item.implementationId)
    executionHash(item.configurationDigest); executionHash(item.implementationDigest); mode(item.mode)
    if (value.mode !== null) check(item.mode === value.mode)
  })
  unique(value.configurations.map((item) => item.configurationId))
  if (value.availability === 'available') check(value.mode !== null)
  return freeze(value)
}

export function normalizePhysicalRun(value) {
  executionFields(value, ['contractVersion', 'runId', 'revision', 'runDigest', 'phase', 'stopStatus', 'mode', 'capabilityId', 'implementationId', 'implementationDigest', 'configurationId', 'configurationDigest', 'routeReceiptDigest', 'inputs', 'snapshotDigest', 'approval', 'createdAt', 'updatedAt', 'events', 'outcome', 'physicalExecutionAuthorized'])
  check(value.contractVersion === PHYSICAL_RUN_VERSION)
  executionRunId(value.runId); integer(value.revision); choice(value.phase, RUN_PHASES); choice(value.stopStatus, STOP_PHASES); mode(value.mode)
  for (const key of ['capabilityId', 'implementationId', 'configurationId']) executionId(value[key])
  for (const key of ['implementationDigest', 'configurationDigest', 'routeReceiptDigest', 'snapshotDigest']) executionHash(value[key])
  jsonObject(value.inputs)
  executionFields(value.approval, ['digest', 'expiresAt', 'approvedAt'])
  executionHash(value.approval.digest); timestamp(value.approval.expiresAt)
  if (value.approval.approvedAt !== null) { timestamp(value.approval.approvedAt); check(Date.parse(value.approval.approvedAt) <= Date.parse(value.approval.expiresAt)) }
  timestamp(value.createdAt); timestamp(value.updatedAt)
  check(Date.parse(value.updatedAt) >= Date.parse(value.createdAt))
  let previousSequence = 0
  boundedArray(value.events, 1024).forEach((event) => {
    executionFields(event, ['sequence', 'type', 'at', 'detail'])
    integer(event.sequence); check(event.sequence === previousSequence + 1); previousSequence = event.sequence
    check(typeof event.type === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(event.type)); timestamp(event.at); jsonObject(event.detail)
  })
  if (value.outcome !== null) {
    executionFields(value.outcome, ['status', 'reason', 'evidenceDigest'])
    choice(value.outcome.status, ['VERIFIED_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED', 'BLOCKED']); executionText(value.outcome.reason, 512)
    if (value.outcome.evidenceDigest !== null) executionHash(value.outcome.evidenceDigest)
    check(value.outcome.status === value.phase)
  }
  if (['READY', 'DISPATCHING', 'RUNNING', 'VERIFYING', 'VERIFIED_SUCCESS'].includes(value.phase)) check(value.approval.approvedAt !== null)
  if (value.phase === 'WAITING_FOR_APPROVAL') check(value.approval.approvedAt === null)
  if (value.phase === 'VERIFIED_SUCCESS') check(value.outcome?.status === 'VERIFIED_SUCCESS' && value.outcome.evidenceDigest !== null)
  noAuthority(value.physicalExecutionAuthorized)
  sealed(value, 'runDigest')
  return freeze(value)
}

export function normalizePhysicalRunList(value) {
  executionFields(value, ['contractVersion', 'runs', 'physicalExecutionAuthorized'])
  check(value.contractVersion === 'physicalsystems-run-list-v1'); noAuthority(value.physicalExecutionAuthorized)
  boundedArray(value.runs, 32).forEach(normalizePhysicalRun)
  unique(value.runs.map((item) => item.runId))
  return freeze(value)
}

export function assertRunMatches(run, expected) {
  for (const key of ['runId', 'mode', 'capabilityId', 'implementationId', 'implementationDigest', 'configurationId', 'configurationDigest', 'routeReceiptDigest', 'snapshotDigest']) {
    if (Object.hasOwn(expected, key)) check(run[key] === expected[key])
  }
  if (expected.inputs) check(canonical(JSON.parse(JSON.stringify(run.inputs))) === canonical(JSON.parse(JSON.stringify(expected.inputs))))
  if (expected.approval) check(run.approval.digest === expected.approval.digest && run.approval.expiresAt === expected.approval.expiresAt)
  if (expected.revision !== undefined) {
    check(run.revision >= expected.revision)
    if (run.revision === expected.revision) check(run.runDigest === expected.runDigest)
    check(run.events.length >= expected.events.length)
    expected.events.forEach((event, index) => check(canonical(run.events[index]) === canonical(event)))
  }
  return run
}

export function normalizePhysicalRunReceipt(value, expected = {}) {
  executionFields(value, ['contractVersion', 'run', 'snapshot', 'receiptDigest', 'physicalExecutionAuthorized'])
  check(value.contractVersion === 'physicalsystems-run-receipt-v1'); noAuthority(value.physicalExecutionAuthorized)
  assertRunMatches(normalizePhysicalRun(value.run), expected)
  jsonObject(value.snapshot); check(Object.keys(value.snapshot).length > 0)
  check(executionDigest(value.snapshot) === value.run.snapshotDigest)
  sealed(value, 'receiptDigest')
  return freeze(value)
}

export function normalizeExecutionSnapshot(value, expectedDigest) {
  executionFields(value, ['contractVersion', 'snapshotDigest', 'snapshot', 'physicalExecutionAuthorized'])
  check(value.contractVersion === 'physicalsystems-snapshot-v1'); noAuthority(value.physicalExecutionAuthorized)
  check(executionHash(value.snapshotDigest) === executionHash(expectedDigest))
  jsonObject(value.snapshot); check(Object.keys(value.snapshot).length > 0)
  check(executionDigest(value.snapshot) === expectedDigest)
  return freeze(value)
}
