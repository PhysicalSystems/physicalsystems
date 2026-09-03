import { createHash } from 'node:crypto'
import { normalizePhysicalNodeUrl } from './node-client.js'

const ENDPOINT = '/v1/physical/camera-preview'
const VERSION = 'experimental-camera-preview-'
const MAX_WIRE_BYTES = 4 * 1024 * 1024
const MAX_JPEG_BYTES = 2 * 1024 * 1024
const ERROR_CODES = ['open-failed', 'device-unavailable', 'capture-failed', 'geometry-mismatch', 'driver-unavailable', 'permission-denied', 'capture-ended', 'worker-start-failed', 'worker-still-running']
class CameraHttpError extends Error {}

function invalid() { throw new TypeError('Camera preview response failed contract validation') }
function assert(value) { if (!value) invalid() }
function object(value) { assert(value && typeof value === 'object' && !Array.isArray(value)); return value }
function fields(value, names, optional = []) {
  object(value)
  assert(names.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => names.includes(key) || optional.includes(key)))
  return value
}
function text(value, maximum = 256) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value))
  return value
}
function id(value, maximum = 128) { assert(typeof value === 'string' && value.length <= maximum && /^[a-z][a-z0-9-]*$/.test(value)); return value }
function digest(value) { assert(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)); return value }
function integer(value, maximum = Number.MAX_SAFE_INTEGER) { assert(Number.isSafeInteger(value) && value >= 0 && value <= maximum); return value }
function oneOf(value, options) { assert(options.includes(value)); return value }
function nullable(value, normalize) { return value === null ? null : normalize(value) }
function ns(value) { assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n); return value }
function receiptNs(value) {
  assert(typeof value === 'bigint' || Number.isSafeInteger(value))
  return ns(String(value))
}
function identity(value) {
  text(value, 512)
  assert(/^\/dev\/video[0-9]+$/.test(value) || /^\/dev\/v4l\/by-id\/[^/]+$/.test(value))
  return value
}
function sha(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

function normalizeCandidate(value) {
  fields(value, ['candidateId', 'candidateDigest', 'displayName', 'observedIdentity', 'identityStability', 'adapter'])
  fields(value.adapter, ['status', 'adapterId', 'detail'])
  return {
    candidateId: id(value.candidateId), candidateDigest: digest(value.candidateDigest),
    displayName: text(value.displayName), observedIdentity: identity(value.observedIdentity),
    identityStability: oneOf(value.identityStability, ['stable', 'session']),
    // Native diagnostic prose is not forwarded into the operator/model surface.
    adapter: { status: oneOf(value.adapter.status, ['available', 'setup-required', 'unavailable']), adapterId: nullable(value.adapter.adapterId, id) },
  }
}

function normalizeStatus(value, { inventory = false } = {}) {
  fields(value, ['contractVersion', 'state', 'captureSessionId', 'selectedCandidateId', 'latestFrameId', 'frameFresh', 'frameAgeMs', 'staleAfterMs', 'errorCode', 'observationStatus', 'physicalState', 'physicalExecutionAuthorized', 'rawFramePersisted'], ['availableCameras'])
  assert(value.contractVersion === `${VERSION}status-v1` && value.physicalState === 'unknown' && value.physicalExecutionAuthorized === false && value.rawFramePersisted === false)
  const state = oneOf(value.state, ['idle', 'starting', 'streaming', 'stale', 'error', 'stopped', 'stop-unconfirmed'])
  const result = {
    phase: state === 'streaming' ? 'live' : state,
    captureSessionId: nullable(value.captureSessionId, (v) => id(v, 64)),
    selectedCandidateId: nullable(value.selectedCandidateId, id),
    latestFrameId: nullable(value.latestFrameId, id),
    frameFresh: value.frameFresh,
    frameAgeMs: nullable(value.frameAgeMs, integer),
    staleAfterMs: value.staleAfterMs,
    errorCode: nullable(value.errorCode, (v) => oneOf(v, ERROR_CODES)),
    observationStatus: oneOf(value.observationStatus, ['not-configured', 'provisional', 'blocked', 'simulated', 'stale']),
    physicalState: 'unknown', physicalExecutionAuthorized: false, rawFramePersisted: false,
  }
  assert(result.frameFresh === (state === 'streaming') && result.staleAfterMs === 2000)
  assert((result.captureSessionId === null) === (result.selectedCandidateId === null))
  if (state === 'idle') assert(result.captureSessionId === null && result.latestFrameId === null)
  else assert(result.captureSessionId !== null)
  if (state === 'streaming') assert(result.latestFrameId !== null && result.frameAgeMs !== null && result.frameAgeMs < result.staleAfterMs)
  if (result.latestFrameId !== null) assert(result.latestFrameId.startsWith(`${result.captureSessionId}-`) && result.frameAgeMs !== null)
  else assert(result.frameAgeMs === null)
  if (state === 'stopped') assert(result.latestFrameId === null)
  if (inventory || Object.hasOwn(value, 'availableCameras')) {
    assert(Array.isArray(value.availableCameras) && value.availableCameras.length <= 128)
    result.availableCameras = value.availableCameras.map(normalizeCandidate)
    assert(new Set(result.availableCameras.map((item) => item.candidateId)).size === result.availableCameras.length)
  }
  return result
}

function jpegGeometry(bytes) {
  assert(bytes.length >= 4 && bytes.length <= MAX_JPEG_BYTES && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9)
  let offset = 2
  while (offset + 4 <= bytes.length) {
    assert(bytes[offset++] === 0xff)
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    assert(marker !== 0xda && marker !== 0xd9 && offset + 2 <= bytes.length)
    const size = bytes.readUInt16BE(offset)
    assert(size >= 2 && offset + size <= bytes.length)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      assert(size >= 8)
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += size
  }
  invalid()
}

function normalizeObservation(value, packet, status) {
  if (value === null) { assert(packet.analysis === null && status.observationStatus === 'not-configured'); return null }
  fields(value, ['frameId', 'receipt', 'routingEvidencePublished'])
  assert(value.frameId === packet.frameId && value.routingEvidencePublished === false && packet.analysis !== null)
  const receipt = object(value.receipt)
  const capture = object(receipt.capture)
  const boundary = object(receipt.evidenceBoundary)
  assert(receipt.contractVersion === 'experimental-fixed-camera-observation-v1' && receipt.hardwareIdentity === packet.source.hardwareIdentity)
  assert(capture.sequence === packet.sequence && receiptNs(capture.capturedAtMonotonicNs) === packet.capture.capturedAtMonotonicNs
    && capture.clockSessionId === packet.capture.clockSessionId && capture.clockDomain === 'host-monotonic'
    && capture.width === packet.source.width && capture.height === packet.source.height
    && capture.rotationDegrees === packet.preview.rotationDegrees && capture.analysisFrameDigest === packet.analysis.digest
    && capture.timestampBasis === 'host-read-window-start' && capture.sensorExposureAgeBounded === false && capture.rawFramePersisted === false)
  const expires = receiptNs(capture.expiresAtMonotonicNs)
  assert(BigInt(expires) > BigInt(packet.capture.capturedAtMonotonicNs))
  oneOf(receipt.status, ['blocked', 'observed-provisional'])
  assert(typeof boundary.cameraOpened === 'boolean' && boundary.perceptionExecuted === true && boundary.robotOpened === false && boundary.torqueEnabled === false && boundary.jointCommandsSent === 0 && boundary.physicalTaskSuccessProven === false && boundary.rawFramePersisted === false)
  if (packet.source.kind === 'synthetic') assert(boundary.cameraOpened === false)
  const expected = !boundary.cameraOpened ? 'simulated' : receipt.status === 'blocked' ? 'blocked' : 'provisional'
  assert(status.observationStatus === expected || status.observationStatus === 'stale')
  if (status.observationStatus !== 'stale') assert(BigInt(packet.capture.capturedAtMonotonicNs) + BigInt(status.frameAgeMs) * 1000000n < BigInt(expires))
  // Node seals the legacy receipt. Do not reserialize/rehash it with JS number
  // semantics, or expose its nested state as trusted workcell/routing evidence.
  return {
    frameId: packet.frameId, observationDigest: digest(receipt.observationDigest),
    status: status.observationStatus, capturedAtMonotonicNs: packet.capture.capturedAtMonotonicNs,
    expiresAtMonotonicNs: expires, routingEvidencePublished: false,
    physicalExecutionAuthorized: false,
  }
}

function normalizePacket(value, status) {
  fields(value, ['contractVersion', 'frameId', 'candidateId', 'candidateDigest', 'captureSessionId', 'sequence', 'source', 'capture', 'preview', 'analysis', 'observation', 'physicalExecutionAuthorized'])
  assert(value.contractVersion === `${VERSION}packet-v1` && value.physicalExecutionAuthorized === false)
  const sequence = integer(value.sequence)
  const session = id(value.captureSessionId, 64)
  const candidateId = id(value.candidateId)
  assert(value.frameId === `${session}-${sequence}` && value.frameId === status.latestFrameId && session === status.captureSessionId && candidateId === status.selectedCandidateId)
  fields(value.source, ['kind', 'hardwareIdentity', 'identityStability', 'pixelFormat', 'digest', 'width', 'height'])
  const source = {
    kind: oneOf(value.source.kind, ['synthetic', 'live-camera']), hardwareIdentity: identity(value.source.hardwareIdentity),
    identityStability: oneOf(value.source.identityStability, ['stable', 'session']), pixelFormat: oneOf(value.source.pixelFormat, ['bgr8']),
    digest: digest(value.source.digest), width: integer(value.source.width, 1920), height: integer(value.source.height, 1080),
  }
  assert(source.width > 0 && source.height > 0)
  fields(value.capture, ['capturedAtMonotonicNs', 'clockDomain', 'clockSessionId', 'timestampBasis', 'sensorExposureAgeBounded'])
  const capture = {
    capturedAtMonotonicNs: ns(value.capture.capturedAtMonotonicNs), clockSessionId: id(value.capture.clockSessionId, 64),
    clockDomain: oneOf(value.capture.clockDomain, ['host-monotonic']), timestampBasis: oneOf(value.capture.timestampBasis, ['host-read-window-start']),
    sensorExposureAgeBounded: false,
  }
  assert(value.capture.sensorExposureAgeBounded === false)
  fields(value.preview, ['contentType', 'encoding', 'data', 'digest', 'derivedFromSourceDigest', 'width', 'height', 'rotationDegrees'])
  const preview = value.preview
  assert(preview.contentType === 'image/jpeg' && preview.encoding === 'base64' && typeof preview.data === 'string' && preview.data.length <= 4 * Math.ceil(MAX_JPEG_BYTES / 3)
    && preview.data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(preview.data))
  const jpegBytes = Buffer.from(preview.data, 'base64')
  assert(jpegBytes.toString('base64') === preview.data && sha(jpegBytes) === digest(preview.digest))
  const dimensions = jpegGeometry(jpegBytes)
  assert(preview.derivedFromSourceDigest === source.digest && preview.width === source.width && preview.height === source.height && dimensions.width === source.width && dimensions.height === source.height)
  oneOf(preview.rotationDegrees, [0, 180])
  let analysis = null
  if (value.analysis !== null) {
    fields(value.analysis, ['pixelFormat', 'digest', 'derivedFromSourceDigest', 'rotationDegrees'])
    assert(value.analysis.pixelFormat === 'hsv8' && value.analysis.derivedFromSourceDigest === source.digest && value.analysis.rotationDegrees === preview.rotationDegrees)
    analysis = { pixelFormat: 'hsv8', digest: digest(value.analysis.digest), derivedFromSourceDigest: source.digest, rotationDegrees: preview.rotationDegrees }
  }
  const result = {
    frameId: value.frameId, candidateId, candidateDigest: digest(value.candidateDigest), captureSessionId: session, sequence,
    jpegBytes, previewDigest: preview.digest, source, capture,
    preview: { contentType: 'image/jpeg', digest: preview.digest, derivedFromSourceDigest: source.digest, width: source.width, height: source.height, rotationDegrees: preview.rotationDegrees },
    analysis, observation: null, physicalExecutionAuthorized: false,
  }
  result.observation = normalizeObservation(value.observation, result, status)
  return result
}

async function readBoundedJson(response, maximum) {
  const reader = response.body?.getReader?.()
  assert(reader)
  let size = 0
  const chunks = []
  try {
    assert(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json')
    const length = response.headers.get('content-length')
    if (length !== null) assert(/^[0-9]+$/.test(length) && Number(length) <= maximum)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      assert(size <= maximum)
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  // Preserve legacy integer nanoseconds without converting an already rounded
  // Number back to a string. No raw receipt is returned to the browser/model.
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      assert(context && /^-?[0-9]+$/.test(context.source))
      return BigInt(context.source)
    }
    return value
  })
}

/** Server-side only. Never pass the Node camera token to browser/model tools. */
export function createCameraPreviewClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  if (typeof fetchImpl !== 'function') throw new TypeError('Camera preview requires HTTP transport')
  let previous = null

  async function request(path, body) {
    // Opening the Harness is useful without optional camera support. Missing
    // credentials disable these requests, not the rest of the local app.
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new TypeError('Camera preview requires a configured server-side token')
    try {
      const response = await fetchImpl(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.redirected || response.type === 'opaqueredirect') invalid()
      if (response.url) assert(new URL(response.url).href === new URL(path, origin).href)
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        const status = Number.isInteger(response.status) ? response.status : 503
        const code = ({ 401: 'camera_unauthorized', 403: 'camera_forbidden', 409: 'camera_conflict', 503: 'camera_unavailable' })[status] ?? 'camera_request_failed'
        const error = new CameraHttpError(({ 401: 'Camera preview credentials were rejected', 403: 'Camera preview origin was rejected', 409: 'Camera selection or capture session changed; refresh and select again', 503: 'Camera preview is unavailable on the local node' })[status] ?? 'Camera preview request failed')
        error.code = code; error.status = status
        throw error
      }
      return await readBoundedJson(response, path.endsWith('/frame') ? MAX_WIRE_BYTES : 256 * 1024)
    } catch (error) {
      if (error instanceof CameraHttpError) throw error
      throw new Error('Camera preview transport or response is unavailable', { cause: undefined })
    }
  }

  return Object.freeze({
    async status() { return normalizeStatus(await request(ENDPOINT), { inventory: true }) },
    async frame() {
      const requestedAt = performance.now()
      const value = await request(`${ENDPOINT}/frame`)
      fields(value, ['contractVersion', 'status', 'frame'])
      assert(value.contractVersion === `${VERSION}frame-v1`)
      const status = normalizeStatus(value.status)
      if (!status.frameFresh) return { status, frame: null }
      const elapsed = performance.now() - requestedAt
      if (status.frameAgeMs + elapsed >= status.staleAfterMs) {
        return { status: { ...status, phase: 'stale', frameFresh: false, observationStatus: status.observationStatus === 'not-configured' ? 'not-configured' : 'stale' }, frame: null }
      }
      const frame = normalizePacket(value.frame, status)
      const fingerprint = sha(JSON.stringify({
        source: frame.source, capture: frame.capture, preview: frame.preview, analysis: frame.analysis,
        observationDigest: frame.observation?.observationDigest ?? null,
        observationExpiresAt: frame.observation?.expiresAtMonotonicNs ?? null,
      }))
      if (previous?.captureSessionId === frame.captureSessionId) {
        assert(frame.candidateId === previous.candidateId && frame.candidateDigest === previous.candidateDigest && frame.capture.clockSessionId === previous.capture.clockSessionId && frame.sequence >= previous.sequence
          && frame.source.hardwareIdentity === previous.source.hardwareIdentity && frame.source.identityStability === previous.source.identityStability && frame.source.kind === previous.source.kind)
        if (frame.sequence === previous.sequence) assert(fingerprint === previous.fingerprint && status.frameAgeMs >= previous.frameAgeMs)
        else assert(BigInt(frame.capture.capturedAtMonotonicNs) > BigInt(previous.capture.capturedAtMonotonicNs))
      }
      previous = { ...frame, jpegBytes: undefined, observation: undefined, frameAgeMs: status.frameAgeMs, fingerprint }
      // Include the round trip conservatively; later agent events must not
      // renew the image's freshness in the browser.
      return { status: { ...status, frameAgeMs: status.frameAgeMs + Math.ceil(elapsed) }, frame }
    },
    async start(value) {
      fields(value, ['candidateId', 'expectedCandidateDigest'])
      const candidateId = id(value.candidateId)
      const status = normalizeStatus(await request(`${ENDPOINT}:start`, { contractVersion: `${VERSION}start-v1`, candidateId, expectedCandidateDigest: digest(value.expectedCandidateDigest) }))
      assert(status.selectedCandidateId === candidateId && !['idle', 'stopped'].includes(status.phase))
      previous = null
      return status
    },
    async stop(value) {
      fields(value, ['expectedCaptureSessionId'])
      const expectedCaptureSessionId = id(value.expectedCaptureSessionId, 64)
      const status = normalizeStatus(await request(`${ENDPOINT}:stop`, { contractVersion: `${VERSION}stop-v1`, expectedCaptureSessionId }))
      assert(status.captureSessionId === expectedCaptureSessionId && ['stopped', 'stop-unconfirmed'].includes(status.phase))
      if (status.phase === 'stopped') previous = null
      return status
    },
  })
}
