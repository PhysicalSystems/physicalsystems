import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPhysicalNodeClient,
  normalizePhysicalNodeUrl,
  PHYSICAL_NODE_INTENT_REQUEST_VERSION,
  PHYSICAL_NODE_INTENT_VERSION,
  PHYSICAL_NODE_STATE_VERSION,
} from '../src/physical/node-client.js'

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const values = {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          ...Object.fromEntries(Object.entries(headers).map(([key, entry]) => [key.toLowerCase(), entry])),
        }
        return values[name.toLowerCase()] ?? null
      },
    },
    async text() { return body },
  }
}

function stateFixture() {
  return {
    contractVersion: PHYSICAL_NODE_STATE_VERSION,
    nodeName: 'ubuntu-lab',
    system: {
      systemId: 'cup-transfer', displayName: 'Cup transfer workcell', workcellId: 'desk-one',
    },
    discovery: {
      schemaVersion: 'experimental-physical-discovery-snapshot-v1',
      enrollmentId: 'local-demo',
      observedAt: '2026-08-31T12:00:00.000Z',
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      devices: [{
        deviceId: 'overhead-camera',
        kind: 'camera',
        roles: ['observation'],
        capabilities: ['capture-frame', 'observe-state'],
        configured: true,
        detected: true,
        driverReady: true,
        calibrationReady: true,
        ready: true,
      }],
      summary: {
        configured: 1, detected: 1, driverReady: 1, calibrationReady: 1, ready: 1, allReady: true,
      },
    },
    discoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
    physicalExecutionAuthorized: false,
  }
}

function intentFixture() {
  return {
    contractVersion: PHYSICAL_NODE_INTENT_VERSION,
    interpretation: {
      contractVersion: 'experimental-physical-intent-interpretation-v1',
      status: 'ready',
      action: 'transfer',
      grounding: {
        objectId: 'cup-one',
        sourceStationId: 'source',
        destinationStationId: 'destination',
        routeStationIds: ['source', 'destination'],
      },
      workflowIntent: { workflowId: 'transfer-one-cup' },
      requiredOperations: [],
      gaps: [],
      questions: [],
      physicalExecutionAuthorized: false,
    },
    observationEvidence: { kind: 'live-camera', status: 'observed' },
    discoverySnapshotDigest: `sha256:${'b'.repeat(64)}`,
    discoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
    physicalExecutionAuthorized: false,
  }
}

test('physical node URL accepts only a loopback HTTP origin', () => {
  assert.equal(normalizePhysicalNodeUrl(), 'http://127.0.0.1:8876')
  assert.equal(normalizePhysicalNodeUrl('http://localhost:9000/'), 'http://localhost:9000')
  assert.throws(() => normalizePhysicalNodeUrl('https://127.0.0.1:8876'), /loopback HTTP/)
  assert.throws(() => normalizePhysicalNodeUrl('http://192.168.1.50:8876'), /loopback HTTP/)
  assert.throws(() => normalizePhysicalNodeUrl('http://user:pass@localhost:8876'), /credentials/)
  assert.throws(() => normalizePhysicalNodeUrl('http://localhost:8876/api'), /origin/)
})

test('physical node client inspects and interprets through exact versioned routes', async () => {
  const requests = []
  const client = createPhysicalNodeClient({
    async fetchImpl(url, options) {
      requests.push({ url: url.toString(), options })
      return options.method === 'POST' ? jsonResponse(intentFixture()) : jsonResponse(stateFixture())
    },
  })

  const state = await client.inspect()
  const intent = await client.interpret(
    '  Move   the cup from source to destination.  ',
    state.discoveryBindingDigest,
  )
  assert.equal(state.discovery.devices[0].ready, true)
  assert.equal(intent.interpretation.status, 'ready')
  assert.deepEqual(requests.map((item) => item.url), [
    'http://127.0.0.1:8876/v1/physical/state',
    'http://127.0.0.1:8876/v1/physical/intents:interpret',
  ])
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    contractVersion: PHYSICAL_NODE_INTENT_REQUEST_VERSION,
    text: 'Move the cup from source to destination.',
    expectedDiscoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
  })
  assert.equal(requests[1].options.redirect, 'error')
})

test('physical node client rejects configured-only readiness and authorization claims', async () => {
  const invalidState = stateFixture()
  invalidState.discovery.devices[0].detected = false
  invalidState.discovery.devices[0].ready = false
  invalidState.discovery.summary.detected = 0
  invalidState.discovery.summary.ready = 0
  invalidState.discovery.summary.allReady = false
  const client = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse(invalidState),
  })
  const state = await client.inspect()
  assert.equal(state.discovery.devices[0].configured, true)
  assert.equal(state.discovery.devices[0].detected, false)
  assert.equal(state.discovery.devices[0].ready, false)

  const authorized = intentFixture()
  authorized.physicalExecutionAuthorized = true
  const intentClient = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse(authorized),
  })
  await assert.rejects(intentClient.interpret(
    'Move cup from source to destination',
    `sha256:${'c'.repeat(64)}`,
  ), /cannot authorize/)
})

test('physical node client rejects inconsistent readiness and changed intent bindings', async () => {
  const inconsistent = stateFixture()
  inconsistent.discovery.devices[0].ready = false
  const stateClient = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse(inconsistent),
  })
  await assert.rejects(stateClient.inspect(), /readiness is inconsistent/)

  const changed = intentFixture()
  changed.discoveryBindingDigest = `sha256:${'d'.repeat(64)}`
  const intentClient = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse(changed),
  })
  await assert.rejects(intentClient.interpret(
    'Move cup from source to destination',
    `sha256:${'c'.repeat(64)}`,
  ), /does not match the inspected discovery/)
})

test('physical node client fails closed on remote redirects, oversized data, and errors', async () => {
  const nonJson = createPhysicalNodeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'text/html' : null },
      async text() { return '<html></html>' },
    }),
  })
  await assert.rejects(nonJson.inspect(), /non-JSON/)

  const oversized = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse({}, { headers: { 'content-length': String(300 * 1024) } }),
  })
  await assert.rejects(oversized.inspect(), /too large/)

  let cancelled = false
  const streamed = createPhysicalNodeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: {
        getReader() {
          let emitted = false
          return {
            async read() {
              if (emitted) return { done: true }
              emitted = true
              return { done: false, value: new Uint8Array(256 * 1024 + 1) }
            },
            async cancel() { cancelled = true },
          }
        },
      },
    }),
  })
  await assert.rejects(streamed.inspect(), /too large/)
  assert.equal(cancelled, true)

  const failed = createPhysicalNodeClient({
    fetchImpl: async () => jsonResponse({ error: 'workcell is not enrolled' }, { status: 503 }),
  })
  await assert.rejects(failed.inspect(), /workcell is not enrolled/)

  const unavailable = createPhysicalNodeClient({
    fetchImpl: async () => { throw new Error('connect failed') },
  })
  await assert.rejects(unavailable.inspect(), /unavailable at http:\/\/127\.0\.0\.1:8876/)
})

test('physical intent is bounded before network access', async () => {
  let called = false
  const client = createPhysicalNodeClient({
    fetchImpl: async () => { called = true; return jsonResponse(intentFixture()) },
  })
  await assert.rejects(client.interpret('', `sha256:${'c'.repeat(64)}`), /1-500/)
  await assert.rejects(client.interpret('x'.repeat(501), `sha256:${'c'.repeat(64)}`), /1-500/)
  assert.equal(called, false)
})

test('physical node timeout remains active while the response body is read', async () => {
  const client = createPhysicalNodeClient({
    timeoutMs: 100,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      text() {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    }),
  })
  await assert.rejects(client.inspect(), /before the timeout/)
})
