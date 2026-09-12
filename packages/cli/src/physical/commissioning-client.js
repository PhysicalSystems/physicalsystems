// SPDX-License-Identifier: Apache-2.0
import { normalizePhysicalNodeUrl } from './node-client.js'
import { executionFields as fields, executionHash as hash, executionId as id, executionText as text, executionDigest, parseExecutionJson } from './execution-contracts.js'

export const GRIPPER_CHECK_VERSION = 'physicalsystems-gripper-check-v1'
export const GRIPPER_JOINTS = Object.freeze(['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'])
const ROOT = '/v2/physical/commissioning/gripper'
const assert = (condition) => { if (!condition) throw new TypeError('Gripper check response failed contract validation') }
const number = (value, minimum = -100000, maximum = 100000) => assert(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum)
const date = (value) => { text(value, 64); assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value))) }
const optionalText = (value) => { if (value !== null) text(value, 512) }
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
const RECOVERY_FIELDS = ['trialNodeSessionId', 'recovery', 'recoveryClearance', 'canInspectRecovery', 'canConfirmRecovery']
const RECOVERY_BINDING = ['trialId', 'trialDigest', 'trialNodeSessionId', 'nodeSessionId', 'configurationDigest', 'deviceIdentity']
function recoveryBinding(value) {
  for (const key of ['trialId', 'trialNodeSessionId', 'nodeSessionId']) id(value[key])
  hash(value.trialDigest); hash(value.configurationDigest); text(value.deviceIdentity)
}
function recoveryReceipt(value) {
  fields(value, ['id', 'digest', ...RECOVERY_BINDING, 'recoveryDigest', 'confirmedAt', 'inspectionDigest', 'priorRunDigest', 'priorRevision'])
  id(value.id); hash(value.digest); recoveryBinding(value); hash(value.recoveryDigest); date(value.confirmedAt)
  hash(value.inspectionDigest); hash(value.priorRunDigest); assert(Number.isSafeInteger(value.priorRevision) && value.priorRevision > 0)
  assert(value.digest === executionDigest(value, 'digest'))
  return value
}
const originSession = (value) => value.trialNodeSessionId ?? value.nodeSessionId
function recoveryMatches(value, expected) {
  return Boolean(expected?.trial && expected.configuration && value.trialId === expected.trial.trialId && value.trialDigest === expected.trial.digest &&
    value.trialNodeSessionId === originSession(expected) && value.configurationDigest === expected.configuration.digest && value.deviceIdentity === expected.configuration.deviceIdentity)
}
export function gripperRecoveryCleared(value, expected = value) {
  if (value?.trial?.phase !== 'OUTCOME_UNKNOWN' || !value.recoveryClearance) return false
  recoveryReceipt(value.recoveryClearance)
  return recoveryMatches(value.recoveryClearance, value) && recoveryMatches(value.recoveryClearance, expected)
}
/** Recovery alone may bind a restarted responder to the immutable old trial. */
export function assertGripperRecoveryMatches(value, expected) {
  assert(value.trial?.phase === 'OUTCOME_UNKNOWN' && expected?.trial && value.configuration && expected.configuration)
  assert(value.trialNodeSessionId === originSession(expected) && value.configuration.digest === expected.configuration.digest && value.configuration.deviceIdentity === expected.configuration.deviceIdentity)
  assert(['trialId', 'digest', 'startPosition', 'targetPosition', 'maximumDurationSeconds', 'approvalExpiresAt'].every((key) => value.trial[key] === expected.trial[key]))
  return value
}

export function normalizeGripperCheck(value) {
  const recoverySupported = RECOVERY_FIELDS.some((key) => Object.hasOwn(value || {}, key))
  fields(value, ['contractVersion', 'nodeSessionId', 'configuration', 'inspection', 'trial', 'canInspect', 'canPrepare', 'canApprove', 'canStop', 'blockedReason', ...(recoverySupported ? RECOVERY_FIELDS : [])])
  assert(value.contractVersion === GRIPPER_CHECK_VERSION); id(value.nodeSessionId)
  for (const key of ['canInspect', 'canPrepare', 'canApprove', 'canStop']) assert(typeof value[key] === 'boolean')
  optionalText(value.blockedReason)
  const c = value.configuration, i = value.inspection, t = value.trial
  if (c !== null) {
    fields(c, ['id', 'digest', 'displayName', 'deviceIdentity', 'calibrationDigest', 'minimum', 'maximum', 'maximumDelta', 'maximumDurationSeconds', 'maximumStep', 'stepIntervalSeconds', 'tolerance'])
    id(c.id); hash(c.digest); text(c.displayName); text(c.deviceIdentity); hash(c.calibrationDigest)
    for (const key of ['minimum', 'maximum', 'maximumDelta', 'maximumStep', 'tolerance']) number(c[key], 0, 100)
    number(c.maximumDurationSeconds, 0.001, 120); number(c.stepIntervalSeconds, 0.001, 10)
    assert(c.minimum < c.maximum && c.maximumDelta > 0 && c.maximumStep > 0 && c.tolerance > 0 && c.maximumStep <= c.maximumDelta)
  }
  if (i !== null) {
    fields(i, ['id', 'digest', 'observedAt', 'expiresAt', 'ready', 'positions', 'torqueEnabled', 'checks', 'gripperPosition'])
    id(i.id); hash(i.digest); date(i.observedAt); date(i.expiresAt); assert(Date.parse(i.expiresAt) > Date.parse(i.observedAt))
    assert(typeof i.ready === 'boolean'); fields(i.positions, GRIPPER_JOINTS); fields(i.torqueEnabled, GRIPPER_JOINTS)
    GRIPPER_JOINTS.forEach((joint) => { if (i.positions[joint] !== null) number(i.positions[joint]); assert(i.torqueEnabled[joint] === null || typeof i.torqueEnabled[joint] === 'boolean') })
    if (i.gripperPosition !== null) number(i.gripperPosition)
    assert(Array.isArray(i.checks) && i.checks.length <= 64)
    i.checks.forEach((check) => { fields(check, ['code', 'state', 'message']); text(check.code, 128); assert(['met', 'violated', 'unknown'].includes(check.state)); text(check.message, 512) })
    if (i.ready) assert(i.gripperPosition !== null && GRIPPER_JOINTS.every((joint) => i.positions[joint] !== null && i.torqueEnabled[joint] === false) && i.checks.length > 0 && i.checks.every((check) => check.state === 'met'))
  }
  if (t !== null) {
    fields(t, ['trialId', 'digest', 'phase', 'approvalExpiresAt', 'startPosition', 'targetPosition', 'maximumDurationSeconds', 'latestPosition', 'stopStatus', 'message'])
    id(t.trialId); hash(t.digest); assert(['WAITING_FOR_APPROVAL', 'RUNNING', 'COMPLETED', 'STOPPED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(t.phase))
    date(t.approvalExpiresAt); number(t.startPosition); number(t.targetPosition, 0, 100); number(t.maximumDurationSeconds, 0.001, 120)
    if (t.latestPosition !== null) number(t.latestPosition)
    assert([null, 'STOPPING', 'STOPPED', 'STOP_UNCONFIRMED'].includes(t.stopStatus)); optionalText(t.message)
    if (t.phase === 'COMPLETED') assert(t.stopStatus === 'STOPPED' && t.latestPosition !== null)
  }
  if (value.canPrepare) assert(c !== null && i?.ready === true)
  if (value.canApprove) assert(c !== null && t?.phase === 'WAITING_FOR_APPROVAL' && t.stopStatus === null)
  if (value.canStop) assert(t !== null)
  if (recoverySupported) {
    assert(typeof value.canInspectRecovery === 'boolean' && typeof value.canConfirmRecovery === 'boolean')
    if (t) id(value.trialNodeSessionId); else assert(value.trialNodeSessionId === null)
    const offer = value.recovery
    if (offer !== null) {
      fields(offer, ['id', 'digest', ...RECOVERY_BINDING, 'observedAt', 'expiresAt', 'ready', 'positions', 'torqueEnabled', 'checks'])
      id(offer.id); hash(offer.digest); recoveryBinding(offer); date(offer.observedAt); date(offer.expiresAt)
      assert(Date.parse(offer.expiresAt) > Date.parse(offer.observedAt) && typeof offer.ready === 'boolean')
      fields(offer.positions, GRIPPER_JOINTS); fields(offer.torqueEnabled, GRIPPER_JOINTS)
      GRIPPER_JOINTS.forEach((joint) => { number(offer.positions[joint]); assert(typeof offer.torqueEnabled[joint] === 'boolean') })
      assert(Array.isArray(offer.checks) && offer.checks.length > 0 && offer.checks.length <= 64)
      offer.checks.forEach((check) => { fields(check, ['code', 'state', 'message']); text(check.code, 128); assert(['met', 'violated', 'unknown'].includes(check.state)); text(check.message, 512) })
      if (offer.ready) assert(GRIPPER_JOINTS.every((joint) => offer.torqueEnabled[joint] === false) && offer.checks.every((check) => check.state === 'met'))
      assert(offer.digest === executionDigest(offer, 'digest') && recoveryMatches(offer, value) && offer.nodeSessionId === value.nodeSessionId && t.phase === 'OUTCOME_UNKNOWN')
    }
    if (value.recoveryClearance !== null) recoveryReceipt(value.recoveryClearance)
    if (value.canInspectRecovery || value.canConfirmRecovery) assert(t?.phase === 'OUTCOME_UNKNOWN' && c !== null && !gripperRecoveryCleared(value))
    if (value.canConfirmRecovery) assert(offer?.ready === true)
  }
  return freeze(value)
}

export const commissioningUnresolved = (status) => Boolean(status?.trial && !gripperRecoveryCleared(status) && (!['COMPLETED', 'STOPPED', 'FAILED'].includes(status.trial.phase) || status.trial.stopStatus !== 'STOPPED'))
export function assertGripperCheckMatches(value, expected) {
  assert(value.nodeSessionId === expected.nodeSessionId && value.configuration?.digest === expected.configuration?.digest)
  assert(value.trial && expected.trial && ['trialId', 'digest', 'startPosition', 'targetPosition', 'maximumDurationSeconds', 'approvalExpiresAt'].every((key) => value.trial[key] === expected.trial[key]))
  return value
}
export class CommissioningHttpError extends Error {}
export const commissioningFailureMessage = (error, fallback) => error instanceof CommissioningHttpError ? error.message : fallback

async function readJson(response) {
  assert(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json')
  const length = response.headers.get('content-length')
  assert(length === null || (/^[0-9]+$/.test(length) && Number(length) <= 65536))
  const reader = response.body?.getReader?.(); assert(reader)
  let size = 0; const chunks = []
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; assert(size <= 65536); chunks.push(value) }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return parseExecutionJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

/** Authenticated operator closure only. No credential or mutation is a model tool. */
export function createCommissioningClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  async function request(action, body) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new CommissioningHttpError('Gripper check requires an execution credential saved in the native encrypted credential store.')
    try {
      const url = new URL(`${ROOT}${action ? `/${action}` : ''}`, origin)
      const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(action === 'inspect' || action.startsWith('recovery/') ? 35000 : 5000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      assert(!response.redirected && response.type !== 'opaqueredirect' && (!response.url || response.url === url.href))
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        const error = new CommissioningHttpError(({ 401: 'The Node rejected the execution credential.', 403: 'This gripper check request was not permitted.',
          404: 'This Node does not support the gripper check.', 501: 'This Node does not support the gripper check.',
          409: 'The Node session, inspection or trial changed. Refresh and review its retained state.',
          422: 'The robot did not meet the configured gripper check requirements. Inspect its current state.',
          503: 'Gripper check is unavailable on this Node.' })[response.status] || 'The gripper check request was not confirmed.')
        error.status = response.status; throw error
      }
      const status = normalizeGripperCheck(await readJson(response))
      if (body && status.nodeSessionId !== body.expectedNodeSessionId) throw new Error('Node session changed')
      if (body?.trialId && (status.trial?.trialId !== body.trialId || (body.trialDigest && status.trial.digest !== body.trialDigest))) throw new Error('Trial changed')
      if (action === 'prepare' && (status.configuration?.digest !== body.configurationDigest || status.trial?.targetPosition !== body.targetPosition || status.trial?.phase !== 'WAITING_FOR_APPROVAL')) throw new Error('Proposal changed')
      if (action === 'approve' && status.trial.phase === 'WAITING_FOR_APPROVAL') throw new Error('Approval was not acknowledged')
      if (action === 'recovery/inspect' && (!status.recovery || status.recovery.nodeSessionId !== body.expectedNodeSessionId)) throw new Error('Recovery inspection was not acknowledged')
      if (action === 'recovery/confirm' && (!gripperRecoveryCleared(status) || status.recoveryClearance.nodeSessionId !== body.expectedNodeSessionId || status.recoveryClearance.recoveryDigest !== body.recoveryDigest)) throw new Error('Durable recovery clearance was not acknowledged')
      return status
    } catch (error) { if (error instanceof CommissioningHttpError) throw error; throw new Error('Gripper check transport or response is unavailable; no outcome is assumed.') }
  }
  return Object.freeze({
    status: () => request(''),
    inspect(body) { fields(body, ['expectedNodeSessionId']); id(body.expectedNodeSessionId); return request('inspect', body) },
    prepare(body) { fields(body, ['expectedNodeSessionId', 'configurationDigest', 'inspectionDigest', 'targetPosition']); id(body.expectedNodeSessionId); hash(body.configurationDigest); hash(body.inspectionDigest); number(body.targetPosition, 0, 100); return request('prepare', body) },
    approve(body) { fields(body, ['expectedNodeSessionId', 'trialId', 'trialDigest', 'approved']); id(body.expectedNodeSessionId); id(body.trialId); hash(body.trialDigest); assert(body.approved === true); return request('approve', body) },
    stop(body) { fields(body, ['expectedNodeSessionId', 'trialId', 'reason']); id(body.expectedNodeSessionId); id(body.trialId); text(body.reason, 256); return request('stop', body) },
    recoveryInspect(body) { fields(body, ['expectedNodeSessionId', 'trialId', 'trialDigest']); id(body.expectedNodeSessionId); id(body.trialId); hash(body.trialDigest); return request('recovery/inspect', body) },
    recoveryConfirm(body) { fields(body, ['expectedNodeSessionId', 'trialId', 'trialDigest', 'recoveryDigest', 'confirmed']); id(body.expectedNodeSessionId); id(body.trialId); hash(body.trialDigest); hash(body.recoveryDigest); assert(body.confirmed === true); return request('recovery/confirm', body) },
  })
}
