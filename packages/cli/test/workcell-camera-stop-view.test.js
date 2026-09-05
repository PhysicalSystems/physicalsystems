import assert from 'node:assert/strict'
import test from 'node:test'
import { camera, view, tick, assertCleared } from './fixtures/workcell-browser.js'

function stoppedState(ui, phase = 'stopped') {
  const state = structuredClone(ui.state())
  state.camera.status.phase = phase
  state.camera.frame = null
  state.camera.previewFrameId = null
  state.camera.stopUnconfirmed = phase !== 'stopped'
  state.camera.stopCaptureSessionId = phase === 'stopped' ? null : state.camera.status.captureSessionId
  return state
}

test('camera Stop stays available while the shared assistant works', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, status: 'working' } })
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick()
  assertCleared(ui)
  assert.equal(ui.actions.length, 1)
  ui.actions[0].resolve(Response.json(stoppedState(ui)))
  await stop
  assert.match(ui.elements.get('camera-state').textContent, /^STOPPED$/)
})

test('camera Stop bypasses a pending ordinary refresh and its late response cannot restore capture', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const oldState = structuredClone(ui.state())
  const refresh = ui.elements.get('refresh').onclick()
  await tick()
  assert.equal(ui.actions[0].path, '/api/refresh')
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick()
  await tick()
  assert.equal(ui.actions[1].path, '/api/camera/stop')
  ui.actions[1].resolve(Response.json(stoppedState(ui)))
  await stop
  ui.actions[0].resolve(Response.json(oldState))
  await refresh
  assertCleared(ui)
  assert.match(ui.elements.get('camera-state').textContent, /STOPPED|STOP UNCONFIRMED/)
})

test('a hung camera Stop is bounded, clears pixels, and permits exact-session retry', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const first = ui.elements.get('camera-stop').onclick()
  await tick()
  const pending = ui.actions[0]
  assert.ok(pending.options.signal, 'Stop carries a bounded abort signal')
  assert.equal(ui.elements.get('camera-stop').disabled, true)
  await ui.advance(7000)
  await first
  assert.equal(pending.options.signal.aborted, true)
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  assert.equal(ui.elements.get('refresh').disabled, false)
  assert.match(ui.elements.get('camera-state').textContent, /STOP UNCONFIRMED/)
  assert.match(ui.elements.get('notice').textContent, /not confirmed|unconfirmed/i)
  assertCleared(ui)
  const retry = ui.elements.get('camera-stop').onclick()
  assert.deepEqual(JSON.parse(ui.actions[1].options.body), { expectedCaptureSessionId: 'capture-one' })
  ui.actions[1].resolve(Response.json(stoppedState(ui)))
  await retry
  pending.resolve(Response.json({ ...ui.state(), camera: camera(2, { receivedAt: ui.now() }) }))
  await tick(); await tick()
  assertCleared(ui)
  assert.equal(ui.elements.get('camera-state').textContent, 'STOPPED')
})

test('a failed Stop reports unconfirmed capture rather than LIVE PREVIEW and keeps retry available', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const stop = ui.elements.get('camera-stop').onclick()
  ui.actions[0].resolve(Response.json({ error: 'Workcell action could not be completed' }, { status: 503 }))
  await stop
  await ui.pushCamera(camera(2))
  assertCleared(ui)
  assert.equal(ui.elements.get('camera-state').textContent, 'STOP UNCONFIRMED')
  assert.match(ui.elements.get('camera-detail').textContent, /not confirmed|unconfirmed/i)
  assert.equal(ui.elements.get('camera-stop').disabled, false)
})

test('a reopened view suppresses an unconfirmed session and can retry using its retained exact identity', async (t) => {
  const ui = await view(t)
  await ui.pushCamera({ ...camera(1), availability: 'unavailable', stopUnconfirmed: true,
    stopCaptureSessionId: 'capture-one', status: { phase: 'idle', captureSessionId: null } })
  assertCleared(ui)
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick()
  assert.deepEqual(JSON.parse(ui.actions[0].options.body), { expectedCaptureSessionId: 'capture-one' })
  ui.actions[0].resolve(Response.json(stoppedState(ui)))
  await stop
})

test('camera Stop can reach its exact known session while the event stream is disconnected', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.disconnect()
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick()
  assert.equal(ui.actions[0].path, '/api/camera/stop')
  ui.actions[0].resolve(Response.json(stoppedState(ui)))
  await stop
  assertCleared(ui)
})

test('an owned Start can be cancelled before it returns a capture identity', async (t) => {
  const ui = await view(t)
  await ui.pushCamera({ availability: 'available', pending: 'start', frame: null,
    status: { phase: 'idle', captureSessionId: null, availableCameras: [] } })
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const stop = ui.elements.get('camera-stop').onclick()
  assert.deepEqual(JSON.parse(ui.actions[0].options.body), { expectedCaptureSessionId: null })
  ui.actions[0].resolve(Response.json({ ...ui.state(), camera: { ...ui.state().camera, stopUnconfirmed: true } }))
  await stop
  assert.equal(ui.elements.get('camera-state').textContent, 'STOP UNCONFIRMED')
  assertCleared(ui)
})

test('authoritative stopped state clears only the obsolete camera Stop warning', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const stop = ui.elements.get('camera-stop').onclick()
  ui.actions[0].resolve(Response.json(stoppedState(ui, 'stop-unconfirmed')))
  await stop
  assert.match(ui.elements.get('notice').textContent, /not confirmed/i)
  await ui.push(stoppedState(ui))
  assert.equal(ui.elements.get('camera-state').textContent, 'STOPPED')
  assert.doesNotMatch(ui.elements.get('notice').textContent, /not confirmed|retry Stop/i)
})

test('an older Stop response cannot replace a newer confirmed state delivered by SSE', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const oldUnconfirmed = stoppedState(ui, 'stop-unconfirmed')
  const stop = ui.elements.get('camera-stop').onclick()
  await ui.push(stoppedState(ui))
  ui.actions[0].resolve(Response.json(oldUnconfirmed))
  await stop
  assert.equal(ui.elements.get('camera-state').textContent, 'STOPPED')
  assert.equal(ui.elements.get('camera-stop').disabled, true)
  assertCleared(ui)
})

test('failed cancellation before capture identity is known never admits the late Start image', async (t) => {
  const ui = await view(t)
  await ui.pushCamera({ availability: 'available', pending: 'start', frame: null,
    status: { phase: 'idle', captureSessionId: null, availableCameras: [] } })
  const stop = ui.elements.get('camera-stop').onclick()
  ui.actions[0].resolve(Response.json({ error: 'Camera Stop was not confirmed' }, { status: 503 }))
  await stop
  await ui.pushCamera(camera(1))
  assert.equal(ui.requests.length, 0, 'a late identity does not authorize restoring cancelled preview pixels')
  assertCleared(ui)
  assert.equal(ui.elements.get('camera-state').textContent, 'STOP UNCONFIRMED')
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  const retry = ui.elements.get('camera-stop').onclick()
  assert.deepEqual(JSON.parse(ui.actions[1].options.body), { expectedCaptureSessionId: 'capture-one' })
  ui.actions[1].resolve(Response.json(stoppedState(ui)))
  await retry
  assertCleared(ui)
})

test('an old Harness session Stop completion cannot clear a newer session Stop pending guard', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const oldState = stoppedState(ui)
  const first = ui.elements.get('camera-stop').onclick()
  await ui.push({ ...ui.state(), sessionId: 'harness-two', camera: camera(2, { session: 'capture-two' }) })
  const second = ui.elements.get('camera-stop').onclick()
  assert.equal(ui.elements.get('camera-stop').disabled, true)
  assert.deepEqual(JSON.parse(ui.actions[1].options.body), { expectedCaptureSessionId: 'capture-two' })
  ui.actions[0].resolve(Response.json(oldState))
  await first
  const pendingRemains = ui.elements.get('camera-stop').disabled
  ui.actions[1].resolve(Response.json(stoppedState(ui)))
  await second
  assert.equal(pendingRemains, true, 'old cleanup cannot clear the current Stop guard')
  assert.equal(ui.state().sessionId, 'harness-two')
  assert.equal(ui.elements.get('camera-state').textContent, 'STOPPED')
  assertCleared(ui)
})

test('a queued Start cancelled before capture leaves an idle view with Start available', async (t) => {
  const ui = await view(t)
  const availableCameras = [{ candidateId: 'camera-one', candidateDigest: 'digest', displayName: 'Camera one', identityStability: 'stable' }]
  await ui.pushCamera({ availability: 'available', pending: 'start', stopPending: false, stopUnconfirmed: false, frame: null,
    status: { phase: 'idle', captureSessionId: null, availableCameras } })
  const stopping = ui.elements.get('camera-stop').onclick()
  assert.deepEqual(JSON.parse(ui.actions[0].options.body), { expectedCaptureSessionId: null })
  ui.actions[0].resolve(Response.json({ ...ui.state(), camera: { ...ui.state().camera, stopPending: true } }))
  await stopping
  // The controller cancelled its queued Start before calling the Node; no
  // capture session ever existed, so no exact-session stopped status will come.
  await ui.pushCamera({ ...ui.state().camera, pending: null, stopPending: false, stopUnconfirmed: false })
  ui.elements.get('camera-select').onchange({ target: { value: 'camera-one' } })
  await tick()
  assert.equal(ui.elements.get('camera-start').disabled, false)
  assert.equal(ui.elements.get('camera-stop').disabled, true, 'there is no pending Start or capture to stop')
  assert.match(ui.elements.get('camera-state').textContent, /^(IDLE|START CANCELLED)$/)
  assert.equal(ui.actions.length, 1, 'the cancellation never guesses an exact capture identity')
  assertCleared(ui)
})
