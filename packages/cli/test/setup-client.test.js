import assert from 'node:assert/strict'
import test from 'node:test'
import { createSetupRequirementsClient, setupReadFailure } from '../src/physical/setup-client.js'
import { normalizeSetupRequirements } from '../src/physical/setup-contracts.js'
import { setupRequirements, setupRequirement } from './fixtures/setup-requirements.js'

const TOKEN = 'synthetic-setup-credential-00000000000000'
function fixture(handler = () => Response.json(setupRequirements())) {
  const calls = []
  const client = createSetupRequirementsClient({ baseUrl: 'http://127.0.0.1:8876', token: TOKEN,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return handler(url, options) } })
  return { client, calls }
}

test('setup reader is inert, GET-only, authenticated and returns a frozen exact public projection', async () => {
  const h = fixture()
  assert.deepEqual(Object.keys(h.client), ['requirements'])
  assert.equal(h.calls.length, 0)
  const result = await h.client.requirements()
  assert.equal(result.status, 'available')
  assert.equal(result.report.physicalExecutionAuthorized, false)
  assert.equal(Object.isFrozen(result.report.implementations[0].requirements[0].evidence), true)
  assert.equal(h.calls.length, 1)
  const { url, options } = h.calls[0]
  assert.equal(url, 'http://127.0.0.1:8876/v2/physical/setup/requirements')
  assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store')
  assert.equal(Object.hasOwn(options, 'body'), false)
  assert.ok(options.signal)
})

test('only 404 and 501 identify an unsupported legacy inspection contract', async () => {
  for (const status of [404, 501]) {
    const h = fixture(() => new Response(`PRIVATE ${TOKEN}`, { status }))
    assert.deepEqual(await h.client.requirements(), { status: 'unsupported', report: null })
  }
  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    const h = fixture(() => new Response(`PRIVATE ${TOKEN}`, { status }))
    await assert.rejects(h.client.requirements(), error => {
      assert.equal(setupReadFailure(error), 'unavailable')
      assert.doesNotMatch(error.message, /PRIVATE|synthetic-setup/)
      return true
    })
  }
})

test('read-only setup refuses remote endpoints and absent credentials without contacting Node', async () => {
  assert.throws(() => createSetupRequirementsClient({ baseUrl: 'https://elsewhere.example', token: TOKEN }))
  await assert.rejects(createSetupRequirementsClient({ baseUrl: 'http://127.0.0.1:8876',
    fetchImpl() { assert.fail('No credential must mean no network request') } }).requirements(), /unavailable/)
})

test('redirects, oversized wire data, non-JSON and malformed contracts fail as invalid without echoing bodies', async () => {
  for (const response of [
    () => new Response(`PRIVATE ${TOKEN}`, { headers: { 'content-type': 'text/plain' } }),
    () => new Response(`PRIVATE ${TOKEN}`, { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999999' } }),
    () => Response.json({ ...setupRequirements(), physicalExecutionAuthorized: true }),
    () => { const response = Response.json(setupRequirements()); Object.defineProperty(response, 'redirected', { value: true }); return response },
    () => { const response = Response.json(setupRequirements()); Object.defineProperty(response, 'url', { value: 'http://127.0.0.1:8876/private' }); return response },
  ]) {
    await assert.rejects(fixture(response).client.requirements(), error => {
      assert.equal(setupReadFailure(error), 'invalid')
      assert.doesNotMatch(error.message, /PRIVATE|synthetic-setup/)
      return true
    })
  }
  assert.equal(setupReadFailure({ code: 'invalid', message: TOKEN }), 'unavailable', 'Arbitrary errors cannot impersonate validated error classes')
})

test('setup schema refuses authority, unknown fields, invented statuses and unsafe procedure semantics', () => {
  for (const alter of [
    value => { value.inspectionOnly = false }, value => { value.physicalExecutionAuthorized = true },
    value => { value.rawConfiguration = { secret: TOKEN } }, value => { value.registryUpdatedAt = '2026-02-31T00:00:00Z' },
    value => { value.maximumAgeMs = 30_001 }, value => { value.nodeSessionId = '../private' },
    value => { value.implementations[0].registeredImplementation = false },
    value => { value.implementations[0].bindings[0].scope = 'route-implementation' },
    value => { value.implementations[0].requirements[0].state = 'ready' },
    value => { value.implementations[0].requirements[0].kind = 'new-unknown-kind' },
    value => { value.implementations[0].requirements[0].evidence.sourceUpdatedAt = value.inspectedAt },
    value => { value.implementations[0].requirements[0].procedure.requiresApproval = false },
    value => { value.implementations[0].requirements[0].procedure.description = 'x'.repeat(481) },
  ]) {
    const value = setupRequirements(); alter(value)
    assert.throws(() => normalizeSetupRequirements(value))
  }
})

test('bindings, requirement and implementation uniqueness, bounds and omission counts are enforced', () => {
  for (const alter of [
    value => { value.implementations.push(value.implementations[0]) },
    value => { value.implementations[0].requirements.push(value.implementations[0].requirements[0]) },
    value => { value.implementations[0].bindings.push(value.implementations[0].bindings[0]) },
    value => { value.implementations[0].requirements = Array.from({ length: 17 }, (_, n) => setupRequirement({ requirementId: `id-${n}` })) },
    value => { value.truncation.requirementsOmitted = -1 },
  ]) { const value = setupRequirements(); alter(value); assert.throws(() => normalizeSetupRequirements(value)) }
  const value = setupRequirements()
  value.implementations[0].registeredImplementation = false
  value.implementations[0].implementationId = null
  assert.equal(normalizeSetupRequirements(value).implementations[0].registeredImplementation, false)
})

test('exact configured dependency versions and observation ages retain units and original source dates', () => {
  const value = setupRequirements()
  const source = { source: 'installed-configuration', sourceUpdatedAt: '2026-09-01T12:00:00Z' }
  value.implementations[0].constraints = [
    { kind: 'dependency-version', name: 'numpy', value: '2.2.4', unit: null, ...source },
    { kind: 'observation-limit', name: 'observation-maximum-age', value: 0.25, unit: 'seconds', ...source },
    { kind: 'observation-limit', name: 'capture-maximum-frame-age', value: 250_000_000, unit: 'ns', ...source },
    { kind: 'precondition', name: 'destination-vacant', value: value.registryDigest, unit: null, source: 'registry', sourceUpdatedAt: value.registryUpdatedAt },
    { kind: 'precondition-age', name: 'destination-vacant', value: 1_000_000_000, unit: 'ns', source: 'registry', sourceUpdatedAt: value.registryUpdatedAt },
    { kind: 'implementation-precondition', name: 'destination-vacant', value: value.registryDigest, unit: null, source: 'registry', sourceUpdatedAt: value.registryUpdatedAt },
    { kind: 'implementation-precondition-age', name: 'destination-vacant', value: 500_000_000, unit: 'ns', source: 'registry', sourceUpdatedAt: value.registryUpdatedAt },
  ]
  value.implementations[0].bindings.push({ scope: 'installed-dependency', id: 'numpy', digest: value.registryDigest },
    { scope: 'dependency-artifact', id: 'numpy', digest: value.registryDigest })
  const normalized = normalizeSetupRequirements(value)
  assert.deepEqual(normalized.implementations[0].constraints, value.implementations[0].constraints)
  assert.equal(normalized.implementations[0].requirements[0].state, 'unverified', 'Declared ages and pins do not validate physical state')
})

test('typed constraints reject arbitrary dependencies, values, unknown units, unsafe integers and false provenance', () => {
  const base = { kind: 'observation-limit', name: 'capture-maximum-frame-age', value: 250_000_000, unit: 'ns', source: 'installed-configuration', sourceUpdatedAt: null }
  for (const invalid of [
    { ...base, name: 'private-path' }, { ...base, value: true }, { ...base, value: -1 }, { ...base, value: 0.5 },
    { ...base, value: Number.MAX_SAFE_INTEGER + 1 }, { ...base, unit: 'seconds' }, { ...base, source: 'registry' },
    { ...base, kind: 'dependency-version', name: 'unreviewed-package', value: '1.0', unit: null },
    { ...base, kind: 'dependency-version', name: 'numpy', value: '/private/path', unit: null },
    { ...base, name: 'minimum-detection-score', unit: 'ratio', value: 1.1 },
    { ...base, kind: 'precondition-age', name: 'source-present', value: 0, source: 'registry' },
    { ...base, kind: 'precondition', name: 'source-present', value: 'ready', unit: null, source: 'registry' },
  ]) {
    const value = setupRequirements(); value.implementations[0].constraints = [invalid]
    assert.throws(() => normalizeSetupRequirements(value))
  }
  const value = setupRequirements(); value.implementations[0].constraints = [base, base]
  assert.throws(() => normalizeSetupRequirements(value))
})

test('a dropped response stream is unavailable while malformed JSON is invalid, and unused bodies are cancelled', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(Error(`PRIVATE ${TOKEN}`)) } })
  await assert.rejects(fixture(() => new Response(stream, { headers: { 'content-type': 'application/json' } })).client.requirements(), error => {
    assert.equal(setupReadFailure(error), 'unavailable'); assert.doesNotMatch(error.message, /PRIVATE|synthetic-setup/); return true
  })
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  await assert.rejects(fixture(() => new Response(body, { headers: { 'content-type': 'text/plain' } })).client.requirements())
  assert.equal(cancelled, true)
})
