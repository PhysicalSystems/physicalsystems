import { randomUUID } from 'node:crypto'
import { assertRunMatches, executionFields, executionHash, executionId, executionRunId } from '../physical/execution-contracts.js'
import { executionFailureMessage } from '../physical/execution-client.js'
import { projectExecutionObservation } from './execution-evidence.js'

const TERMINAL = new Set(['VERIFIED_SUCCESS', 'FAILED', 'CANCELLED', 'BLOCKED'])
const MAX_READ_AGE = 5000
const printable = (value, length = 512) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, length)
const summary = (run) => ({ runId: run.runId, runDigest: run.runDigest, phase: run.phase, stopStatus: run.stopStatus,
  mode: run.mode, capabilityId: run.capabilityId, configurationId: run.configurationId, updatedAt: run.updatedAt })
function projectRun(run) {
  if (!run) return null
  return { ...summary(run), revision: run.revision, implementationId: run.implementationId, implementationDigest: run.implementationDigest,
    configurationDigest: run.configurationDigest, routeReceiptDigest: run.routeReceiptDigest, snapshotDigest: run.snapshotDigest,
    inputs: Object.fromEntries(Object.entries(run.inputs).slice(0, 128).map(([key, value]) => [key, printable(value)])),
    approval: run.approval, createdAt: run.createdAt, outcome: run.outcome,
    events: run.events.slice(-32).map(({ sequence, type, at }) => ({ sequence, type, at })),
    physicalExecutionAuthorized: false }
}

/** An operator channel alongside the same agent session, not an execution owner.
 * Closing this view never retries, resumes or replaces Node-owned controller work.
 */
export function createExecutionController({ client, currentRoute = () => null, canPrepare = () => true,
  onChange = () => {}, now = Date.now, pollMs = 1000 } = {}) {
  let disposed = false, viewers = 0, timer = null, readPending = null
  let actionPending = null, stopPending = false
  let availability = 'unchecked', status = null, error = null, runs = [], run = null, receipt = null
  let observedAt = 0, contextRevision = 0
  const emit = () => { if (!disposed) onChange() }
  const fresh = () => availability === 'available' && now() >= observedAt && now() - observedAt < MAX_READ_AGE
  const route = () => {
    const value = currentRoute()
    return value?.decision?.decision_status === 'selected' && value.physicalExecutionAuthorized === false ? value : null
  }
  const eligibleConfigurations = () => {
    const value = route()
    return value && status?.availability === 'available' ? status.configurations.filter((item) => item.capabilityId === value.capabilityId
      && item.implementationId === value.decision.selected_implementation_id) : []
  }
  const unresolved = () => runs.some((item) => !TERMINAL.has(item.phase)) || (run && !TERMINAL.has(run.phase))
  const configurationReason = () => {
    if (!status || status.availability !== 'available') return 'No available installed configuration. Configure a trusted local controller and observation source first.'
    if (!status.configurations.length) return 'No local configuration is installed.'
    if (!route()) return `${status.configurations.length} local configuration(s) installed. Obtain a successful capability route before selecting one.`
    if (!eligibleConfigurations().length) return 'Installed configurations do not match the capability and implementation selected by this route.'
    if (unresolved()) return 'An unresolved invocation must be stopped or reconciled before preparing another.'
    return 'Select the exact local configuration. Installation and route selection do not establish current physical readiness.'
  }
  const approvalReady = () => Boolean(fresh() && !actionPending && !stopPending && canPrepare() && run?.phase === 'WAITING_FOR_APPROVAL'
    && run.stopStatus === 'NOT_REQUESTED' && run.approval.approvedAt === null && Date.parse(run.approval.expiresAt) > now()
    && route()?.receiptDigest === run.routeReceiptDigest
    && eligibleConfigurations().some((item) => item.configurationId === run.configurationId && item.configurationDigest === run.configurationDigest
      && item.implementationDigest === run.implementationDigest && item.mode === run.mode))
  const snapshot = () => ({ availability, status: status ? { availability: status.availability, mode: status.mode, reason: status.reason } : null,
    error, receivedAt: observedAt ? new Date(observedAt).toISOString() : null,
    pending: actionPending, stopPending, configurations: eligibleConfigurations(), configurationReason: configurationReason(), runs: runs.slice(0, 32).map(summary), run: projectRun(run), receipt,
    canPrepare: Boolean(!disposed && fresh() && !actionPending && !stopPending && canPrepare() && !unresolved() && eligibleConfigurations().length),
    canApprove: !disposed && approvalReady(), canStop: Boolean(!disposed && run && (!TERMINAL.has(run.phase) || run.stopStatus === 'STOP_UNCONFIRMED') && !stopPending),
    canReconcile: Boolean(!disposed && fresh() && run?.phase === 'OUTCOME_UNKNOWN' && !actionPending && !stopPending), physicalExecutionAuthorized: false })
  const acceptRun = (value) => {
    if (run?.runId === value.runId) {
      if (value.revision < run.revision) return false // A slow poll cannot replace a newer stop/approval result.
      assertRunMatches(value, run)
    }
    run = value
    runs = [value, ...runs.filter((item) => item.runId !== value.runId)].slice(0, 128)
    if (receipt?.runDigest !== value.runDigest) receipt = null
    return true
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!disposed && viewers) { timer = setTimeout(() => { void refresh().finally(schedule) }, pollMs); timer.unref?.() }
  }
  async function refresh() {
    if (disposed || readPending) return readPending
    if (!client) { availability = 'unavailable'; error = 'Execution integration is unavailable'; emit(); return }
    readPending = (async () => {
      try {
        const [statusResult, listingResult] = await Promise.allSettled([client.status(), client.runs()])
        if (disposed) return
        if (statusResult.status === 'fulfilled') status = statusResult.value
        if (statusResult.status === 'rejected') throw statusResult.reason
        if (listingResult.status === 'rejected') throw listingResult.reason
        const nextStatus = statusResult.value, listing = listingResult.value
        const known = new Map(runs.map((item) => [item.runId, item]))
        runs = listing.runs.map((item) => {
          const previous = known.get(item.runId)
          if (previous && item.revision < previous.revision) return previous
          if (previous) assertRunMatches(item, previous)
          return item
        })
        if (run && !runs.some((item) => item.runId === run.runId)) runs.unshift(run)
        if (!run) run = runs.find((item) => !TERMINAL.has(item.phase)) || null
        if (run) {
          const expected = run
          const value = await client.run(expected.runId, expected)
          if (disposed) return
          if (run?.runId === expected.runId) acceptRun(value)
        }
        availability = nextStatus.availability
        error = nextStatus.reason
        observedAt = now()
        emit()
      } catch (failure) {
        if (!disposed) { availability = 'unavailable'; error = status?.availability === 'unavailable' && status.reason
          ? status.reason : executionFailureMessage(failure, 'Execution status is unavailable. No outcome is assumed; Stop remains available for the known run.'); emit() }
      }
    })().finally(() => { readPending = null })
    return readPending
  }
  async function action(kind, body) {
    if (disposed || !client) throw new Error('Execution integration is unavailable')
    if (kind === 'refresh') { executionFields(body, []); await refresh(); return snapshot() }
    if (kind === 'stop') {
      executionFields(body, ['runId', 'reason']); executionRunId(body.runId)
      if (!run || run.runId !== body.runId || stopPending) throw new Error('Select the known run before requesting stop')
      if (body.reason !== 'operator-requested-stop') throw new TypeError('Unsupported stop reason')
      stopPending = true; emit()
      const expected = run
      try {
        const value = await client.stop(run.runId, { reason: body.reason }, expected)
        if (!disposed && run?.runId === expected.runId) { acceptRun(value); error = null }
      } catch {
        if (!disposed) { availability = 'unavailable'; error = 'Stop could not be confirmed. Treat the outcome as unknown and use the physical stop procedure.' }
        throw new Error('Stop could not be confirmed; use the physical stop procedure')
      } finally { stopPending = false; emit() }
      return snapshot()
    }
    if (actionPending || stopPending) throw new Error('An operator execution request is already pending')
    if (kind === 'select' || kind === 'receipt') {
      executionFields(body, ['runId']); executionRunId(body.runId)
      const known = runs.find((item) => item.runId === body.runId)
      if (!known) throw new Error('Refresh and select a known run')
      actionPending = kind; emit()
      try {
        if (kind === 'select') {
          const value = await client.run(body.runId, known)
          if (!disposed) { run = null; acceptRun(value); receipt = null }
        } else {
          const value = await client.receipt(body.runId, known)
          const configurationDigest = value.snapshot.contractVersion === 'physicalsystems-run-snapshot-v1' ? value.snapshot.configurationSnapshotDigest : null
          if (configurationDigest && configurationDigest !== value.run.configurationDigest) throw new Error('Receipt configuration reference does not match the run')
          const evidenceDigest = value.run.outcome?.evidenceDigest
          const [configurationSnapshot, evidenceSnapshot] = await Promise.all([
            configurationDigest ? client.snapshot(configurationDigest) : null,
            evidenceDigest ? client.snapshot(evidenceDigest) : null,
          ])
          if (!disposed && run?.runId === value.run.runId && acceptRun(value.run)) {
            receipt = { receiptDigest: value.receiptDigest, runId: value.run.runId, runDigest: value.run.runDigest, snapshotDigest: value.run.snapshotDigest,
              configurationSnapshotDigest: configurationSnapshot?.snapshotDigest || null, evidenceDigest: evidenceSnapshot?.snapshotDigest || null,
              preparation: projectExecutionObservation(value.snapshot.preparationObservation, { stage: 'preparation', at: value.run.createdAt, mode: value.run.mode }),
              verification: projectExecutionObservation(evidenceSnapshot?.snapshot, { stage: 'verification', at: value.run.updatedAt, mode: value.run.mode }) }
          }
        }
        return snapshot()
      } finally { actionPending = null; emit() }
    }
    if (kind === 'prepare') {
      executionFields(body, ['configurationId', 'expectedConfigurationDigest', 'routeReceiptDigest'])
      executionId(body.configurationId); executionHash(body.expectedConfigurationDigest); executionHash(body.routeReceiptDigest)
      const selected = eligibleConfigurations().find((item) => item.configurationId === body.configurationId && item.configurationDigest === body.expectedConfigurationDigest)
      const current = route()
      if (!snapshot().canPrepare || !selected || current?.receiptDigest !== body.routeReceiptDigest) throw new Error('A current successful route and available exact configuration are required')
      actionPending = kind; emit()
      try {
        const value = await client.prepare({ contractVersion: 'physicalsystems-run-prepare-v1', configurationId: selected.configurationId,
          expectedConfigurationDigest: selected.configurationDigest, routeReceiptDigest: current.receiptDigest, idempotencyKey: `prepare-${randomUUID()}` },
        { mode: selected.mode, capabilityId: current.capabilityId, implementationId: selected.implementationId, implementationDigest: selected.implementationDigest,
          inputs: Object.fromEntries(current.request.arguments.map((argument) => [argument.name, argument.value])) })
        if (!disposed) { run = null; acceptRun(value); receipt = null; error = null }
      } catch (failure) {
        if (!disposed) { availability = 'unavailable'; error = executionFailureMessage(failure, 'Preparation was not confirmed. Refresh run history before attempting another preparation.') }
        throw new Error(executionFailureMessage(failure, 'Preparation was not confirmed; inspect run history, do not blindly repeat'))
      } finally { actionPending = null; emit() }
      return snapshot()
    }
    if (!run || body?.runId !== run.runId || body?.expectedRunDigest !== run.runDigest) throw new Error('Run changed; review the current run before acting')
    const expected = run, currentContext = contextRevision
    if (kind === 'approve') {
      executionFields(body, ['runId', 'expectedRunDigest', 'approvalDigest', 'approved'])
      if (!approvalReady() || body.approved !== true || body.approvalDigest !== run.approval.digest) throw new Error('Review and explicitly approve the current unexpired run')
    } else if (kind === 'reconcile') {
      executionFields(body, ['runId', 'expectedRunDigest'])
      if (!snapshot().canReconcile) throw new Error('Only an uncertain run can be reconciled; no retry will be issued')
    } else throw new TypeError('Unsupported operator execution action')
    actionPending = kind; emit()
    try {
      // No deferred auto-dispatch, retry, fallback or second planner.
      if (disposed || currentContext !== contextRevision) throw new Error('Workcell changed')
      const value = kind === 'approve'
        ? await client.approve(expected.runId, { expectedRunDigest: expected.runDigest, approvalDigest: body.approvalDigest, approved: true }, expected)
        : await client.reconcile(expected.runId, { expectedRunDigest: expected.runDigest }, expected)
      if (!disposed && run?.runId === expected.runId) { acceptRun(value); error = null }
    } catch {
      if (!disposed) { availability = 'unavailable'; error = 'Run action was not confirmed. No success or retry is assumed; refresh or request Stop.' }
      throw new Error('Run action was not confirmed; inspect the same run before acting again')
    } finally { actionPending = null; emit() }
    return snapshot()
  }
  return {
    snapshot, refresh, action,
    contextChanged() { contextRevision += 1; emit() },
    connect() { viewers += 1; void refresh().finally(schedule); let closed = false; return () => { if (closed) return; closed = true; viewers = Math.max(0, viewers - 1); if (!viewers) clearTimeout(timer) } },
    dispose() { disposed = true; clearTimeout(timer) },
  }
}
