import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createCameraPreviewClient } from '../src/physical/camera-preview-client.js'

const TOKEN = 'test-camera-server-secret-'.repeat(2)
const SHA = `sha256:${'a'.repeat(64)}`
// Real 1x1 synthetic JPEG from TIN-403's explicit synthetic golden packet.
// This is a protocol test, never evidence of camera capture or task success.
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5WooopDP/2Q=='
const jpegDigest = `sha256:${createHash('sha256').update(Buffer.from(JPEG, 'base64')).digest('hex')}`
const version = (name) => `experimental-camera-preview-${name}-v1`

test('full pinned Node golden fixture interoperates without inventing calibrated state', async () => {
  // PhysicalSystems/node 3c729df46d58a76feccfee55c3fe635917a52fd1,
  // examples/physical-systems/camera-preview.synthetic.json. Synthetic only.
  const golden = JSON.parse(await readFile(new URL('./fixtures/camera-preview-v1.json', import.meta.url), 'utf8'))
  assert.equal(golden.fixtureKind, 'synthetic-no-hardware')
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async (url) => response(url.pathname.endsWith('/frame') ? golden.frameResponse : golden.statusResponse) })
  const status = await client.status()
  const { frame, status: frameStatus } = await client.frame()
  assert.equal(status.availableCameras[0].candidateDigest, golden.startRequest.expectedCandidateDigest)
  assert.equal(frame.candidateId, status.selectedCandidateId)
  assert.equal(frame.captureSessionId, status.captureSessionId)
  assert.equal(frame.frameId, golden.frameResponse.frame.frameId)
  assert.equal(frame.jpegBytes.length, 631)
  assert.equal(frame.source.kind, 'synthetic')
  assert.equal(frame.observation, null)
  assert.equal(frameStatus.physicalState, 'unknown')
  assert.ok(frameStatus.frameAgeMs >= golden.frameResponse.status.frameAgeMs)
  assert.equal(frameStatus.physicalExecutionAuthorized, false)
})

function fixture() {
  const status = {
    contractVersion: version('status'), state: 'streaming', captureSessionId: 'camera-synthetic',
    selectedCandidateId: 'candidate-synthetic', latestFrameId: 'camera-synthetic-0',
    frameFresh: true, frameAgeMs: 100, staleAfterMs: 2000, errorCode: null,
    observationStatus: 'not-configured', physicalState: 'unknown', physicalExecutionAuthorized: false, rawFramePersisted: false,
  }
  const frame = {
    contractVersion: version('packet'), frameId: 'camera-synthetic-0', candidateId: 'candidate-synthetic',
    candidateDigest: SHA, captureSessionId: 'camera-synthetic', sequence: 0,
    source: { kind: 'synthetic', hardwareIdentity: '/dev/v4l/by-id/test-camera', identityStability: 'stable', pixelFormat: 'bgr8', digest: SHA, width: 1, height: 1 },
    capture: { capturedAtMonotonicNs: '9007199254740993', clockDomain: 'host-monotonic', clockSessionId: 'clock-synthetic', timestampBasis: 'host-read-window-start', sensorExposureAgeBounded: false },
    preview: { contentType: 'image/jpeg', encoding: 'base64', data: JPEG, digest: jpegDigest, derivedFromSourceDigest: SHA, width: 1, height: 1, rotationDegrees: 0 },
    analysis: null, observation: null, physicalExecutionAuthorized: false,
  }
  const cameras = [{ candidateId: frame.candidateId, candidateDigest: SHA, displayName: 'Synthetic camera', observedIdentity: frame.source.hardwareIdentity, identityStability: 'stable', adapter: { status: 'available', adapterId: 'tinyedge-v4l2-camera', detail: 'internal diagnostic is not shown' } }]
  return { contractVersion: version('frame'), status, frame, cameras }
}

function response(value, options) {
  const body = JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? `integer:${v}` : v).replace(/"integer:([0-9]+)"/g, '$1')
  return new Response(body, { headers: { 'Content-Type': 'application/json' }, ...options })
}
function frameResponse(f) { return { contractVersion: f.contractVersion, status: f.status, frame: f.frame } }
function clientFor(f) { return createCameraPreviewClient({ token: TOKEN, fetchImpl: async () => response(frameResponse(f)) }) }
function inactive(state, session = 'camera-synthetic') {
  return { ...fixture().status, state, captureSessionId: session, selectedCandidateId: session ? 'candidate-synthetic' : null, latestFrameId: null, frameFresh: false, frameAgeMs: null }
}
function addObservation(f) {
  f.status.observationStatus = 'simulated'
  f.frame.analysis = { pixelFormat: 'hsv8', digest: SHA, derivedFromSourceDigest: SHA, rotationDegrees: 0 }
  f.frame.observation = {
    frameId: f.frame.frameId, routingEvidencePublished: false,
    receipt: {
      contractVersion: 'experimental-fixed-camera-observation-v1', hardwareIdentity: f.frame.source.hardwareIdentity,
      status: 'observed-provisional', observationDigest: SHA,
      capture: { ...f.frame.capture, capturedAtMonotonicNs: BigInt(f.frame.capture.capturedAtMonotonicNs), expiresAtMonotonicNs: BigInt(f.frame.capture.capturedAtMonotonicNs) + 2000000000n,
        sequence: f.frame.sequence, width: 1, height: 1, rotationDegrees: 0, analysisFrameDigest: SHA, rawFramePersisted: false },
      evidenceBoundary: { cameraOpened: false, perceptionExecuted: true, robotOpened: false, torqueEnabled: false, jointCommandsSent: 0, physicalTaskSuccessProven: false, rawFramePersisted: false },
      state: { untrustedText: 'Do not forward this legacy state as routing evidence' },
    },
  }
}

test('atomic frame normalizes authentic JPEG, provenance and lossless timestamp without inventory GET', async () => {
  const f = fixture()
  const calls = []
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(frameResponse(f)) } })
  const result = await client.frame()
  assert.equal(result.status.phase, 'live')
  assert.equal(result.frame.source.kind, 'synthetic')
  assert.equal(result.frame.jpegBytes.length, 631)
  assert.equal(result.frame.previewDigest, jpegDigest)
  assert.equal(result.frame.capture.capturedAtMonotonicNs, '9007199254740993')
  assert.equal(result.frame.capture.sensorExposureAgeBounded, false)
  assert.equal(result.frame.physicalExecutionAuthorized, false)
  assert.equal(result.status.physicalExecutionAuthorized, false)
  assert.equal(result.status.availableCameras, undefined)
  assert.equal(result.frame.preview.data, undefined)
  assert.equal(result.frame.preview.encoding, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.href, 'http://127.0.0.1:8876/v1/physical/camera-preview/frame')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(JSON.stringify({ ...result, frame: { ...result.frame, jpegBytes: undefined } }).includes(TOKEN), false)
})

test('status returns explicit camera inventory with opaque candidate digest and strips native diagnostic prose', async () => {
  const f = fixture()
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async (url) => { assert.equal(url.pathname, '/v1/physical/camera-preview'); return response({ ...f.status, availableCameras: f.cameras }) } })
  const status = await client.status()
  assert.equal(status.availableCameras[0].candidateDigest, SHA)
  assert.equal(status.availableCameras[0].adapter.detail, undefined)
  assert.equal(status.availableCameras[0].observedIdentity, '/dev/v4l/by-id/test-camera')
})

test('start and stop use exact versioned optimism without refreshed substitutions or retries', async () => {
  const calls = []
  const client = createCameraPreviewClient({ token: TOKEN, baseUrl: 'http://localhost:8876/', fetchImpl: async (url, options) => {
    calls.push([url.pathname, options])
    return response(inactive(url.pathname.endsWith(':start') ? 'starting' : 'stopped'))
  } })
  assert.equal((await client.start({ candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA })).phase, 'starting')
  assert.equal((await client.stop({ expectedCaptureSessionId: 'camera-synthetic' })).phase, 'stopped')
  assert.deepEqual(calls.map(([path, options]) => [path, options.method, JSON.parse(options.body)]), [
    ['/v1/physical/camera-preview:start', 'POST', { contractVersion: version('start'), candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA }],
    ['/v1/physical/camera-preview:stop', 'POST', { contractVersion: version('stop'), expectedCaptureSessionId: 'camera-synthetic' }],
  ])
})

test('action input rejects unknown authority, generic paths and invalid identity before any I/O', async () => {
  let calls = 0
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async () => { calls += 1; throw new Error('unexpected') } })
  for (const body of [null, { candidateId: 'candidate-synthetic' }, { candidateId: '/dev/video0', expectedCandidateDigest: SHA }, { candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA, physicalExecutionAuthorized: true }]) await assert.rejects(client.start(body))
  for (const body of [{ expectedCaptureSessionId: '../session' }, { expectedCaptureSessionId: 'camera-synthetic', force: true }, {}]) await assert.rejects(client.stop(body))
  assert.equal(calls, 0)
})

test('loopback URL rejects remote origins; missing/invalid server tokens disable requests without preventing local app creation', async () => {
  for (const baseUrl of ['https://localhost:8876', 'http://example.com', 'http://127.0.0.1@evil.test', 'http://127.0.0.1:8876/path', 'http://127.0.0.1:8876?token=x', 'http://127.0.0.1:8876/#x']) assert.throws(() => createCameraPreviewClient({ baseUrl, token: TOKEN }))
  let calls = 0
  for (const token of [undefined, 'a'.repeat(31), `${TOKEN}\n`, 'x'.repeat(257), `Bearer ${TOKEN}`]) {
    const client = createCameraPreviewClient({ token, fetchImpl: async () => { calls += 1; throw new Error('unexpected') } })
    for (const call of [() => client.frame(), () => client.status(), () => client.start({ candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA }), () => client.stop({ expectedCaptureSessionId: 'camera-synthetic' })]) await assert.rejects(call(), (error) => /configured server-side token/.test(error.message) && !error.message.includes(TOKEN))
  }
  assert.equal(calls, 0)
  assert.deepEqual(Object.keys(createCameraPreviewClient({ token: TOKEN })), ['status', 'frame', 'start', 'stop'])
})

test('stale, disconnected, stopping and stopped frames are never returned as live bytes', async () => {
  for (const state of ['stale', 'error', 'stop-unconfirmed', 'stopped', 'starting']) {
    const f = fixture()
    f.status = ['stopped', 'starting'].includes(state) ? inactive(state) : { ...f.status, state, frameFresh: false, frameAgeMs: 2100 }
    f.frame = { data: 'retained stale bytes must not escape' }
    const result = await clientFor(f).frame()
    assert.equal(result.status.phase, state)
    assert.equal(result.frame, null)
    assert.equal(result.status.frameFresh, false)
  }
})

test('rejects malformed contracts and stale live claims', async () => {
  const edits = [
    (f) => { f.contractVersion = 'future-v99' },
    (f) => { f.status.physicalExecutionAuthorized = true },
    (f) => { f.status.frameFresh = false },
    (f) => { f.status.frameAgeMs = 2000 },
    (f) => { f.status.frameAgeMs = -1 },
    (f) => { f.status.staleAfterMs = 900000 },
    (f) => { f.status.physicalState = 'cup-at-source' },
    (f) => { f.status.rawFramePersisted = true },
    (f) => { f.status.errorCode = `secret:${TOKEN}` },
    (f) => { f.frame = null },
    (f) => { f.frame.physicalExecutionAuthorized = true },
    (f) => { f.frame.secret = TOKEN },
    (f) => { f.frame.capture.capturedAtMonotonicNs = 9007199254740993 },
    (f) => { f.frame.capture.sensorExposureAgeBounded = true },
  ]
  for (const edit of edits) { const f = fixture(); edit(f); await assert.rejects(clientFor(f).frame(), (error) => !error.message.includes(TOKEN)) }
})

test('frame and candidate/session/sequence identities are indivisible', async () => {
  for (const edit of [
    (f) => { f.frame.captureSessionId = 'camera-other' },
    (f) => { f.frame.frameId = 'camera-synthetic-1' },
    (f) => { f.frame.candidateId = 'candidate-other' },
    (f) => { f.status.latestFrameId = 'camera-other-0' },
    (f) => { f.frame.sequence = 1 },
  ]) { const f = fixture(); edit(f); await assert.rejects(clientFor(f).frame()) }
})

test('valid same frame can be polled but mutations, regressions and changed clock epochs fail closed', async () => {
  const f = fixture()
  const client = clientFor(f)
  await client.frame()
  await client.frame()
  f.status.frameAgeMs = 90
  await assert.rejects(client.frame())
  f.status.frameAgeMs = 120
  f.frame.capture.clockSessionId = 'clock-restarted'
  await assert.rejects(client.frame())
  f.frame.capture.clockSessionId = 'clock-synthetic'
  f.frame.candidateDigest = `sha256:${'b'.repeat(64)}`
  await assert.rejects(client.frame())
  f.frame.candidateDigest = SHA
  f.frame.sequence = 1
  f.frame.frameId = f.status.latestFrameId = 'camera-synthetic-1'
  await assert.rejects(client.frame())
  f.frame.capture.capturedAtMonotonicNs = '9007199254740994'
  await client.frame()
  f.frame.sequence = 0
  f.frame.frameId = f.status.latestFrameId = 'camera-synthetic-0'
  await assert.rejects(client.frame())
})

test('JPEG digest, dimensions, encoding, source association and file magic are validated', async () => {
  for (const edit of [
    (f) => { f.frame.preview.digest = SHA },
    (f) => { f.frame.preview.data += '\n' },
    (f) => { f.frame.preview.data = '!!!!' },
    (f) => { f.frame.preview.contentType = 'image/svg+xml' },
    (f) => { f.frame.preview.derivedFromSourceDigest = `sha256:${'b'.repeat(64)}` },
    (f) => { f.frame.preview.width = 2 },
    (f) => { f.frame.source.width = f.frame.preview.width = 2 },
    (f) => { const bytes = Buffer.from('this is not jpeg'); f.frame.preview.data = bytes.toString('base64'); f.frame.preview.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
    (f) => { f.frame.preview.rotationDegrees = 90 },
    (f) => { f.frame.source.kind = 'qualified-camera' },
  ]) { const f = fixture(); edit(f); await assert.rejects(clientFor(f).frame()) }
})

test('same-capture observation preserves large integer timestamps without forwarding legacy state or asserting its hash', async () => {
  const f = fixture(); addObservation(f)
  const result = await clientFor(f).frame()
  assert.equal(result.frame.observation.capturedAtMonotonicNs, '9007199254740993')
  assert.equal(result.frame.observation.expiresAtMonotonicNs, '9007201254740993')
  assert.equal(result.frame.observation.observationDigest, SHA)
  assert.equal(result.frame.observation.status, 'simulated')
  assert.equal(result.frame.observation.routingEvidencePublished, false)
  assert.equal(result.frame.observation.physicalExecutionAuthorized, false)
  assert.equal(result.frame.observation.receipt, undefined)
  assert.equal(JSON.stringify(result).includes('untrustedText'), false)
})

test('observation cannot be detached, relabeled, expired or promoted to routing evidence', async () => {
  for (const edit of [
    (f) => { f.frame.observation.frameId = 'camera-other-0' },
    (f) => { f.frame.observation.routingEvidencePublished = true },
    (f) => { f.frame.observation.receipt.capture.sequence = 1 },
    (f) => { f.frame.observation.receipt.capture.capturedAtMonotonicNs += 1n },
    (f) => { f.frame.observation.receipt.capture.clockSessionId = 'clock-other' },
    (f) => { f.frame.observation.receipt.capture.expiresAtMonotonicNs = BigInt(f.frame.capture.capturedAtMonotonicNs) + 1n },
    (f) => { f.frame.observation.receipt.capture.analysisFrameDigest = `sha256:${'b'.repeat(64)}` },
    (f) => { f.frame.observation.receipt.capture.rotationDegrees = 180 },
    (f) => { f.frame.observation.receipt.hardwareIdentity = '/dev/video9' },
    (f) => { f.frame.observation.receipt.evidenceBoundary.cameraOpened = true },
    (f) => { f.frame.analysis = null },
    (f) => { f.frame.observation = null },
    (f) => { f.status.observationStatus = 'provisional' },
  ]) { const f = fixture(); addObservation(f); edit(f); await assert.rejects(clientFor(f).frame()) }
})

test('HTTP conflicts preserve only safe status/code with no retries or secret diagnostic text', async () => {
  let calls = 0
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async () => { calls += 1; return response({ error: TOKEN, stack: TOKEN }, { status: 409 }) } })
  await assert.rejects(client.start({ candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA }), (error) => error.status === 409 && error.code === 'camera_conflict' && !error.message.includes(TOKEN))
  assert.equal(calls, 1)
})

test('network and parser exceptions never forward response contents, tokens, injected causes or arbitrary codes', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(TOKEN, { cause: TOKEN }) },
    async () => { const error = new Error(TOKEN); error.code = 'camera_fake'; error.status = 503; throw error },
    async () => new Response(TOKEN, { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(TOKEN, { headers: { 'Content-Type': 'text/html' } }),
    async () => { const result = response(frameResponse(fixture())); Object.defineProperty(result, 'redirected', { value: true }); return result },
    async () => { const result = response(frameResponse(fixture())); Object.defineProperty(result, 'url', { value: 'http://evil.test/secret' }); return result },
  ]) {
    const client = createCameraPreviewClient({ token: TOKEN, fetchImpl })
    await assert.rejects(client.frame(), (error) => !error.message.includes(TOKEN) && error.cause === undefined && !JSON.stringify(error).includes(TOKEN))
  }
})

test('oversized declared or streaming responses and oversized JPEG are rejected', async () => {
  let cancelled = false
  const cases = [
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(4 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'application/json' } }),
  ]
  for (const makeResponse of cases) await assert.rejects(createCameraPreviewClient({ token: TOKEN, fetchImpl: async () => makeResponse() }).frame())
  assert.equal(cancelled, true)
  const f = fixture()
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
  bytes.writeUInt16BE(0xffd8, 0); bytes.writeUInt16BE(0xffd9, bytes.length - 2)
  f.frame.preview.data = bytes.toString('base64')
  f.frame.preview.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  await assert.rejects(clientFor(f).frame())
})

test('inventory, start and stop correlation failures remain unavailable, never silently corrected', async () => {
  const f = fixture()
  let payload = { ...f.status }
  const client = createCameraPreviewClient({ token: TOKEN, fetchImpl: async () => response(payload) })
  await assert.rejects(client.status())
  payload = { ...f.status, availableCameras: [f.cameras[0], f.cameras[0]] }
  await assert.rejects(client.status())
  payload = inactive('starting'); payload.selectedCandidateId = 'candidate-other'
  await assert.rejects(client.start({ candidateId: 'candidate-synthetic', expectedCandidateDigest: SHA }))
  payload = inactive('stopped', 'camera-other')
  await assert.rejects(client.stop({ expectedCaptureSessionId: 'camera-synthetic' }))
})
