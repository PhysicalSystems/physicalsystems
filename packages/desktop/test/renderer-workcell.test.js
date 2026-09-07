import assert from 'node:assert/strict'
import test from 'node:test'
import { view, camera, tick, visible, assertCleared } from './fixtures/renderer-workcell.js'

function stopped(ui) {
  const next = structuredClone(ui.state()); next.revision += 1
  next.camera.status.phase = 'stopped'; next.camera.frame = null; next.camera.previewFrameId = null
  next.camera.stopUnconfirmed = false; next.camera.stopPending = false
  return next
}

test('desktop frame IPC keeps decoded pixels and exact metadata until an atomic replacement', async (t) => {
  const ui = await view(t); const old = await ui.show(camera(1)); const before = visible(ui)
  await ui.pushCamera(camera(2, { age: 200, observation: false }))
  assert.deepEqual(visible(ui), before)
  assert.equal(ui.requests.at(-1).name, 'workcell.camera.frame')
  assert.equal(ui.requests.at(-1).payload.frameId, 'preview-capture-one-2')
  await ui.response(); assert.deepEqual(visible(ui), before)
  await ui.decode(); assert.notEqual(visible(ui).src, old)
  assert.match(visible(ui).details, /Frame 2 · age at receipt 200 ms/)
  assert.match(visible(ui).observation, /Unknown/)
  assert.equal(ui.revoked.filter((url) => url === old).length, 1)
})

test('desktop failed and slow frames never extend the old pixels freshness', async (t) => {
  const ui = await view(t); await ui.show(camera(1, { age: 1600 }))
  await ui.pushCamera(camera(2)); await ui.response(undefined, true)
  assert.match(visible(ui).details, /Frame 1/)
  await ui.advance(401); assertCleared(ui)
})

test('desktop disconnect, capture changes and disposal clear camera pixels', async (t) => {
  const ui = await view(t); await ui.show(camera(1)); await ui.disconnect(); assertCleared(ui)
  await ui.show(camera(2)); await ui.pushCamera(camera(3, { session: 'capture-two' })); assertCleared(ui)
  await ui.response(); await ui.decode(); assert.match(visible(ui).details, /capture-two/)
  await ui.close(); assertCleared(ui)
})

test('desktop Stop bypasses assistant and ordinary request busy state and retains ownership until confirmed', async (t) => {
  const ui = await view(t); await ui.show(camera(1))
  const refresh = ui.elements.get('refresh').onclick(); await tick()
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, status: 'working' } })
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick(); assertCleared(ui)
  assert.equal(ui.actions[1].name, 'workcell.camera.stop')
  assert.equal(ui.actions[1].payload.expectedCaptureSessionId, 'capture-one')
  ui.actions[1].reject(new Error('Temporary service failure')); await stop
  assert.match(ui.elements.get('camera-state').textContent, /STOP UNCONFIRMED/)
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const retry = ui.elements.get('camera-stop').onclick(); ui.actions[2].resolve(stopped(ui)); await retry
  ui.actions[0].resolve(ui.state()); await refresh
  assertCleared(ui); assert.equal(ui.elements.get('camera-state').textContent, 'STOPPED')
})

test('desktop Stop IPC is bounded and late completion cannot restore image', async (t) => {
  const ui = await view(t); await ui.show(camera(1))
  const stop = ui.elements.get('camera-stop').onclick(); await tick(); await ui.advance(6501); await stop
  assert.equal(ui.elements.get('camera-stop').disabled, false); assertCleared(ui)
  assert.match(ui.elements.get('notice').textContent, /not confirmed/i)
  ui.actions[0].resolve({ ...ui.state(), camera: camera(2, { receivedAt: ui.now() }) }); await tick(); await tick(); assertCleared(ui)
})

test('desktop frames reject mismatched IPC identity even if image bytes decode', async (t) => {
  const ui = await view(t); await ui.show(camera(1)); const before = visible(ui)
  await ui.pushCamera(camera(2)); ui.requests.at(-1).resolve({ id: 'wrong-frame', contentType: 'image/jpeg', bytes: [1,2,3] })
  await tick(); await tick(); assert.deepEqual(visible(ui), before); assert.equal(ui.decodes.length, 1)
})

test('desktop execution uses exact configuration and approval digests and expires permission', async (t) => {
  const ui = await view(t)
  const run = { runId: 'run-one', revision: 1, phase: 'WAITING_FOR_APPROVAL', mode: 'simulation', inputs: {}, events: [], stopStatus: 'not_requested', capabilityId: 'transfer', implementationId: 'sim', runDigest: 'run-digest', configurationDigest: 'configuration-digest', approval: { digest: 'approval-digest', approvedAt: null, expiresAt: new Date(ui.now() + 3000).toISOString() } }
  await ui.push({ ...ui.state(), workflow: { routeReceipt: { receiptDigest: 'route-digest', decision: { decision_status: 'selected', candidates: [], request_rejection_codes: [] }, request: { arguments: [] }, capabilityId: 'transfer' } }, execution: { availability: 'available', receivedAt: new Date(ui.now()).toISOString(), canPrepare: true, canApprove: true, canStop: true, configurations: [{ configurationId: 'configuration-one', configurationDigest: 'configuration-digest', displayName: 'Fixture', mode: 'simulation' }], run } })
  ui.elements.get('configuration-select').onchange({ target: { value: 'configuration-one' } })
  ui.elements.get('run-prepare').onclick(); await tick()
  assert.equal(ui.actions[0].name, 'workcell.execution.prepare')
  assert.deepEqual({ ...ui.actions[0].payload }, { configurationId: 'configuration-one', expectedConfigurationDigest: 'configuration-digest', routeReceiptDigest: 'route-digest' })
  ui.actions[0].resolve(ui.state()); await tick(); await tick()
  ui.elements.get('run-confirm').checked = true; ui.elements.get('run-confirm').onchange(); ui.elements.get('run-approve').onclick(); await tick()
  assert.deepEqual({ ...ui.actions[1].payload }, { runId: 'run-one', expectedRunDigest: 'run-digest', approvalDigest: 'approval-digest', approved: true })
  ui.actions[1].resolve(ui.state()); await tick(); await ui.advance(3500)
  assert.equal(ui.elements.get('run-approve').disabled, true); assert.equal(ui.elements.get('run-confirm').checked, false)
  assert.equal(ui.elements.get('run-stop').disabled, false)
})
