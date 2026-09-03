import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionController } from '../src/harness/execution-controller.js'
import { makeRun, evolve, route, configuration, status, instant, runId, digest, makeReceipt } from './fixtures/execution.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const prepareBody = () => ({ configurationId: configuration.configurationId, expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest })
const approveBody = (run) => ({ runId: run.runId, expectedRunDigest: run.runDigest, approvalDigest: run.approval.digest, approved: true })
function setup(t, overrides = {}) {
  let current = null, currentRoute = route, clock = instant, available = true, busy = false
  const calls = []
  const client = {
    async status() { calls.push(['status']); if (!available) throw new Error('offline'); return status },
    async runs() { calls.push(['runs']); return { runs: current ? [current] : [] } },
    async run() { calls.push(['run']); return current },
    async receipt() { calls.push(['receipt']); return makeReceipt(current) },
    async snapshot(snapshotDigest) { calls.push(['snapshot', snapshotDigest]); return { snapshotDigest, snapshot: { evidence: { mode: 'simulation', readinessChecks: { imageQuality: true } }, verified: true, stopped: true, preconditionsMet: null } } },
    async prepare(body) { calls.push(['prepare', body]); current = makeRun(); return current },
    async approve(id, body) { calls.push(['approve', id, body]); current = evolve(current, 'RUNNING'); return current },
    async stop(id, body) { calls.push(['stop', id, body]); current = evolve(current, 'CANCELLED', { stopStatus: 'STOP_CONFIRMED' }); return current },
    async reconcile(id, body) { calls.push(['reconcile', id, body]); return current },
    ...overrides,
  }
  const controller = createExecutionController({ client, currentRoute: () => currentRoute, canPrepare: () => !busy, now: () => clock, pollMs: 60_000 })
  t.after(() => controller.dispose())
  return { controller, client, calls, setRun: (value) => { current = value }, setRoute: (value) => { currentRoute = value; controller.contextChanged() },
    setClock: (value) => { clock = value }, setAvailable: (value) => { available = value }, setBusy: (value) => { busy = value } }
}

test('execution starts inert; only explicit prepare and exact approval reach the node', async (t) => {
  const { controller, calls } = setup(t)
  assert.equal(calls.length, 0)
  assert.equal(controller.snapshot().canPrepare, false)
  await controller.refresh()
  assert.equal(controller.snapshot().canPrepare, true)
  assert.equal(calls.some(([action]) => ['prepare', 'approve', 'stop'].includes(action)), false)
  await controller.action('prepare', prepareBody())
  const prepared = controller.snapshot().run
  assert.equal(controller.snapshot().canApprove, true)
  assert.equal(prepared.mode, 'simulation')
  assert.equal(prepared.physicalExecutionAuthorized, false)
  await assert.rejects(controller.action('approve', { ...approveBody(prepared), approved: false }))
  await assert.rejects(controller.action('approve', { ...approveBody(prepared), expectedRunDigest: digest('b') }))
  await controller.action('approve', approveBody(prepared))
  assert.equal(controller.snapshot().run.phase, 'RUNNING')
  assert.equal(controller.snapshot().run.outcome, null)
  assert.equal(calls.filter(([action]) => action === 'approve').length, 1)
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
})

test('preparation fails closed for missing route, mismatched configuration and busy shared agent', async (t) => {
  const context = setup(t)
  await context.controller.refresh()
  await assert.rejects(context.controller.action('prepare', { ...prepareBody(), expectedConfigurationDigest: digest('b') }))
  context.setBusy(true)
  await assert.rejects(context.controller.action('prepare', prepareBody()))
  context.setBusy(false); context.setRoute({ ...route, decision: { decision_status: 'no_match' } })
  await assert.rejects(context.controller.action('prepare', prepareBody()))
  context.setRoute({ ...route, physicalExecutionAuthorized: true })
  await assert.rejects(context.controller.action('prepare', prepareBody()))
  assert.equal(context.calls.some(([action]) => action === 'prepare'), false)
})

test('changed route, expired approval, stale reads and changed configuration revoke approval', async (t) => {
  const context = setup(t)
  await context.controller.refresh(); await context.controller.action('prepare', prepareBody())
  const body = approveBody(context.controller.snapshot().run)
  context.setRoute({ ...route, receiptDigest: digest('b') })
  await assert.rejects(context.controller.action('approve', body))
  context.setRoute(route); context.setClock(instant + 5000)
  await assert.rejects(context.controller.action('approve', body))
  await context.controller.refresh(); context.setClock(instant + 61000)
  await context.controller.refresh()
  await assert.rejects(context.controller.action('approve', body))
  context.setClock(instant)
  context.client.status = async () => ({ ...status, configurations: [{ ...configuration, configurationDigest: digest('b') }] })
  await context.controller.refresh()
  await assert.rejects(context.controller.action('approve', body))
})

test('Stop is independent while approval is inflight and a late older reply cannot erase it', async (t) => {
  const pending = deferred()
  const context = setup(t, { async approve() { return pending.promise } })
  await context.controller.refresh(); await context.controller.action('prepare', prepareBody())
  const waiting = makeRun()
  const approval = context.controller.action('approve', approveBody(waiting))
  assert.equal(context.controller.snapshot().pending, 'approve')
  const stopped = evolve(evolve(waiting, 'RUNNING'), 'CANCELLED', { stopStatus: 'STOP_CONFIRMED' })
  context.client.stop = async () => stopped
  await context.controller.action('stop', { runId, reason: 'operator-requested-stop' })
  assert.equal(context.controller.snapshot().run.stopStatus, 'STOP_CONFIRMED')
  pending.resolve(evolve(waiting, 'RUNNING'))
  await approval
  assert.equal(context.controller.snapshot().run.phase, 'CANCELLED')
})

test('poll failures preserve the known run and Stop but never claim success or retry', async (t) => {
  const context = setup(t)
  await context.controller.refresh(); await context.controller.action('prepare', prepareBody())
  await context.controller.action('approve', approveBody(context.controller.snapshot().run))
  context.setAvailable(false)
  await context.controller.refresh()
  assert.equal(context.controller.snapshot().availability, 'unavailable')
  assert.equal(context.controller.snapshot().canStop, true)
  assert.equal(context.controller.snapshot().canApprove, false)
  assert.equal(context.controller.snapshot().run.phase, 'RUNNING')
  await context.controller.action('stop', { runId, reason: 'operator-requested-stop' })
  assert.equal(context.controller.snapshot().run.stopStatus, 'STOP_CONFIRMED')
  assert.equal(context.calls.filter(([action]) => action === 'approve').length, 1)
})

test('failed approval leaves outcome unconfirmed and repeated clicks cannot dispatch again', async (t) => {
  let count = 0
  const context = setup(t, { async approve() { count += 1; throw new Error('secret backend error') } })
  await context.controller.refresh(); await context.controller.action('prepare', prepareBody())
  const body = approveBody(context.controller.snapshot().run)
  await assert.rejects(context.controller.action('approve', body), /not confirmed/)
  await assert.rejects(context.controller.action('approve', body))
  assert.equal(count, 1)
  assert.equal(context.controller.snapshot().canStop, true)
  assert.equal(context.controller.snapshot().error.includes('secret'), false)
})

test('uncertain runs block new preparation and reconciliation never invokes approve or prepare', async (t) => {
  const context = setup(t)
  context.setRun(evolve(makeRun(), 'OUTCOME_UNKNOWN', { outcome: { status: 'OUTCOME_UNKNOWN', reason: 'Acknowledgement lost', evidenceDigest: null } }))
  await context.controller.refresh()
  assert.equal(context.controller.snapshot().canPrepare, false)
  assert.equal(context.controller.snapshot().canReconcile, true)
  await context.controller.action('reconcile', { runId, expectedRunDigest: context.controller.snapshot().run.runDigest })
  assert.equal(context.calls.some(([action]) => ['prepare', 'approve'].includes(action)), false)
  assert.equal(context.controller.snapshot().run.phase, 'OUTCOME_UNKNOWN')
})

test('verified simulation and compact stored receipt remain explicitly nonphysical', async (t) => {
  const context = setup(t)
  const run = evolve(makeRun(), 'VERIFIED_SUCCESS', { outcome: { status: 'VERIFIED_SUCCESS', reason: 'Simulated state transition verified', evidenceDigest: digest('b') } })
  context.setRun(run)
  await context.controller.refresh(); await context.controller.action('select', { runId })
  await context.controller.action('receipt', { runId })
  assert.equal(context.controller.snapshot().run.mode, 'simulation')
  assert.equal(context.controller.snapshot().physicalExecutionAuthorized, false)
  assert.deepEqual(Object.keys(context.controller.snapshot().receipt).sort(), ['configurationSnapshotDigest', 'evidenceDigest', 'preparation', 'receiptDigest', 'runDigest', 'runId', 'snapshotDigest', 'verification'])
  assert.equal(context.controller.snapshot().receipt.verification.historical, true)
  assert.equal(context.controller.snapshot().receipt.evidenceDigest, run.outcome.evidenceDigest)
  assert.equal('detail' in context.controller.snapshot().run.events[0], false)
})

test('partial status failure retains read-only configuration reason without granting preparation', async (t) => {
  const context = setup(t, { async status() { return { ...status, availability: 'unavailable', reason: 'Commissioned observation source is missing' } }, async runs() { throw new Error('private host detail') } })
  await context.controller.refresh()
  assert.equal(context.controller.snapshot().error, 'Commissioned observation source is missing')
  assert.equal(context.controller.snapshot().canPrepare, false)
})

test('installed configuration count is visible without route while selection remains blocked', async (t) => {
  const context = setup(t)
  context.setRoute(null); await context.controller.refresh()
  assert.match(context.controller.snapshot().configurationReason, /1 local configuration\(s\) installed/)
  assert.deepEqual(context.controller.snapshot().configurations, [])
  assert.equal(context.controller.snapshot().canPrepare, false)
})

test('receipt follows only exact pinned configuration and evidence references without exposing snapshots', async (t) => {
  const context = setup(t)
  const run = makeRun()
  context.setRun(run)
  context.client.receipt = async () => makeReceipt(run, { contractVersion: 'physicalsystems-run-snapshot-v1', configurationSnapshotDigest: run.configurationDigest,
    preparationObservation: { evidence: { mode: 'simulation', readinessChecks: { markerGeometry: true }, privatePath: '/private/config' }, preconditionsMet: true, stopped: true, verified: null } })
  await context.controller.refresh()
  await context.controller.action('receipt', { runId })
  assert.equal(context.controller.snapshot().receipt.configurationSnapshotDigest, run.configurationDigest)
  assert.equal(context.controller.snapshot().receipt.preparation.preconditions, 'met')
  assert.equal(JSON.stringify(context.controller.snapshot()).includes('/private/config'), false)
  context.client.receipt = async () => makeReceipt(run, { contractVersion: 'physicalsystems-run-snapshot-v1', configurationSnapshotDigest: digest('b') })
  await assert.rejects(context.controller.action('receipt', { runId }), /does not match/)
  assert.equal(context.calls.filter(([action]) => action === 'snapshot').length, 1)
})

test('disconnect and disposal never stop, resume, approve or retry a Node-owned invocation', async (t) => {
  const context = setup(t)
  context.setRun(evolve(makeRun(), 'RUNNING'))
  await context.controller.refresh()
  const leave = context.controller.connect(); leave(); context.controller.dispose()
  await assert.rejects(context.controller.action('stop', { runId, reason: 'operator-requested-stop' }))
  assert.equal(context.calls.some(([action]) => ['prepare', 'approve', 'stop', 'reconcile'].includes(action)), false)
})
