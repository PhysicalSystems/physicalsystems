import { assertRunMatches, executionDigest, executionHash, executionId, executionRunId, normalizeExecutionSnapshot,
  normalizeExecutionStatus, normalizePhysicalRun, normalizePhysicalRunList, normalizePhysicalRunReceipt } from '../physical/execution-contracts.js'
import { projectExecutionObservation } from './execution-evidence.js'

const MAX_READ_AGE = 5000
const MAX_KNOWN_RUNS = 128
const PIN_IDS = ['capabilityId', 'implementationId', 'configurationId']
const PIN_DIGESTS = ['implementationDigest', 'configurationDigest', 'routeReceiptDigest', 'snapshotDigest']
const MESSAGES = Object.freeze({
  inspected: 'Read-only execution records inspected. A recorded result is historical evidence, not current readiness or permission to execute.',
  execution_unavailable: 'Execution inspection is unavailable. No run outcome is inferred. Check the local Node connection and use /workcell to inspect the operator view.',
  inspection_timeout: 'Execution inspection timed out. No run outcome is inferred. Wait for the bounded read to settle, then inspect again.',
  inspection_cancelled: 'Execution inspection was cancelled. No run outcome is inferred and no execution action was requested.',
  context_changed: 'The session, route or selected run changed during inspection. Inspect again in the current context; no result from the retired context is used.',
  inspection_expired: 'Execution inspection expired before it completed. Inspect again; no current state or run outcome is inferred.',
  selection_required: 'Several known runs exist. Ask which exact listed run to inspect, or select it in /workcell. Do not assume the newest run belongs to this task.',
  invalid_request: 'Inspect with no arguments, or with an exact runId previously returned by this tool or currently selected in /workcell. Paths, URLs and execution actions are not accepted.',
  inspection_busy: 'An execution inspection read is still pending. No duplicate read or execution action was started. Wait for it to settle before trying again.',
  disposed: 'This execution inspection session has ended. No read or execution action was started.',
  run_context_mismatch: 'The execution mode or exact run identity changed or failed validation. Inspect the current operator view; no matching result is assumed.',
})
const CONFIGURATION_MESSAGES = Object.freeze({
  matching: 'Matching installed configurations are available to review in /workcell. Installation and route selection do not establish current readiness or approval. Node preparation performs the exact checks.',
  missing_route: 'Obtain a successful capability route to identify matching installed configurations. A route does not authorize preparation or execution.',
  missing_configuration: 'No installed configuration matches the selected capability and implementation. The operator must configure and qualify the intended setup before preparation can succeed.',
  unavailable: 'Configuration availability could not be inspected. Check the local Node connection in /workcell; no readiness is assumed.',
})
class InspectionFailure extends Error {
  constructor(code) { super(code); this.code = code }
}
function check(condition) { if (!condition) throw new InspectionFailure('run_context_mismatch') }
async function joined(reads) {
  const results = await Promise.allSettled(reads)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
  return results.map((result) => result.value)
}
function pinRun(run) {
  executionRunId(run.runId)
  check(['simulation', 'physical'].includes(run.mode))
  const pinned = { runId: run.runId, mode: run.mode }
  for (const key of PIN_IDS) pinned[key] = executionId(run[key])
  for (const key of PIN_DIGESTS) pinned[key] = executionHash(run[key])
  check(Number.isSafeInteger(run.revision) && run.revision >= 0)
  pinned.revision = run.revision
  pinned.runDigest = executionHash(run.runDigest)
  return pinned
}
function matchPins(run, expected) {
  const { revision, runDigest, eventDigests, inputsDigest, approvalDigest, approvalExpiresAt, ...pins } = expected
  assertRunMatches(run, pins)
  check(run.revision >= revision && (run.revision !== revision || run.runDigest === runDigest))
  if (eventDigests) {
    check(run.events.length >= eventDigests.length)
    eventDigests.forEach((digest, index) => check(executionDigest(run.events[index]) === digest))
    check(executionDigest(run.inputs) === inputsDigest && run.approval.digest === approvalDigest && run.approval.expiresAt === approvalExpiresAt)
  }
  return run
}
function rememberRun(run) {
  // Preserve the existing client's immutable inputs/approval and append-only
  // event guarantees between observations without retaining private payloads.
  return { ...pinRun(run), eventDigests: run.events.map((event) => executionDigest(event)),
    inputsDigest: executionDigest(run.inputs), approvalDigest: run.approval.digest, approvalExpiresAt: run.approval.expiresAt }
}
function projectRoute(value) {
  if (value?.decision?.decision_status !== 'selected' || value.physicalExecutionAuthorized !== false) return null
  return { receiptDigest: executionHash(value.receiptDigest), capabilityId: executionId(value.capabilityId),
    implementationId: executionId(value.decision.selected_implementation_id) }
}
function summary(run) {
  return { ...pinRun(run), phase: run.phase, stopStatus: run.stopStatus, createdAt: run.createdAt, updatedAt: run.updatedAt,
    outcomeStatus: run.outcome?.status ?? null, historical: true }
}
function receiptUnavailable(status = 'not_requested') {
  return { status, historical: true, receiptDigest: null, runId: null, runDigest: null, snapshotDigest: null,
    configurationSnapshotDigest: null, evidenceDigest: null, preparation: null, verification: null,
    message: status === 'unavailable'
      ? 'The recorded run phase is available, but its receipt and referenced evidence could not be verified. Do not claim a verified result or infer a different Node outcome.'
      : 'No receipt has been inspected.' }
}
function base(code, status = 'unavailable') {
  return { contractVersion: 'physicalsystems-execution-inspection-v1',
    inspection: { status, observedAt: null, expiresAt: null, reasonCode: code, message: MESSAGES[code] },
    service: { availability: 'unavailable', mode: null }, route: null,
    configurationAvailability: { status: 'unavailable', matchingConfigurations: [], installedCount: null,
      message: CONFIGURATION_MESSAGES.unavailable }, runs: [], selectedRun: null, receipt: receiptUnavailable(),
    operatorPath: '/workcell', physicalExecutionAuthorized: false }
}

/** One bounded, read-only observation of Node-owned execution records.
 * The supplied client is a GET-only facade; this module never owns execution,
 * derives readiness, polls, or changes the browser's operator selection.
 */
export function createExecutionInspector({ client, getContext = () => ({}), now = Date.now, readTimeoutMs = MAX_READ_AGE } = {}) {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > MAX_READ_AGE) throw new TypeError('Invalid execution inspection timeout')
  let disposed = false, pending = null
  const known = new Map()
  const context = () => {
    const value = getContext() || {}
    return { generation: value.generation, route: projectRoute(value.route), selectedRun: value.selectedRun ? pinRun(value.selectedRun) : null }
  }
  async function inspect(args = {}, { signal } = {}) {
    if (disposed) return base('disposed', 'disposed')
    if (signal?.aborted) return base('inspection_cancelled')
    let initial, requested
    try {
      check(args && typeof args === 'object' && !Array.isArray(args))
      const keys = Object.keys(args)
      check(keys.length === 0 || (keys.length === 1 && keys[0] === 'runId'))
      initial = context()
      if (keys.length) {
        requested = executionRunId(args.runId)
        check(known.has(requested) || initial.selectedRun?.runId === requested)
      }
    } catch { return base('invalid_request', 'invalid_request') }
    if (pending) return base('inspection_busy', 'busy')
    if (!client) return base('execution_unavailable')

    const startedAt = now(), attempt = { active: true, code: null, cancel: null }
    let timer, abort
    const failure = (code) => base(code, code === 'disposed' ? 'disposed'
      : ['context_changed', 'inspection_expired'].includes(code) ? 'stale' : 'unavailable')
    const guard = (run = null) => {
      if (disposed) throw new InspectionFailure('disposed')
      if (!attempt.active) throw new InspectionFailure(attempt.code)
      const current = context()
      if (!Object.is(current.generation, initial.generation) || current.route?.receiptDigest !== initial.route?.receiptDigest
        || current.selectedRun?.runId !== initial.selectedRun?.runId) throw new InspectionFailure('context_changed')
      if (now() < startedAt || now() - startedAt >= MAX_READ_AGE) throw new InspectionFailure('inspection_expired')
      if (run && current.selectedRun?.runId === run.runId) matchPins(run, current.selectedRun)
    }
    const interrupted = new Promise((resolve) => {
      attempt.cancel = (code) => {
        if (!attempt.active) return
        attempt.active = false; attempt.code = code
        clearTimeout(timer)
        resolve(failure(code))
      }
    })
    pending = attempt
    timer = setTimeout(() => attempt.cancel('inspection_timeout'), readTimeoutMs)
    abort = () => attempt.cancel('inspection_cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    // Retain the pending slot until underlying GETs settle even after cancellation
    // or timeout. A hanging client cannot accumulate unbounded duplicate reads.
    const work = (async () => {
      try {
        guard()
        const [statusValue, listValue] = await joined([client.status(), client.runs()])
        guard()
        const status = normalizeExecutionStatus(statusValue), listing = normalizePhysicalRunList(listValue)
        if (status.availability !== 'available') return base('execution_unavailable')
        for (const run of listing.runs) {
          check(run.mode === status.mode)
          if (known.has(run.runId)) matchPins(run, known.get(run.runId))
          if (initial.selectedRun?.runId === run.runId) matchPins(run, initial.selectedRun)
        }
        const result = base('inspected', 'available')
        result.inspection.observedAt = new Date(startedAt).toISOString()
        result.inspection.expiresAt = new Date(startedAt + MAX_READ_AGE).toISOString()
        result.service = { availability: status.availability, mode: status.mode }
        result.route = initial.route
        // Route implementation digests identify the routing envelope. Execution
        // configuration implementationDigest identifies its executable artifact.
        // Match candidate IDs here; do not equate the two distinct digest roles.
        const matching = initial.route ? status.configurations.filter((item) => item.capabilityId === initial.route.capabilityId
          && item.implementationId === initial.route.implementationId) : []
        const configurationStatus = !initial.route ? 'missing_route' : matching.length ? 'matching' : 'missing_configuration'
        result.configurationAvailability = { status: configurationStatus, installedCount: status.configurations.length,
          matchingConfigurations: matching.slice(0, 32).map(({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode }) =>
            ({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode })),
          message: CONFIGURATION_MESSAGES[configurationStatus] }
        result.runs = listing.runs.map(summary)
        const selectedId = requested || initial.selectedRun?.runId || (listing.runs.length === 1 ? listing.runs[0].runId : null)
        if (!selectedId && listing.runs.length > 1) {
          result.inspection.status = 'selection_required'; result.inspection.reasonCode = 'selection_required'
          result.inspection.message = MESSAGES.selection_required
        }
        let selected = null
        if (selectedId) {
          const listed = listing.runs.find((item) => item.runId === selectedId)
          const expected = listed ? rememberRun(listed) : initial.selectedRun?.runId === selectedId ? initial.selectedRun : known.get(selectedId)
          check(expected)
          // The browser/model projection intentionally omits raw event details.
          // The client's revision check needs the complete event prefix, so pass
          // immutable pins to it and enforce our monotonic revision locally.
          const { revision, runDigest, ...immutablePins } = pinRun(expected)
          const value = await client.run(selectedId, immutablePins)
          guard()
          selected = matchPins(normalizePhysicalRun(value), expected)
          if (known.has(selectedId)) matchPins(selected, known.get(selectedId))
          check(selected.mode === status.mode)
          guard(selected)
          // A failed receipt read never changes the run's recorded phase. It only
          // withholds the evidence-verification claim and raw evidence payloads.
          try {
            const receipt = normalizePhysicalRunReceipt(await client.receipt(selectedId, selected), selected)
            guard(receipt.run)
            const snapshot = receipt.snapshot, recordedRun = receipt.run
            selected = recordedRun
            check(snapshot.contractVersion === 'physicalsystems-run-snapshot-v1')
            check(snapshot.configurationId === recordedRun.configurationId && snapshot.configurationSnapshotDigest === recordedRun.configurationDigest)
            check(snapshot.prepared && snapshot.prepared.mode === recordedRun.mode)
            for (const key of ['capabilityId', 'implementationId', 'implementationDigest', 'configurationDigest']) check(snapshot.prepared[key] === recordedRun[key])
            check(executionDigest(snapshot.prepared.inputs) === executionDigest(recordedRun.inputs))
            const configurationDigest = executionHash(snapshot.configurationSnapshotDigest)
            const evidenceDigest = recordedRun.outcome?.evidenceDigest
            const [configurationValue, evidenceValue] = await joined([
              client.snapshot(configurationDigest), evidenceDigest ? client.snapshot(evidenceDigest) : null,
            ])
            guard(recordedRun)
            const configuration = normalizeExecutionSnapshot(configurationValue, configurationDigest)
            const evidence = evidenceDigest ? normalizeExecutionSnapshot(evidenceValue, evidenceDigest) : null
            const preparation = projectExecutionObservation(snapshot.preparationObservation, { stage: 'preparation', at: recordedRun.createdAt, mode: recordedRun.mode })
            const verification = projectExecutionObservation(evidence?.snapshot, { stage: 'verification', at: recordedRun.updatedAt, mode: recordedRun.mode })
            check(preparation && (!evidenceDigest || verification))
            if (recordedRun.phase === 'VERIFIED_SUCCESS') check(verification?.verified === 'met')
            result.receipt = { status: 'verified', historical: true, receiptDigest: receipt.receiptDigest, runId: selected.runId,
              runDigest: selected.runDigest, snapshotDigest: selected.snapshotDigest, configurationSnapshotDigest: configuration.snapshotDigest,
              evidenceDigest: evidence?.snapshotDigest ?? null, preparation, verification,
              message: 'Receipt and referenced snapshots passed integrity and exact run checks. Observations describe their recorded times, not current readiness. Receipt verification does not change the recorded outcome.' }
          } catch (error) {
            guard(selected)
            result.receipt = receiptUnavailable('unavailable')
          }
          const installed = status.configurations.find((item) => item.configurationId === selected.configurationId)
          result.selectedRun = { ...summary(selected), currentConfiguration: !installed ? 'not_installed'
            : ['mode', 'capabilityId', 'implementationId', 'implementationDigest', 'configurationDigest'].every((key) => selected[key] === installed[key]) ? 'exact' : 'changed',
          routeRelationship: !initial.route ? 'no_route' : initial.route.receiptDigest === selected.routeReceiptDigest ? 'current' : 'historical' }
          result.runs = [summary(selected), ...result.runs.filter((run) => run.runId !== selected.runId)].slice(0, 32)
        }
        guard(selected)
        for (const run of result.runs) {
          const record = run.runId === selected?.runId ? selected : listing.runs.find((item) => item.runId === run.runId)
          known.delete(run.runId); known.set(run.runId, rememberRun(record))
        }
        while (known.size > MAX_KNOWN_RUNS) known.delete(known.keys().next().value)
        return result
      } catch (error) { return failure(error instanceof InspectionFailure ? error.code : 'execution_unavailable') }
      finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (pending === attempt) pending = null
      }
    })()
    return Promise.race([work, interrupted])
  }
  return Object.freeze({ inspect, dispose() { disposed = true; known.clear(); pending?.cancel('disposed') } })
}
