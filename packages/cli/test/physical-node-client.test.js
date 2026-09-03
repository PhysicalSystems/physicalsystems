import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createPhysicalNodeClient,
  normalizePhysicalNodeUrl,
  PHYSICAL_CANDIDATE_SNAPSHOT_VERSION,
  PHYSICAL_NODE_INTENT_REQUEST_VERSION,
  PHYSICAL_NODE_INTENT_VERSION,
  PHYSICAL_NODE_STATE_VERSION,
} from '../src/physical/node-client.js'

function routeFixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url), 'utf8'))
}

test('capability catalog, route preview and receipt retrieval use bounded loopback requests', async () => {
  const fixture = routeFixture()
  const calls = []
  const client = createPhysicalNodeClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return jsonResponse(url.pathname.endsWith('/capabilities') ? fixture.catalog : fixture.selected)
    },
  })
  const catalog = await client.capabilities()
  const selected = await client.previewCapability(fixture.request)
  const retained = await client.routeReceipt(selected.receiptDigest)
  assert.equal(catalog.physicalExecutionAuthorized, false)
  assert.equal(selected.physicalExecutionAuthorized, false)
  assert.equal(selected.decision.physical_execution_authorized, false)
  assert.equal(selected.decision.decision_status, 'selected')
  assert.equal(retained.receiptDigest, selected.receiptDigest)
  assert.deepEqual(calls.map(({ url, options }) => [url.pathname, options.method]), [
    ['/v2/physical/capabilities', 'GET'],
    ['/v2/physical/routes:preview', 'POST'],
    [`/v2/physical/routes/${selected.receiptDigest.slice(7)}`, 'GET'],
  ])
  assert.deepEqual(JSON.parse(calls[1].options.body), fixture.request)
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'http://127.0.0.1:8876')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.Accept, 'application/json')
  }
})

test('capability preview rejects invented authority/evidence fields before making a request', async () => {
  let calls = 0
  const client = createPhysicalNodeClient({ fetchImpl: async () => { calls += 1; throw new Error('unexpected request') } })
  const fixture = routeFixture()
  for (const injected of [
    { physicalExecutionAuthorized: true }, { preconditions: [] }, { qualification: 'qualified' },
    { policy: {} }, { implementationId: 'invented' },
  ]) {
    await assert.rejects(client.previewCapability({ ...fixture.request, ...injected }), /unsupported|missing fields/)
  }
  assert.equal(calls, 0)
})

test('capability route errors preserve host conflict code and never retry or fall back', async () => {
  const fixture = routeFixture()
  const calls = []
  const client = createPhysicalNodeClient({
    fetchImpl: async (url) => {
      calls.push(url.pathname)
      return jsonResponse({ error: 'Registry changed; inspect again', code: 'snapshot_mismatch' }, { status: 409 })
    },
  })
  await assert.rejects(client.previewCapability(fixture.request), (error) => {
    assert.equal(error.status, 409)
    assert.equal(error.code, 'snapshot_mismatch')
    return /Registry changed/.test(error.message)
  })
  assert.deepEqual(calls, ['/v2/physical/routes:preview'])
})

test('absent capability routing reports unavailable without legacy intent fallback', async () => {
  const calls = []
  const client = createPhysicalNodeClient({
    fetchImpl: async (url) => {
      calls.push(url.pathname)
      return jsonResponse({ error: 'Pinned Runtime unavailable', code: 'runtime_unavailable' }, { status: 503 })
    },
  })
  await assert.rejects(client.capabilities(), (error) => error.status === 503 && error.code === 'runtime_unavailable')
  assert.deepEqual(calls, ['/v2/physical/capabilities'])
})

test('preview receipt must match the requested invocation and retained receipt digest', async () => {
  const fixture = routeFixture()
  const client = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(fixture.selected) })
  await assert.rejects(client.previewCapability({ ...fixture.request, workcellId: 'different-workcell' }), /match/)
  await assert.rejects(client.routeReceipt(`sha256:${'f'.repeat(64)}`), /different route receipt/)
  await assert.rejects(client.routeReceipt('../receipt'), /digest/)
})

test('unknown and stale physical observations remain no-match responses', async () => {
  const fixture = routeFixture()
  for (const name of ['unknown', 'stale']) {
    const client = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(fixture[name]) })
    const receipt = await client.previewCapability(fixture[name].request)
    assert.equal(receipt.decision.decision_status, 'no_match')
    assert.equal(receipt.decision.selected_implementation_id, null)
    assert.equal(receipt.physicalExecutionAuthorized, false)
    assert.ok(receipt.decision.candidates.some((candidate) => candidate.rejection_codes.includes(`precondition_${name}`)))
  }
})

test('route JSON accepts more than 256 KiB through 2 MiB without increasing legacy limits', async () => {
  const fixture = routeFixture()
  const rawReceipt = JSON.stringify(fixture.selected)
  for (const bytes of [300 * 1024, 2 * 1024 * 1024]) {
    // Legal JSON whitespace exercises transport size without changing the
    // authentic Node-generated contract or its content-addressed digests.
    const body = `${' '.repeat(bytes - Buffer.byteLength(rawReceipt))}${rawReceipt}`
    const client = createPhysicalNodeClient({
      fetchImpl: async () => ({
        ok: true, status: 200,
        headers: { get: (name) => ({ 'content-type': 'application/json', 'content-length': String(bytes) })[name] ?? null },
        async text() { return body },
      }),
    })
    assert.equal((await client.previewCapability(fixture.request)).receiptDigest, fixture.selected.receiptDigest)
    assert.equal((await client.routeReceipt(fixture.selected.receiptDigest)).receiptDigest, fixture.selected.receiptDigest)
    await assert.rejects(client.inspect(), /too large/)
  }
})

test('route JSON over 2 MiB is rejected for declared and streamed response sizes', async () => {
  const fixture = routeFixture()
  let readBody = false
  const declared = createPhysicalNodeClient({
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: (name) => ({ 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) })[name] ?? null },
      async text() { readBody = true; return '{}' },
    }),
  })
  await assert.rejects(declared.previewCapability(fixture.request), /too large/)
  assert.equal(readBody, false)
  let cancelled = false
  const streamed = createPhysicalNodeClient({
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: {
        getReader() {
          let emitted = false
          return {
            async read() {
              if (emitted) return { done: true }
              emitted = true
              return { done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }
            },
            async cancel() { cancelled = true },
          }
        },
      },
    }),
  })
  await assert.rejects(streamed.routeReceipt(fixture.selected.receiptDigest), /too large/)
  assert.equal(cancelled, true)
})

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

function candidateFixture() {
  // Mirrors tinyedge-agent/examples/physical-systems/physical-candidates.example.json
  // from the producer contract introduced by TIN-392.
  return {
    contractVersion: PHYSICAL_CANDIDATE_SNAPSHOT_VERSION,
    nodeName: 'ubuntu-workstation',
    observedAt: '2026-09-02T12:00:00.000Z',
    snapshotDigest: `sha256:${'e'.repeat(64)}`,
    candidates: [
      {
        candidateId: 'candidate-89429c72a0d023d8170f',
        displayName: 'USB serial controller',
        deviceClass: 'serial-device',
        transport: 'serial',
        providerId: 'fixture-provider',
        detected: true,
        observedIdentity: '/dev/serial/by-id/usb-controller',
        identityStability: 'stable',
        adapter: {
          status: 'unavailable',
          adapterId: null,
          detail: 'hardware identity has not been matched to an adapter',
        },
        capabilities: [],
        properties: { 'device-path': '/dev/ttyACM0' },
        commissioned: false,
        ready: false,
      },
      {
        candidateId: 'candidate-af82c39fa1321a42639b',
        displayName: 'tinyedge-thor.local',
        deviceClass: 'compute-node',
        transport: 'network',
        providerId: 'fixture-provider',
        detected: true,
        observedIdentity: 'mac:aa:bb:cc:dd:ee:ff',
        identityStability: 'network',
        adapter: { status: 'available', adapterId: 'tinyedge-physical-node', detail: null },
        capabilities: ['physical-node-api'],
        properties: {
          address: '10.42.71.92',
          hostname: 'tinyedge-thor.local',
          interface: 'enp1s0',
          'service-port': '8876',
          'service-type': '_tinyedge-physical._tcp',
        },
        commissioned: false,
        ready: false,
      },
      {
        candidateId: 'candidate-ef0da69ca0e2229db21b',
        displayName: 'Mounted USB camera',
        deviceClass: 'camera',
        transport: 'v4l2',
        providerId: 'fixture-provider',
        detected: true,
        observedIdentity: '/dev/v4l/by-id/usb-camera',
        identityStability: 'stable',
        adapter: { status: 'available', adapterId: 'tinyedge-v4l2-camera', detail: null },
        capabilities: ['capture-frame'],
        properties: { 'device-path': '/dev/video0' },
        commissioned: false,
        ready: false,
      },
    ],
    providers: [{
      providerId: 'fixture-provider', status: 'ok', candidateCount: 3, detail: null,
    }],
    summary: {
      detected: 3, adapterAvailable: 2, setupRequired: 0, commissioned: 0, ready: 0,
    },
    physicalExecutionAuthorized: false,
    evidenceBoundary: {
      claim: 'read-only candidate inventory; identity and readiness are not established',
      deviceNodesOpened: false,
      serialOpened: false,
      cameraOpened: false,
      activePortScan: false,
      remoteLogin: false,
      networkMessagesSent: false,
      commandsIssued: 0,
    },
  }
}

function legacyStateFetch(value) {
  return async (url) => url.pathname.endsWith('/candidates')
    ? jsonResponse({ error: 'not found' }, { status: 404 })
    : jsonResponse(value)
}

function candidateOnlyFetch(value, requests = null) {
  return async (url) => {
    requests?.push(url.toString())
    return url.pathname.endsWith('/candidates')
      ? jsonResponse(value)
      : jsonResponse({ error: 'commissioned physical system is not configured' }, { status: 409 })
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
      interpretationDigest: `sha256:${'d'.repeat(64)}`,
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
      if (options.method === 'POST') return jsonResponse(intentFixture())
      return url.pathname.endsWith('/candidates')
        ? jsonResponse({ error: 'not found' }, { status: 404 })
        : jsonResponse(stateFixture())
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
    'http://127.0.0.1:8876/v2/physical/candidates',
    'http://127.0.0.1:8876/v1/physical/state',
    'http://127.0.0.1:8876/v1/physical/intents:interpret',
  ])
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    contractVersion: PHYSICAL_NODE_INTENT_REQUEST_VERSION,
    text: 'Move the cup from source to destination.',
    expectedDiscoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
  })
  assert.equal(requests[2].options.redirect, 'error')
})

test('physical node client consumes enrollment-free observed candidates first', async () => {
  const requests = []
  const client = createPhysicalNodeClient({
    fetchImpl: candidateOnlyFetch(candidateFixture(), requests),
  })
  const state = await client.inspect()
  assert.deepEqual(requests, [
    'http://127.0.0.1:8876/v2/physical/candidates',
    'http://127.0.0.1:8876/v1/physical/state',
  ])
  assert.equal(state.contractVersion, PHYSICAL_CANDIDATE_SNAPSHOT_VERSION)
  assert.equal(state.discovery.enrollmentId, null)
  assert.equal(state.discovery.devices.length, 3)
  assert.equal(state.discovery.devices[0].displayName, 'USB serial controller')
  assert.equal(state.discovery.devices[0].readiness, 'detected')
  assert.equal(state.discovery.devices[1].readiness, 'adapter-available')
  assert.equal(state.discovery.devices[1].configured, false)
  assert.equal(state.discovery.summary.detected, 3)
  assert.equal(state.discovery.summary.ready, 0)
  assert.equal(state.discovery.providerErrors.length, 0)
})

test('commissioned state takes precedence when candidate and v1 routes are both available', async () => {
  const requests = []
  const client = createPhysicalNodeClient({
    async fetchImpl(url, options) {
      requests.push(url.toString())
      if (options.method === 'POST') return jsonResponse(intentFixture())
      if (url.pathname.endsWith('/candidates')) return jsonResponse(candidateFixture())
      return jsonResponse(stateFixture())
    },
  })
  const state = await client.inspect()
  assert.equal(state.contractVersion, PHYSICAL_NODE_STATE_VERSION)
  assert.equal(state.discoveryBindingDigest, `sha256:${'c'.repeat(64)}`)
  const intent = await client.interpret(
    'Move the cup from source to destination',
    state.discoveryBindingDigest,
    state,
  )
  assert.equal(intent.interpretation.status, 'ready')
  assert.deepEqual(requests, [
    'http://127.0.0.1:8876/v2/physical/candidates',
    'http://127.0.0.1:8876/v1/physical/state',
    'http://127.0.0.1:8876/v1/physical/intents:interpret',
  ])
})

test('candidate readiness preserves adapter setup, commissioning, and ready as separate states', async () => {
  const cases = [
    {
      mutate(value) {
        value.candidates[2].adapter.status = 'setup-required'
        value.summary.adapterAvailable = 1
        value.summary.setupRequired = 1
      },
      expected: 'setup-required',
    },
    {
      mutate(value) {
        value.candidates[2].commissioned = true
        value.summary.commissioned = 1
      },
      expected: 'commissioned',
    },
    {
      mutate(value) {
        value.candidates[2].commissioned = true
        value.candidates[2].ready = true
        value.summary.commissioned = 1
        value.summary.ready = 1
      },
      expected: 'ready',
    },
  ]
  for (const { mutate, expected } of cases) {
    const fixture = candidateFixture()
    mutate(fixture)
    const client = createPhysicalNodeClient({ fetchImpl: candidateOnlyFetch(fixture) })
    const state = await client.inspect()
    assert.equal(state.discovery.devices[2].readiness, expected)
  }
})

test('candidate discovery never crosses into the enrollment-bound intent route', async () => {
  const requests = []
  const client = createPhysicalNodeClient({
    fetchImpl: candidateOnlyFetch(candidateFixture(), requests),
  })
  const state = await client.inspect()
  await assert.rejects(
    client.interpret(
      'Inspect the sample with the mounted camera',
      state.discoveryBindingDigest,
      state,
    ),
    (error) => error?.code === 'PHYSICAL_COMMISSIONING_REQUIRED'
      && /commissioned physical-system configuration/.test(error.message),
  )
  assert.deepEqual(requests, [
    'http://127.0.0.1:8876/v2/physical/candidates',
    'http://127.0.0.1:8876/v1/physical/state',
  ])
})

test('candidate discovery rejects unobserved, inconsistent readiness, and authorization', async () => {
  for (const mutate of [
    (value) => { value.candidates[0].detected = false },
    (value) => { value.candidates[0].adapter.status = 'ready' },
    (value) => { value.candidates[0].ready = true },
    (value) => { value.physicalExecutionAuthorized = true },
  ]) {
    const invalid = candidateFixture()
    mutate(invalid)
    const client = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(invalid) })
    await assert.rejects(client.inspect(), /observed|unsupported|before commissioning|cannot authorize/)
  }
})

test('physical node client rejects configured-only readiness and authorization claims', async () => {
  const invalidState = stateFixture()
  invalidState.discovery.devices[0].detected = false
  invalidState.discovery.devices[0].ready = false
  invalidState.discovery.summary.detected = 0
  invalidState.discovery.summary.ready = 0
  invalidState.discovery.summary.allReady = false
  const client = createPhysicalNodeClient({
    fetchImpl: legacyStateFetch(invalidState),
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
    fetchImpl: legacyStateFetch(inconsistent),
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

test('physical intent validates workflow and required-operation structure before showing a plan', async () => {
  for (const mutate of [
    (value) => { value.interpretation.workflowIntent = 'not-a-workflow' },
    (value) => { value.interpretation.workflowIntent = {} },
    (value) => {
      value.interpretation.requiredOperations = [{
        deviceRole: 'camera', operationId: 'capture-frame', effect: 'observing',
      }]
    },
    (value) => {
      value.interpretation.requiredOperations = [
        { deviceRole: 'camera', operationId: 'capture-frame', effect: 'read-only' },
        { deviceRole: 'camera', operationId: 'capture-frame', effect: 'read-only' },
      ]
    },
  ]) {
    const invalid = intentFixture()
    mutate(invalid)
    const client = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(invalid) })
    await assert.rejects(client.interpret(
      'Inspect the sample',
      `sha256:${'c'.repeat(64)}`,
    ), /object|must not be empty|unsupported|requiredOperations must be distinct/)
  }
})

test('physical node client validates commissioning binding evidence at the loopback boundary', async () => {
  const commissioning = intentFixture()
  commissioning.interpretation.status = 'needs-clarification'
  commissioning.interpretation.workflowIntent = null
  commissioning.interpretation.gaps = [{
    gapId: 'robot-manipulation-commissioning',
    kind: 'commissioning-required',
    deviceId: 'robot-one',
    operationIds: ['pick-container'],
    detail: 'The selected robot requires a qualified pick operation.',
  }]
  const valid = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(commissioning) })
  const result = await valid.interpret(
    'Move cup from source to destination',
    `sha256:${'c'.repeat(64)}`,
  )
  assert.equal(result.interpretation.interpretationDigest, `sha256:${'d'.repeat(64)}`)
  assert.deepEqual(result.interpretation.gaps[0].operationIds, ['pick-container'])

  for (const mutate of [
    (value) => { value.interpretation.interpretationDigest = 'not-a-digest' },
    (value) => { value.interpretation.gaps[0].deviceId = 'Robot One' },
    (value) => { value.interpretation.gaps[0].operationIds = ['Pick Container'] },
    (value) => { value.interpretation.gaps[0].operationIds = ['pick-container', 'pick-container'] },
  ]) {
    const invalid = structuredClone(commissioning)
    mutate(invalid)
    const client = createPhysicalNodeClient({ fetchImpl: async () => jsonResponse(invalid) })
    await assert.rejects(client.interpret(
      'Move cup from source to destination',
      `sha256:${'c'.repeat(64)}`,
    ), /digest|identifier|distinct/)
  }
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
