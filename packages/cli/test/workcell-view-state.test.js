import assert from 'node:assert/strict'
import test from 'node:test'
import { cameraIsFresh, executionReadIsFresh, executionApprovalAvailable } from '../src/harness/workcell-view/view-state.js'

const received = Date.parse('2026-09-02T18:00:00.000Z')
function camera() {
  return { availability: 'available', receivedAt: new Date(received).toISOString(), frame: { sequence: 1 }, previewFrameId: 'exact-frame',
    status: { phase: 'live', frameFresh: true, frameAgeMs: 1500, staleAfterMs: 2000 } }
}

test('browser freshness expires on camera receipt plus existing age, not agent updates', () => {
  const value = camera()
  assert.equal(cameraIsFresh(value, received), true)
  assert.equal(cameraIsFresh(value, received + 499), true)
  assert.equal(cameraIsFresh(value, received + 500), false)
  // An unrelated assistant or workflow render reuses the same camera receipt.
  assert.equal(cameraIsFresh({ ...value }, received + 1000), false)
})

test('browser frame admission rejects stale, unavailable, missing and invalid-clock state', () => {
  assert.equal(cameraIsFresh(null, received), false)
  assert.equal(cameraIsFresh(camera(), received - 1), false)
  for (const edit of [
    (c) => { c.status.phase = 'stale' }, (c) => { c.status.frameFresh = false },
    (c) => { c.availability = 'unavailable' }, (c) => { c.frame = null },
    (c) => { c.previewFrameId = null }, (c) => { c.receivedAt = 'invalid' },
    (c) => { c.status.frameAgeMs = -1 }, (c) => { c.status.staleAfterMs = NaN },
  ]) { const value = camera(); edit(value); assert.equal(cameraIsFresh(value, received), false) }
})

test('browser approval expires independently of unrelated camera and agent SSE events', () => {
  const execution = { availability: 'available', receivedAt: new Date(received).toISOString(), canApprove: true,
    run: { phase: 'WAITING_FOR_APPROVAL', approval: { approvedAt: null, expiresAt: new Date(received + 3000).toISOString() } } }
  assert.equal(executionApprovalAvailable(execution, received), true)
  assert.equal(executionApprovalAvailable({ ...execution }, received + 3000), false)
  execution.run.approval.expiresAt = new Date(received + 30000).toISOString()
  assert.equal(executionApprovalAvailable(execution, received + 5000), false)
  assert.equal(executionReadIsFresh(execution, received - 1), false)
  assert.equal(executionApprovalAvailable({ ...execution, availability: 'unavailable' }, received), false)
  execution.run.phase = 'RUNNING'
  assert.equal(executionApprovalAvailable(execution, received), false)
})
