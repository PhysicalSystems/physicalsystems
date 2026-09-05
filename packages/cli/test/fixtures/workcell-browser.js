import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { cameraIsFresh, executionReadIsFresh, executionApprovalAvailable } from '../../src/harness/workcell-view/view-state.js'

export const startedAt = Date.parse('2026-09-05T10:00:00.000Z')
export const tick = () => new Promise((resolve) => setImmediate(resolve))
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function camera(sequence, { receivedAt = startedAt, age = 100, observation = true, session = 'capture-one',
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
export async function view(t, options = {}) {
  let now = startedAt, nextTimer = 0, nextUrl = 0
  const readResponse = options.readResponse
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
  const html = readFileSync(new URL('../../src/harness/workcell-view/index.html', import.meta.url), 'utf8')
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.id = match[2]; element.hidden = /\bhidden\b/.test(match[0])
    const alt = match[0].match(/\balt="([^"]+)"/)
    if (alt) element.alt = alt[1]
    elements.set(element.id, element)
  }
  elements.get('camera-empty').append(new Element('h3'), new Element('p'))
  const reads = [], streams = []
  let currentStream = null
  const location = { hash: options.hash ?? '#token=local-view-test', pathname: '/', reload() {} }
  function makeStream(signal) {
    const entry = { closed: false, controller: null, signal, stream: null }
    entry.stream = new ReadableStream({ start(controller) { entry.controller = controller } })
    signal.addEventListener('abort', () => {
      if (!entry.closed) { entry.closed = true; entry.controller.close() }
    }, { once: true })
    streams.push(entry); currentStream = entry
    return entry.stream
  }
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
  const source = readFileSync(new URL('../../src/harness/workcell-view/app.js', import.meta.url), 'utf8')
    .replace(/^import .* from '\.\/view-state\.js'\r?\n/m, '')
  runInNewContext(source, {
    document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag) },
    location, history: { replaceState() { location.hash = '' } },
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
      if (path === '/api/state' || path === '/api/events') {
        reads.push({ path, options })
        const response = readResponse?.({ path, options, state })
        if (response !== undefined) return response
        return path === '/api/state' ? Response.json(state) : new Response(makeStream(options.signal))
      }
      if (['/api/camera/start', '/api/camera/stop', '/api/refresh', '/api/intent', '/api/choice'].includes(path)) {
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
  t.after(() => {
    handlers.get('pagehide')?.()
    for (const entry of streams) if (!entry.closed) { entry.closed = true; entry.controller.close() }
  })
  return {
    elements, requests, actions, decodes, created, revoked, reads, streams, location, state: () => state, now: () => now,
    pendingTimers: () => [...timers.values()].map(({ due, interval }) => ({ due, interval })),
    async push(next) {
      state = { ...next, revision: state.revision + 1 }
      currentStream.controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`))
      await tick(); await tick()
    },
    async pushEvent(value) {
      currentStream.controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(value)}\n\n`))
      await tick(); await tick()
    },
    async pushRaw(value) {
      currentStream.controller.enqueue(new TextEncoder().encode(value))
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
    async disconnect() { currentStream.closed = true; currentStream.controller.close(); await tick(); await tick() },
    async close() { handlers.get('pagehide')?.(); await tick(); await tick() },
  }
}

export function visible(ui) {
  return { src: ui.elements.get('preview').src, hidden: ui.elements.get('preview').hidden,
    details: ui.elements.get('frame-details').textContent, observation: ui.elements.get('observation').textContent,
    kind: ui.elements.get('frame-kind').textContent, kindHidden: ui.elements.get('frame-kind').hidden }
}
export function assertCleared(ui) {
  assert.equal(ui.elements.get('preview').hidden, true)
  assert.equal(ui.elements.get('preview').src, undefined)
  assert.equal(ui.elements.get('frame-kind').hidden, true)
  assert.equal(ui.elements.get('camera-empty').hidden, false)
  assert.doesNotMatch(ui.elements.get('frame-details').textContent, /Frame [12] ·/)
  assert.doesNotMatch(ui.elements.get('observation').textContent, /simulated · exact-frame/)
}
