// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionController } from '../src/harness/execution-controller.js'
import { makeRun, evolve, route, status, instant } from './fixtures/execution.js'

function fixture(t) {
  const active = makeRun({ runId: `run-${'b'.repeat(32)}` })
  const historical = evolve(makeRun(), 'CANCELLED', { stopStatus: 'STOP_CONFIRMED' })
  const records = new Map([[historical.runId, historical], [active.runId, active]])
  const calls = []
  let listing = [historical, active], stopReply = null
  const client = {
    status: async () => status,
    runs: async () => ({ runs: listing }),
    run: async (id) => records.get(id),
    stop: async (id, body, expected) => {
      calls.push({ id, body, expected })
      if (stopReply instanceof Error) throw stopReply
      const value = stopReply || evolve(records.get(id), 'CANCELLED', { stopStatus: 'STOP_CONFIRMED' })
      records.set(id, value)
      return value
    },
  }
  const controller = createExecutionController({ client, currentRoute: () => route, now: () => instant })
  t.after(() => controller.dispose())
  return { controller, client, active, historical, calls, records, setListing: (value) => { listing = value }, setStopReply: (value) => { stopReply = value } }
}

test('omission from a later history listing retains unresolved ownership and exact Stop bindings', async (t) => {
  const f = fixture(t)
  await f.controller.refresh()
  await f.controller.action('select', { runId: f.historical.runId })
  f.setListing([f.historical])
  await f.controller.refresh()
  assert.ok(f.controller.snapshot().runs.some((run) => run.runId === f.active.runId), 'a partial history listing must not discard the known unresolved invocation')
  assert.equal(f.controller.snapshot().canPrepare, false)
  assert.deepEqual(f.controller.snapshot().activeRuns.map((run) => run.runId), [f.active.runId])
  await f.controller.action('stop', { runId: f.active.runId, reason: 'operator-requested-stop' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].id, f.active.runId)
  assert.deepEqual(f.calls[0].expected, f.active, 'the selected history must never supply another run’s bindings')
  assert.equal(f.controller.snapshot().run.runId, f.historical.runId)
  assert.equal(f.controller.snapshot().run.runDigest, f.historical.runDigest)
  assert.deepEqual(f.controller.snapshot().activeRuns, [])
})

test('failed or mismatched nonselected Stop retains its owner and never changes history', async (t) => {
  const f = fixture(t)
  await f.controller.refresh()
  await f.controller.action('select', { runId: f.historical.runId })
  f.setStopReply(new Error('temporary response failure'))
  await assert.rejects(f.controller.action('stop', { runId: f.active.runId, reason: 'operator-requested-stop' }), /not be confirmed/)
  assert.deepEqual(f.controller.snapshot().activeRuns.map((run) => run.runId), [f.active.runId])
  assert.equal(f.controller.snapshot().activeRuns[0].canStop, true)
  f.setStopReply(f.historical)
  await assert.rejects(f.controller.action('stop', { runId: f.active.runId, reason: 'operator-requested-stop' }), /not be confirmed/)
  assert.deepEqual(f.controller.snapshot().activeRuns.map((run) => run.runId), [f.active.runId])
  assert.equal(f.controller.snapshot().run.runDigest, f.historical.runDigest)
})

test('a terminal phase with STOP_UNCONFIRMED still blocks preparation and exposes exact Stop', async (t) => {
  const f = fixture(t)
  const uncertain = evolve(f.active, 'CANCELLED', { stopStatus: 'STOP_UNCONFIRMED' })
  f.records.set(uncertain.runId, uncertain); f.setListing([f.historical, uncertain])
  await f.controller.refresh()
  await f.controller.action('select', { runId: f.historical.runId })
  assert.equal(f.controller.snapshot().canPrepare, false)
  assert.equal(f.controller.snapshot().activeRuns[0].stopStatus, 'STOP_UNCONFIRMED')
  await f.controller.action('stop', { runId: uncertain.runId, reason: 'operator-requested-stop' })
  assert.deepEqual(f.controller.snapshot().activeRuns, [])
  assert.equal(f.controller.snapshot().run.runId, f.historical.runId)
})

test('a late history selection cannot revive an independently stopped known run', async (t) => {
  const f = fixture(t)
  await f.controller.refresh()
  await f.controller.action('select', { runId: f.historical.runId })
  let reply
  f.client.run = async () => new Promise((resolve) => { reply = resolve })
  const selection = f.controller.action('select', { runId: f.active.runId })
  await f.controller.action('stop', { runId: f.active.runId, reason: 'operator-requested-stop' })
  assert.equal(f.controller.snapshot().run.runId, f.historical.runId, 'Stop itself does not replace history selection')
  reply(f.active)
  await selection
  assert.equal(f.controller.snapshot().run.runId, f.active.runId, 'the explicit selection may finish')
  assert.equal(f.controller.snapshot().run.phase, 'CANCELLED', 'the newest confirmed Stop wins over the old selection response')
  assert.equal(f.controller.snapshot().run.stopStatus, 'STOP_CONFIRMED')
  assert.deepEqual(f.controller.snapshot().activeRuns, [])
})
