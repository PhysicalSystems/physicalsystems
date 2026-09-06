import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createExecutionInspector } from '../src/harness/execution-inspection.js'
import { executionDigest, parseExecutionJson } from '../src/physical/execution-contracts.js'
import { createExecutionClient } from '../src/physical/execution-client.js'

const wire = await readFile(new URL('./fixtures/physical-execution-v1.json', import.meta.url), 'utf8')
const recorded = parseExecutionJson(wire)
const instant = Date.parse('2026-09-06T12:00:00.000Z')
const digest = (letter) => `sha256:${letter.repeat(64)}`
const otherId = `run-${'b'.repeat(32)}`
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
const sealRun = (run) => ({ ...run, runDigest: executionDigest(run, 'runDigest') })
function fixture() {
  // Reuse the public Node fixture's real routing envelope/artifact distinction.
  // Supply synthetic hash-addressed snapshots without copying host evidence.
  const original = parseExecutionJson(wire)
  const route = JSON.parse(original.receipt.snapshot.routeReceiptCanonicalJson)
  const configurationSnapshot = { contractVersion: 'test-configuration-v1', mode: 'simulation', controller: 'synthetic-only' }
  const configurationDigest = executionDigest(configurationSnapshot)
  const configuration = { ...original.status.configurations[0], configurationDigest }
  const snapshot = { ...original.receipt.snapshot, configurationSnapshotDigest: configurationDigest,
    prepared: { ...original.receipt.snapshot.prepared, configurationDigest } }
  const evidence = original.run.events.find((event) => event.type === 'verification_observed').detail.observation
  const run = sealRun({ ...original.run, configurationDigest, snapshotDigest: executionDigest(snapshot),
    outcome: { ...original.run.outcome, evidenceDigest: executionDigest(evidence) } })
  const receipt = { ...original.receipt, run, snapshot }
  receipt.receiptDigest = executionDigest(receipt, 'receiptDigest')
  const snapshots = new Map([[configurationDigest, configurationSnapshot], [run.outcome.evidenceDigest, evidence]])
  return { route, run, receipt, snapshots, configuration, status: { ...original.status, configurations: [configuration] } }
}
function setup(t, options = {}) {
  const data = fixture(), calls = []
  let clock = instant, context = { generation: 1, route: data.route, selectedRun: null }
  const client = Object.fromEntries(['status', 'runs', 'run', 'receipt', 'snapshot'].map((method) => [method, async (...args) => {
    calls.push([method, ...args])
    if (options[method]) return options[method](...args)
    if (method === 'status') return data.status
    if (method === 'runs') return { contractVersion: 'physicalsystems-run-list-v1', runs: [data.run], physicalExecutionAuthorized: false }
    if (method === 'run') return data.run
    if (method === 'receipt') return data.receipt
    return { contractVersion: 'physicalsystems-snapshot-v1', snapshotDigest: args[0], snapshot: data.snapshots.get(args[0]), physicalExecutionAuthorized: false }
  }]))
  for (const method of ['prepare', 'approve', 'stop', 'reconcile']) Object.defineProperty(client, method, { get() { throw new Error('Mutation authority was accessed') } })
  const inspector = createExecutionInspector({ client: Object.freeze(client), getContext: () => context, now: () => clock, readTimeoutMs: options.readTimeoutMs ?? 1000 })
  t.after(() => inspector.dispose())
  return { inspector, calls, data, setClock(value) { clock = value }, setContext(value) { context = { ...context, ...value } } }
}

test('inspects the exact simulated run and verifies its receipt and both referenced snapshots without authority', async (t) => {
  const { inspector, calls, data } = setup(t)
  assert.equal(calls.length, 0)
  const result = await inspector.inspect()
  assert.equal(result.contractVersion, 'physicalsystems-execution-inspection-v1')
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.inspection.observedAt, new Date(instant).toISOString())
  assert.equal(result.inspection.expiresAt, new Date(instant + 5000).toISOString())
  assert.equal(result.service.mode, 'simulation')
  assert.equal(result.selectedRun.runId, data.run.runId)
  assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
  assert.equal(result.selectedRun.currentConfiguration, 'exact')
  assert.equal(result.receipt.status, 'verified')
  assert.equal(result.receipt.receiptDigest, data.receipt.receiptDigest)
  assert.equal(result.receipt.configurationSnapshotDigest, data.run.configurationDigest)
  assert.equal(result.receipt.evidenceDigest, data.run.outcome.evidenceDigest)
  assert.equal(result.receipt.preparation.preconditions, 'met')
  assert.equal(result.receipt.verification.verified, 'met')
  assert.equal(result.receipt.preparation.historical, true)
  assert.equal(result.receipt.verification.mode, 'simulation')
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.equal(result.operatorPath, '/workcell')
  assert.deepEqual(calls.map(([method]) => method), ['status', 'runs', 'run', 'receipt', 'snapshot', 'snapshot'])
  assert.deepEqual(Object.keys(inspector).sort(), ['dispose', 'inspect'])
})

test('real Node fixture exposes matching availability despite distinct routing-envelope and artifact digests', async (t) => {
  const value = fixture()
  const { inspector } = setup(t, { status: () => recorded.status, runs: () => ({ contractVersion: 'physicalsystems-run-list-v1', runs: [], physicalExecutionAuthorized: false }) })
  assert.notEqual(value.route.decision.selected_implementation_digest, recorded.status.configurations[0].implementationDigest)
  const result = await inspector.inspect()
  assert.equal(result.configurationAvailability.status, 'matching')
  assert.equal(result.configurationAvailability.matchingConfigurations[0].implementationDigest, recorded.status.configurations[0].implementationDigest)
  assert.equal(result.selectedRun, null)
  assert.equal(result.physicalExecutionAuthorized, false)
  assert.match(result.configurationAvailability.message, /do not establish current readiness/i)
})

test('missing route and missing setup receive separate actionable explanations without readiness claims', async (t) => {
  const context = setup(t, { runs: () => ({ contractVersion: 'physicalsystems-run-list-v1', runs: [], physicalExecutionAuthorized: false }) })
  context.setContext({ route: null })
  let result = await context.inspector.inspect()
  assert.equal(result.configurationAvailability.status, 'missing_route')
  assert.match(result.configurationAvailability.message, /route/i)
  context.data.status = { ...context.data.status, configurations: [] }
  context.setContext({ route: context.data.route })
  result = await context.inspector.inspect()
  assert.equal(result.configurationAvailability.status, 'missing_configuration')
  assert.match(result.configurationAvailability.message, /configured|configuration/i)
})

test('multiple history entries require an exact advertised selection and never choose the latest as this task', async (t) => {
  const data = fixture(), other = sealRun({ ...data.run, runId: otherId })
  const context = setup(t, { runs: () => ({ contractVersion: 'physicalsystems-run-list-v1', runs: [data.run, other], physicalExecutionAuthorized: false }) })
  let result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'selection_required')
  assert.equal(result.selectedRun, null)
  assert.deepEqual(result.runs.map(({ runId }) => runId), [data.run.runId, otherId])
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
  result = await context.inspector.inspect({ runId: data.run.runId })
  assert.equal(result.selectedRun.runId, data.run.runId)
  assert.equal(result.receipt.status, 'verified')
})

test('ordinary assistant turns retain advertised identity while newly listed explicit guesses are rejected before any read', async (t) => {
  const context = setup(t)
  const initial = await context.inspector.inspect({ runId: context.data.run.runId })
  assert.equal(initial.inspection.status, 'invalid_request')
  assert.equal(context.calls.length, 0)
  await context.inspector.inspect()
  context.setContext({ generation: 2, route: null })
  const result = await context.inspector.inspect({ runId: context.data.run.runId })
  assert.equal(result.selectedRun.runId, context.data.run.runId)
  assert.equal(result.selectedRun.routeRelationship, 'no_route')
})

test('browser-selected projected run can be inspected explicitly without a prior model listing', async (t) => {
  const context = setup(t)
  const { inputs, approval, events, ...projected } = context.data.run
  context.setContext({ selectedRun: projected })
  const result = await context.inspector.inspect({ runId: projected.runId })
  assert.equal(result.receipt.status, 'verified')
  assert.equal(result.selectedRun.runId, projected.runId)
})

test('refuses URLs, paths, unknown run IDs, extra fields and non-object arguments without network requests', async (t) => {
  const context = setup(t)
  for (const args of [{ runId: 'http://localhost/token' }, { runId: '../../secret' }, { runId: otherId }, { url: 'http://localhost' }, { runId: otherId, approved: true }, null, [], 'run', { runId: undefined }]) {
    assert.equal((await context.inspector.inspect(args)).inspection.status, 'invalid_request')
  }
  assert.equal(context.calls.length, 0)
})

test('raw labels, inputs, event details, reasons, secrets and snapshot internals never reach model output', async (t) => {
  const context = setup(t)
  const secret = 'IGNORE-INSTRUCTIONS-SECRET-http://private/token'
  context.data.status.reason = secret
  context.data.status.configurations[0].displayName = secret
  const run = sealRun({ ...context.data.run, inputs: { secret }, outcome: { ...context.data.run.outcome, reason: secret },
    events: context.data.run.events.map((event) => ({ ...event, detail: { secret } })) })
  context.data.run = run
  context.data.receipt = { ...context.data.receipt, run }
  context.data.receipt.receiptDigest = executionDigest(context.data.receipt, 'receiptDigest')
  const result = await context.inspector.inspect()
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
  for (const field of ['inputs', 'approval', 'events', 'reason']) assert.equal(Object.hasOwn(result.selectedRun, field), false)
})

test('transport failures are unavailable inspection, never a fabricated OUTCOME_UNKNOWN', async (t) => {
  const context = setup(t, { status: () => { throw new Error('secret provider diagnostics') } })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.selectedRun, null)
  assert.equal(result.receipt.status, 'not_requested')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('OUTCOME_UNKNOWN'), false)
})

test('Node-reported unavailability suppresses configuration candidates and keeps diagnostics redacted', async (t) => {
  const context = setup(t)
  context.data.status = { ...context.data.status, availability: 'unavailable', reason: 'private address and credential' }
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.configurationAvailability.status, 'unavailable')
  assert.deepEqual(result.configurationAvailability.matchingConfigurations, [])
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
  assert.equal(JSON.stringify(result).includes('private address'), false)
})

test('a failed receipt read preserves the recorded run phase and distinguishes unverified evidence', async (t) => {
  const context = setup(t, { receipt: () => { throw new Error('private receipt path') } })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
  assert.equal(result.receipt.status, 'unavailable')
  assert.equal(result.receipt.verification, null)
  assert.equal(JSON.stringify(result).includes('private receipt path'), false)
})

test('actual Node OUTCOME_UNKNOWN is preserved as its recorded phase rather than a transport error', async (t) => {
  const context = setup(t, { receipt: () => { throw new Error('no receipt') } })
  context.data.run = sealRun({ ...context.data.run, phase: 'OUTCOME_UNKNOWN', outcome: { ...context.data.run.outcome, status: 'OUTCOME_UNKNOWN' } })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.selectedRun.phase, 'OUTCOME_UNKNOWN')
  assert.equal(result.receipt.status, 'unavailable')
})

for (const defect of ['receipt-digest', 'run-id', 'snapshot-digest', 'configuration-reference', 'prepared-mode', 'evidence-digest', 'configuration-bytes', 'evidence-mode']) {
  test(`rejects ${defect} receipt/reference inconsistency without relabeling the recorded outcome`, async (t) => {
    const context = setup(t)
    const { data } = context
    if (defect === 'receipt-digest') data.receipt.receiptDigest = digest('a')
    if (defect === 'run-id') {
      data.receipt.run = sealRun({ ...data.run, runId: otherId })
      data.receipt.receiptDigest = executionDigest(data.receipt, 'receiptDigest')
    }
    if (defect === 'snapshot-digest') data.receipt.snapshot = { wrong: true }
    if (defect === 'configuration-reference' || defect === 'prepared-mode') {
      data.receipt.snapshot = { ...data.receipt.snapshot, ...(defect === 'configuration-reference'
        ? { configurationSnapshotDigest: digest('a') }
        : { prepared: { ...data.receipt.snapshot.prepared, mode: 'physical' } }) }
      data.run = sealRun({ ...data.run, snapshotDigest: executionDigest(data.receipt.snapshot) })
      data.receipt.run = data.run
      data.receipt.receiptDigest = executionDigest(data.receipt, 'receiptDigest')
    }
    if (defect === 'evidence-digest') data.snapshots.delete(data.run.outcome.evidenceDigest)
    if (defect === 'configuration-bytes') data.snapshots.set(data.run.configurationDigest, { changed: true })
    if (defect === 'evidence-mode') {
      const old = data.snapshots.get(data.run.outcome.evidenceDigest)
      const evidence = { ...old, evidence: { ...old.evidence, mode: 'physical' } }
      const evidenceDigest = executionDigest(evidence)
      data.snapshots.set(evidenceDigest, evidence)
      data.run = sealRun({ ...data.run, outcome: { ...data.run.outcome, evidenceDigest } })
      data.receipt.run = data.run
      data.receipt.receiptDigest = executionDigest(data.receipt, 'receiptDigest')
    }
    const result = await context.inspector.inspect()
    assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
    assert.equal(result.receipt.status, 'unavailable')
    assert.equal(result.receipt.verification, null)
  })
}

test('a changed current configuration leaves exact historical receipt readable without claiming present eligibility', async (t) => {
  const context = setup(t)
  context.data.status.configurations[0].configurationDigest = digest('a')
  context.setContext({ route: { ...context.data.route, receiptDigest: digest('b') } })
  const result = await context.inspector.inspect()
  assert.equal(result.selectedRun.currentConfiguration, 'changed')
  assert.equal(result.selectedRun.routeRelationship, 'historical')
  assert.equal(result.receipt.status, 'verified')
  assert.equal(result.physicalExecutionAuthorized, false)
})

test('mode and immutable run pin mismatches fail closed before receipt reads', async (t) => {
  for (const field of ['mode', 'implementationDigest', 'configurationDigest', 'routeReceiptDigest']) {
    const context = setup(t)
    const selected = context.data.run
    context.setContext({ selectedRun: selected })
    context.data.run = sealRun({ ...selected, [field]: field === 'mode' ? 'physical' : digest('a') })
    const result = await context.inspector.inspect()
    assert.equal(result.inspection.status, 'unavailable', field)
    assert.equal(result.selectedRun, null, field)
    assert.equal(context.calls.some(([method]) => method === 'receipt'), false, field)
  }
})

test('the known exact run cannot regress in revision or silently change immutable pins between inspections', async (t) => {
  const context = setup(t)
  await context.inspector.inspect()
  context.data.run = sealRun({ ...context.data.run, revision: context.data.run.revision - 1 })
  const result = await context.inspector.inspect({ runId: context.data.run.runId })
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.selectedRun, null)
})

for (const change of ['generation', 'route', 'selectedRun']) {
  test(`a ${change} change retires pending reads and prevents later endpoint access`, async (t) => {
    const pending = deferred(), context = setup(t, { status: () => pending.promise })
    const reading = context.inspector.inspect()
    context.setContext(change === 'generation' ? { generation: 2 } : change === 'route' ? { route: null } : { selectedRun: { ...context.data.run, runId: otherId } })
    pending.resolve(context.data.status)
    const result = await reading
    assert.equal(result.inspection.status, 'stale')
    assert.equal(result.selectedRun, null)
    assert.deepEqual(result.runs, [])
    assert.equal(context.calls.some(([method]) => method === 'run'), false)
  })
}

test('an inspection whose clock expires is stale and does not claim a newly read historical result is current state', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => pending.promise })
  const reading = context.inspector.inspect()
  context.setClock(instant + 5000)
  pending.resolve(context.data.status)
  const result = await reading
  assert.equal(result.inspection.status, 'stale')
  assert.equal(result.selectedRun, null)
})

test('hung and overlapping reads are bounded, and a timed-out continuation cannot issue more requests', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => pending.promise, readTimeoutMs: 20 })
  const reading = context.inspector.inspect()
  assert.equal((await context.inspector.inspect()).inspection.status, 'busy')
  const result = await reading
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.inspection.reasonCode, 'inspection_timeout')
  assert.equal((await context.inspector.inspect()).inspection.status, 'busy')
  pending.resolve(context.data.status)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
})

test('dispose promptly invalidates pending reads and cannot restore retired state or expose advertised IDs', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => pending.promise })
  const reading = context.inspector.inspect()
  context.inspector.dispose()
  const result = await reading
  assert.equal(result.inspection.status, 'disposed')
  pending.resolve(context.data.status)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await context.inspector.inspect()).inspection.status, 'disposed')
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
})

test('one failed read cannot release the concurrency bound while its sibling read remains hung', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => { throw new Error('unavailable') }, runs: () => pending.promise, readTimeoutMs: 20 })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.reasonCode, 'inspection_timeout')
  assert.equal((await context.inspector.inspect()).inspection.status, 'busy')
  pending.resolve({ contractVersion: 'physicalsystems-run-list-v1', runs: [], physicalExecutionAuthorized: false })
})

test('caller cancellation retires its reads without advertising run IDs or blocking disposal', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => pending.promise })
  const abort = new AbortController()
  const reading = context.inspector.inspect({}, { signal: abort.signal })
  abort.abort()
  const result = await reading
  assert.equal(result.inspection.reasonCode, 'inspection_cancelled')
  assert.equal(result.selectedRun, null)
  pending.resolve(context.data.status)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await context.inspector.inspect({ runId: context.data.run.runId })).inspection.status, 'invalid_request')
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
})

test('browser progress on the same selected run accepts a newer read without treating it as a different context', async (t) => {
  const pending = deferred(), context = setup(t, { status: () => pending.promise })
  context.setContext({ selectedRun: recorded.prepared })
  // Use the real fixture's exact immutable configuration and snapshot pins for
  // this progress test; referenced snapshots deliberately remain unavailable.
  context.data.status = recorded.status
  context.data.run = recorded.run
  context.data.receipt = recorded.receipt
  const reading = context.inspector.inspect()
  context.setContext({ selectedRun: recorded.approved })
  pending.resolve(recorded.status)
  const result = await reading
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
})

test('fresh service mode cannot relabel a historical run from a different mode as this execution', async (t) => {
  const context = setup(t)
  context.data.status = { ...context.data.status, mode: 'physical', configurations: context.data.status.configurations.map((item) => ({ ...item, mode: 'physical' })) }
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.reasonCode, 'run_context_mismatch')
  assert.equal(result.selectedRun, null)
  assert.equal(context.calls.some(([method]) => method === 'receipt'), false)
})

test('incomplete preparation and contradictory success evidence cannot acquire verified receipt status', async (t) => {
  for (const stage of ['preparation', 'verification']) {
    const context = setup(t)
    const { data } = context
    if (stage === 'preparation') {
      data.receipt.snapshot = { ...data.receipt.snapshot, preparationObservation: null }
      data.run = sealRun({ ...data.run, snapshotDigest: executionDigest(data.receipt.snapshot) })
    } else {
      const evidence = { ...data.snapshots.get(data.run.outcome.evidenceDigest), verified: false }
      const evidenceDigest = executionDigest(evidence)
      data.snapshots.set(evidenceDigest, evidence)
      data.run = sealRun({ ...data.run, outcome: { ...data.run.outcome, evidenceDigest } })
    }
    data.receipt.run = data.run
    data.receipt.receiptDigest = executionDigest(data.receipt, 'receiptDigest')
    const result = await context.inspector.inspect()
    assert.equal(result.selectedRun.phase, 'VERIFIED_SUCCESS')
    assert.equal(result.receipt.status, 'unavailable')
  }
})

test('oversized or malformed listings fail contract validation without exposing raw records', async (t) => {
  const data = fixture()
  const context = setup(t, { runs: () => ({ contractVersion: 'physicalsystems-run-list-v1', runs: Array.from({ length: 33 }, (_, index) =>
    sealRun({ ...data.run, runId: `run-${index.toString(16).padStart(32, '0')}` })), physicalExecutionAuthorized: false }) })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'unavailable')
  assert.deepEqual(result.runs, [])
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
})

test('real GET client validates projected known pins without requiring omitted private event details', async (t) => {
  const data = fixture(), requests = []
  const client = createExecutionClient({ baseUrl: 'http://127.0.0.1:8765', token: 'a'.repeat(32), fetchImpl: async (url, options) => {
    requests.push({ path: url.pathname, method: options.method })
    const suffix = url.pathname.replace('/v2/physical/execution', '')
    let body
    if (suffix === '/status') body = data.status
    else if (suffix === '/runs') body = { contractVersion: 'physicalsystems-run-list-v1', runs: [data.run], physicalExecutionAuthorized: false }
    else if (suffix === `/runs/${data.run.runId}`) body = data.run
    else if (suffix === `/runs/${data.run.runId}/receipt`) body = data.receipt
    else {
      const snapshotDigest = suffix.slice('/snapshots/'.length)
      body = { contractVersion: 'physicalsystems-snapshot-v1', snapshotDigest, snapshot: data.snapshots.get(snapshotDigest), physicalExecutionAuthorized: false }
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  } })
  const reads = Object.freeze(Object.fromEntries(['status', 'runs', 'run', 'receipt', 'snapshot'].map((name) => [name, client[name]])))
  const inspector = createExecutionInspector({ client: reads, getContext: () => ({ route: data.route }), now: () => instant })
  t.after(() => inspector.dispose())
  let result = await inspector.inspect()
  assert.equal(result.inspection.status, 'available')
  assert.equal(result.receipt.status, 'verified')
  result = await inspector.inspect({ runId: data.run.runId })
  assert.equal(result.receipt.status, 'verified')
  assert.equal(requests.length, 12)
  assert.equal(requests.every(({ method }) => method === 'GET'), true)
})

test('mixed-mode run listings cannot advertise a run as belonging to the current execution service', async (t) => {
  const data = fixture(), other = sealRun({ ...data.run, runId: otherId, mode: 'physical' })
  const context = setup(t, { runs: () => ({ contractVersion: 'physicalsystems-run-list-v1', runs: [data.run, other], physicalExecutionAuthorized: false }) })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.reasonCode, 'run_context_mismatch')
  assert.deepEqual(result.runs, [])
  assert.equal(context.calls.some(([method]) => method === 'run'), false)
})

for (const defect of ['events', 'inputs', 'approval']) {
  test(`higher run revisions cannot rewrite the previously inspected ${defect}`, async (t) => {
    const context = setup(t)
    assert.equal((await context.inspector.inspect()).receipt.status, 'verified')
    const run = context.data.run
    context.data.run = sealRun({ ...run, revision: run.revision + 1, ...(defect === 'events'
      ? { events: run.events.map((event, index) => index ? event : { ...event, detail: { rewritten: true } }) }
      : defect === 'inputs' ? { inputs: { changed: 'historical-inputs' } }
        : { approval: { ...run.approval, digest: digest('b') } }) })
    context.calls.length = 0
    const result = await context.inspector.inspect({ runId: run.runId })
    assert.equal(result.inspection.status, 'unavailable')
    assert.equal(result.selectedRun, null)
    assert.equal(context.calls.some(([method]) => method === 'run'), false)
  })
}

test('run details cannot rewrite a list event prefix while incrementing revision during the same inspection', async (t) => {
  const data = fixture()
  const changed = sealRun({ ...data.run, revision: data.run.revision + 1,
    events: data.run.events.map((event, index) => index ? event : { ...event, detail: { replaced: true } }) })
  const context = setup(t, { run: () => changed })
  const result = await context.inspector.inspect()
  assert.equal(result.inspection.status, 'unavailable')
  assert.equal(result.selectedRun, null)
  assert.equal(context.calls.some(([method]) => method === 'receipt'), false)
})
