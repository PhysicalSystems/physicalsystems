import assert from 'node:assert/strict'
import test from 'node:test'
import { createSetupView } from '../src/harness/setup-view.js'
import { createSetupInspector } from '../src/harness/setup-inspection.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(t, read) {
  let context = {}, clock = Date.now(), notifications = 0
  const report = { inspection: { status: 'available', expiresAt: new Date(clock + 5000).toISOString() }, physicalExecutionAuthorized: false }
  const view = createSetupView({ inspector: { inspect: read || (async () => report), dispose() {} }, getContext: () => context,
    now: () => clock, onChange: () => { notifications++ } })
  t.after(() => view.dispose())
  return { view, report, change() { context = {}; view.contextChanged() }, clock(value) { clock += value }, notices: () => notifications }
}

test('shared setup report is inert until explicit inspection, expires on its original deadline and does not survive context changes', async t => {
  const h = setup(t)
  assert.deepEqual(h.view.snapshot(), { pending: false, report: null, historicalReport: null, error: null })
  await h.view.inspect()
  assert.equal(h.view.snapshot().report, h.report)
  h.clock(4999)
  assert.equal(h.view.snapshot().report, h.report)
  h.clock(1)
  assert.equal(h.view.snapshot().report, null)
  assert.equal(h.view.snapshot().historicalReport, h.report, 'instructions remain readable as historical guidance only')
  assert.match(h.view.snapshot().error, /expired/)
  h.change()
  assert.deepEqual(h.view.snapshot(), { pending: false, report: null, historicalReport: null, error: null })
})

test('late replies after context change, cancellation or disposal cannot repopulate the browser report', async t => {
  for (const action of ['context', 'cancel', 'dispose']) {
    const pending = deferred(), abort = new AbortController()
    let signal
    const h = setup(t, async (_args, options) => { signal = options.signal; return pending.promise })
    const reading = h.view.inspect({}, { signal: abort.signal })
    assert.equal(h.view.snapshot().pending, true)
    if (action === 'context') h.change()
    else if (action === 'cancel') abort.abort()
    else h.view.dispose()
    assert.equal(signal.aborted, action !== 'context')
    pending.resolve(h.report)
    await reading
    assert.equal(h.view.snapshot().report, null)
    assert.equal(h.view.snapshot().pending, false)
  }
})

test('duplicate inspector response never overwrites the pending shared report', async t => {
  const pending = deferred()
  let calls = 0
  const h = setup(t, () => ++calls === 1 ? pending.promise : { inspection: { status: 'busy', expiresAt: null } })
  const first = h.view.inspect()
  assert.equal((await h.view.inspect()).inspection.status, 'busy')
  assert.equal(h.view.snapshot().pending, true)
  assert.equal(h.view.snapshot().report, null)
  pending.resolve(h.report)
  await first
  assert.equal(h.view.snapshot().report, h.report)
})

test('clock rollback clears the stored report and inspection failures show only a fixed retry message', async t => {
  const h = setup(t)
  await h.view.inspect()
  h.clock(-1)
  assert.equal(h.view.snapshot().report, null)
  const failing = setup(t, async () => { throw Error('private-token /private/config') })
  await assert.rejects(failing.view.inspect())
  assert.equal(failing.view.snapshot().pending, false)
  assert.match(failing.view.snapshot().error, /Retry Inspect setup/)
  assert.doesNotMatch(failing.view.snapshot().error, /private/)
})

test('disposing the shared view prevents new underlying reads even before the inspector is separately disposed', async t => {
  let reads = 0
  const inspector = createSetupInspector({ client: { status() { reads++; throw Error('must not read') } } })
  const view = createSetupView({ inspector, getContext: () => ({}) })
  t.after(() => view.dispose())
  view.dispose()
  assert.equal((await view.inspect()).inspection.status, 'disposed')
  assert.equal(reads, 0)
})
