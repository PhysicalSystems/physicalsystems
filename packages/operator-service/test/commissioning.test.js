// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createOperatorService, createPublicClients, agentToolNames } from '../src/index.js'
import { normalizeLocalEndpoint } from '../../desktop/src/connections.js'
import { createCommissioningClient, normalizeGripperCheck, GRIPPER_JOINTS } from '../../cli/src/physical/commissioning-client.js'
import { createCommissioningController } from '../../cli/src/harness/commissioning-controller.js'
import { createExperimentStore } from '../../operator-core/src/index.js'

const token = 'fixture-execution-credential-0000000000000000'
const digest = (n) => `sha256:${String(n).repeat(64)}`
const initial = (now) => ({ contractVersion: 'physicalsystems-gripper-check-v1', nodeSessionId: 'node-session-one',
  configuration: { id: 'fixture-gripper', digest: digest(1), displayName: 'Fixture gripper', deviceIdentity: 'usb-fixture-device', calibrationDigest: digest(2),
    minimum: 0, maximum: 100, maximumDelta: 5, maximumDurationSeconds: 10, maximumStep: 1, stepIntervalSeconds: 0.2, tolerance: 0.1 },
  inspection: null, trial: null, canInspect: true, canPrepare: false, canApprove: false, canStop: false, blockedReason: null })
const inspect = (now) => ({ id: 'inspection-one', digest: digest(3), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(), ready: true,
  positions: Object.fromEntries(GRIPPER_JOINTS.map((key) => [key, key === 'gripper' ? 50 : 0])), torqueEnabled: Object.fromEntries(GRIPPER_JOINTS.map((key) => [key, false])),
  checks: [{ code: 'fixture-observed', state: 'met', message: 'Synthetic evidence only' }], gripperPosition: 50 })
const trial = (now, target = 52) => ({ trialId: 'trial-one', digest: digest(4), phase: 'WAITING_FOR_APPROVAL', approvalExpiresAt: new Date(now + 30000).toISOString(),
  startPosition: 50, targetPosition: target, maximumDurationSeconds: 10, latestPosition: 50, stopStatus: null, message: null })

async function fixture(t) {
  let clock = Date.now(), node = initial(clock), failStatus = null, failStop = false, approvalWait = null, dropApproval = false, disconnected
  const calls = [], credentials = new Map(), dataDir = await mkdtemp(path.join(tmpdir(), 'operator-gripper-'))
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : undefined, action = req.url.split('/').pop()
    calls.push({ action, body, authorization: req.headers.authorization })
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{}'); return }
    if (failStatus) { res.statusCode = failStatus; res.end('{"secret":"must-not-reflect-provider-body"}'); return }
    if (body && body.expectedNodeSessionId !== node.nodeSessionId) { res.statusCode = 409; res.end('{}'); return }
    if (action === 'inspect') node = { ...node, inspection: inspect(clock), canPrepare: true }
    if (action === 'prepare') node = { ...node, trial: trial(clock, body.targetPosition), canInspect: false, canPrepare: false, canApprove: true, canStop: true }
    if (action === 'approve') {
      node = { ...node, trial: { ...node.trial, phase: 'RUNNING' }, canApprove: false }
      const response = structuredClone(node)
      await approvalWait
      if (dropApproval) { req.socket.destroy(); return }
      res.end(JSON.stringify(response)); return
    }
    if (action === 'stop') {
      if (failStop) { req.socket.destroy(); return }
      node = { ...node, trial: { ...node.trial, phase: 'STOPPED', stopStatus: 'STOPPED' }, canInspect: true, canApprove: false, canStop: false }
    }
    res.end(JSON.stringify(node))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const options = { dataDir, now: () => clock, allowDeviceConnections: true,
    secretStore: { async read(key) { return credentials.get(key) }, async write(key, value) { credentials.set(key, value) } },
    clientFactory: (options) => {
      const clients = createPublicClients(options)
      return { ...clients,
        node: { origin: endpoint, async inspect() { return { nodeName: 'loopback-fixture-node', discovery: { devices: [], observedAt: new Date(clock).toISOString() } } },
          async capabilities() { return { physicalExecutionAuthorized: false, capabilities: [], workcells: [] } } },
        camera: { async status() { return { phase: 'idle', captureSessionId: null, availableCameras: [] } } },
        execution: { async status() { return { availability: 'unavailable', configurations: [], reason: null } }, async runs() { return { runs: [] } } },
      }
    },
    connections: { normalizeLocalEndpoint, async attachLocal(profile, options) { return { endpoint, identity: await options.probeNode({ endpoint }), async close() {}, onDisconnect(fn) { disconnected = fn; return () => {} } } } },
  }
  let service = await createOperatorService(options)
  const projectId = (await service.command('project.create', { name: 'Synthetic hardware fixture', connection: { type: 'local', nodeUrl: endpoint } })).activeProjectId
  await service.command('connection.saveCredential', { projectId, cameraToken: 'fixture-camera-token', executionToken: token })
  const bound = await service.command('session.bind', { projectId, serverId: 'fixture-server', sessionId: 'fixture-session' })
  await service.command('connection.connect', { projectId })
  const owner = { ...bound.binding, connectionGeneration: service.snapshot().connectionGeneration }
  const command = (action, body = {}, scope = owner) => service.command(`workcell.commissioning.${action}`, { ...Object.fromEntries(['projectId', 'conversationId', 'serverId', 'sessionId', 'connectionGeneration'].map((key) => [key, scope[key]])), ...body })
  const prepare = async () => { await command('refresh'); await command('inspect'); await command('prepare', { configurationDigest: digest(1), inspectionDigest: digest(3), targetPosition: 52 }) }
  t.after(async () => {
    failStatus = null; failStop = false; node.nodeSessionId = 'node-session-one'
    if (service.snapshot().activeCommissioning.length) {
      const active = service.snapshot().activeCommissioning[0]
      node.trial = structuredClone(active.status?.trial || trial(clock))
      try { await command('stop', { trialId: active.trialId, reason: 'operator-requested-stop' }, active) } catch {}
    }
    try { await service.close() } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }) }
  })
  return { get service() { return service }, options, owner, bound, command, prepare, endpoint, calls, dataDir,
    set node(value) { node = value }, get node() { return node }, advance: (ms) => { clock += ms }, disconnect: () => disconnected(),
    failStatus: (value) => { failStatus = value }, failStop: (value) => { failStop = value }, waitApproval: (value) => { approvalWait = value }, dropApproval: () => { dropApproval = true },
    restart: async (records) => { await service.close(); const store = createExperimentStore({ storageDir: path.join(dataDir, 'operator-state'), sessionId: 'operator-service-v1' }); const state = store.read(); state.ownership = records; store.write(state); store.release(); service = await createOperatorService(options) },
  }
}

test('operator gripper flow is explicit, authenticated, bound to exact plan and globally stoppable', async (t) => {
  const f = await fixture(t)
  assert.equal(f.calls.length, 0, 'constructing and connecting clients never inspects the robot')
  await f.command('refresh'); assert.equal(f.calls[0].action, 'gripper')
  assert.equal(f.service.snapshot().workcell.commissioning.status.inspection, null)
  await f.command('inspect')
  await assert.rejects(f.command('prepare', { configurationDigest: digest(1), inspectionDigest: digest(3), targetPosition: 60 }))
  assert.equal(f.calls.filter((call) => call.action === 'prepare').length, 0)
  await f.command('prepare', { configurationDigest: digest(1), inspectionDigest: digest(3), targetPosition: 52 })
  const approval = { trialId: 'trial-one', trialDigest: digest(4), approved: true }
  await assert.rejects(f.command('approve', { ...approval, trialDigest: digest(5) }))
  await assert.rejects(f.command('approve', { ...approval, approved: false }))
  await assert.rejects(f.command('approve', approval, { ...f.owner, sessionId: 'wrong-session' }), /binding changed/i)
  await assert.rejects(f.service.agentCall({ agentToken: f.bound.agentToken, name: 'approve_gripper_check', arguments: approval, callId: 'fixture-call' }), /capability|available/i)
  assert.equal(agentToolNames.some((name) => name.includes('commissioning')), false)
  await f.command('approve', approval)
  const active = f.service.snapshot().activeCommissioning[0]
  assert.equal(active.status.trial.phase, 'RUNNING')
  assert.equal(active.conversationId, f.owner.conversationId)
  assert.equal(f.calls.every((call) => call.authorization === `Bearer ${token}`), true)
  assert.equal(JSON.stringify(f.service.snapshot()).includes(token), false)
  await assert.rejects(f.service.close(), /retained operations/i)
  await assert.rejects(f.service.command('connection.disconnect', { projectId: f.owner.projectId }), /owned operation/i)
  const other = await f.service.command('session.bind', { projectId: f.owner.projectId, serverId: 'fixture-server', sessionId: 'another-session' })
  await assert.rejects(f.command('inspect', {}, other.binding), /another conversation owns/i)
  await f.command('stop', { trialId: active.trialId, reason: 'operator-requested-stop' }, { ...f.owner, connectionGeneration: 0 })
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
})

test('freshness, disconnected scope, expiry and changed selected conversation fail before hardware requests', async (t) => {
  const f = await fixture(t); await f.prepare()
  const approval = { trialId: 'trial-one', trialDigest: digest(4), approved: true }
  f.advance(5001)
  assert.equal(f.service.snapshot().workcell.commissioning.fresh, false)
  await assert.rejects(f.command('approve', approval))
  await f.command('refresh')
  await f.service.command('session.bind', { projectId: f.owner.projectId, serverId: 'fixture-server', sessionId: 'another-session' })
  await assert.rejects(f.command('approve', approval), /selected conversation/i)
  await f.service.command('session.select', { projectId: f.owner.projectId, conversationId: f.owner.conversationId })
  f.advance(25000)
  await f.service.command('connection.connect', { projectId: f.owner.projectId })
  await f.command('refresh')
  await assert.rejects(f.command('approve', approval), /not be confirmed/i)
  f.disconnect()
  await assert.rejects(f.command('approve', approval), /connect/i)
  assert.equal(f.service.snapshot().workcell.commissioning.fresh, false)
  assert.equal(f.calls.some((call) => call.action === 'approve'), false)
  await f.command('stop', { trialId: 'trial-one', reason: 'operator-requested-stop' })
})

test('unsupported and rejected endpoints return bounded unavailable state without reflecting provider text', async (t) => {
  const f = await fixture(t)
  for (const code of [404, 501, 401, 503]) {
    f.failStatus(code); await f.command('refresh')
    const view = f.service.snapshot().workcell.commissioning
    assert.equal(view.available, false); assert.equal(view.fresh, false)
    assert.equal(view.message.includes('must-not-reflect-provider-body'), false)
    await assert.rejects(f.command('inspect'))
  }
  assert.equal(f.calls.every((call) => call.action === 'gripper'), true)
})

test('lost approval response retains exact owned trial and Stop works independently of a pending approval', async (t) => {
  const f = await fixture(t); await f.prepare()
  let release; f.waitApproval(new Promise((resolve) => { release = resolve }))
  const approving = f.command('approve', { trialId: 'trial-one', trialDigest: digest(4), approved: true })
  while (!f.calls.some((call) => call.action === 'approve')) await delay(5)
  await f.command('stop', { trialId: 'trial-one', reason: 'operator-requested-stop' })
  release(); await approving
  assert.equal(f.service.snapshot().workcell.commissioning.status.trial.phase, 'STOPPED', 'late approval cannot replace confirmed Stop')
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
})

test('transport loss and Node restart cannot erase unresolved trial ownership', async (t) => {
  const f = await fixture(t); await f.prepare(); f.dropApproval()
  await assert.rejects(f.command('approve', { trialId: 'trial-one', trialDigest: digest(4), approved: true }))
  assert.equal(f.service.snapshot().activeCommissioning[0].trialId, 'trial-one')
  await f.command('refresh')
  assert.equal(f.service.snapshot().activeCommissioning[0].status.trial.phase, 'RUNNING')
  f.failStop(true)
  await assert.rejects(f.command('stop', { trialId: 'trial-one', reason: 'operator-requested-stop' }))
  assert.equal(f.service.snapshot().activeCommissioning.length, 1)
  f.node = { ...f.node, nodeSessionId: 'restarted-node-session', trial: null, canInspect: true, canApprove: false, canPrepare: false, canStop: false }
  await f.command('refresh')
  const active = f.service.snapshot().activeCommissioning[0]
  assert.equal(active.nodeSessionId, 'node-session-one'); assert.equal(active.statusUnavailable, true)
  await assert.rejects(f.command('inspect'))
  await assert.rejects(f.service.command('connection.disconnect', { projectId: f.owner.projectId }))
})

test('persisted operator recovery exposes only exact old-session Stop without replaying approval', async (t) => {
  const f = await fixture(t)
  const status = { ...f.node, inspection: inspect(Date.now()), trial: { ...trial(Date.now()), phase: 'RUNNING' }, canInspect: false, canPrepare: false, canApprove: false, canStop: true }
  const record = { projectId: f.owner.projectId, conversationId: f.owner.conversationId, nodeId: 'loopback-fixture-node', connectionGeneration: f.owner.connectionGeneration,
    kind: 'commissioning', trialId: 'trial-one', nodeSessionId: 'node-session-one', status: 'RUNNING', commissioningStatus: status }
  f.node = status
  await f.restart([record])
  assert.equal(f.service.snapshot().activeCommissioning[0].canStop, false)
  await f.service.command('connection.connect', { projectId: f.owner.projectId })
  const active = f.service.snapshot().activeCommissioning[0]
  assert.equal(active.canStop, true)
  await assert.rejects(f.command('refresh', {}, active), /retained unresolved/i)
  await f.command('stop', { trialId: 'trial-one', reason: 'operator-requested-stop' }, active)
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  assert.equal(f.calls.some((call) => call.action === 'approve'), false)
})

test('malformed success, oversized responses and redirects never become valid commissioning status', async () => {
  const valid = initial(Date.now())
  for (const value of [{ ...valid, canInspect: 'true' }, { ...valid, extra: 'unknown' }, { ...valid, configuration: { ...valid.configuration, maximumDelta: Infinity } },
    { ...valid, inspection: { ...inspect(Date.now()), torqueEnabled: { gripper: false } } }, { ...valid, canApprove: true }]) assert.throws(() => normalizeGripperCheck(value))
  for (const fetchImpl of [async () => new Response(JSON.stringify({ ...valid, canInspect: 'true' }), { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(' '.repeat(65537), { headers: { 'Content-Type': 'application/json' } }),
    async () => ({ ok: true, redirected: true })]) {
    const client = createCommissioningClient({ baseUrl: 'http://127.0.0.1:8876', token, fetchImpl })
    await assert.rejects(client.status(), /no outcome is assumed/i)
  }
})

test('an active gripper check polls without a viewer and never clears a Node unknown latch', async () => {
  let calls = 0, status = { ...initial(Date.now()), inspection: inspect(Date.now()), trial: trial(Date.now()), canInspect: false, canPrepare: false, canApprove: true, canStop: true }
  const client = { async status() { calls += 1; return structuredClone(status) } }
  const controller = createCommissioningController({ client, pollMs: 10 })
  try {
    await controller.action('refresh', {})
    for (let i = 0; i < 30 && calls < 2; i++) await delay(5)
    assert.ok(calls >= 2)
    status = { ...status, trial: { ...status.trial, phase: 'OUTCOME_UNKNOWN', stopStatus: 'STOP_UNCONFIRMED' }, canApprove: false }
    await controller.refresh()
    status = { ...status, trial: { ...status.trial, phase: 'STOPPED', stopStatus: 'STOPPED' }, canStop: false }
    await controller.refresh()
    assert.equal(controller.snapshot().status.trial.phase, 'OUTCOME_UNKNOWN')
    assert.equal(controller.snapshot().unresolved, true)
  } finally { controller.dispose() }
})

test('a lost approval delivery is never offered for repeat even if a later read still shows a waiting plan', async () => {
  let approvals = 0
  const status = { ...initial(Date.now()), inspection: inspect(Date.now()), trial: trial(Date.now()), canInspect: false, canPrepare: false, canApprove: true, canStop: true }
  const controller = createCommissioningController({ client: { async status() { return structuredClone(status) }, async approve() { approvals++; throw new Error('Synthetic lost connection') } } })
  const approval = { trialId: 'trial-one', trialDigest: digest(4), approved: true }
  try {
    await controller.refresh()
    await assert.rejects(controller.action('approve', approval))
    await controller.refresh()
    assert.equal(controller.snapshot().status.canApprove, false)
    assert.match(controller.snapshot().message, /already submitted/i)
    await assert.rejects(controller.action('approve', approval))
    assert.equal(approvals, 1)
    assert.equal(controller.snapshot().unresolved, true)
  } finally { controller.dispose() }
})
