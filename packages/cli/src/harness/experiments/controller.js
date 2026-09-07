import { createHash, randomUUID } from 'node:crypto'
import { experimentFixture, runSyntheticTrial } from './fixture.js'
import { createExperimentStore } from './storage.js'

const TERMINAL = new Set(['COMPLETED', 'STOPPED', 'INTERRUPTED', 'FAILED'])
const PHASES = new Set(['PROPOSED', 'READY', 'RUNNING', 'OUTCOME_UNKNOWN', ...TERMINAL])
const MAX_HISTORY = 8
const MAX_REQUESTS = 2048
const APPROVAL_LIFETIME_MS = 15 * 60 * 1000
const clone = (value) => structuredClone(value)
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class LocalExperimentError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalExperimentError'; this.code = code }
}
function failure(code, message) { return new LocalExperimentError(code, message) }
/** Only messages created by this module may cross the browser/tool boundary. */
export function experimentRequestFailure(error) {
  if (!(error instanceof LocalExperimentError)) return null
  const status = error.code === 'APPROVAL_EXPIRED' ? 410
    : ['EXPERIMENT_CHANGED', 'REQUEST_CONFLICT', 'EXPERIMENT_BUSY', 'PLAN_CHANGED', 'APPROVAL_UNAVAILABLE', 'APPROVAL_REQUIRED',
      'TRIAL_LIMIT_REACHED', 'FINISH_UNAVAILABLE', 'SESSION_REQUEST_LIMIT', 'DISPOSED'].includes(error.code) ? 409 : 400
  return { status, code: error.code, message: error.message }
}
function identifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw failure('INVALID_REQUEST', `${name} must be a nonempty identifier of at most 160 characters`)
  return value
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw failure('INVALID_REQUEST', 'This experiment request contains unsupported fields')
}
function summary(experiment) {
  const measured = experiment.trials.filter((trial) => trial.status === 'COMPLETED' && trial.result)
  const best = measured.reduce((value, trial) => !value || trial.result.alignmentErrorMm < value.result.alignmentErrorMm ? trial : value, null)
  return { completedTrials: measured.length, totalTrials: experiment.trials.length,
    bestTrialId: best?.id || null, bestOffsetMm: best?.offsetMm ?? null,
    bestAlignmentErrorMm: best?.result.alignmentErrorMm ?? null,
    interpretation: best ? `Lowest recorded synthetic alignment error: ${best.result.alignmentErrorMm} mm. Physical behavior is not verified.` : 'No completed synthetic measurement is available.' }
}
function assertStored(state, sessionId) {
  if (!state || state.schemaVersion !== 1 || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.history) || state.history.length > MAX_HISTORY || !Array.isArray(state.requests) || state.requests.length > MAX_REQUESTS) throw failure('STORAGE_INVALID', 'Saved experiment metadata is invalid; preserve it for inspection')
  for (const experiment of [...state.history, ...(state.current ? [state.current] : [])]) {
    if (!experiment || experiment.mode !== 'simulation' || !PHASES.has(experiment.phase) || typeof experiment.id !== 'string'
      || typeof experiment.goal !== 'string' || experiment.goal.length > 4000 || !Number.isInteger(experiment.trialLimit) || experiment.trialLimit < 1 || experiment.trialLimit > 10
      || !Array.isArray(experiment.trials) || experiment.trials.length > experiment.trialLimit || !Number.isFinite(experiment.expiresAt)) throw failure('STORAGE_INVALID', 'Saved experiment state cannot be resumed safely; preserve it for inspection')
    const expected = digest({ id: experiment.id, goal: experiment.goal, mode: 'simulation', fixtureId: experimentFixture.id,
      trialLimit: experiment.trialLimit, expiresAt: experiment.expiresAt })
    if (experiment.planDigest !== expected) throw failure('STORAGE_INVALID', 'Saved experiment plan does not match its digest; preserve it for inspection')
    for (const trial of experiment.trials) {
      if (!trial || typeof trial.id !== 'string' || typeof trial.requestId !== 'string' || typeof trial.offsetMm !== 'number'
        || !Number.isFinite(trial.offsetMm) || trial.offsetMm < -10 || trial.offsetMm > 10
        || !['RUNNING', 'COMPLETED', 'STOPPED', 'FAILED', 'INTERRUPTED', 'OUTCOME_UNKNOWN'].includes(trial.status)
        || (trial.result !== null && (!Number.isFinite(trial.result?.alignmentErrorMm) || trial.result.alignmentErrorMm < 0))) throw failure('STORAGE_INVALID', 'Saved trial metadata is invalid; preserve it for inspection')
    }
  }
  const ids = new Set()
  for (const request of state.requests) {
    if (!request || typeof request.id !== 'string' || typeof request.fingerprint !== 'string' || !['propose', 'trial'].includes(request.kind) || !['PENDING', 'SETTLED'].includes(request.status)
      || ids.has(request.id)) throw failure('STORAGE_INVALID', 'Saved request identity metadata is invalid; preserve it for inspection')
    ids.add(request.id)
  }
}

/** Shared operator/agent experiment state. This controller never imports a Node
 * client, accesses a device, or confers physical execution authority. The runner
 * injection exists for simulation contract tests, not hardware providers. */
export function createExperimentController({ sessionId, storageDir, now = Date.now, trialTimeoutMs = 2000, runTrialImpl, stepMs = 250 } = {}) {
  identifier(sessionId, 'sessionId')
  if (!Number.isFinite(trialTimeoutMs) || trialTimeoutMs < 1 || trialTimeoutMs > 30000 || !Number.isFinite(stepMs) || stepMs < 0 || stepMs > 30000) throw new TypeError('Simulation time bounds must be finite and at most 30 seconds')
  if (runTrialImpl !== undefined && typeof runTrialImpl !== 'function') throw new TypeError('The simulation runner must be a function')
  const store = createExperimentStore({ sessionId, storageDir })
  const builtin = !runTrialImpl
  const runner = runTrialImpl || runSyntheticTrial
  let state
  try {
    state = store.read() || { schemaVersion: 1, sessionId, revision: 0, current: null, history: [], requests: [] }
    assertStored(state, sessionId)
  } catch (error) { store.release(); throw error }
  let disposed = false, active = null, storageFailed = false
  const listeners = new Set()
  const timestamp = () => {
    const value = now()
    if (!Number.isFinite(value) || value < 0) throw failure('INVALID_CLOCK', 'Experiment clock is unavailable')
    return value
  }
  const snapshot = () => clone({ sessionId, availability: 'simulation-only', revision: state.revision, fixture: experimentFixture,
    current: state.current, history: state.history.map((item) => ({ ...item, goal: item.goal.slice(0, 400) })),
    error: storageFailed ? 'Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence.' : null,
    physicalExecutionAuthorized: false })
  const emit = () => {
    const value = snapshot()
    for (const listener of listeners) { try { listener(value) } catch { /* A view cannot break ownership or persistence. */ } }
  }
  const save = () => {
    if (disposed) return
    if (state.current) state.current.summary = summary(state.current)
    state.revision += 1
    try {
      if (storageFailed) throw new Error('Experiment storage is unavailable')
      store.write(state)
    } catch {
      // A mutation is never a usable approval or result until durable. Abort the
      // current synthetic operation and fail closed for this controller lifetime.
      storageFailed = true
      if (state.current) {
        state.current.phase = 'OUTCOME_UNKNOWN'
        state.current.recoveryReason = 'Experiment evidence could not be saved. Preserve local files, repair storage, then retry Stop after the synthetic runner has settled. No outcome is assumed.'
        const trial = state.current.trials.find((item) => item.id === active?.trialId)
        if (trial) { trial.status = 'OUTCOME_UNKNOWN'; trial.result = null }
      }
      active?.controller.abort()
      emit()
      throw failure('STORAGE_UNAVAILABLE', 'Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence')
    }
    emit()
  }
  try { if (state.current && ['RUNNING', 'READY', 'OUTCOME_UNKNOWN'].includes(state.current.phase)) {
    // No approved trial is replayed after a reload. A previously approved plan
    // requires a new proposal, while unresolved custom runner outcomes stay blocked.
    const unknown = state.current.phase === 'OUTCOME_UNKNOWN'
    state.current.phase = unknown ? 'OUTCOME_UNKNOWN' : 'INTERRUPTED'
    state.current.recoveryReason = unknown
      ? 'A previous simulated trial did not confirm cleanup. This experiment remains blocked; inspect its evidence. No trial was replayed.'
      : 'This conversation was reopened. The previous approval was not resumed and no trial was replayed. Propose a new experiment to continue.'
    for (const trial of state.current.trials) if (trial.status === 'RUNNING') { trial.status = unknown ? 'OUTCOME_UNKNOWN' : 'INTERRUPTED'; trial.finishedAt = timestamp() }
    for (const request of state.requests) if (request.status === 'PENDING') request.status = 'SETTLED'
    save()
  } } catch (error) { store.release(); throw error }
  const ensureOpen = (allowStorageFailure = false) => {
    if (disposed) throw failure('DISPOSED', 'This experiment session is closed; reopen the conversation')
    if (storageFailed && !allowStorageFailure) throw failure('STORAGE_UNAVAILABLE', 'Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence')
  }
  const current = (id, allowStorageFailure = false) => {
    ensureOpen(allowStorageFailure)
    if (!state.current || state.current.id !== id) throw failure('EXPERIMENT_CHANGED', 'The experiment has changed. Refresh and review the current proposal before acting')
    return state.current
  }
  const remember = (kind, id, payload) => {
    identifier(id, 'requestId')
    const fingerprint = digest({ kind, ...payload })
    const known = state.requests.find((request) => request.id === id)
    if (known) {
      if (known.fingerprint !== fingerprint || known.kind !== kind) throw failure('REQUEST_CONFLICT', 'This request identifier was already used for a different action. Refresh and submit a new request')
      return known
    }
    if (state.requests.length >= MAX_REQUESTS) throw failure('SESSION_REQUEST_LIMIT', 'This conversation has reached its experiment request limit. Start a new conversation; existing evidence is preserved')
    return null
  }
  const settleRequest = (id) => { const request = state.requests.find((item) => item.id === id); if (request) request.status = 'SETTLED' }
  const requireFresh = (experiment) => {
    if (timestamp() >= experiment.expiresAt) throw failure('APPROVAL_EXPIRED', 'This experiment approval has expired. Stop it and propose a new bounded experiment for review')
  }

  function propose(body) {
    ensureOpen(); fields(body, ['goal', 'trialLimit', 'requestId', 'mode'])
    const { goal, requestId, mode, trialLimit = 4 } = body
    if (mode !== 'simulation') throw failure('UNSUPPORTED_MODE', 'Only the synthetic simulation is available. This action cannot authorize devices or hardware trials')
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(goal)) throw failure('INVALID_GOAL', 'Describe the experiment goal in 1 to 4000 characters')
    if (!Number.isInteger(trialLimit) || trialLimit < 1 || trialLimit > 10) throw failure('INVALID_TRIAL_LIMIT', 'Choose a bounded trial limit from 1 to 10')
    if (remember('propose', requestId, { goal: goal.trim(), mode, trialLimit })) return snapshot()
    if (active || (state.current && !TERMINAL.has(state.current.phase))) throw failure('EXPERIMENT_BUSY', 'Finish or stop the current experiment before proposing another. An unconfirmed stop must settle first')
    if (state.current) state.history = [clone(state.current), ...state.history].slice(0, MAX_HISTORY)
    const id = randomUUID(), expiresAt = timestamp() + APPROVAL_LIFETIME_MS
    state.current = { id, goal: goal.trim(), mode, phase: 'PROPOSED', trialLimit, expiresAt,
      planDigest: digest({ id, goal: goal.trim(), mode, fixtureId: experimentFixture.id, trialLimit, expiresAt }),
      createdAt: timestamp(), approvedAt: null, trials: [], summary: null }
    state.requests.push({ id: requestId, kind: 'propose', fingerprint: digest({ kind: 'propose', goal: goal.trim(), mode, trialLimit }), status: 'SETTLED', experimentId: id })
    save(); return snapshot()
  }
  function approve(body) {
    fields(body, ['experimentId', 'expectedDigest'])
    const experiment = current(body.experimentId)
    if (typeof body.expectedDigest !== 'string' || body.expectedDigest !== experiment.planDigest) throw failure('PLAN_CHANGED', 'The proposal does not match the reviewed plan. Refresh and review its exact goal and trial limit')
    requireFresh(experiment)
    if (experiment.phase === 'READY') return snapshot()
    if (experiment.phase !== 'PROPOSED') throw failure('APPROVAL_UNAVAILABLE', 'Only the current proposed experiment can be approved')
    experiment.phase = 'READY'; experiment.approvedAt = timestamp(); save(); return snapshot()
  }

  function interrupt(kind) {
    const owner = active
    if (!owner) return
    clearTimeout(owner.timer)
    // A repeated Stop cannot rewrite an existing timeout's cause.
    owner.interrupted ||= kind
    kind = owner.interrupted
    const experiment = state.current
    const trial = experiment.trials.find((item) => item.id === owner.trialId)
    trial.status = builtin ? (kind === 'stop' ? 'STOPPED' : 'FAILED') : 'OUTCOME_UNKNOWN'
    trial.finishedAt = timestamp()
    trial.error = kind === 'stop' ? 'Stop requested. No successful measurement is assumed.' : 'The simulated trial exceeded its time limit. No successful measurement is assumed.'
    experiment.phase = builtin ? (kind === 'stop' ? 'STOPPED' : 'FAILED') : 'OUTCOME_UNKNOWN'
    experiment.stopStatus = builtin ? 'CONFIRMED' : 'UNCONFIRMED'
    settleRequest(owner.requestId)
    if (builtin) active = null
    owner.controller.abort()
    try { save() } catch { /* Stop still aborts and the caller receives the truthful unresolved snapshot. */ }
    finally { owner.resolve(snapshot()) }
  }

  function trial(body) {
    ensureOpen(); fields(body, ['experimentId', 'requestId', 'offsetMm'])
    const { experimentId, requestId, offsetMm } = body
    if (typeof offsetMm !== 'number' || !Number.isFinite(offsetMm) || offsetMm < -10 || offsetMm > 10) throw failure('INVALID_TRIAL_INPUT', 'Choose an offsetMm between -10 and 10 for the synthetic fixture')
    const known = remember('trial', requestId, { experimentId, offsetMm })
    if (known) return active?.requestId === requestId ? active.promise : Promise.resolve(snapshot())
    const experiment = current(experimentId)
    if (active || experiment.phase === 'RUNNING' || experiment.phase === 'OUTCOME_UNKNOWN') throw failure('EXPERIMENT_BUSY', 'A simulated trial is active or its stop is unconfirmed. Wait for its outcome; Stop remains available')
    if (experiment.phase !== 'READY') throw failure('APPROVAL_REQUIRED', 'Review and approve this exact simulation proposal before running a trial')
    requireFresh(experiment)
    if (experiment.trials.length >= experiment.trialLimit) throw failure('TRIAL_LIMIT_REACHED', 'The approved trial limit has been reached. Finish this experiment or propose a new one for review')
    const record = { id: randomUUID(), requestId, offsetMm, status: 'RUNNING', startedAt: timestamp(), finishedAt: null, result: null, error: null }
    experiment.trials.push(record); experiment.phase = 'RUNNING'
    state.requests.push({ id: requestId, kind: 'trial', fingerprint: digest({ kind: 'trial', experimentId, offsetMm }), status: 'PENDING', experimentId })
    const owner = { controller: new AbortController(), trialId: record.id, requestId, interrupted: null, timer: null, resolve: null, promise: null }
    owner.promise = new Promise((resolve) => { owner.resolve = resolve })
    active = owner
    try { save() } catch (error) { active = null; owner.controller.abort(); throw error }
    owner.timer = setTimeout(() => { if (!disposed && active === owner) interrupt('timeout') }, trialTimeoutMs)
    const complete = (result, error) => {
      clearTimeout(owner.timer)
      if (disposed || active !== owner || state.current.id !== experimentId) return
      active = null
      record.finishedAt = timestamp()
      settleRequest(requestId)
      if (owner.interrupted) {
        record.status = owner.interrupted === 'stop' ? 'STOPPED' : 'FAILED'
        experiment.phase = owner.interrupted === 'stop' ? 'STOPPED' : 'FAILED'
        experiment.stopStatus = 'CONFIRMED'
        record.error = 'The simulated runner settled after cancellation. Its late result was discarded.'
      } else if (error || !result || !Number.isFinite(result.alignmentErrorMm) || result.alignmentErrorMm < 0) {
        record.status = 'FAILED'; experiment.phase = 'FAILED'
        record.error = 'The simulated runner failed or returned an invalid measurement. No hardware operation occurred. Inspect the trial and propose a new experiment to retry.'
      } else {
        record.status = 'COMPLETED'; experiment.phase = 'READY'
        record.result = { alignmentErrorMm: result.alignmentErrorMm,
          ...(Number.isFinite(result.signedErrorMm) ? { signedErrorMm: result.signedErrorMm } : {}), source: experimentFixture.id }
      }
      save(); owner.resolve(snapshot())
    }
    Promise.resolve().then(() => {
      if (owner.controller.signal.aborted) throw new Error('Trial stopped before dispatch')
      return runner({ offsetMm, signal: owner.controller.signal, stepMs, experimentId, trialId: record.id })
    }).then((result) => complete(result, null), (error) => complete(null, error)).catch(() => {
      // Persistence failures cannot authorize a follow-up; keep an unresolved
      // snapshot rather than allowing an unhandled rejection to lose ownership.
      if (!disposed && state.current?.id === experimentId) {
        experiment.phase = 'OUTCOME_UNKNOWN'; record.status = 'OUTCOME_UNKNOWN'; record.result = null
        experiment.recoveryReason = 'The trial could not persist its outcome. Preserve local evidence, repair storage, then retry Stop. Its unknown result will not be replayed or reported as success.'
        experiment.summary = summary(experiment)
        emit()
        owner.resolve(snapshot())
      }
    })
    return owner.promise
  }

  function finish(body) {
    fields(body, ['experimentId'])
    const experiment = current(body.experimentId)
    if (experiment.phase === 'COMPLETED') return snapshot()
    if (active || experiment.phase !== 'READY' || !experiment.trials.length) throw failure('FINISH_UNAVAILABLE', 'Finish is available after an approved experiment has at least one settled trial. Stop is available while work is active')
    experiment.phase = 'COMPLETED'; experiment.finishedAt = timestamp(); save(); return snapshot()
  }
  function stop(body) {
    fields(body, ['experimentId'])
    const experiment = current(body.experimentId, true)
    if (active) { interrupt('stop'); return snapshot() }
    if (storageFailed) {
      // No runner remains owned by this live controller. Explicit Stop may retry
      // only the evidence write, never a trial or approval. Keep any unknown
      // trial result unknown even when recording confirmed runtime cleanup.
      experiment.phase = 'STOPPED'; experiment.stopStatus = 'CONFIRMED'; experiment.finishedAt = timestamp()
      experiment.recoveryReason = 'Synthetic work is stopped and the retained evidence was saved after storage recovery. Any unknown trial outcome remains unknown; no trial was replayed.'
      storageFailed = false
      try { save() } catch { /* Still unavailable: save restores the failure latch and unknown state. */ }
      return snapshot()
    }
    if (experiment.phase === 'OUTCOME_UNKNOWN') return snapshot()
    if (TERMINAL.has(experiment.phase)) return snapshot()
    experiment.phase = 'STOPPED'; experiment.stopStatus = 'CONFIRMED'; experiment.finishedAt = timestamp()
    try { save() } catch { /* The operation is stopped even if evidence cannot be saved; state remains unresolved. */ }
    return snapshot()
  }
  function dispose() {
    if (disposed) return
    try { if (active) interrupt('stop') }
    finally { disposed = true; listeners.clear(); store.release() }
  }
  return { snapshot, propose, approve, trial, finish, stop, dispose,
    subscribe(listener) { ensureOpen(); if (typeof listener !== 'function') throw new TypeError('A change listener is required'); listeners.add(listener); return () => listeners.delete(listener) } }
}
