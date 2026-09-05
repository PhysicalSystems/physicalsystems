import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { cameraIsFresh, executionReadIsFresh, executionApprovalAvailable } from '../src/harness/workcell-view/view-state.js'

const startedAt = Date.parse('2026-09-05T10:00:00.000Z')
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function camera(sequence, { receivedAt = startedAt, age = 100, observation = true, session = 'capture-one',
  candidate = 'camera-one', digest = 'candidate-digest', clock = 'clock-one', hardware = '/dev/video0', kind = 'synthetic',
  observationExpiresAfterMs = 2000 } = {}) {
  return { availability: 'available', receivedAt: new Date(receivedAt).toISOString(), previewFrameId: `preview-${session}-${sequence}`,
    status: { phase: 'live', frameFresh: true, frameAgeMs: age, staleAfterMs: 2000, captureSessionId: session,
      selectedCandidateId: candidate, observationStatus: observation ? 'simulated' : 'not-configured', availableCameras: [
        { candidateId: candidate, candidateDigest: digest, displayName: candidate, identityStability: 'stable' },
      ] },
    frame: { sequence, captureSessionId: session, candidateId: candidate, candidateDigest: digest,
      capture: { clockSessionId: clock, capturedAtMonotonicNs: '1000000000' },
      source: { kind, hardwareIdentity: hardware, identityStability: 'stable' },
      observation: observation ? { frameId: `${session}-${sequence}`, observationDigest: 'observation-digest', status: 'simulated',
        capturedAtMonotonicNs: '1000000000', expiresAtMonotonicNs: String(1000000000n + BigInt(observationExpiresAfterMs) * 1000000n),
        routingEvidencePublished: false, physicalExecutionAuthorized: false } : null } }
}

/** Executes the actual browser entry point with controlled I/O; never contacts a Node or camera. */
async function view(t) {
  let now = startedAt, nextTimer = 0, nextUrl = 0
  const timers = new Map(), handlers = new Map(), elements = new Map(), requests = [], actions = [], decodes = [], created = [], revoked = []
  class Element {
    constructor(tag = 'div', text = '') {
      this.tagName = tag; this.textContent = text; this.children = []; this.value = ''; this.disabled = false
      this.hidden = false; this.checked = false; this.classList = { toggle() {} }; this.naturalWidth = 640; this.naturalHeight = 480
    }
    replaceChildren(...items) { this.children = items }
    append(...items) { this.children.push(...items) }
    add(item) { this.append(item) }
    setAttribute(name, value) { this[name] = value }
    getAttribute(name) { return this[name] ?? null }
    removeAttribute(name) { delete this[name] }
    querySelector(tag) { return this.children.find((item) => item.tagName === tag) }
    querySelectorAll() { return this.children.filter((item) => ['button', 'input'].includes(item.tagName)) }
    get childElementCount() { return this.children.length }
    replaceWith(next) {
      assert.equal(next.tagName, 'img')
      assert.equal(next.id, this.id, 'the replacement retains the preview element identity')
      assert.equal(next.decoded, true, 'only a decoded image may enter the visible DOM')
      elements.set(this.id, next)
    }
    decode() {
      assert.equal(this.tagName, 'img')
      const pending = deferred()
      decodes.push({ image: this, ...pending })
      return pending.promise.then(() => { this.decoded = true })
    }
  }
  const html = readFileSync(new URL('../src/harness/workcell-view/index.html', import.meta.url), 'utf8')
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.id = match[2]; element.hidden = /\bhidden\b/.test(match[0])
    const alt = match[0].match(/\balt="([^"]+)"/)
    if (alt) element.alt = alt[1]
    elements.set(element.id, element)
  }
  elements.get('camera-empty').append(new Element('h3'), new Element('p'))
  let streamController, streamClosed = false
  const stream = new ReadableStream({ start(controller) { streamController = controller } })
  let state = { contractVersion: 'physicalsystems-workcell-view-v1', sessionId: 'harness-one', revision: 0,
    physicalExecutionAuthorized: false, agent: { status: 'idle', canPrompt: false, pendingChoice: null, model: null },
    camera: { availability: 'unchecked' }, workflow: { nodeOrigin: 'http://127.0.0.1:8876' }, execution: { availability: 'unchecked' } }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  function timer(callback, delay = 0, interval = false) {
    const id = ++nextTimer
    timers.set(id, { callback, due: now + delay, interval: interval ? delay : 0 })
    return id
  }
  const source = readFileSync(new URL('../src/harness/workcell-view/app.js', import.meta.url), 'utf8')
    .replace(/^import .* from '\.\/view-state\.js'\r?\n/m, '')
  runInNewContext(source, {
    document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag) },
    location: { hash: '#token=local-view-test', pathname: '/', reload() {} }, history: { replaceState() {} },
    Option: class extends Element { constructor(text, value) { super('option', text); this.value = value } },
    Image: class extends Element { constructor() { super('img') } },
    URL: { createObjectURL(blob) { assert.equal(blob.type, 'image/jpeg'); const url = `blob:test-${++nextUrl}`; created.push(url); return url },
      revokeObjectURL(url) { revoked.push(url) } },
    URLSearchParams, AbortController, AbortSignal, TextDecoder, Date: ClockDate,
    cameraIsFresh: (value, at = now) => cameraIsFresh(value, at),
    executionReadIsFresh: (value, at = now) => executionReadIsFresh(value, at),
    executionApprovalAvailable: (value, at = now) => executionApprovalAvailable(value, at),
    setInterval: (callback, delay) => timer(callback, delay, true), clearInterval: (id) => timers.delete(id),
    setTimeout: (callback, delay) => timer(callback, delay), clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => handlers.set(name, callback),
    fetch: async (path, options) => {
      assert.equal(options.headers.Authorization, 'Bearer local-view-test')
      if (path === '/api/state') return Response.json(state)
      if (path === '/api/events') return new Response(stream)
      if (path === '/api/camera/stop') {
        assert.equal(options.method, 'POST')
        const pending = deferred(); actions.push({ path, options, ...pending }); return pending.promise
      }
      assert.equal(options.method, 'GET', 'camera view tests never start capture or actuate hardware')
      assert.match(path, /^\/api\/camera\/frame\//)
      const pending = deferred()
      requests.push({ path, options, ...pending })
      // Intentionally let a response arrive after abort, to test completion guards.
      return pending.promise
    },
  })
  await tick(); await tick()
  t.after(() => { handlers.get('pagehide')?.(); if (!streamClosed) streamController.close() })
  return {
    elements, requests, actions, decodes, created, revoked, state: () => state, now: () => now,
    async push(next) {
      state = { ...next, revision: state.revision + 1 }
      streamController.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`))
      await tick(); await tick()
    },
    async pushCamera(value) { await this.push({ ...state, camera: value }) },
    async response(request = requests.at(-1), status = 200, type = 'image/jpeg') {
      assert.ok(request, 'a frame request is pending')
      request.resolve(new Response(status === 200 ? 'synthetic-jpeg' : JSON.stringify({ error: 'exact frame unavailable' }),
        { status, headers: { 'Content-Type': type } }))
      await tick(); await tick()
    },
    async decode(pending = decodes.at(-1), fail = false) {
      assert.ok(pending, 'the replacement waits for decoding')
      if (fail) pending.reject(new Error('invalid image'))
      else pending.resolve()
      await tick(); await tick()
    },
    async show(value) { await this.pushCamera(value); await this.response(); await this.decode(); return elements.get('preview').src },
    async advance(milliseconds) {
      const until = now + milliseconds
      for (;;) {
        const next = [...timers].filter(([, value]) => value.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        const [id, value] = next
        now = value.due
        if (value.interval) value.due += value.interval
        else timers.delete(id)
        value.callback(); await tick(); await tick()
      }
      now = until; await tick(); await tick()
    },
    async disconnect() { streamClosed = true; streamController.close(); await tick(); await tick() },
    async close() { handlers.get('pagehide')?.(); await tick(); await tick() },
  }
}

function visible(ui) {
  return { src: ui.elements.get('preview').src, hidden: ui.elements.get('preview').hidden,
    details: ui.elements.get('frame-details').textContent, observation: ui.elements.get('observation').textContent,
    kind: ui.elements.get('frame-kind').textContent, kindHidden: ui.elements.get('frame-kind').hidden }
}
function assertCleared(ui) {
  assert.equal(ui.elements.get('preview').hidden, true)
  assert.equal(ui.elements.get('preview').src, undefined)
  assert.equal(ui.elements.get('frame-kind').hidden, true)
  assert.equal(ui.elements.get('camera-empty').hidden, false)
  assert.doesNotMatch(ui.elements.get('frame-details').textContent, /Frame [12] ·/)
  assert.doesNotMatch(ui.elements.get('observation').textContent, /simulated · exact-frame/)
}

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
