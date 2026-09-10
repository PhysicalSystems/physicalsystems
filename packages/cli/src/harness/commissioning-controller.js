// SPDX-License-Identifier: Apache-2.0
import { executionFields as fields, executionHash as hash, executionId as id } from '../physical/execution-contracts.js'
import { commissioningUnresolved, commissioningFailureMessage, assertGripperCheckMatches } from '../physical/commissioning-client.js'

export const COMMISSIONING_MAXIMUM_AGE_MS = 5000
/** Operator-only gripper check. Reads never inspect hardware; a Node-owned trial
 * keeps its exact owner across connection loss, stopped views and unknown results. */
export function createCommissioningController({ client, canAct = () => true, onChange = () => {}, now = Date.now, pollMs = 1000 } = {}) {
  let status = null, available = false, receivedAt = null, message = null, pending = null, stopPending = false
  const attemptedApprovals = new Set()
  let disposed = false, timer = null, reading = null, epoch = 0, uncertain = false
  const emit = () => { if (!disposed) onChange() }
  const fresh = () => Boolean(available && receivedAt !== null && now() >= receivedAt && now() - receivedAt < COMMISSIONING_MAXIMUM_AGE_MS)
  const active = () => commissioningUnresolved(status)
  const snapshot = () => ({ status: status ? { ...status, canApprove: status.canApprove && !attemptedApprovals.has(`${status.nodeSessionId}:${status.trial?.trialId}`) } : null, fresh: fresh(), available, receivedAt, maximumAgeMs: COMMISSIONING_MAXIMUM_AGE_MS,
    pending, stopPending, message: status?.trial?.phase === 'WAITING_FOR_APPROVAL' && attemptedApprovals.has(`${status.nodeSessionId}:${status.trial.trialId}`)
      ? 'Approval was already submitted. Its delivery is uncertain; request Stop instead of approving again.' : message, unresolved: active() || uncertain })
  const invalidate = (error, fallback) => { available = false; receivedAt = null; message = commissioningFailureMessage(error, fallback) }
  const accept = (next) => {
    if (active()) {
      const before = status.trial, after = next.trial
      assertGripperCheckMatches(next, status)
      // An uncertain acknowledgement can be resolved by exact Node readback, but
      // Node's durable OUTCOME_UNKNOWN latch itself is never downgraded here.
      if ((before.phase === 'OUTCOME_UNKNOWN' && after.phase !== 'OUTCOME_UNKNOWN') || (before.phase === 'RUNNING' && after.phase === 'WAITING_FOR_APPROVAL')) throw new Error('Unknown trial cannot be silently cleared')
    }
    status = next; available = true; receivedAt = now(); message = next.blockedReason; uncertain = false
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!disposed && (active() || uncertain)) { timer = setTimeout(() => { void refresh().finally(schedule) }, pollMs); timer.unref?.() }
  }
  async function refresh() {
    if (disposed || reading || pending || stopPending) return reading
    if (!client) { invalidate(null, 'This host does not provide the gripper check integration.'); emit(); return }
    const revision = epoch
    reading = (async () => {
      try { const next = await client.status(); if (!disposed && revision === epoch) accept(next) }
      catch (error) { if (!disposed && revision === epoch) invalidate(error, 'Gripper check status is unavailable. Retain the original trial; no outcome is assumed.') }
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
      ++epoch; stopPending = true; emit()
      try { accept(await client.stop({ expectedNodeSessionId: expected.nodeSessionId, trialId: expected.trial.trialId, reason: body.reason })) }
      catch (error) { uncertain = true; invalidate(error, 'Gripper Stop is unconfirmed. Retain the trial and use the independent motor power cutoff.'); throw new Error(message) }
      finally { stopPending = false; emit(); schedule() }
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
  return { snapshot, action, refresh,
    dispose() { disposed = true; ++epoch; clearTimeout(timer) },
  }
}
