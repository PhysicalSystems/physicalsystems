import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createExecutionClient } from '../src/physical/execution-client.js'
import { executionDigest, parseExecutionJson, normalizePhysicalRun, normalizePhysicalRunReceipt, normalizeExecutionSnapshot, normalizeExecutionStatus, assertRunMatches } from '../src/physical/execution-contracts.js'
import { status, route, configuration, makeRun, makeReceipt, evolve, runId, digest } from './fixtures/execution.js'

const TOKEN = 'synthetic-test-credential-00000000000000'
const prepare = () => ({ contractVersion: 'physicalsystems-run-prepare-v1', routeReceiptDigest: route.receiptDigest, configurationId: configuration.configurationId, expectedConfigurationDigest: configuration.configurationDigest, idempotencyKey: 'prepare-one' })
function setup(handler = () => status) {
  const calls = []
  const client = createExecutionClient({ baseUrl: 'http://127.0.0.1:8876', token: TOKEN,
    fetchImpl: async (url, options) => { calls.push({ path: new URL(url).pathname, options }); const value = await handler(new URL(url).pathname, options); return value instanceof Response ? value : Response.json(value) } })
  return { client, calls }
}

test('authentic Node registry/router/SQLite simulation fixture validates through every execution decoder', () => {
  const fixture = parseExecutionJson(readFileSync(new URL('./fixtures/physical-execution-v1.json', import.meta.url), 'utf8'))
  normalizeExecutionStatus(fixture.status)
  const prepared = normalizePhysicalRun(fixture.prepared)
  assertRunMatches(normalizePhysicalRun(fixture.approved), prepared)
  assertRunMatches(normalizePhysicalRun(fixture.run), fixture.approved)
  const receipt = normalizePhysicalRunReceipt(fixture.receipt, fixture.run)
  assert.equal(receipt.run.phase, 'VERIFIED_SUCCESS')
  assert.equal(receipt.run.mode, 'simulation')
  assert.equal(receipt.physicalExecutionAuthorized, false)
})

test('execution HTTP client uses only exact authenticated loopback endpoints and correlates every run', async () => {
  let run = makeRun()
  const { client, calls } = setup((path) => {
    if (path.endsWith('/status')) return status
    if (path.endsWith('/runs')) return { contractVersion: 'physicalsystems-run-list-v1', runs: [run], physicalExecutionAuthorized: false }
    if (path.endsWith('/receipt')) return makeReceipt(run)
    return run
  })
  assert.equal((await client.status()).availability, 'available')
  assert.equal((await client.runs()).runs.length, 1)
  assert.equal((await client.prepare(prepare(), configuration)).runId, runId)
  assert.equal((await client.run(runId, run)).runDigest, run.runDigest)
  assert.equal((await client.receipt(runId, run)).run.runId, runId)
  const waiting = run
  run = evolve(run, 'RUNNING')
  await client.approve(runId, { expectedRunDigest: waiting.runDigest, approvalDigest: waiting.approval.digest, approved: true }, waiting)
  await client.stop(runId, { reason: 'operator-requested-stop' }, run)
  await client.reconcile(runId, { expectedRunDigest: run.runDigest }, run)
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.cache, 'no-store')
    assert.ok(call.options.signal)
    assert.match(call.path, /^\/v2\/physical\/execution\//)
  }
})

test('requests reject extra approval/evidence fields, traversal, and absent credentials before network', async () => {
  const { client, calls } = setup()
  assert.throws(() => client.prepare({ ...prepare(), physicalExecutionAuthorized: true }))
  assert.throws(() => client.approve(runId, { expectedRunDigest: digest('a'), approvalDigest: digest('b'), approved: false }))
  assert.throws(() => client.stop('../run-other', { reason: 'operator-requested-stop' }))
  assert.throws(() => client.reconcile(runId, { expectedRunDigest: digest('a'), retry: true }))
  assert.throws(() => createExecutionClient({ baseUrl: 'https://remote.example', token: TOKEN }))
  assert.equal(calls.length, 0)
  await assert.rejects(createExecutionClient({ baseUrl: 'http://127.0.0.1:8876', fetchImpl() { assert.fail('must not call') } }).status(), /server-side credential/)
})

test('run response checks integrity, exact context, authority, phases, timestamps and event ordering', async () => {
  const good = makeRun()
  assert.equal(normalizePhysicalRun(good).physicalExecutionAuthorized, false)
  for (const modify of [
    (value) => { value.physicalExecutionAuthorized = true },
    (value) => { value.phase = 'SUCCESS' }, (value) => { value.revision = 1.5 },
    (value) => { value.createdAt = '2026-02-31T00:00:00Z' },
    (value) => { value.events[0].sequence = 0 }, (value) => { value.events[0].type = 'ready<script>' },
    (value) => { value.extra = true }, (value) => { value.phase = 'VERIFIED_SUCCESS' },
    (value) => { value.inputs.source = 'changed' },
  ]) {
    const bad = structuredClone(good); modify(bad)
    assert.throws(() => normalizePhysicalRun(bad))
  }
  assert.throws(() => assertRunMatches(makeRun({ configurationDigest: digest('b') }), good))
  assert.throws(() => assertRunMatches(makeRun({ revision: 0 }), good))
  assert.throws(() => normalizeExecutionStatus({ ...status, configurations: [configuration, configuration] }))
  const { client } = setup(() => makeRun({ routeReceiptDigest: digest('b') }))
  await assert.rejects(client.prepare(prepare()), /no outcome is assumed/)
})

test('receipt binds full snapshot and run; opaque data never overrides authority', () => {
  const good = makeReceipt()
  assert.equal(normalizePhysicalRunReceipt(good).receiptDigest, good.receiptDigest)
  const bad = structuredClone(good); bad.snapshot.configuration.configurationId = 'different'
  bad.receiptDigest = executionDigest(bad, 'receiptDigest')
  assert.throws(() => normalizePhysicalRunReceipt(bad))
  assert.throws(() => normalizePhysicalRunReceipt(makeReceipt(makeRun(), {})))
})

test('snapshot reads are exact authenticated digest lookups and reject tampering, authority or extra fields', async () => {
  const snapshot = { calibrated: 'synthetic', threshold: 0.25 }
  const snapshotDigest = executionDigest(snapshot)
  const envelope = { contractVersion: 'physicalsystems-snapshot-v1', snapshotDigest, snapshot, physicalExecutionAuthorized: false }
  const { client, calls } = setup(() => envelope)
  assert.equal((await client.snapshot(snapshotDigest)).snapshotDigest, snapshotDigest)
  assert.equal(calls[0].path, `/v2/physical/execution/snapshots/${snapshotDigest}`)
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`)
  assert.throws(() => client.snapshot('../private'))
  for (const value of [{ ...envelope, physicalExecutionAuthorized: true }, { ...envelope, extra: true }, { ...envelope, snapshot: { changed: true } }]) {
    assert.throws(() => normalizeExecutionSnapshot(value, snapshotDigest))
  }
  assert.throws(() => normalizeExecutionSnapshot(envelope, digest('b')))
})

test('known failed readiness code gives a fixed explanation without reflecting provider text', async () => {
  const { client } = setup(() => Response.json({ code: 'preconditions_unknown', error: `${TOKEN}: /private/camera` }, { status: 422 }))
  await assert.rejects(client.prepare(prepare()), (error) => {
    assert.match(error.message, /Fresh observed preconditions/)
    assert.equal(error.message.includes(TOKEN), false)
    assert.equal(error.message.includes('/private/camera'), false)
    return true
  })
})

test('Python wire floats and Unicode canonical hashing retain precision without unsafe integer acceptance', () => {
  for (const raw of ['{"value":1e-05}', '{"value":1e-07}', '{"value":0.25}', '{"a":"é","z":0.000123}']) {
    assert.equal(executionDigest(parseExecutionJson(raw)), `sha256:${createHash('sha256').update(raw).digest('hex')}`)
  }
  assert.equal(executionDigest(parseExecutionJson('{"value":1.0}')), executionDigest({ value: 1 }))
  assert.throws(() => parseExecutionJson('{"value":9007199254740993}'))
  assert.throws(() => parseExecutionJson('{"value":1e999}'))
  let nested = {}; for (let i = 0; i < 22; i += 1) nested = { nested }
  assert.throws(() => executionDigest(nested))
})

test('execution bounds accept a 1024-event run and 512KiB snapshot while rejecting excess or deep payloads', () => {
  const events = Array.from({ length: 1024 }, (_, index) => ({ sequence: index + 1, type: 'journal_event', at: makeRun().createdAt, detail: {} }))
  const large = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`part${index}`, 'x'.repeat(60000)]))
  const run = makeRun({ events, revision: 1024, snapshotDigest: executionDigest(large) })
  assert.equal(normalizePhysicalRun(run).events.length, 1024)
  assert.equal(normalizePhysicalRunReceipt(makeReceipt(run, large)).run.snapshotDigest, run.snapshotDigest)
  assert.throws(() => normalizePhysicalRun(makeRun({ events: [...events, { ...events[0], sequence: 1025 }] })))
  const oversized = { ...large, more1: 'x'.repeat(60000), more2: 'x'.repeat(60000), more3: 'x'.repeat(60000) }
  assert.throws(() => normalizePhysicalRunReceipt(makeReceipt(makeRun({ snapshotDigest: executionDigest(oversized) }), oversized)))
  let nested = {}; for (let index = 0; index < 16; index += 1) nested = { nested }
  normalizePhysicalRunReceipt(makeReceipt(makeRun({ snapshotDigest: executionDigest(nested) }), nested))
  nested = { nested }
  assert.throws(() => normalizePhysicalRunReceipt(makeReceipt(makeRun({ snapshotDigest: executionDigest(nested) }), nested)))
})

test('recovery retains immutable historical approval but uncertain/cancelled phase is not dispatch authority', () => {
  const approved = evolve(makeRun(), 'RUNNING')
  const recovered = evolve(approved, 'OUTCOME_UNKNOWN', { events: [...approved.events, {
    sequence: approved.events.length + 1, type: 'recovered_after_restart', at: approved.updatedAt,
    detail: { previousPhase: approved.phase, previousApproval: approved.approval, approvalCannotAuthorizeNewDispatch: true },
  }], outcome: { status: 'OUTCOME_UNKNOWN', reason: 'Recovered after restart; outcome unresolved', evidenceDigest: null } })
  const value = assertRunMatches(normalizePhysicalRun(recovered), approved)
  assert.equal(value.approval.approvedAt, approved.approval.approvedAt)
  assert.equal(value.approval.expiresAt, approved.approval.expiresAt)
  assert.equal(value.physicalExecutionAuthorized, false)
})

test('bounded transport refuses redirects, oversized JSON, malformed contracts and never reflects token/errors', async () => {
  for (const response of [
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    () => new Response(TOKEN, { status: 409 }),
    () => Response.json({ ...status, physicalExecutionAuthorized: true }),
    () => { const value = Response.json(status); Object.defineProperty(value, 'redirected', { value: true }); return value },
  ]) {
    const { client } = setup(response)
    await assert.rejects(client.status(), (error) => { assert.equal(error.message.includes(TOKEN), false); return true })
  }
})
