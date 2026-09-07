// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createOperatorService, agentToolDefinitions, createPublicClients } from '../src/index.js'
import { normalizeLocalEndpoint } from '../../desktop/src/connections.js'
import { createExperimentStore } from '../../operator-core/src/index.js'
import { makeRun, evolve, route, configuration, status, instant, makeReceipt, digest } from '../../cli/test/fixtures/execution.js'

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'operator-service-'))
  const calls = [], forbidden = async () => assert.fail('This fixture cannot access hardware, providers or credentials')
  const service = await createOperatorService({ dataDir, stepMs: 10,
    secretStore: { read: forbidden, write: forbidden, delete: forbidden },
    submitContinuation: async (request) => { calls.push(request); return { accepted: true, requestId: request.requestId } }, ...options })
  t.after(async () => {
    for (const owner of service.snapshot().activeExperiments) await service.command('experiment.stop', { projectId: owner.projectId, conversationId: owner.conversationId, experimentId: owner.experiment.id })
    for (const owner of service.snapshot().activeCaptures) if (owner.canStop) await service.command('workcell.camera.stop', { projectId: owner.projectId, conversationId: owner.conversationId, connectionGeneration: owner.connectionGeneration, expectedCaptureSessionId: owner.captureSessionId })
    await service.close(); await rm(dataDir, { recursive: true, force: true })
  })
  const create = async (name = 'Synthetic project') => (await service.command('project.create', { name, connection: { type: 'simulation' } })).activeProjectId
  const bind = async (projectId, sessionId = 'opencode-session-one', serverId = 'review-server-one') => service.command('session.bind', { projectId, serverId, sessionId })
  return { service, create, bind, calls, dataDir }
}
const propose = (service, bound, callId = 'proposal-one') => service.agentCall({ agentToken: bound.agentToken, name: 'propose_local_experiment', callId,
  arguments: { mode: 'simulation', goal: 'Compare synthetic offsets', trialLimit: 2 } })
const approve = (bound, current, requestId = 'continue-one') => ({ ...bound.binding, experimentId: current.id, expectedDigest: current.planDigest, requestId, approved: true })
const next = (bound, current, requestId = 'continue-two') => ({ ...bound.binding, experimentId: current.id, expectedDigest: current.planDigest, requestId })
const value = (result) => JSON.parse(result.content[0].text)

test('bound agent proposes, trusted operator approves once, then canonical synthetic tools measure and finish', async (t) => {
  const f = await fixture(t), bound = await f.bind(await f.create())
  const planned = value(await propose(f.service, bound)).current
  await assert.rejects(f.service.agentCall({ agentToken: bound.agentToken, name: 'run_simulated_trial', callId: 'trial-before-approval', arguments: { experimentId: planned.id, offsetMm: 0 } }), /approve this exact/i)
  const accepted = await f.service.command('experiment.approveAndContinue', approve(bound, planned))
  assert.equal(accepted.current.phase, 'READY'); assert.equal(accepted.continuation.accepted, true)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].binding.sessionId, bound.binding.sessionId)
  assert.match(f.calls[0].text, /approved synthetic simulation/)
  assert.equal(f.calls[0].text.includes(planned.planDigest), false)
  assert.equal((await f.service.command('experiment.approveAndContinue', approve(bound, planned))).continuation.duplicate, true)
  assert.equal(f.calls.length, 1)
  const trial = { agentToken: bound.agentToken, name: 'run_simulated_trial', callId: 'measured-trial-one', arguments: { experimentId: planned.id, offsetMm: 1 } }
  await f.service.agentCall(trial); await f.service.agentCall(trial)
  assert.equal(f.service.snapshot().experiments.current.trials.length, 1)
  await assert.rejects(f.service.agentCall({ ...trial, arguments: { ...trial.arguments, offsetMm: 2 } }), /different/i)
  await f.service.agentCall({ ...trial, callId: 'measured-trial-two', arguments: { experimentId: planned.id, offsetMm: 3 } })
  const finished = await f.service.agentCall({ agentToken: bound.agentToken, name: 'finish_local_experiment', callId: 'finish-one', arguments: { experimentId: planned.id } })
  assert.equal(value(finished).current.phase, 'COMPLETED'); assert.equal(value(finished).current.summary.bestAlignmentErrorMm, 0)
  assert.deepEqual(f.service.snapshot().activeExperiments, [])
  assert.equal(finished.details.physicalSystems.conversationId, bound.binding.conversationId)
})

test('agent capability cannot approve, spoof an owner, choose paths or manufacture request identity', async (t) => {
  const f = await fixture(t), bound = await f.bind(await f.create())
  const names = agentToolDefinitions.map((tool) => tool.name)
  assert.ok(names.includes('preview_physical_capability')); assert.equal(names.some((name) => /approve|camera|execute|stop/.test(name)), false)
  const proposalTool = agentToolDefinitions.find((tool) => tool.name === 'propose_local_experiment')
  assert.match(proposalTool.description, /approval card in this conversation/)
  assert.match(proposalTool.description, /Approve & continue/)
  for (const tool of agentToolDefinitions) {
    assert.equal(Object.hasOwn(tool.parameters.properties || {}, 'requestId'), false)
    assert.equal(tool.parameters.required?.includes('requestId') || false, false)
  }
  const base = { agentToken: bound.agentToken, name: 'inspect_local_experiment', arguments: {}, callId: 'inspect-one' }
  for (const bad of [{ name: 'experiment.approve' }, { agentToken: 'forged-token' }, { arguments: { projectId: bound.binding.projectId } }, { projectId: bound.binding.projectId }]) await assert.rejects(f.service.agentCall({ ...base, ...bad }), /not available|unsupported|missing/i)
  await assert.rejects(f.service.agentCall({ ...base, name: 'propose_local_experiment', arguments: { mode: 'simulation', goal: 'Fake', requestId: 'invented-id' } }), /unsupported/i)
  assert.equal(f.service.snapshot().experiments.current, null)
  assert.equal(JSON.stringify(f.service.snapshot()).includes(bound.agentToken), false)
  const otherProject = await f.create('Different project')
  await assert.rejects(f.bind(otherProject), /already belongs/i)
})

test('multiple tabs retain independent experiments and background exact-owner Stop', async (t) => {
  const f = await fixture(t), project = await f.create(), first = await f.bind(project)
  const one = value(await propose(f.service, first)).current
  await f.service.command('experiment.approve', { ...first.binding, experimentId: one.id, expectedDigest: one.planDigest, approved: true })
  const second = await f.bind(project, 'opencode-session-two')
  assert.equal(f.service.snapshot().experiments.current, null)
  const two = value(await propose(f.service, second)).current
  assert.notEqual(one.id, two.id)
  await assert.rejects(f.service.command('experiment.continue', next(first, one)), /selected conversation changed/i)
  await assert.rejects(f.service.command('experiment.stop', { ...second.binding, experimentId: one.id }), /experiment has changed/i)
  await f.service.command('experiment.stop', { ...first.binding, experimentId: one.id })
  assert.equal(f.service.snapshot().activeConversationId, second.binding.conversationId)
  assert.equal(f.service.snapshot().experiments.current.id, two.id)
  await f.service.command('session.select', { projectId: project, conversationId: first.binding.conversationId })
  assert.equal(f.service.snapshot().experiments.current.phase, 'STOPPED')
  await f.service.command('session.select', { projectId: project, conversationId: second.binding.conversationId })
  assert.equal(f.service.snapshot().experiments.current.phase, 'PROPOSED')
})

test('background session binding grants only its exact capability without changing the selected conversation', async (t) => {
  const f = await fixture(t), project = await f.create(), first = await f.bind(project)
  const one = value(await propose(f.service, first)).current
  const background = await f.service.command('session.bind', { projectId: project, serverId: 'review-server-one', sessionId: 'background-session', activate: false })
  assert.equal(f.service.snapshot().activeConversationId, first.binding.conversationId)
  assert.equal(f.service.snapshot().experiments.current.id, one.id)
  const two = value(await propose(f.service, background)).current
  assert.notEqual(one.id, two.id)
  assert.equal(f.service.snapshot().activeConversationId, first.binding.conversationId)
  await f.service.command('session.bind', { projectId: project, serverId: 'review-server-one', sessionId: 'background-session', activate: false })
  assert.equal(f.service.snapshot().activeConversationId, first.binding.conversationId)
  for (const activate of ['false', 0, null, {}]) await assert.rejects(f.service.command('session.bind', { projectId: project, serverId: 'review-server-one', sessionId: 'invalid-activation', activate }), /activation|boolean/i)
  assert.equal(f.service.snapshot().projects[0].conversations.length, 2)
  await assert.rejects(f.service.command('experiment.approve', { ...background.binding, experimentId: two.id, expectedDigest: two.planDigest, approved: true }), /selected conversation changed/i)
  await assert.rejects(f.service.command('experiment.approveAndContinue', approve(background, two)), /selected conversation changed/i)
  await f.service.command('session.bind', { projectId: project, serverId: 'review-server-one', sessionId: 'background-session', activate: true })
  assert.equal(f.service.snapshot().activeConversationId, background.binding.conversationId)
  assert.equal(f.service.snapshot().experiments.current.id, two.id)
})

test('trusted agent cancellation blocks a queued proposal and stops only its exact in-flight synthetic trial', async (t) => {
  const f = await fixture(t, { stepMs: 500 }), first = await f.bind(await f.create())
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.service.agentCall({ agentToken: first.agentToken, name: 'propose_local_experiment', callId: 'cancelled-proposal',
    arguments: { mode: 'simulation', goal: 'Must not be proposed', trialLimit: 2 }, signal: cancelled.signal }), /cancelled/i)
  assert.equal(f.service.snapshot().experiments.current, null)
  await assert.rejects(f.service.agentCall({ agentToken: first.agentToken, name: 'inspect_local_experiment', callId: 'invalid-signal', arguments: {}, signal: {} }), /signal/i)
  const one = value(await propose(f.service, first)).current
  await f.service.command('experiment.approve', { ...first.binding, experimentId: one.id, expectedDigest: one.planDigest, approved: true })
  const other = await f.bind(first.binding.projectId, 'other-cancellation-session'), two = value(await propose(f.service, other)).current
  await f.service.command('experiment.approve', { ...other.binding, experimentId: two.id, expectedDigest: two.planDigest, approved: true })
  const controller = new AbortController()
  const running = f.service.agentCall({ agentToken: first.agentToken, name: 'run_simulated_trial', callId: 'cancelled-trial',
    arguments: { experimentId: one.id, offsetMm: 0 }, signal: controller.signal })
  while (!f.service.snapshot().activeExperiments.some((owner) => owner.experiment.id === one.id && owner.experiment.phase === 'RUNNING')) await delay(1)
  controller.abort()
  await assert.rejects(running, /cancelled|stopped/i)
  assert.equal(f.service.snapshot().experiments.current.id, two.id)
  assert.equal(f.service.snapshot().experiments.current.phase, 'READY')
  await f.service.command('session.select', { projectId: first.binding.projectId, conversationId: first.binding.conversationId })
  assert.equal(f.service.snapshot().experiments.current.phase, 'STOPPED')
})

test('scope, expiry, exact digest, explicit consent and remaining budget gate continuation', async (t) => {
  let time = Date.now()
  const f = await fixture(t, { now: () => time }), bound = await f.bind(await f.create()), planned = value(await propose(f.service, bound)).current
  await assert.rejects(f.service.command('experiment.continue', next(bound, planned)), /approve this exact/i)
  for (const invalid of [{ approved: false }, { expectedDigest: 'wrong-plan' }, { connectionGeneration: 123 }, { requestId: 'bad id' }, { executor: 'physical' }]) await assert.rejects(f.service.command('experiment.approveAndContinue', { ...approve(bound, planned), ...invalid }), /approve|reviewed|connection changed|request ID|unsupported/i)
  time = planned.expiresAt
  await assert.rejects(f.service.command('experiment.approveAndContinue', approve(bound, planned)), /expired/i)
  assert.equal(f.calls.length, 0); assert.equal(f.service.snapshot().experiments.current.phase, 'PROPOSED')
})

test('model busy and unaccepted submission preserve recoverable exact approval without replay', async (t) => {
  let unavailable = true, submissions = 0
  const f = await fixture(t, { submitContinuation: async ({ requestId }) => { submissions += 1; return unavailable ? { accepted: false, requestId, error: 'Select a fixture model' } : { accepted: true, requestId } } })
  const bound = await f.bind(await f.create()), planned = value(await propose(f.service, bound)).current
  await f.service.command('session.agentState', { ...bound.binding, busy: true })
  await assert.rejects(f.service.command('experiment.approveAndContinue', approve(bound, planned)), /assistant request/i)
  assert.equal(f.service.snapshot().experiments.current.phase, 'PROPOSED')
  await f.service.command('session.agentState', { ...bound.binding, busy: false })
  const rejected = await f.service.command('experiment.approveAndContinue', approve(bound, planned))
  assert.equal(rejected.current.phase, 'READY'); assert.equal(rejected.continuation.accepted, false)
  unavailable = false
  const recovered = await f.service.command('experiment.continue', next(bound, planned, 'continue-one'))
  assert.equal(recovered.continuation.accepted, true)
  assert.equal((await f.service.command('experiment.continue', next(bound, planned, 'continue-one'))).continuation.duplicate, true)
  assert.equal(submissions, 2)
})

test('lost continuation acknowledgement survives browser reload and only the original request can be inspected', async (t) => {
  const attempts = []
  const f = await fixture(t, { submitContinuation: async (request) => {
    attempts.push({ retry: request.retry, requestId: request.requestId })
    return request.retry ? { accepted: true, duplicate: true, requestId: request.requestId }
      : { accepted: false, requestId: request.requestId, error: 'The first submission acknowledgement was lost' }
  } })
  const bound = await f.bind(await f.create()), planned = value(await propose(f.service, bound)).current
  const statuses = [], unsubscribe = f.service.subscribe((snapshot) => { if (snapshot.experiments?.continuation) statuses.push(snapshot.experiments.continuation.status) })
  t.after(unsubscribe)
  const first = await f.service.command('experiment.approveAndContinue', approve(bound, planned, 'lost-acknowledgement'))
  assert.equal(first.continuation.accepted, false)
  assert.deepEqual(statuses.slice(-2), ['PENDING', 'UNCONFIRMED'])
  const retained = f.service.snapshot().experiments.continuation
  assert.equal(retained.requestId, 'lost-acknowledgement')
  assert.equal(retained.status, 'UNCONFIRMED')
  assert.equal(retained.experimentId, planned.id)
  assert.equal(retained.planDigest, planned.planDigest)
  assert.match(retained.checkpoint, /^[0-9a-f]{64}$/)
  const folder = path.join(f.dataDir, 'operator-state'), file = (await readdir(folder)).find((name) => name.endsWith('.json'))
  const durable = JSON.parse(await readFile(path.join(folder, file), 'utf8')).continuations[0]
  assert.equal(durable.checkpoint, retained.checkpoint)
  // A renderer reload loses its local request map. A freshly generated UUID
  // must not become another model prompt while this exact outcome is unknown.
  await assert.rejects(f.service.command('experiment.continue', next(bound, planned, 'new-id-after-browser-reload')), /unconfirmed|retained request/i)
  assert.equal(attempts.length, 1)
  const checked = await f.service.command('experiment.continue', next(bound, planned, retained.requestId))
  assert.equal(checked.continuation.accepted, true)
  assert.equal(checked.continuation.duplicate, true)
  assert.deepEqual(attempts, [{ retry: false, requestId: retained.requestId }, { retry: true, requestId: retained.requestId }])
  assert.equal(f.service.snapshot().experiments.continuation.status, 'ACCEPTED')
  // Once the previous prompt is confirmed and its agent is idle, an explicit
  // new Continue is a separate request, still bounded by the exact trial budget.
  await f.service.command('experiment.continue', next(bound, planned, 'explicit-later-continuation'))
  assert.deepEqual(attempts[2], { retry: false, requestId: 'explicit-later-continuation' })
})

test('pending continuation has independent Stop, aborts its signal and never resumes stopped trials', async (t) => {
  let pending, signal
  const f = await fixture(t, { submitContinuation: (request) => { signal = request.signal; return new Promise((resolve) => { pending = () => resolve({ accepted: false, requestId: request.requestId, error: 'Stopped before submission' }) }) } })
  const bound = await f.bind(await f.create()), planned = value(await propose(f.service, bound)).current
  const approval = f.service.command('experiment.approveAndContinue', approve(bound, planned))
  while (!pending) await delay(1)
  await assert.rejects(f.service.command('experiment.continue', next(bound, planned)), /in progress/i)
  await f.service.command('experiment.stop', { ...bound.binding, experimentId: planned.id })
  assert.equal(signal.aborted, true); assert.equal(f.service.snapshot().experiments.current.phase, 'STOPPED')
  pending(); assert.equal((await approval).continuation.accepted, false)
  await assert.rejects(f.service.command('experiment.continue', next(bound, planned)), /approve this exact/i)
})

test('approval persistence failure blocks the model and retains unknown evidence for Stop', async (t) => {
  const f = await fixture(t), bound = await f.bind(await f.create()), planned = value(await propose(f.service, bound)).current
  const directory = path.join(f.dataDir, 'experiments'), file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith('.json'))), saved = await readFile(file)
  await rm(file); await mkdir(file)
  try {
    await assert.rejects(f.service.command('experiment.approveAndContinue', approve(bound, planned)), /evidence could not be saved/i)
    assert.equal(f.service.snapshot().experiments.current.phase, 'OUTCOME_UNKNOWN'); assert.equal(f.calls.length, 0)
  } finally { await rm(file, { recursive: true }); await writeFile(file, saved) }
  await f.service.command('experiment.stop', { ...bound.binding, experimentId: planned.id })
  assert.equal(f.service.snapshot().experiments.current.phase, 'STOPPED')
})

test('real public client constructors stay inert and real connection is disabled by default', async (t) => {
  let fetches = 0
  const clients = createPublicClients({ endpoint: 'http://127.0.0.1:1', fetchImpl: async () => { fetches += 1; assert.fail('No network') } })
  assert.equal(typeof clients.execution.approve, 'function'); assert.equal(typeof clients.camera.stop, 'function'); assert.equal(fetches, 0)
  const f = await fixture(t)
  const project = await f.service.command('project.create', { name: 'Offline real profile', connection: { type: 'local', nodeUrl: 'http://127.0.0.1:1' } })
  assert.equal(project.projects[0].connection.status, 'offline')
  await assert.rejects(f.service.command('connection.connect', { projectId: project.activeProjectId }), /disabled/i)
  assert.equal(fetches, 0)
})

function fakeDevices() {
  const calls = { inspect: 0, attached: 0, closed: 0, starts: 0, stops: [], failClose: false, nodeId: 'fixture-node-one', waitStart: null, enteredStart: false }
  let camera = { phase: 'idle', captureSessionId: null, availableCameras: [] }
  const clientFactory = ({ endpoint }) => ({
    node: { origin: endpoint, async inspect() { calls.inspect += 1; return { nodeName: calls.nodeId, discovery: { observedAt: new Date().toISOString(), devices: [] } } },
      async capabilities() { return { physicalExecutionAuthorized: false, capabilities: [], workcells: [] } } },
    camera: { async status() { return camera }, async frame() { return { status: camera, frame: null } },
      async start() { calls.starts += 1; calls.enteredStart = true; await calls.waitStart; camera = { phase: 'live', captureSessionId: 'capture-fixture-one', availableCameras: [] }; return camera },
      async stop({ expectedCaptureSessionId }) { calls.stops.push(expectedCaptureSessionId); camera = { phase: 'stopped', captureSessionId: expectedCaptureSessionId, availableCameras: [] }; return camera } },
    execution: { async status() { return { availability: 'available', configurations: [], reason: null } }, async runs() { return { runs: [] } } },
    setup: { async requirements() { return { status: 'unsupported', report: null } } },
  })
  const attach = async (profile, options) => { calls.attached += 1; return { endpoint: profile.nodeUrl, identity: await options.probeNode({ endpoint: profile.nodeUrl }),
    async close() { calls.closed += 1; if (calls.failClose) throw new Error('Unconfirmed fixture cleanup') }, onDisconnect: () => () => {} } }
  return { calls, clientFactory, connections: { normalizeLocalEndpoint, attachLocal: attach, attachSSH: attach },
    secretStore: { async read() { return JSON.stringify({ cameraToken: 'fixture-camera-token', executionToken: 'fixture-execution-token' }) }, async write() {}, async delete() {} } }
}
async function local(f, address = 'http://127.0.0.1:19991', session = 'physical-session-one') {
  const p = await f.service.command('project.create', { name: 'Fake connected bench', connection: { type: 'local', nodeUrl: address } })
  const bound = await f.bind(p.activeProjectId, session)
  await f.service.command('connection.connect', { projectId: p.activeProjectId })
  bound.binding.connectionGeneration = f.service.snapshot().connectionGeneration
  return bound
}

test('fake connected Node remains exclusively owned across project aliases and tab navigation', async (t) => {
  const devices = fakeDevices(), f = await fixture(t, { ...devices, allowDeviceConnections: true }), first = await local(f)
  assert.equal(f.service.snapshot().projects[0].connection.deviceCount, 0)
  await f.service.command('workcell.refresh', first.binding)
  await f.service.command('workcell.camera.start', { ...first.binding, candidateId: 'fixture-camera', expectedCandidateDigest: 'fixture-digest' })
  assert.equal(f.service.snapshot().activeCaptures[0].conversationId, first.binding.conversationId)
  const second = await f.bind(first.binding.projectId, 'physical-session-two')
  second.binding.connectionGeneration = first.binding.connectionGeneration
  await assert.rejects(f.service.command('workcell.camera.start', { ...first.binding, candidateId: 'fixture-camera', expectedCandidateDigest: 'fixture-digest' }), /selected conversation changed/i)
  await assert.rejects(f.service.command('workcell.refresh', second.binding), /another conversation owns/i)
  await assert.rejects(f.service.command('connection.disconnect', { projectId: first.binding.projectId }), /owned operation/i)
  await f.service.command('workcell.camera.stop', { ...first.binding, expectedCaptureSessionId: 'capture-fixture-one' })
  assert.equal(f.service.snapshot().activeConversationId, second.binding.conversationId)
  assert.deepEqual(devices.calls.stops, ['capture-fixture-one']); assert.equal(f.service.snapshot().activeCaptures.length, 0)
  await f.service.command('workcell.refresh', second.binding)
  const alias = await f.service.command('project.create', { name: 'Alias', connection: { type: 'local', nodeUrl: 'http://localhost:19991' } })
  const before = devices.calls.attached
  await assert.rejects(f.service.command('connection.connect', { projectId: alias.activeProjectId }), /already belongs/i)
  assert.equal(devices.calls.attached, before)
  const aliasIdentity = await f.service.command('project.create', { name: 'Node identity alias', connection: { type: 'local', nodeUrl: 'http://127.0.0.1:19992' } })
  await assert.rejects(f.service.command('connection.connect', { projectId: aliasIdentity.activeProjectId }), /owned by another/i)
})

test('fake delayed camera Start retains independent exact cleanup while another tab is visible', async (t) => {
  const devices = fakeDevices(); let finishStart
  devices.calls.waitStart = new Promise((resolve) => { finishStart = resolve })
  const f = await fixture(t, { ...devices, allowDeviceConnections: true }), first = await local(f)
  const start = f.service.command('workcell.camera.start', { ...first.binding, candidateId: 'fixture-camera', expectedCandidateDigest: 'fixture-digest' })
  while (!devices.calls.enteredStart) await delay(1)
  await f.bind(first.binding.projectId, 'other-visible-tab')
  await f.service.command('workcell.camera.stop', { ...first.binding, expectedCaptureSessionId: null })
  assert.equal(f.service.snapshot().activeCaptures[0].conversationId, first.binding.conversationId)
  finishStart(); await start
  assert.deepEqual(devices.calls.stops, ['capture-fixture-one']); assert.equal(f.service.snapshot().activeCaptures.length, 0)
})

test('a process restart restores binding and evidence without reviving approval or old agent capability', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'operator-service-restart-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const script = `
    import { createOperatorService } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    const service = await createOperatorService({dataDir:${JSON.stringify(dataDir)},submitContinuation:async({requestId})=>({accepted:true,requestId})});
    const state = await service.command('project.create',{name:'Persisted synthetic lab',connection:{type:'simulation'}});
    const bound = await service.command('session.bind',{projectId:state.activeProjectId,serverId:'persisted-server',sessionId:'persisted-session'});
    await service.agentCall({agentToken:bound.agentToken,name:'propose_local_experiment',arguments:{mode:'simulation',goal:'Persist only scalar evidence',trialLimit:2},callId:'persistent-proposal'});
    const planned=service.snapshot().experiments.current;
    await service.command('experiment.approveAndContinue',{...bound.binding,experimentId:planned.id,expectedDigest:planned.planDigest,approved:true,requestId:'persistent-continuation'});
    process.stdout.write(JSON.stringify({bound,planned}));process.exit(0);
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 10000 })
  const previous = JSON.parse(stdout); let resumed = 0
  const service = await createOperatorService({ dataDir, submitContinuation: async () => { resumed += 1; assert.fail('Restart cannot submit continuation') } })
  t.after(() => service.close())
  assert.equal(service.snapshot().experiments.current.id, previous.planned.id)
  assert.equal(service.snapshot().experiments.current.phase, 'INTERRUPTED'); assert.equal(resumed, 0)
  await assert.rejects(service.agentCall({ agentToken: previous.bound.agentToken, name: 'inspect_local_experiment', arguments: {}, callId: 'old-token-inspect' }), /not available/i)
  const rebound = await service.command('session.bind', { projectId: previous.bound.binding.projectId, serverId: 'persisted-server', sessionId: 'persisted-session' })
  assert.equal(rebound.binding.conversationId, previous.bound.binding.conversationId)
  await assert.rejects(service.command('experiment.continue', next(rebound, previous.planned, 'persistent-continuation')), /stopped or interrupted/i)
  assert.equal(resumed, 0)
})

test('reviewed skill reader uses pinned public packages without a Pi parser or filesystem tool', async (t) => {
  const f = await fixture(t), bound = await f.bind(await f.create())
  const result = value(await f.service.agentCall({ agentToken: bound.agentToken, name: 'read_agent_skill', arguments: { skillId: 'inspect-workcell' }, callId: 'read-reviewed-skill' }))
  assert.equal(result.source, 'bundled-reviewed-package'); assert.deepEqual(result.permissionsGranted, []); assert.equal(result.physicalExecutionAuthorized, false)
  await assert.rejects(f.service.agentCall({ agentToken: bound.agentToken, name: 'read_agent_skill', arguments: { skillId: '/etc/passwd' }, callId: 'invalid-skill-read' }))
})

test('real connection adapter explains missing Node authorization before any network access', async (t) => {
  const f = await fixture(t, { allowDeviceConnections: true, clientFactory() { assert.fail('Missing authorization must precede all probes') } })
  const state = await f.service.command('project.create', { name: 'Unconfigured local Node', connection: { type: 'local', nodeUrl: 'http://127.0.0.1:1' } })
  await assert.rejects(f.service.command('connection.connect', { projectId: state.activeProjectId }), /Node credential reference|Node authorization/i)
  assert.equal(f.service.snapshot().projects[0].connection.status, 'offline')
})

test('recovered camera Stop requires the exact retained capture acknowledgement and blocks replacement until confirmed', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'operator-recovered-camera-'))
  const store = createExperimentStore({ storageDir: path.join(dataDir, 'operator-state'), sessionId: 'operator-service-v1' })
  const projectId = 'project-recovered-camera', conversationId = 'conversation-recovered-camera', captureSessionId = 'capture-recovered-camera'
  store.write({ schemaVersion: 1, revision: 1,
    projects: [{ id: projectId, name: 'Recovered fake camera', cwd: dataDir, generation: 1,
      connection: { type: 'local', label: 'Fake Node', nodeUrl: 'http://127.0.0.1:19993', expectedNodeId: 'fixture-node-one' } }],
    bindings: [{ id: conversationId, projectId, serverId: 'recovered-server', sessionId: 'recovered-session', title: 'Retained operation' }],
    selection: { projectId, conversationId }, continuations: [],
    ownership: [{ projectId, conversationId, nodeId: 'fixture-node-one', connectionGeneration: 1, kind: 'camera', captureSessionId, status: 'OUTCOME_UNKNOWN', recovered: false }] })
  store.release()
  const devices = fakeDevices(), original = devices.clientFactory
  let wrongAcknowledgement = true
  devices.clientFactory = (options) => {
    const clients = original(options)
    clients.camera.stop = async (request) => { devices.calls.stops.push(request.expectedCaptureSessionId); return { phase: 'stopped', captureSessionId: wrongAcknowledgement ? 'unrelated-capture' : captureSessionId } }
    return clients
  }
  const f = await fixture(t, { ...devices, dataDir, allowDeviceConnections: true })
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const bound = await f.service.command('session.bind', { projectId, serverId: 'recovered-server', sessionId: 'recovered-session' })
  await f.service.command('connection.connect', { projectId })
  bound.binding.connectionGeneration = f.service.snapshot().connectionGeneration
  await assert.rejects(f.service.command('workcell.refresh', bound.binding), /unresolved physical ownership/i)
  await assert.rejects(f.service.command('workcell.camera.stop', { ...bound.binding, expectedCaptureSessionId: captureSessionId }), /unconfirmed|could not be confirmed/i)
  assert.equal(f.service.snapshot().activeCaptures.length, 1)
  await assert.rejects(f.service.command('connection.disconnect', { projectId }), /owned operation/i)
  wrongAcknowledgement = false
  await f.service.command('workcell.camera.stop', { ...bound.binding, expectedCaptureSessionId: captureSessionId })
  assert.deepEqual(devices.calls.stops, [captureSessionId, captureSessionId])
  assert.equal(f.service.snapshot().activeCaptures.length, 0)
  assert.equal(devices.calls.starts, 0)
})

test('fake Node route flows through operator preparation, exact approval, independent Stop and historical receipt', async (t) => {
  const fixtureRoute = JSON.parse(await readFile(new URL('../../cli/test/fixtures/physical-route-v1.json', import.meta.url), 'utf8'))
  const devices = fakeDevices(), original = devices.clientFactory, mutations = []
  let run = null
  devices.clientFactory = (options) => {
    const clients = original(options)
    clients.node.capabilities = async () => fixtureRoute.catalog
    clients.node.previewCapability = async () => ({ ...route, decision: { ...route.decision, physical_execution_authorized: false } })
    clients.execution = {
      async status() { return status }, async runs() { return { runs: run ? [run] : [] } }, async run() { return run },
      async prepare(body) { mutations.push(['prepare', body]); run = makeRun(); return run },
      async approve(id, body) { mutations.push(['approve', id, body]); run = evolve(run, 'RUNNING'); return run },
      async stop(id, body) { mutations.push(['stop', id, body]); run = evolve(run, 'CANCELLED', { stopStatus: 'STOP_CONFIRMED' }); return run },
      async receipt() { return makeReceipt(run) },
      async snapshot(snapshotDigest) { return { snapshotDigest, snapshot: { evidence: { mode: 'simulation' }, verified: false, stopped: true, preconditionsMet: null } } },
    }
    return clients
  }
  const f = await fixture(t, { ...devices, allowDeviceConnections: true, now: () => instant }), bound = await local(f)
  const call = (name, args = {}) => f.service.agentCall({ agentToken: bound.agentToken, name, arguments: args, callId: name })
  await call('inspect_physical_system'); await call('inspect_physical_capabilities')
  const { contractVersion, ...routeRequest } = fixtureRoute.request
  await call('preview_physical_capability', routeRequest)
  await f.service.command('workcell.execution.refresh', bound.binding)
  assert.equal(f.service.snapshot().workcell.execution.canPrepare, true)
  assert.deepEqual(mutations, [])
  await f.service.command('workcell.execution.prepare', { ...bound.binding, configurationId: configuration.configurationId,
    expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest })
  assert.equal(f.service.snapshot().workcell.execution.run.phase, 'WAITING_FOR_APPROVAL')
  assert.deepEqual(f.service.snapshot().recoveryOperations, [])
  const approval = { ...bound.binding, runId: run.runId, expectedRunDigest: run.runDigest, approvalDigest: run.approval.digest, approved: true }
  await f.bind(bound.binding.projectId, 'stale-approval-tab')
  await assert.rejects(f.service.command('workcell.execution.approve', approval), /selected conversation changed/i)
  await f.service.command('session.select', { projectId: bound.binding.projectId, conversationId: bound.binding.conversationId })
  await assert.rejects(f.service.command('workcell.execution.approve', { ...approval, expectedRunDigest: digest('b') }))
  assert.equal(mutations.filter(([operation]) => operation === 'approve').length, 0)
  await f.service.command('workcell.execution.approve', approval)
  assert.equal(f.service.snapshot().workcell.execution.run.phase, 'RUNNING')
  const other = await f.bind(bound.binding.projectId, 'background-execution-observer')
  await f.service.command('session.agentState', { ...bound.binding, busy: true })
  await f.service.command('workcell.execution.stop', { ...bound.binding, runId: run.runId, reason: 'operator-requested-stop' })
  assert.equal(f.service.snapshot().activeConversationId, other.binding.conversationId)
  assert.equal(f.service.snapshot().activeRuns.length, 0)
  await f.service.command('session.agentState', { ...bound.binding, busy: false })
  await f.service.command('session.select', { projectId: bound.binding.projectId, conversationId: bound.binding.conversationId })
  await f.service.command('workcell.execution.receipt', { ...bound.binding, runId: run.runId })
  assert.equal(f.service.snapshot().workcell.execution.receipt.runId, run.runId)
  assert.equal(f.service.snapshot().workcell.execution.receipt.runDigest, run.runDigest)
  assert.equal(f.service.snapshot().workcell.execution.run.phase, 'CANCELLED')
  assert.equal(f.service.snapshot().workcell.execution.physicalExecutionAuthorized, false)
  assert.deepEqual(mutations.map(([operation]) => operation), ['prepare', 'approve', 'stop'])
})

test('a lost camera Start acknowledgement stays visibly owned and blocks another tab from replacing it', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'operator-unknown-camera-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const script = `
    import { createOperatorService } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    import { normalizeLocalEndpoint } from ${JSON.stringify(new URL('../../desktop/src/connections.js', import.meta.url).href)};
    const devices = (${fakeDevices.toString()})();
    const original = devices.clientFactory;
    devices.clientFactory = (options) => {const clients = original(options); clients.camera.start = async () => {devices.calls.starts += 1; throw new Error('Simulated lost Start acknowledgement')}; return clients};
    const service = await createOperatorService({...devices,dataDir:${JSON.stringify(dataDir)},allowDeviceConnections:true});
    const state = await service.command('project.create',{name:'Lost fake acknowledgement',connection:{type:'local',nodeUrl:'http://127.0.0.1:19994'}});
    const bound = await service.command('session.bind',{projectId:state.activeProjectId,serverId:'fixture-server',sessionId:'fixture-owner'});
    await service.command('connection.connect',{projectId:state.activeProjectId});bound.binding.connectionGeneration=service.snapshot().connectionGeneration;
    let startError, replacementError, closeError;
    try {await service.command('workcell.camera.start',{...bound.binding,candidateId:'fixture-camera',expectedCandidateDigest:'fixture-digest'})}catch(error){startError=error.message}
    const other = await service.command('session.bind',{projectId:state.activeProjectId,serverId:'fixture-server',sessionId:'fixture-other'});
    try {await service.command('workcell.camera.start',{...other.binding,candidateId:'fixture-camera',expectedCandidateDigest:'fixture-digest'})}catch(error){replacementError=error.message}
    try {await service.close()}catch(error){closeError=error.message}
    process.stdout.write(JSON.stringify({startError,replacementError,closeError,starts:devices.calls.starts,snapshot:service.snapshot()}));process.exit(0);
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 10000 })
  const result = JSON.parse(stdout)
  assert.match(result.startError, /not confirmed|unconfirmed/i)
  assert.equal(result.starts, 1)
  assert.match(result.replacementError, /unresolved|recovery/i)
  assert.match(result.closeError, /retained operations/i)
  assert.equal(result.snapshot.activeCaptures.length, 1)
  assert.equal(result.snapshot.activeCaptures[0].captureSessionId, null)
  assert.equal(result.snapshot.activeCaptures[0].canStop, false)
  assert.match(result.snapshot.activeCaptures[0].error, /identity|acknowledgement/i)
})

test('asynchronous shutdown blocks new work and failed transport cleanup preserves a recoverable conversation', async (t) => {
  const devices = fakeDevices(), attach = devices.connections.attachLocal
  let release, entered = false
  devices.connections.attachLocal = async (...args) => {
    const connection = await attach(...args)
    connection.close = async () => {
      entered = true
      await new Promise((resolve) => { release = resolve })
      if (devices.calls.failClose) throw new Error('Fake transport cleanup remains uncertain')
    }
    return connection
  }
  const f = await fixture(t, { ...devices, allowDeviceConnections: true }), bound = await local(f)
  const close = f.service.close()
  while (!entered) await delay(1)
  await assert.rejects(propose(f.service, bound), /closing/i)
  await assert.rejects(f.service.command('session.bind', { projectId: bound.binding.projectId, serverId: 'review-server-one', sessionId: 'too-late-session' }), /closing/i)
  devices.calls.failClose = true; release()
  await assert.rejects(close, /cleanup.*unconfirmed|cleanup.*confirmed/i)
  const current = value(await propose(f.service, bound)).current
  assert.equal(current.phase, 'PROPOSED')
  assert.equal(f.service.snapshot().projects[0].connection.status, 'offline')
  devices.calls.failClose = false; entered = false
  const retry = f.service.close()
  while (!entered) await delay(1)
  release(); await retry
})
