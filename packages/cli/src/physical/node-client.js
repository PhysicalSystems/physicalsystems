const DEFAULT_PHYSICAL_NODE_URL = 'http://127.0.0.1:8876'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_INTENT_CHARACTERS = 500
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const PHYSICAL_NODE_STATE_VERSION = 'experimental-physical-node-state-v1'
export const PHYSICAL_NODE_INTENT_REQUEST_VERSION = 'experimental-physical-node-intent-request-v1'
export const PHYSICAL_NODE_INTENT_VERSION = 'experimental-physical-node-intent-response-v1'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function text(value, label, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || !value.trim()) {
    throw new Error(`${label} must be non-empty text`)
  }
  return value
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function array(value, label, maximum = 64) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`)
  }
  return value
}

function identifier(value, label) {
  const result = text(value, label, 128)
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(result)) {
    throw new Error(`${label} must be a lowercase identifier`)
  }
  return result
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function digest(value, label) {
  const result = text(value, label, 80)
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a sha256 digest`)
  return result
}

export function normalizePhysicalNodeUrl(value = DEFAULT_PHYSICAL_NODE_URL) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw new TypeError('Physical node URL must be an absolute loopback HTTP URL')
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TypeError('Physical node must use loopback HTTP')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Physical node URL cannot contain credentials, query, or fragment')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError('Physical node URL must be an origin without a path')
  }
  return parsed.origin
}

function normalizeDevice(value, index) {
  const device = object(value, `physical discovery device ${index}`)
  const roles = array(device.roles, `physical discovery device ${index}.roles`, 8)
    .map((role, roleIndex) => identifier(role, `physical discovery device ${index}.roles[${roleIndex}]`))
  const capabilities = array(device.capabilities, `physical discovery device ${index}.capabilities`)
    .map((capability, capabilityIndex) => identifier(
      capability,
      `physical discovery device ${index}.capabilities[${capabilityIndex}]`,
    ))
  const result = {
    deviceId: identifier(device.deviceId, `physical discovery device ${index}.deviceId`),
    kind: identifier(device.kind, `physical discovery device ${index}.kind`),
    roles,
    capabilities,
    configured: bool(device.configured, `physical discovery device ${index}.configured`),
    detected: bool(device.detected, `physical discovery device ${index}.detected`),
    driverReady: bool(device.driverReady, `physical discovery device ${index}.driverReady`),
    calibrationReady: bool(
      device.calibrationReady,
      `physical discovery device ${index}.calibrationReady`,
    ),
    ready: bool(device.ready, `physical discovery device ${index}.ready`),
  }
  if (!result.configured) throw new Error(`physical discovery device ${index} must be enrolled`)
  if (result.ready !== (result.detected && result.driverReady && result.calibrationReady)) {
    throw new Error(`physical discovery device ${index} readiness is inconsistent`)
  }
  return result
}

function normalizeSummary(value, devices) {
  const summary = object(value, 'physical discovery summary')
  const result = {}
  for (const name of ['configured', 'detected', 'driverReady', 'calibrationReady', 'ready']) {
    if (!Number.isInteger(summary[name]) || summary[name] < 0 || summary[name] > devices.length) {
      throw new Error(`physical discovery summary.${name} is invalid`)
    }
    result[name] = summary[name]
  }
  result.allReady = bool(summary.allReady, 'physical discovery summary.allReady')
  const expected = {
    configured: devices.length,
    detected: devices.filter((device) => device.detected).length,
    driverReady: devices.filter((device) => device.driverReady).length,
    calibrationReady: devices.filter((device) => device.calibrationReady).length,
    ready: devices.filter((device) => device.ready).length,
  }
  if (Object.keys(expected).some((name) => result[name] !== expected[name])) {
    throw new Error('physical discovery summary does not match its devices')
  }
  if (result.allReady !== (devices.length > 0 && result.ready === devices.length)) {
    throw new Error('physical discovery allReady does not match its devices')
  }
  return result
}

export function normalizePhysicalNodeState(value) {
  const state = object(value, 'physical node state')
  if (state.contractVersion !== PHYSICAL_NODE_STATE_VERSION) {
    throw new Error(`physical node state must use ${PHYSICAL_NODE_STATE_VERSION}`)
  }
  const system = object(state.system, 'physical node system')
  const discovery = object(state.discovery, 'physical node discovery')
  const devices = array(discovery.devices, 'physical node discovery.devices', 16)
    .map(normalizeDevice)
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) {
    throw new Error('physical discovery device IDs must be distinct')
  }
  const normalized = {
    contractVersion: PHYSICAL_NODE_STATE_VERSION,
    nodeName: text(state.nodeName, 'physical node name', 128),
    system: {
      systemId: identifier(system.systemId, 'physical node system.systemId'),
      displayName: text(system.displayName, 'physical node system.displayName', 256),
      workcellId: identifier(system.workcellId, 'physical node system.workcellId'),
    },
    discovery: {
      schemaVersion: text(discovery.schemaVersion, 'physical node discovery.schemaVersion', 128),
      enrollmentId: identifier(discovery.enrollmentId, 'physical node discovery.enrollmentId'),
      observedAt: text(discovery.observedAt, 'physical node discovery.observedAt', 64),
      snapshotDigest: digest(discovery.snapshotDigest, 'physical node discovery.snapshotDigest'),
      devices,
      summary: normalizeSummary(discovery.summary, devices),
    },
    discoveryBindingDigest: digest(
      state.discoveryBindingDigest,
      'physical node state.discoveryBindingDigest',
    ),
    physicalExecutionAuthorized: bool(
      state.physicalExecutionAuthorized,
      'physical node state.physicalExecutionAuthorized',
    ),
  }
  if (normalized.physicalExecutionAuthorized) {
    throw new Error('physical node discovery cannot authorize execution')
  }
  return Object.freeze(normalized)
}

function normalizeInterpretation(value) {
  const interpretation = object(value, 'physical intent interpretation')
  const status = text(interpretation.status, 'physical intent status', 64)
  if (!['ready', 'needs-clarification', 'unsupported'].includes(status)) {
    throw new Error('physical intent status is unsupported')
  }
  const normalized = clone(interpretation)
  normalized.status = status
  normalized.physicalExecutionAuthorized = bool(
    interpretation.physicalExecutionAuthorized,
    'physical intent physicalExecutionAuthorized',
  )
  if (normalized.physicalExecutionAuthorized) {
    throw new Error('physical intent planning cannot authorize execution')
  }
  normalized.gaps = array(interpretation.gaps, 'physical intent gaps', 64).map((gap, index) => {
    const item = object(gap, `physical intent gap ${index}`)
    text(item.gapId, `physical intent gap ${index}.gapId`, 128)
    text(item.kind, `physical intent gap ${index}.kind`, 128)
    text(item.detail, `physical intent gap ${index}.detail`, 512)
    return clone(item)
  })
  normalized.questions = array(interpretation.questions, 'physical intent questions', 16)
    .map((question, index) => text(question, `physical intent question ${index}`, 500))
  if (status === 'ready' && !interpretation.workflowIntent) {
    throw new Error('ready physical intent must contain a workflow intent')
  }
  return normalized
}

export function normalizePhysicalIntentResponse(value) {
  const response = object(value, 'physical intent response')
  if (response.contractVersion !== PHYSICAL_NODE_INTENT_VERSION) {
    throw new Error(`physical intent response must use ${PHYSICAL_NODE_INTENT_VERSION}`)
  }
  const normalized = {
    contractVersion: PHYSICAL_NODE_INTENT_VERSION,
    interpretation: normalizeInterpretation(response.interpretation),
    observationEvidence: clone(object(response.observationEvidence, 'physical observation evidence')),
    discoverySnapshotDigest: digest(
      response.discoverySnapshotDigest,
      'physical intent discoverySnapshotDigest',
    ),
    discoveryBindingDigest: digest(
      response.discoveryBindingDigest,
      'physical intent discoveryBindingDigest',
    ),
    physicalExecutionAuthorized: bool(
      response.physicalExecutionAuthorized,
      'physical intent response.physicalExecutionAuthorized',
    ),
  }
  if (normalized.physicalExecutionAuthorized) {
    throw new Error('physical intent response cannot authorize execution')
  }
  return Object.freeze(normalized)
}

function normalizeIntent(value) {
  if (typeof value !== 'string') throw new TypeError('Physical intent must be text')
  const result = value.replace(/\s+/g, ' ').trim()
  if (!result || result.length > MAX_INTENT_CHARACTERS) {
    throw new TypeError(`Physical intent must contain 1-${MAX_INTENT_CHARACTERS} characters`)
  }
  return result
}

function contentLength(response) {
  const raw = response.headers?.get?.('content-length')
  if (raw == null) return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Physical node returned invalid Content-Length')
  return parsed
}

async function boundedResponseText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return response.text()
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array)) throw new Error('Physical node returned invalid response bytes')
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('Physical node response is too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export function createPhysicalNodeClient({
  baseUrl = DEFAULT_PHYSICAL_NODE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  if (typeof fetchImpl !== 'function') throw new TypeError('Physical node fetch implementation is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('Physical node timeout must be between 100 and 30000 ms')
  }

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(new URL(path, origin), {
        method,
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (error?.name === 'AbortError') throw new Error('Physical node did not respond before the timeout')
      throw new Error(`Physical node is unavailable at ${origin}`)
    }
    let raw
    try {
      const declaredLength = contentLength(response)
      if (declaredLength != null && declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error('Physical node response is too large')
      }
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        throw new Error('Physical node returned a non-JSON response')
      }
      raw = await boundedResponseText(response)
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('Physical node response is too large')
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Physical node did not respond before the timeout')
      throw error
    } finally {
      clearTimeout(timer)
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('Physical node returned invalid JSON')
    }
    if (!response.ok) {
      const detail = typeof payload?.error === 'string' ? payload.error.slice(0, 300) : `HTTP ${response.status}`
      throw new Error(`Physical node request failed: ${detail}`)
    }
    return payload
  }

  return Object.freeze({
    origin,
    async inspect() {
      return normalizePhysicalNodeState(await request('/v1/physical/state'))
    },
    async interpret(intent, expectedDiscoveryBindingDigest) {
      const expectedBinding = digest(
        expectedDiscoveryBindingDigest,
        'expected discovery binding digest',
      )
      const response = normalizePhysicalIntentResponse(await request('/v1/physical/intents:interpret', {
        method: 'POST',
        body: {
          contractVersion: PHYSICAL_NODE_INTENT_REQUEST_VERSION,
          text: normalizeIntent(intent),
          expectedDiscoveryBindingDigest: expectedBinding,
        },
      }))
      if (response.discoveryBindingDigest !== expectedBinding) {
        throw new Error('Physical node intent response does not match the inspected discovery')
      }
      return response
    },
  })
}

export { DEFAULT_PHYSICAL_NODE_URL }
