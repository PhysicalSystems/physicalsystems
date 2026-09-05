import assert from 'node:assert/strict'
import test from 'node:test'
import { startedAt, tick, deferred, camera, view, visible, assertCleared } from './fixtures/workcell-browser.js'

test('camera replacement retains the exact visible image and metadata through fetch and decode, then swaps together', async (t) => {
  const ui = await view(t)
  const oldUrl = await ui.show(camera(1))
  const before = visible(ui)
  assert.equal(before.hidden, false)
  assert.match(before.details, /Frame 1 · age at receipt 100 ms · capture-one/)
  assert.match(before.observation, /simulated · exact-frame/)
  assert.match(before.kind, /SYNTHETIC TEST FRAME/)
  await ui.pushCamera(camera(2, { age: 200, observation: false }))
  assert.deepEqual(visible(ui), before, 'fetching must preserve the complete displayed observation')
  assert.equal(ui.revoked.includes(oldUrl), false)
  await ui.response()
  assert.deepEqual(visible(ui), before, 'decoding must preserve the complete displayed observation')
  assert.equal(ui.decodes.at(-1).image.id === 'preview' && ui.elements.get('preview') === ui.decodes.at(-1).image, false)
  await ui.decode()
  assert.notEqual(visible(ui).src, oldUrl)
  assert.equal(visible(ui).hidden, false)
  assert.match(visible(ui).details, /Frame 2 · age at receipt 200 ms · capture-one/)
  assert.match(visible(ui).observation, /Unknown/)
  assert.equal(ui.revoked.filter((url) => url === oldUrl).length, 1)
  assert.equal(ui.elements.get('preview').alt, 'Exact selected-camera preview frame')
})

test('newer SSE frames coalesce behind an in-flight replacement without aborting a still-fresh frame', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.pushCamera(camera(2))
  const pending = ui.requests.at(-1)
  await ui.pushCamera(camera(3))
  await ui.pushCamera(camera(4))
  assert.equal(ui.requests.length, 2)
  assert.equal(pending.options.signal.aborted, false)
  await ui.response(pending); await ui.decode()
  assert.match(visible(ui).details, /Frame 2 ·/)
  assert.deepEqual(ui.requests.map((request) => request.path), [
    '/api/camera/frame/preview-capture-one-1', '/api/camera/frame/preview-capture-one-2', '/api/camera/frame/preview-capture-one-4',
  ])
  await ui.response(); await ui.decode()
  assert.match(visible(ui).details, /Frame 4 ·/)
})

test('the displayed frame expires on its own receipt without cancelling a newer valid pending frame', async (t) => {
  const ui = await view(t)
  const oldUrl = await ui.show(camera(1, { age: 1800 }))
  await ui.advance(100)
  await ui.pushCamera(camera(2, { receivedAt: ui.now(), age: 0 }))
  const pending = ui.requests.at(-1)
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, reply: 'An unrelated assistant update' } })
  await ui.advance(400)
  assertCleared(ui)
  assert.equal(pending.options.signal.aborted, false)
  assert.equal(ui.revoked.filter((url) => url === oldUrl).length, 1)
  await ui.response(pending); await ui.decode()
  assert.match(visible(ui).details, /Frame 2 ·/)
  assert.equal(visible(ui).hidden, false)
})

test('a replacement that expires while decoding cannot be admitted by a newer fresh SSE frame', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const before = visible(ui)
  await ui.pushCamera(camera(2, { age: 1800 }))
  await ui.response()
  const pending = ui.decodes.at(-1), expiredUrl = pending.image.src
  await ui.advance(100)
  await ui.pushCamera(camera(3, { receivedAt: ui.now(), age: 0 }))
  await ui.advance(400)
  await ui.decode(pending)
  assert.deepEqual(visible(ui), before)
  assert.equal(ui.revoked.filter((url) => url === expiredUrl).length, 1)
  assert.match(ui.requests.at(-1).path, /-3$/)
  await ui.response(); await ui.decode()
  assert.match(visible(ui).details, /Frame 3 ·/)
})

test('an expired fetch releases the queue and its late response cannot cancel the next replacement', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.pushCamera(camera(2, { age: 1800 }))
  const expiredRequest = ui.requests.at(-1)
  await ui.advance(100)
  await ui.pushCamera(camera(3, { receivedAt: ui.now(), age: 0 }))
  await ui.advance(100)
  assert.equal(expiredRequest.options.signal.aborted, true)
  const currentRequest = ui.requests.at(-1)
  assert.match(currentRequest.path, /-3$/)
  await ui.response(expiredRequest)
  assert.equal(currentRequest.options.signal.aborted, false)
  assert.match(visible(ui).details, /Frame 1 ·/)
  await ui.response(currentRequest); await ui.decode()
  assert.match(visible(ui).details, /Frame 3 ·/)
})

test('repeated same-frame and unrelated SSE updates cannot renew the displayed frame lifetime', async (t) => {
  const ui = await view(t)
  const oldUrl = await ui.show(camera(1, { age: 1800 }))
  await ui.advance(100)
  await ui.pushCamera(camera(1, { receivedAt: ui.now(), age: 100 }))
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, reply: 'Still working' } })
  await ui.advance(400)
  assertCleared(ui)
  assert.equal(ui.revoked.filter((url) => url === oldUrl).length, 1)
})

test('an exact-frame observation can expire before its JPEG without clearing still-fresh pixels', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1, { observationExpiresAfterMs: 300 }))
  const before = visible(ui)
  await ui.advance(199)
  assert.equal(visible(ui).observation, before.observation)
  await ui.advance(1)
  assert.equal(visible(ui).src, before.src)
  assert.equal(visible(ui).hidden, false)
  assert.equal(visible(ui).details, before.details)
  assert.match(visible(ui).observation, /Unknown.*stale observation/)
  assert.equal(ui.revoked.length, 0)
})

test('a stale status for the same displayed frame immediately demotes its observation', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const before = visible(ui)
  const stale = camera(1)
  stale.status.observationStatus = 'stale'; stale.frame.observation.status = 'stale'
  await ui.pushCamera(stale)
  assert.equal(visible(ui).src, before.src)
  assert.equal(visible(ui).hidden, false)
  assert.equal(visible(ui).details, before.details)
  assert.match(visible(ui).observation, /Unknown.*stale observation/)
  assert.equal(ui.requests.length, 1)
  await ui.pushCamera(camera(2))
  assert.equal(visible(ui).src, before.src)
  assert.match(visible(ui).observation, /Unknown.*stale observation/, 'a newer frame must not revive the old observation')
  await ui.response(); await ui.decode()
  assert.match(visible(ui).details, /Frame 2 ·/)
  assert.match(visible(ui).observation, /simulated · exact-frame/)
})

test('a newer pending frame cannot change the displayed frame observation status', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  const before = visible(ui)
  const stale = camera(2)
  stale.status.observationStatus = 'stale'; stale.frame.observation.status = 'stale'
  await ui.pushCamera(stale)
  assert.deepEqual(visible(ui), before)
  await ui.response()
  assert.deepEqual(visible(ui), before)
  await ui.decode()
  assert.match(visible(ui).details, /Frame 2 ·/)
  assert.match(visible(ui).observation, /Unknown.*stale observation/)
})

for (const stage of ['fetch', 'decode']) {
  for (const condition of ['stopped', 'starting', 'stale', 'stop-unconfirmed', 'unavailable', 'missing-frame', 'disconnect', 'pagehide',
    'camera', 'candidate-digest', 'capture-session', 'harness-session', 'clock-session', 'hardware-identity', 'source-kind',
    'mismatched-candidate', 'mismatched-capture', 'missing-identity']) {
    test(`${condition} clears the visible frame during ${stage}; late completion cannot restore it`, async (t) => {
      const ui = await view(t)
      const oldUrl = await ui.show(camera(1))
      await ui.pushCamera(camera(2))
      const request = ui.requests.at(-1)
      let decode
      if (stage === 'decode') { await ui.response(request); decode = ui.decodes.at(-1) }
      if (condition === 'disconnect') await ui.disconnect()
      else if (condition === 'pagehide') await ui.close()
      else {
        let next = camera(3)
        if (['stopped', 'starting', 'stale', 'stop-unconfirmed'].includes(condition)) next.status.phase = condition
        else if (condition === 'unavailable') next.availability = 'unavailable'
        else if (condition === 'missing-frame') { next.frame = null; next.previewFrameId = null }
        else if (condition === 'camera') next = camera(3, { candidate: 'camera-two' })
        else if (condition === 'candidate-digest') next = camera(3, { digest: 'changed-candidate-digest' })
        else if (condition === 'capture-session') next = camera(3, { session: 'capture-two' })
        else if (condition === 'clock-session') next = camera(3, { clock: 'clock-two' })
        else if (condition === 'hardware-identity') next = camera(3, { hardware: '/dev/video2' })
        else if (condition === 'source-kind') next = camera(3, { kind: 'live-camera' })
        else if (condition === 'mismatched-candidate') next.status.selectedCandidateId = 'camera-other'
        else if (condition === 'mismatched-capture') next.status.captureSessionId = 'capture-other'
        else if (condition === 'missing-identity') delete next.frame.capture.clockSessionId
        await ui.push({ ...ui.state(), camera: next, ...(condition === 'harness-session' ? { sessionId: 'harness-two' } : {}) })
      }
      assertCleared(ui)
      assert.equal(request.options.signal.aborted, true)
      assert.equal(ui.revoked.filter((url) => url === oldUrl).length, 1)
      if (stage === 'fetch') await ui.response(request)
      else await ui.decode(decode)
      assertCleared(ui)
      if (decode) assert.equal(ui.revoked.filter((url) => url === decode.image.src).length, 1)
    })
  }
}

test('operator Stop clears immediately and subsequent live SSE cannot restore the stopped capture', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.pushCamera(camera(2)); await ui.response()
  const pending = ui.decodes.at(-1)
  void ui.elements.get('camera-stop').onclick()
  await tick()
  assertCleared(ui)
  assert.equal(ui.actions.length, 1)
  assert.deepEqual(JSON.parse(ui.actions[0].options.body), { expectedCaptureSessionId: 'capture-one' })
  await ui.pushCamera(camera(3))
  await ui.decode(pending)
  assertCleared(ui)
  assert.equal(ui.requests.length, 2)
  ui.actions[0].resolve(Response.json(ui.state()))
  await tick(); await tick()
  assertCleared(ui)
  await ui.pushCamera(camera(1, { session: 'capture-two' }))
  await ui.response(); await ui.decode()
  assert.equal(visible(ui).hidden, false)
  assert.match(visible(ui).details, /capture-two/)
})

test('changing the camera selector clears immediately and prevents old-camera SSE from restoring a frame', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  await ui.pushCamera(camera(2)); await ui.response()
  const pending = ui.decodes.at(-1)
  ui.elements.get('camera-select').onchange({ target: { value: 'camera-two' } })
  assertCleared(ui)
  await ui.pushCamera(camera(3))
  await ui.decode(pending)
  assertCleared(ui)
  assert.equal(ui.requests.length, 2)
  assert.equal(ui.actions.length, 0, 'selection alone does not open or stop a camera')
})

for (const failure of ['fetch', 'content-type', 'decode']) {
  test(`a replacement ${failure} failure keeps the previous valid image and metadata`, async (t) => {
    const ui = await view(t)
    await ui.show(camera(1))
    const before = visible(ui)
    await ui.pushCamera(camera(2, { observation: false }))
    if (failure === 'fetch') await ui.response(ui.requests.at(-1), 404, 'application/json')
    else if (failure === 'content-type') await ui.response(ui.requests.at(-1), 200, 'image/png')
    else { await ui.response(); await ui.decode(ui.decodes.at(-1), true) }
    assert.deepEqual(visible(ui), before)
    assert.equal(ui.requests.length, 2, 'a failed latest frame must not create an immediate retry loop')
    if (failure === 'decode') assert.equal(ui.revoked.filter((url) => url === ui.decodes.at(-1).image.src).length, 1)
    await ui.pushCamera(camera(3))
    await ui.response(); await ui.decode()
    assert.match(visible(ui).details, /Frame 3 ·/)
    await ui.close()
    assert.deepEqual([...ui.revoked].sort(), [...ui.created].sort(), 'every created URL is released exactly once')
  })
}
