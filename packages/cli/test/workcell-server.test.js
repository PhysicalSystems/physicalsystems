import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorkcellServer } from '../src/harness/workcell-server.js'
import { createWorkcellController } from '../src/harness/workcell-controller.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const FRAME_ID = 'b'.repeat(64)

class Controller {
  constructor() {
    this.state = { revision: 0, physicalExecutionAuthorized: false }
    this.listeners = new Set()
    this.calls = []
    this.viewers = 0
    this.unsubscribed = 0
    this.closedViewers = 0
  }
  snapshot() { return this.state }
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.unsubscribed += 1; this.listeners.delete(listener) }
  }
  onViewerConnect() {
    this.viewers += 1
    return () => { this.viewers -= 1; this.closedViewers += 1 }
  }
  async refresh() { this.calls.push(['refresh']); return this.state }
  async submitIntent(text) { this.calls.push(['intent', text]); return { accepted: true } }
  async answerChoice(value) { this.calls.push(['choice', value]); return { accepted: true } }
  async cameraAction(action, value) { this.calls.push(['camera', action, value]); return { accepted: true } }
  async executionAction(action, value) { this.calls.push(['execution', action, value]); return { accepted: true } }
  async cameraFrame(frameId) {
    this.calls.push(['frame', frameId])
    return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' }
  }
  emit() { for (const listener of this.listeners) listener(this.state) }
}

async function setup(t, host = new Controller()) {
  const assetsDir = await mkdtemp(join(tmpdir(), 'physicalsystems-view-test-'))
  await Promise.all([
    writeFile(join(assetsDir, 'index.html'), '<!doctype html><script src="/app.js"></script>'),
    writeFile(join(assetsDir, 'app.js'), 'export const view = true'),
    writeFile(join(assetsDir, 'styles.css'), 'body { color: white; }'),
    writeFile(join(assetsDir, 'secret.txt'), 'must not be served'),
  ])
  const server = await createWorkcellServer({ host, assetsDir, port: 0 })
  const token = new URLSearchParams(new URL(server.openUrl).hash.slice(1)).get('token')
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  t.after(async () => { await server.close(); await rm(assetsDir, { recursive: true, force: true }) })
  return { server, host, token, auth: { Authorization: `Bearer ${token}` } }
}

function raw(origin, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const request = httpRequest(origin, {
      path, method,
      headers: { ...(encoded === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': encoded.length }), ...headers },
      timeout: 3000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('test request timeout')))
    request.end(encoded)
  })
}

async function tickUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'expected local transport condition')
}

test('local view serves only static allowlist with restrictive security headers and no embedded bearer', async (t) => {
  const { server, host, token } = await setup(t)
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/)
  assert.equal(new URL(server.openUrl).search, '')
  for (const path of ['/', '/index.html', '/app.js', '/styles.css']) {
    const result = await raw(server.origin, path)
    assert.equal(result.status, 200)
    assert.equal(result.text.includes(token), false)
    assert.equal(result.headers['set-cookie'], undefined)
    assert.equal(result.headers['access-control-allow-origin'], undefined)
    assert.match(result.headers['cache-control'], /no-store/)
    assert.equal(result.headers['x-content-type-options'], 'nosniff')
    assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.match(result.headers['content-security-policy'], /script-src 'self'/)
    assert.equal(result.headers['content-security-policy'].includes('unsafe-inline'), false)
  }
  for (const path of ['/secret.txt', '/../secret.txt', '/%2e%2e/app.js', '/app.js?token=fake', '//example.com/app.js', '/api/proxy?url=http://example.com', '/api/execute']) {
    assert.notEqual((await raw(server.origin, path)).status, 200)
  }
  assert.deepEqual(host.calls, [])
})

test('every API read, frame, stream and mutation requires the session header', async (t) => {
  const { server, token, auth } = await setup(t)
  for (const path of ['/api/state', '/api/events', `/api/camera/frame/${FRAME_ID}`]) {
    assert.equal((await raw(server.origin, path)).status, 401)
    assert.equal((await raw(server.origin, path, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await raw(server.origin, `${path}?token=${token}`)).status, 404)
  }
  assert.equal((await raw(server.origin, '/api/refresh', { method: 'POST', body: {} })).status, 401)
  assert.equal((await raw(server.origin, '/api/state', { headers: auth })).status, 200)
})

test('operator execution endpoints require local authentication, exact digests and explicit approval with no extra fields', async (t) => {
  const { server, host, auth } = await setup(t)
  const runId = `run-${'c'.repeat(32)}`
  const actions = [
    ['refresh', {}], ['prepare', { configurationId: 'table-one', expectedConfigurationDigest: DIGEST, routeReceiptDigest: DIGEST }],
    ['approve', { runId, expectedRunDigest: DIGEST, approvalDigest: DIGEST, approved: true }],
    ['stop', { runId, reason: 'operator-requested-stop' }], ['reconcile', { runId, expectedRunDigest: DIGEST }],
    ['select', { runId }], ['receipt', { runId }],
  ]
  for (const [kind, body] of actions) {
    const path = `/api/execution/${kind}`
    assert.equal((await raw(server.origin, path, { method: 'POST', body })).status, 401)
    assert.equal((await raw(server.origin, path, { method: 'POST', headers: auth, body: { ...body, override: true } })).status, 400)
    assert.equal((await raw(server.origin, path, { method: 'POST', headers: auth, body })).status, 200)
  }
  assert.deepEqual(host.calls, actions.map(([kind, body]) => ['execution', kind, body]))
  for (const body of [
    { runId, expectedRunDigest: DIGEST, approvalDigest: DIGEST, approved: false },
    { runId: '../another', expectedRunDigest: DIGEST, approvalDigest: DIGEST, approved: true },
    { runId, expectedRunDigest: 'latest', approvalDigest: DIGEST, approved: true },
  ]) assert.equal((await raw(server.origin, '/api/execution/approve', { method: 'POST', headers: auth, body })).status, 400)
  assert.equal((await raw(server.origin, '/api/execution/execute', { method: 'POST', headers: auth, body: {} })).status, 404)
  assert.equal(host.calls.length, actions.length)
})

test('forged Host, foreign/null Origin and foreign-session bearer cannot access the view API', async (t) => {
  const first = await setup(t)
  const second = await setup(t)
  for (const headers of [
    { ...first.auth, Host: 'attacker.example' },
    { ...first.auth, Origin: 'https://attacker.example' },
    { ...first.auth, Origin: 'null' },
    { ...first.auth, Origin: `${first.server.origin}/` },
  ]) {
    assert.equal((await raw(first.server.origin, '/api/state', { headers })).status, 403)
  }
  assert.equal((await raw(first.server.origin, '/api/state', { headers: second.auth })).status, 401)
  assert.equal((await raw(first.server.origin, '/api/state', { headers: { ...first.auth, Origin: first.server.origin } })).status, 200)
})

test('allowlisted commands forward exact inputs and never substitute optimistic camera fields', async (t) => {
  const { server, host, auth } = await setup(t)
  const inputs = [
    ['/api/refresh', {}],
    ['/api/intent', { text: 'Move the cup to the destination' }],
    ['/api/choice', { choiceId: 'choice-1', answer: 'Use the mounted camera' }],
    ['/api/choice', { choiceId: 'choice-2', answer: null }],
    ['/api/camera/start', { candidateId: 'camera-1', expectedCandidateDigest: DIGEST }],
    ['/api/camera/stop', { expectedCaptureSessionId: 'capture-1' }],
  ]
  for (const [path, body] of inputs) assert.equal((await raw(server.origin, path, { method: 'POST', headers: auth, body })).status, 200)
  assert.deepEqual(host.calls, [
    ['refresh'], ['intent', inputs[1][1].text], ['choice', inputs[2][1]], ['choice', inputs[3][1]],
    ['camera', 'start', inputs[4][1]], ['camera', 'stop', inputs[5][1]],
  ])
})

test('invalid, excess, control-character and oversized request bodies never reach the controller', async (t) => {
  const { server, host, auth } = await setup(t)
  for (const [path, body] of [
    ['/api/refresh', { extra: true }], ['/api/intent', { text: 'intent', url: 'http://other' }],
    ['/api/intent', { text: 'bad\nintent' }], ['/api/intent', { text: 'x'.repeat(2001) }],
    ['/api/choice', { choiceId: 'choice-1', answer: {}, approved: true }],
    ['/api/camera/start', { candidateId: 'camera-1' }],
    ['/api/camera/start', { candidateId: 'camera-1', expectedCandidateDigest: DIGEST, url: 'http://camera' }],
    ['/api/camera/stop', {}], ['/api/camera/stop', { expectedCaptureSessionId: '../session' }],
  ]) assert.equal((await raw(server.origin, path, { method: 'POST', headers: auth, body })).status, 400)
  assert.equal((await raw(server.origin, '/api/intent', { method: 'POST', headers: auth, body: { text: 'x'.repeat(9000) } })).status, 413)
  assert.equal((await raw(server.origin, '/api/refresh', { method: 'POST', headers: auth, body: '{invalid' })).status, 400)
  assert.equal((await raw(server.origin, '/api/refresh', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await raw(server.origin, '/api/state', { method: 'PUT', headers: auth, body: {} })).status, 404)
  assert.deepEqual(host.calls, [])
})

test('frames require exact opaque IDs and bounded raster bytes; no generic proxy exists', async (t) => {
  const { server, host, auth } = await setup(t)
  const frame = await raw(server.origin, `/api/camera/frame/${FRAME_ID}`, { headers: auth })
  assert.equal(frame.status, 200)
  assert.equal(frame.headers['content-type'], 'image/jpeg')
  assert.deepEqual(frame.bytes, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  for (const id of ['latest', '../secret', FRAME_ID.toUpperCase(), 'http://camera']) {
    assert.equal((await raw(server.origin, `/api/camera/frame/${id}`, { headers: auth })).status, 404)
  }
  host.cameraFrame = async () => ({ bytes: Buffer.alloc(2 * 1024 * 1024 + 1), contentType: 'image/jpeg' })
  assert.equal((await raw(server.origin, `/api/camera/frame/${FRAME_ID}`, { headers: auth })).status, 503)
  host.cameraFrame = async () => ({ bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' })
  assert.equal((await raw(server.origin, `/api/camera/frame/${FRAME_ID}`, { headers: auth })).status, 503)
})

test('controller errors are sanitized and never leak stacks, secret messages or the bearer', async (t) => {
  const { server, host, token, auth } = await setup(t)
  host.submitIntent = async () => { throw new Error(`private-path secret=${token}`) }
  const result = await raw(server.origin, '/api/intent', { method: 'POST', headers: auth, body: { text: 'Do something' } })
  assert.equal(result.status, 503)
  assert.equal(result.text.includes(token), false)
  assert.equal(result.text.includes('private-path'), false)
  assert.deepEqual(JSON.parse(result.text), { error: 'Workcell action could not be completed', code: 'workcell_action_failed' })
})

test('known busy, expired-question and unavailable-model failures give safe actionable HTTP responses', async (t) => {
  const controller = createWorkcellController({ workflow: {}, refreshWorkflow: async () => {}, sendIntent: async () => {} })
  t.after(() => controller.dispose())
  const { server, auth } = await setup(t, controller)
  controller.agentStart('Existing request')
  for (const [path, body] of [['/api/intent', { text: 'Another request' }], ['/api/refresh', {}]]) {
    const result = await raw(server.origin, path, { method: 'POST', headers: auth, body })
    assert.equal(result.status, 409)
    assert.equal(JSON.parse(result.text).code, 'agent_busy')
    assert.match(JSON.parse(result.text).error, /current.*request/)
  }
  const obsolete = await raw(server.origin, '/api/choice', { method: 'POST', headers: auth, body: { choiceId: 'obsolete', answer: 'Late answer' } })
  assert.equal(obsolete.status, 409)
  assert.equal(JSON.parse(obsolete.text).code, 'question_expired')
  assert.match(JSON.parse(obsolete.text).error, /no longer current/)
  const noModel = createWorkcellController({ workflow: {}, refreshWorkflow: async () => {}, sendIntent: async () => {}, canPrompt: () => false })
  t.after(() => noModel.dispose())
  const other = await setup(t, noModel)
  const missing = await raw(other.server.origin, '/api/intent', { method: 'POST', headers: other.auth, body: { text: 'Inspect the workcell' } })
  assert.equal(missing.status, 503)
  assert.equal(JSON.parse(missing.text).code, 'model_unavailable')
  assert.match(JSON.parse(missing.text).error, /select a model/i)
})

test('an arbitrary exception cannot spoof allowlisted error messages or codes', async (t) => {
  const { server, host, auth } = await setup(t)
  host.submitIntent = async () => { throw Object.assign(new Error('private path and secret'), { code: 'agent_busy', status: 409 }) }
  const result = await raw(server.origin, '/api/intent', { method: 'POST', headers: auth, body: { text: 'Inspect' } })
  assert.equal(result.status, 409)
  assert.deepEqual(JSON.parse(result.text), { error: 'Workcell state changed; refresh before retrying', code: 'workcell_conflict' })
})

test('authenticated null Stop cancels only this controller pending Start and never passes null to the camera client', async (t) => {
  let finishStart
  const pending = new Promise((resolve) => { finishStart = resolve })
  const stopped = []
  const controller = createWorkcellController({ workflow: {}, refreshWorkflow: async () => {}, sendIntent: async () => {}, cameraClient: {
    async frame() { return { status: { phase: 'idle', captureSessionId: null }, frame: null } },
    async start() { return pending },
    async stop(body) { stopped.push(body); return { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId } },
  } })
  const { server, auth } = await setup(t, controller)
  t.after(async () => { finishStart({ phase: 'live', captureSessionId: 'late-capture' }); await controller.dispose() })
  const body = { expectedCaptureSessionId: null }
  const absent = await raw(server.origin, '/api/camera/stop', { method: 'POST', headers: auth, body })
  assert.equal(absent.status, 409)
  assert.equal(JSON.parse(absent.text).code, 'camera_changed')
  const start = raw(server.origin, '/api/camera/start', { method: 'POST', headers: auth, body: { candidateId: 'camera-one', expectedCandidateDigest: DIGEST } })
  await tickUntil(() => controller.snapshot().camera.pending === 'start')
  assert.equal((await raw(server.origin, '/api/camera/stop', { method: 'POST', body })).status, 401)
  const cancellation = await raw(server.origin, '/api/camera/stop', { method: 'POST', headers: auth, body })
  const before = stopped.length
  finishStart({ phase: 'live', captureSessionId: 'late-capture' })
  const completed = await start
  assert.equal(cancellation.status, 200)
  assert.equal(JSON.parse(cancellation.text).camera.stopPending, true)
  assert.equal(before, 0)
  assert.equal(completed.status, 200)
  assert.deepEqual(stopped, [{ expectedCaptureSessionId: 'late-capture' }])
  assert.equal(controller.snapshot().camera.status.phase, 'stopped')
})

test('authenticated streamed-fetch SSE publishes bounded state updates and unsubscribes on disconnect', async (t) => {
  const { server, host, auth } = await setup(t)
  const response = await fetch(`${server.origin}/api/events`, { headers: auth })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const first = Buffer.from((await reader.read()).value).toString()
  assert.match(first, /event: state/)
  assert.match(first, /"revision":0/)
  assert.equal(host.viewers, 1)
  host.state = { revision: 1, physicalExecutionAuthorized: false }
  host.emit()
  assert.match(Buffer.from((await reader.read()).value).toString(), /"revision":1/)
  await reader.cancel()
  await tickUntil(() => host.listeners.size === 0)
  assert.equal(host.unsubscribed, 1)
  assert.equal(host.closedViewers, 1)
  assert.equal(host.viewers, 0)
})

test('SSE oversized/failed snapshots close cleanly; shutdown unsubscribes and never disposes host or camera', async (t) => {
  const { server, host, auth } = await setup(t)
  let disposed = false
  host.dispose = () => { disposed = true }
  const response = await fetch(`${server.origin}/api/events`, { headers: auth })
  const reader = response.body.getReader()
  await reader.read()
  host.state = { tooLarge: 'x'.repeat(256 * 1024) }
  host.emit()
  await tickUntil(() => host.listeners.size === 0)
  assert.equal((await reader.read()).done, true)
  host.state = { revision: 2 }
  const next = await fetch(`${server.origin}/api/events`, { headers: auth })
  const nextReader = next.body.getReader()
  await nextReader.read()
  await Promise.all([server.close(), server.close()])
  await tickUntil(() => host.listeners.size === 0)
  assert.equal(host.closedViewers, 2)
  assert.equal(disposed, false)
  assert.deepEqual(host.calls, [])
  await nextReader.cancel().catch(() => {})
})

test('subscription failures return sanitized errors without retaining viewers', async (t) => {
  const host = new Controller()
  host.subscribe = () => { throw new Error('internal subscriber stack secret') }
  const { server, auth } = await setup(t, host)
  const result = await raw(server.origin, '/api/events', { headers: auth })
  assert.equal(result.status, 503)
  assert.equal(result.text.includes('secret'), false)
  assert.equal(host.viewers, 0)
})

test('viewer count is bounded and slow streams do not create an unbounded event queue', async (t) => {
  const { server, host, auth } = await setup(t)
  const streams = []
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`${server.origin}/api/events`, { headers: auth })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    await reader.read()
    streams.push(reader)
  }
  assert.equal(host.viewers, 8)
  assert.equal((await raw(server.origin, '/api/events', { headers: auth })).status, 429)
  // Readers stay idle during a burst. The transport coalesces updates and keeps
  // only its latest bounded snapshot, rather than appending every event.
  for (let revision = 1; revision <= 200; revision += 1) {
    host.state = { revision, payload: 'x'.repeat(100_000) }
    host.emit()
  }
  await new Promise((resolve) => setTimeout(resolve, 25))
  await server.close()
  assert.equal(host.listeners.size, 0)
  assert.equal(host.viewers, 0)
  assert.equal(host.unsubscribed, 8)
  await Promise.all(streams.map((reader) => reader.cancel().catch(() => {})))
})

test('a state change during subscription is delivered instead of leaving the initial snapshot stale', async (t) => {
  const host = new Controller()
  const subscribe = host.subscribe.bind(host)
  host.subscribe = (listener) => {
    host.state = { revision: 42 }
    return subscribe(listener)
  }
  const { server, auth } = await setup(t, host)
  const response = await fetch(`${server.origin}/api/events`, { headers: auth })
  const reader = response.body.getReader()
  let received = ''
  while (!received.includes('"revision":42')) received += Buffer.from((await reader.read()).value).toString()
  await reader.cancel()
  await tickUntil(() => host.listeners.size === 0)
})
