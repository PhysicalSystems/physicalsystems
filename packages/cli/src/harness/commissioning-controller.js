// SPDX-License-Identifier: Apache-2.0
import { executionFields as fields, executionHash as hash, executionId as id } from '../physical/execution-contracts.js'
import { commissioningUnresolved, commissioningFailureMessage, assertGripperCheckMatches, assertGripperRecoveryMatches, gripperRecoveryCleared } from '../physical/commissioning-client.js'

export const COMMISSIONING_MAXIMUM_AGE_MS = 5000
/** Operator-only gripper check. Reads never inspect hardware; a Node-owned trial
 * keeps its exact owner across connection loss, stopped views and unknown results. */
export function createCommissioningController({ client, initialStatus = null, recoveryOnly = false, canAct = () => true, onChange = () => {}, now = Date.now, pollMs = 1000 } = {}) {
  let status = initialStatus, available = false, receivedAt = null, message = null, pending = null, stopPending = false
  let recoveryStatus = null, recoveryAvailable = false, recoveryReceivedAt = null, recoveryMessage = null
  let recoveryRequestStatus = null
  const attemptedApprovals = new Set()
  const attemptedRecoveries = new Set()
  let disposed = false, timer = null, reading = null, epoch = 0, uncertain = false
  const emit = () => { if (!disposed) onChange() }
  const fresh = () => Boolean(available && receivedAt !== null && now() >= receivedAt && now() - receivedAt < COMMISSIONING_MAXIMUM_AGE_MS)
  const recoveryFresh = () => Boolean(recoveryAvailable && recoveryReceivedAt !== null && now() >= recoveryReceivedAt && now() - recoveryReceivedAt < COMMISSIONING_MAXIMUM_AGE_MS)
  const recoveryKey = (value) => `${value.nodeSessionId}:${value.trial?.trialId}:${value.recovery?.digest}`
  const active = () => commissioningUnresolved(status)
  const snapshot = () => ({ status: status ? { ...status, canApprove: status.canApprove && !attemptedApprovals.has(`${status.nodeSessionId}:${status.trial?.trialId}`) } : null, fresh: fresh(), available, receivedAt, maximumAgeMs: COMMISSIONING_MAXIMUM_AGE_MS,
    recoveryStatus: recoveryStatus ? { ...recoveryStatus, canConfirmRecovery: recoveryStatus.canConfirmRecovery && !attemptedRecoveries.has(recoveryKey(recoveryStatus)) } : null,
    recoveryAvailable, recoveryFresh: recoveryFresh(), recoveryReceivedAt,
    pending, stopPending, message: status?.trial?.phase === 'WAITING_FOR_APPROVAL' && attemptedApprovals.has(`${status.nodeSessionId}:${status.trial.trialId}`)
      ? 'Approval was already submitted. Its delivery is uncertain; request Stop instead of approving again.' : recoveryMessage ?? (recoveryAvailable ? recoveryStatus?.blockedReason : message), unresolved: active() || uncertain })
  const invalidate = (error, fallback) => { available = false; receivedAt = null; message = commissioningFailureMessage(error, fallback) }
  const invalidateRecovery = () => { ++epoch; recoveryAvailable = false; recoveryReceivedAt = null; emit() }
  async function cancelRecovery() {
    const current = recoveryRequestStatus, original = status
    invalidateRecovery()
    if (!current || current.nodeSessionId === original?.nodeSessionId) return
    // This cancels only the separately validated current recovery request. It
    // cannot acknowledge Stop for the original session's retained operation.
    assertGripperRecoveryMatches(current, original)
    const next = await client.stop({ expectedNodeSessionId: current.nodeSessionId, trialId: current.trial.trialId, reason: 'operator-requested-stop' })
    assertGripperRecoveryMatches(next, original)
  }
  const acceptRecovery = (next, expected) => {
    assertGripperRecoveryMatches(next, expected)
    recoveryStatus = next; recoveryAvailable = true; recoveryReceivedAt = now(); recoveryMessage = next.blockedReason
    if (gripperRecoveryCleared(next, expected)) { status = next; available = true; receivedAt = now(); uncertain = false }
  }
  const accept = (next) => {
    if (active()) {
      const before = status.trial, after = next.trial
      assertGripperCheckMatches(next, status)
      // An uncertain acknowledgement can be resolved by exact Node readback, but
      // Node's durable OUTCOME_UNKNOWN latch itself is never downgraded here.
      if ((before.phase === 'OUTCOME_UNKNOWN' && after.phase !== 'OUTCOME_UNKNOWN') || (before.phase === 'RUNNING' && after.phase === 'WAITING_FOR_APPROVAL')) throw new Error('Unknown trial cannot be silently cleared')
    }
    if (status?.trial?.trialId !== next.trial?.trialId || status?.trial?.digest !== next.trial?.digest) {
      recoveryStatus = recoveryRequestStatus = null; recoveryAvailable = false; recoveryReceivedAt = null; recoveryMessage = null
    }
    if (gripperRecoveryCleared(next, status || next)) { recoveryStatus = next; recoveryAvailable = true; recoveryReceivedAt = now(); recoveryMessage = next.blockedReason }
    status = next; available = true; receivedAt = now(); message = next.blockedReason; uncertain = false
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!disposed && (active() || uncertain)) { timer = setTimeout(() => { void refresh().finally(schedule) }, pollMs); timer.unref?.() }
  }
  const refreshRecovery = (next) => {
    if (!recoveryAvailable || !recoveryStatus?.recovery) return false
    assertGripperRecoveryMatches(next, status)
    if (next.nodeSessionId !== recoveryStatus.nodeSessionId || !next.recovery || next.recovery.digest !== recoveryStatus.recovery.digest || Date.parse(next.recovery.expiresAt) <= now()) {
      throw new Error('Recovery evidence changed or expired')
    }
    // An authenticated metadata read renews availability only for the exact
    // already inspected offer. It cannot create an offer or renew its expiry.
    recoveryStatus = next; recoveryReceivedAt = now(); recoveryMessage = next.blockedReason
    return true
  }
  async function refresh() {
    if (disposed || reading || pending || stopPending) return reading
    if (!client) { invalidate(null, 'This host does not provide the gripper check integration.'); emit(); return }
    const revision = epoch
    reading = (async () => {
      try {
        const next = await client.status()
        if (!disposed && revision === epoch) {
          const matchedRecovery = refreshRecovery(next)
          // Persisted owners are released only by the explicit service action
          // that durably removes their exact record. Current recovery metadata
          // also must not relabel an original operation from an older session.
          if (!recoveryOnly && !(matchedRecovery && next.nodeSessionId !== status.nodeSessionId)) accept(next)
        }
      }
      catch (error) {
        if (!disposed && revision === epoch) {
          if (recoveryAvailable) { recoveryAvailable = false; recoveryReceivedAt = null; recoveryMessage = 'Recovery status changed, expired or became unavailable. Check the current robot state again before confirming.' }
          invalidate(error, 'Gripper check status is unavailable. Retain the original trial; no outcome is assumed.')
        }
      }
      finally { reading = null; emit() }
    })()
    return reading
  }
  async function action(kind, body) {
    if (disposed || !client) throw new Error('Gripper check integration is unavailable')
    if (kind === 'refresh') { fields(body, []); await refresh(); schedule(); return snapshot() }
    if (kind === 'stop') {
      fields(body, ['trialId', 'reason']); id(body.trialId)
      if (body.reason !== 'operator-requested-stop' || !active() || status.trial.trialId !== body.trialId || stopPending) throw new Error('Request Stop for the exact unresolved gripper trial')
      const expected = status
      stopPending = true; emit()
      try {
        const [original, recovery] = await Promise.allSettled([client.stop({ expectedNodeSessionId: expected.nodeSessionId, trialId: expected.trial.trialId, reason: body.reason }), cancelRecovery()])
        if (original.status === 'rejected') throw original.reason
        if (recovery.status === 'rejected') throw recovery.reason
        if (gripperRecoveryCleared(original.value, expected)) throw new Error('Inspect the durable clearance separately; Stop does not acknowledge recovery')
        accept(original.value)
      }
      catch (error) { uncertain = true; recoveryMessage = null; invalidate(error, 'Gripper Stop is unconfirmed. Retain the trial and use the independent motor power cutoff.'); throw new Error(message) }
      finally { stopPending = false; emit(); schedule() }
      return snapshot()
    }
    if (kind === 'recoveryInspect' || kind === 'recoveryConfirm') {
      fields(body, ['trialId', 'trialDigest', ...(kind === 'recoveryConfirm' ? ['recoveryDigest', 'confirmed'] : [])]); id(body.trialId); hash(body.trialDigest)
      if (pending || stopPending || !canAct() || !active() || body.trialId !== status.trial.trialId || body.trialDigest !== status.trial.digest) throw new Error('Review recovery for the exact retained gripper trial on its connected owner')
      const expected = status, current = recoveryStatus
      if (kind === 'recoveryConfirm') {
        hash(body.recoveryDigest)
        if (!recoveryFresh() || !current?.canConfirmRecovery || !current.recovery?.ready || Date.parse(current.recovery.expiresAt) <= now() ||
          body.confirmed !== true || body.recoveryDigest !== current.recovery.digest || attemptedRecoveries.has(recoveryKey(current))) throw new Error('Explicitly confirm the exact fresh recovery inspection once')
        assertGripperRecoveryMatches(current, expected)
      }
      const revision = ++epoch; pending = kind; recoveryAvailable = false; recoveryReceivedAt = null; recoveryMessage = null
      if (kind === 'recoveryConfirm') attemptedRecoveries.add(recoveryKey(current))
      emit()
      try {
        let next
        if (kind === 'recoveryInspect') {
          const observed = assertGripperRecoveryMatches(await client.status(), expected)
          if (disposed || revision !== epoch || !canAct()) return snapshot()
          recoveryRequestStatus = observed
          if (gripperRecoveryCleared(observed, expected)) next = observed
          else {
            if (!observed.canInspectRecovery) throw new Error('This Node cannot inspect recovery for the retained trial')
            next = await client.recoveryInspect({ expectedNodeSessionId: observed.nodeSessionId, trialId: body.trialId, trialDigest: body.trialDigest })
          }
        } else { recoveryRequestStatus = current; next = await client.recoveryConfirm({ expectedNodeSessionId: current.nodeSessionId, ...body }) }
        if (!disposed && revision === epoch) acceptRecovery(next, expected)
      } catch (error) {
        if (revision === epoch) { recoveryAvailable = false; recoveryReceivedAt = null; recoveryMessage = commissioningFailureMessage(error, 'Recovery was not confirmed. The original outcome and ownership remain retained; inspect recovery status before continuing.'); throw new Error(recoveryMessage) }
      } finally { pending = null; emit(); schedule() }
      return snapshot()
    }
    if (pending || stopPending || !fresh() || !canAct()) throw new Error('Refresh the connected gripper check and wait for the current operation before acting')
    let payload
    if (kind === 'inspect') {
      fields(body, [])
      if (!status.canInspect || active() || uncertain) throw new Error('Resolve the existing trial before inspecting the gripper')
      payload = { expectedNodeSessionId: status.nodeSessionId }
    } else if (kind === 'prepare') {
      fields(body, ['configurationDigest', 'inspectionDigest', 'targetPosition']); hash(body.configurationDigest); hash(body.inspectionDigest)
      const c = status.configuration, i = status.inspection, target = body.targetPosition
      if (!status.canPrepare || active() || uncertain || !c || !i?.ready || Date.parse(i.expiresAt) <= now() || body.configurationDigest !== c.digest || body.inspectionDigest !== i.digest ||
          typeof target !== 'number' || !Number.isFinite(target) || target < c.minimum || target > c.maximum || Math.abs(target - i.gripperPosition) > c.maximumDelta || Math.abs(target - i.gripperPosition) <= c.tolerance) throw new Error('Review a fresh inspection and an absolute target inside the configured gripper limits')
      payload = { expectedNodeSessionId: status.nodeSessionId, ...body }
    } else if (kind === 'approve') {
      fields(body, ['trialId', 'trialDigest', 'approved']); id(body.trialId); hash(body.trialDigest)
      if (attemptedApprovals.has(`${status.nodeSessionId}:${status.trial?.trialId}`) || !status.canApprove || status.trial?.phase !== 'WAITING_FOR_APPROVAL' || status.trial.stopStatus !== null || uncertain || body.approved !== true || body.trialId !== status.trial.trialId || body.trialDigest !== status.trial.digest || Date.parse(status.trial.approvalExpiresAt) <= now()) throw new Error('Explicitly approve the exact current unexpired gripper proposal')
      payload = { expectedNodeSessionId: status.nodeSessionId, ...body }
    } else throw new Error('Unsupported gripper check action')
    const revision = ++epoch; pending = kind
    if (kind === 'approve') attemptedApprovals.add(`${status.nodeSessionId}:${status.trial.trialId}`)
    emit()
    try { const next = await client[kind](payload); if (!disposed && revision === epoch) accept(next) }
    catch (error) {
      if (revision === epoch) { uncertain = kind === 'approve' || kind === 'prepare'; invalidate(error, 'The gripper request was not confirmed. Refresh the exact trial or request Stop; do not repeat the action.'); throw new Error(message) }
    } finally { pending = null; emit(); schedule() }
    return snapshot()
  }
  return { snapshot, action, refresh, invalidateRecovery, cancelRecovery,
    dispose() { disposed = true; ++epoch; clearTimeout(timer) },
  }
}
