import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExperimentController, experimentRequestFailure } from '../src/harness/experiments/controller.js'

function fixture(t, options = {}) {
  const storageDir = mkdtempSync(join(tmpdir(), 'physicalsystems-experiment-test-'))
  const controllers = []
  t.after(() => { for (const controller of controllers) controller.dispose(); rmSync(storageDir, { recursive: true, force: true }) })
  const create = (extra = {}) => {
    const controller = createExperimentController({ sessionId: 'conversation-a', storageDir, stepMs: 0, ...options, ...extra })
    controllers.push(controller)
    return controller
  }
  return { create, storageDir }
}
function proposal(controller, suffix = '1', overrides = {}) {
  return controller.propose({ goal: 'Find a useful synthetic alignment offset', mode: 'simulation', trialLimit: 4, requestId: `proposal-${suffix}`, ...overrides }).current
}
function ready(controller, suffix = '1', overrides = {}) {
  const experiment = proposal(controller, suffix, overrides)
  return controller.approve({ experimentId: experiment.id, expectedDigest: experiment.planDigest }).current
}
const rejectsCode = (code) => (error) => error.code === code
const drain = () => new Promise((resolve) => setImmediate(resolve))

test('proposal → exact operator approval → measured trials → comparison → completion is explicitly synthetic', async (t) => {
  const controller = fixture(t).create()
  const experiment = proposal(controller)
  assert.equal(controller.snapshot().availability, 'simulation-only')
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
  assert.match(controller.snapshot().fixture.description, /fixed synthetic target at 3 mm/)
  assert.throws(() => controller.trial({ experimentId: experiment.id, requestId: 'trial-unapproved', offsetMm: 0 }), rejectsCode('APPROVAL_REQUIRED'))
  assert.throws(() => controller.approve({ experimentId: experiment.id, expectedDigest: 'different' }), rejectsCode('PLAN_CHANGED'))
  controller.approve({ experimentId: experiment.id, expectedDigest: experiment.planDigest })
  const first = await controller.trial({ experimentId: experiment.id, requestId: 'trial-1', offsetMm: 0 })
  assert.deepEqual(first.current.trials[0].result, { alignmentErrorMm: 3, signedErrorMm: 3, source: 'synthetic-alignment-v1' })
  const second = await controller.trial({ experimentId: experiment.id, requestId: 'trial-2', offsetMm: 2 })
  assert.equal(second.current.summary.bestAlignmentErrorMm, 1)
  assert.equal(second.current.summary.bestOffsetMm, 2)
  const completed = controller.finish({ experimentId: experiment.id })
  assert.equal(completed.current.phase, 'COMPLETED')
  assert.match(completed.current.summary.interpretation, /Physical behavior is not verified/)
  proposal(controller, '2')
  assert.equal(controller.snapshot().history[0].id, experiment.id)
  assert.equal(controller.snapshot().history[0].trials.length, 2)
})

test('simulation, exact field, input, trial-count and expiration gates cannot be widened', async (t) => {
  let time = 1000
  const controller = fixture(t, { now: () => time }).create()
  assert.throws(() => proposal(controller, 'hardware', { mode: 'physical' }), rejectsCode('UNSUPPORTED_MODE'))
  assert.throws(() => proposal(controller, 'overflow', { trialLimit: 11 }), rejectsCode('INVALID_TRIAL_LIMIT'))
  assert.throws(() => proposal(controller, 'zero', { trialLimit: 0 }), rejectsCode('INVALID_TRIAL_LIMIT'))
  assert.throws(() => proposal(controller, 'extra', { physicalExecutionAuthorized: true }), rejectsCode('INVALID_REQUEST'))
  const experiment = ready(controller, '1', { trialLimit: 1 })
  for (const offsetMm of [-11, 11, NaN, Infinity, '3']) assert.throws(() => controller.trial({ experimentId: experiment.id, requestId: 'bad-input', offsetMm }), rejectsCode('INVALID_TRIAL_INPUT'))
  await controller.trial({ experimentId: experiment.id, requestId: 'valid', offsetMm: 3 })
  assert.throws(() => controller.trial({ experimentId: experiment.id, requestId: 'over-budget', offsetMm: 3 }), rejectsCode('TRIAL_LIMIT_REACHED'))
  controller.finish({ experimentId: experiment.id })
  const expired = proposal(controller, 'expired')
  time = expired.expiresAt
  assert.throws(() => controller.approve({ experimentId: expired.id, expectedDigest: expired.planDigest }), rejectsCode('APPROVAL_EXPIRED'))
  controller.stop({ experimentId: expired.id })
  const readyButExpired = ready(controller, 'approved-expired')
  time = readyButExpired.expiresAt + 1
  assert.throws(() => controller.trial({ experimentId: readyButExpired.id, requestId: 'expired-trial', offsetMm: 3 }), rejectsCode('APPROVAL_EXPIRED'))
  assert.equal(controller.snapshot().current.trials.length, 0)
})

test('pending and completed duplicate trial IDs dispatch exactly once and reject conflicting input', async (t) => {
  let calls = 0, complete
  const controller = fixture(t, { runTrialImpl: () => { calls += 1; return new Promise((resolve) => { complete = resolve }) } }).create()
  const experiment = ready(controller)
  const body = { experimentId: experiment.id, requestId: 'once', offsetMm: 1 }
  const first = controller.trial(body)
  const duplicate = controller.trial(body)
  assert.equal(first, duplicate)
  assert.throws(() => controller.trial({ ...body, offsetMm: 2 }), rejectsCode('REQUEST_CONFLICT'))
  assert.throws(() => controller.trial({ ...body, requestId: 'concurrent' }), rejectsCode('EXPERIMENT_BUSY'))
  await drain(); assert.equal(calls, 1)
  complete({ alignmentErrorMm: 2 })
  await first
  await controller.trial(body)
  assert.equal(calls, 1)
  assert.equal(controller.snapshot().current.trials.length, 1)
  assert.throws(() => proposal(controller, 'different-id'), rejectsCode('EXPERIMENT_BUSY'))
  assert.equal(proposal(controller).id, experiment.id)
  assert.throws(() => proposal(controller, '1', { goal: 'Changed' }), rejectsCode('REQUEST_CONFLICT'))
})

test('reopening preserves request identities and evidence, invalidates previous approval and never replays trials', async (t) => {
  let calls = 0
  const { create } = fixture(t, { runTrialImpl: async () => { calls += 1; return { alignmentErrorMm: 1 } } })
  const first = create()
  const experiment = ready(first)
  const body = { experimentId: experiment.id, requestId: 'recorded-trial', offsetMm: 2 }
  await first.trial(body)
  first.dispose()
  const reopened = create()
  assert.equal(reopened.snapshot().current.phase, 'INTERRUPTED')
  assert.equal(reopened.snapshot().current.trials[0].result.alignmentErrorMm, 1)
  await reopened.trial(body)
  assert.equal(calls, 1)
  assert.throws(() => reopened.trial({ ...body, requestId: 'after-reopen' }), rejectsCode('APPROVAL_REQUIRED'))
  assert.throws(() => reopened.approve({ experimentId: experiment.id, expectedDigest: experiment.planDigest }), rejectsCode('APPROVAL_UNAVAILABLE'))
  assert.equal(proposal(reopened).id, experiment.id)
  const next = ready(reopened, 'new-review')
  assert.notEqual(next.id, experiment.id)
  assert.equal(reopened.snapshot().history[0].phase, 'INTERRUPTED')
})

test('an unapproved proposal survives reopen without becoming approved', (t) => {
  const { create } = fixture(t)
  const first = create(), proposed = proposal(first)
  first.dispose()
  const reopened = create()
  assert.equal(reopened.snapshot().current.phase, 'PROPOSED')
  assert.equal(reopened.snapshot().current.approvedAt, null)
  assert.throws(() => reopened.trial({ experimentId: proposed.id, requestId: 'not-yet', offsetMm: 3 }), rejectsCode('APPROVAL_REQUIRED'))
  assert.equal(reopened.approve({ experimentId: proposed.id, expectedDigest: proposed.planDigest }).current.phase, 'READY')
})

test('Stop cancels the built-in fixture immediately, including before dispatch, and cannot publish a late image/result', async (t) => {
  const controller = fixture(t, { stepMs: 1000 }).create()
  const experiment = ready(controller)
  const pending = controller.trial({ experimentId: experiment.id, requestId: 'stop-before-dispatch', offsetMm: 2 })
  const stopped = controller.stop({ experimentId: experiment.id })
  assert.equal(stopped.current.phase, 'STOPPED')
  assert.equal(stopped.current.stopStatus, 'CONFIRMED')
  assert.equal((await pending).current.trials[0].result, null)
  const next = ready(controller, 'next')
  await drain()
  assert.equal(controller.snapshot().current.id, next.id)
  assert.equal(controller.snapshot().current.phase, 'READY')
})

test('unconfirmed Stop retains ownership, is repeatable and discards completion before accepting a new proposal', async (t) => {
  let complete, signal
  const controller = fixture(t, { runTrialImpl: (args) => { signal = args.signal; return new Promise((resolve) => { complete = resolve }) } }).create()
  const experiment = ready(controller)
  const pending = controller.trial({ experimentId: experiment.id, requestId: 'slow', offsetMm: 1 })
  await drain()
  assert.equal(controller.stop({ experimentId: experiment.id }).current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(signal.aborted, true)
  assert.equal((await pending).current.stopStatus, 'UNCONFIRMED')
  assert.throws(() => proposal(controller, 'blocked'), rejectsCode('EXPERIMENT_BUSY'))
  assert.throws(() => controller.finish({ experimentId: experiment.id }), rejectsCode('FINISH_UNAVAILABLE'))
  assert.equal(controller.stop({ experimentId: experiment.id }).current.phase, 'OUTCOME_UNKNOWN')
  complete({ alignmentErrorMm: 0 })
  await drain()
  assert.equal(controller.snapshot().current.phase, 'STOPPED')
  assert.equal(controller.snapshot().current.stopStatus, 'CONFIRMED')
  assert.equal(controller.snapshot().current.trials[0].result, null)
  assert.equal(proposal(controller, 'after-cleanup').phase, 'PROPOSED')
})

test('bounded custom-runner timeout records uncertainty until cleanup and never turns a late answer into success', async (t) => {
  let complete
  const controller = fixture(t, { trialTimeoutMs: 15, runTrialImpl: () => new Promise((resolve) => { complete = resolve }) }).create()
  const experiment = ready(controller)
  const result = await controller.trial({ experimentId: experiment.id, requestId: 'timeout', offsetMm: 0 })
  assert.equal(result.current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(result.current.trials[0].result, null)
  assert.throws(() => controller.trial({ experimentId: experiment.id, requestId: 'retry-too-soon', offsetMm: 3 }), rejectsCode('EXPERIMENT_BUSY'))
  complete({ alignmentErrorMm: 0 }); await drain()
  assert.equal(controller.snapshot().current.phase, 'FAILED')
  assert.equal(controller.snapshot().current.stopStatus, 'CONFIRMED')
  assert.equal(controller.snapshot().current.trials[0].result, null)
})

test('bounded builtin timeout confirms arithmetic cleanup and failed runners expose no raw exception data', async (t) => {
  const { create } = fixture(t, { trialTimeoutMs: 10, stepMs: 100 })
  const timed = create(), experiment = ready(timed)
  const result = await timed.trial({ experimentId: experiment.id, requestId: 'bounded', offsetMm: 0 })
  assert.equal(result.current.phase, 'FAILED')
  assert.equal(result.current.stopStatus, 'CONFIRMED')
  const failing = create({ sessionId: 'failing', runTrialImpl: async () => { throw new Error('secret-token-do-not-persist') } })
  const broken = ready(failing)
  const failure = await failing.trial({ experimentId: broken.id, requestId: 'failure', offsetMm: 0 })
  assert.equal(failure.current.phase, 'FAILED')
  assert.equal(JSON.stringify(failure).includes('secret-token'), false)
})

test('dispose bounds the caller and preserves an unconfirmed injected runner outcome across reopen', async (t) => {
  let complete
  const { create } = fixture(t, { runTrialImpl: () => new Promise((resolve) => { complete = resolve }) })
  const first = create(), experiment = ready(first)
  const pending = first.trial({ experimentId: experiment.id, requestId: 'dispose-running', offsetMm: 0 })
  await drain(); first.dispose()
  assert.equal((await pending).current.phase, 'OUTCOME_UNKNOWN')
  const second = create()
  assert.equal(second.snapshot().current.phase, 'OUTCOME_UNKNOWN')
  assert.match(second.snapshot().current.recoveryReason, /No trial was replayed/)
  assert.throws(() => proposal(second, 'new'), rejectsCode('EXPERIMENT_BUSY'))
  complete({ alignmentErrorMm: 0 }); await drain()
  assert.equal(second.snapshot().current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(second.snapshot().current.trials[0].result, null)
})

test('sessions use separate hashed files and cannot open competing controllers for one conversation', (t) => {
  const { create, storageDir } = fixture(t)
  const first = create({ sessionId: '../../conversation-a' })
  const second = create({ sessionId: 'conversation-b' })
  proposal(first)
  assert.equal(second.snapshot().current, null)
  assert.throws(() => create({ sessionId: '../../conversation-a' }), /already owns/)
  assert.ok(readdirSync(storageDir).every((name) => /^[a-f0-9]{64}\.(json|lock)$/u.test(name)))
})

test('saved active work recovers as interrupted; modified approval digests are rejected without overwriting evidence', async (t) => {
  const { create, storageDir } = fixture(t)
  const controller = create(), experiment = ready(controller)
  await controller.trial({ experimentId: experiment.id, requestId: 'finished', offsetMm: 0 })
  controller.dispose()
  const file = join(storageDir, readdirSync(storageDir).find((name) => name.endsWith('.json')))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.current.phase = 'RUNNING'; saved.current.trials[0].status = 'RUNNING'; saved.requests.at(-1).status = 'PENDING'
  writeFileSync(file, JSON.stringify(saved))
  const recovered = create()
  assert.equal(recovered.snapshot().current.phase, 'INTERRUPTED')
  assert.equal(recovered.snapshot().current.trials[0].status, 'INTERRUPTED')
  recovered.dispose()
  const corrupt = JSON.parse(readFileSync(file, 'utf8'))
  corrupt.current.goal = 'A silently modified plan'
  const original = JSON.stringify(corrupt)
  writeFileSync(file, original)
  assert.throws(() => create(), rejectsCode('STORAGE_INVALID'))
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('storage refuses symlink directories and metadata files without changing their targets', (t) => {
  if (process.platform === 'win32') { t.skip('Creating Windows symlinks requires developer mode or elevation'); return }
  const { create, storageDir } = fixture(t)
  const target = join(storageDir, 'external.txt')
  writeFileSync(target, 'preserve this file')
  const controller = create(); proposal(controller); controller.dispose()
  const file = join(storageDir, readdirSync(storageDir).find((name) => name.endsWith('.json')))
  rmSync(file); symlinkSync(target, file)
  assert.throws(() => create(), /unsupported file/)
  assert.equal(readFileSync(target, 'utf8'), 'preserve this file')
  const linked = join(storageDir, 'linked')
  symlinkSync(storageDir, linked)
  assert.throws(() => create({ storageDir: linked }), /symbolic links/)
})

test('history and public snapshots are bounded and external mutation/listener failure cannot corrupt state', async (t) => {
  const controller = fixture(t).create()
  let changes = 0
  const unsubscribe = controller.subscribe(() => { changes += 1; throw new Error('view failure') })
  for (let index = 0; index < 11; index += 1) {
    const experiment = ready(controller, String(index), { goal: 'g'.repeat(4000), trialLimit: 10 })
    for (let trial = 0; trial < 10; trial += 1) await controller.trial({ experimentId: experiment.id, requestId: `run-${index}-${trial}`, offsetMm: trial })
    controller.finish({ experimentId: experiment.id })
  }
  const state = controller.snapshot()
  assert.equal(state.history.length, 8)
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 64 * 1024)
  state.current.trials[0].result.alignmentErrorMm = 999
  state.fixture.input.maximum = 999
  assert.equal(controller.snapshot().current.trials[0].result.alignmentErrorMm, 3)
  assert.equal(controller.snapshot().fixture.input.maximum, 10)
  assert.ok(changes >= 100)
  unsubscribe()
})

test('browser error mapper accepts controller-owned actionable errors and never reflects arbitrary failures', (t) => {
  const controller = fixture(t).create()
  let thrown
  try { proposal(controller, 'invalid', { mode: 'physical' }) } catch (error) { thrown = error }
  assert.deepEqual(experimentRequestFailure(thrown), { status: 400, code: 'UNSUPPORTED_MODE', message: 'Only the synthetic simulation is available. This action cannot authorize devices or hardware trials' })
  assert.equal(experimentRequestFailure(new Error('private/path/secret')), null)
  assert.equal(experimentRequestFailure({ code: 'EXPERIMENT_BUSY', message: 'untrusted' }), null)
})

test('a failed approval write cannot grant trials; repairing storage plus explicit Stop saves evidence and unblocks a new proposal', (t) => {
  let calls = 0
  const { create, storageDir } = fixture(t, { runTrialImpl: async () => { calls += 1; return { alignmentErrorMm: 0 } } })
  const controller = create(), experiment = proposal(controller)
  const file = join(storageDir, readdirSync(storageDir).find((name) => name.endsWith('.json')))
  const saved = readFileSync(file)
  rmSync(file); mkdirSync(file)
  assert.throws(() => controller.approve({ experimentId: experiment.id, expectedDigest: experiment.planDigest }), rejectsCode('STORAGE_UNAVAILABLE'))
  assert.equal(controller.snapshot().current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(controller.stop({ experimentId: experiment.id }).current.phase, 'OUTCOME_UNKNOWN')
  rmSync(file, { recursive: true }); writeFileSync(file, saved)
  assert.throws(() => controller.trial({ experimentId: experiment.id, requestId: 'unsafe-after-write-failure', offsetMm: 3 }), rejectsCode('STORAGE_UNAVAILABLE'))
  assert.equal(calls, 0)
  const recovered = controller.stop({ experimentId: experiment.id })
  assert.equal(recovered.current.phase, 'STOPPED')
  assert.equal(recovered.current.stopStatus, 'CONFIRMED')
  assert.equal(recovered.error, null)
  assert.equal(recovered.current.trials.length, 0)
  assert.match(recovered.current.recoveryReason, /no trial was replayed/)
  const fresh = proposal(controller, 'after-storage-recovery')
  assert.equal(fresh.phase, 'PROPOSED')
  assert.equal(controller.snapshot().history[0].phase, 'STOPPED')
  controller.dispose()
  const reopened = create()
  assert.equal(reopened.snapshot().current.phase, 'PROPOSED')
  assert.equal(reopened.snapshot().current.approvedAt, null)
  assert.equal(reopened.snapshot().current.id, fresh.id)
})

test('Stop still aborts and resolves a pending request when its evidence write fails', async (t) => {
  let signal, complete
  const { create, storageDir } = fixture(t, { runTrialImpl: (args) => { signal = args.signal; return new Promise((resolve) => { complete = resolve }) } })
  const controller = create(), experiment = ready(controller)
  const pending = controller.trial({ experimentId: experiment.id, requestId: 'write-failed-stop', offsetMm: 0 })
  await drain()
  const file = join(storageDir, readdirSync(storageDir).find((name) => name.endsWith('.json')))
  const saved = readFileSync(file)
  rmSync(file); mkdirSync(file)
  assert.equal(controller.stop({ experimentId: experiment.id }).current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(signal.aborted, true)
  assert.equal((await pending).current.phase, 'OUTCOME_UNKNOWN')
  rmSync(file, { recursive: true }); writeFileSync(file, saved)
  assert.equal(controller.stop({ experimentId: experiment.id }).current.phase, 'OUTCOME_UNKNOWN')
  assert.throws(() => proposal(controller, 'before-runner-cleanup'), rejectsCode('STORAGE_UNAVAILABLE'))
  complete({ alignmentErrorMm: 0 }); await drain()
  assert.equal(controller.snapshot().current.phase, 'OUTCOME_UNKNOWN')
  assert.equal(controller.snapshot().current.trials[0].result, null)
  assert.throws(() => proposal(controller, 'write-failed-next'), rejectsCode('STORAGE_UNAVAILABLE'))
  const recovered = controller.stop({ experimentId: experiment.id })
  assert.equal(recovered.current.phase, 'STOPPED')
  assert.equal(recovered.current.trials[0].status, 'OUTCOME_UNKNOWN')
  assert.equal(recovered.current.trials[0].result, null)
  assert.equal(recovered.error, null)
  assert.equal(proposal(controller, 'after-runner-and-storage-cleanup').phase, 'PROPOSED')
})

test('failed recovery writes release the session lock and leave the saved grant unresumed', async (t) => {
  const { create, storageDir } = fixture(t)
  const first = create(), experiment = ready(first)
  await first.trial({ experimentId: experiment.id, requestId: 'recovery-trial', offsetMm: 0 })
  first.dispose()
  const file = join(storageDir, readdirSync(storageDir).find((name) => name.endsWith('.json')))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.current.phase = 'RUNNING'; saved.current.trials[0].status = 'RUNNING'
  writeFileSync(file, JSON.stringify(saved))
  assert.throws(() => create({ now: () => { rmSync(file); mkdirSync(file); return Date.now() } }), rejectsCode('STORAGE_UNAVAILABLE'))
  assert.equal(readdirSync(storageDir).some((name) => name.endsWith('.lock')), false)
  rmSync(file, { recursive: true }); writeFileSync(file, JSON.stringify(saved))
  const reopened = create()
  assert.equal(reopened.snapshot().current.phase, 'INTERRUPTED')
  assert.equal(reopened.snapshot().current.trials[0].status, 'INTERRUPTED')
})
