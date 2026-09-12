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
import { createCommissioningClient, normalizeGripperCheck, commissioningUnresolved, GRIPPER_JOINTS } from '../../cli/src/physical/commissioning-client.js'
import { executionDigest } from '../../cli/src/physical/execution-contracts.js'
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
const seal = (value) => ({ ...value, digest: executionDigest(value) })
const recoveryBinding = (status) => ({ trialId: status.trial.trialId, trialDigest: status.trial.digest, trialNodeSessionId: status.trialNodeSessionId,
  nodeSessionId: status.nodeSessionId, configurationDigest: status.configuration.digest, deviceIdentity: status.configuration.deviceIdentity })
const unknown = (status, currentSession = status.nodeSessionId) => ({ ...status, nodeSessionId: currentSession, trialNodeSessionId: status.trialNodeSessionId ?? status.nodeSessionId,
  trial: { ...status.trial, phase: 'OUTCOME_UNKNOWN', stopStatus: 'STOPPED' }, canInspect: false, canPrepare: false, canApprove: false, canStop: true,
  recovery: null, recoveryClearance: null, canInspectRecovery: true, canConfirmRecovery: false })
const recoveryOffer = (status, now) => seal({ id: 'recovery-one', ...recoveryBinding(status), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(),
  ready: true, positions: inspect(now).positions, torqueEnabled: inspect(now).torqueEnabled, checks: inspect(now).checks })
const clearance = (status, now, recoveryDigest = status.recovery?.digest || digest(6)) => seal({ id: 'clearance-one', ...recoveryBinding(status), recoveryDigest,
  confirmedAt: new Date(now).toISOString(), inspectionDigest: digest(7), priorRunDigest: digest(8), priorRevision: 3 })
const cleared = (status, now) => ({ ...status, recovery: null, recoveryClearance: clearance(status, now), canInspectRecovery: false, canConfirmRecovery: false, canInspect: true, canStop: false })

async function fixture(t) {
  let clock = Date.now(), node = initial(clock), failStatus = null, failStop = false, approvalWait = null, recoveryWait = null, recoveryCancelled = false, dropApproval = false, dropRecovery = false, disconnected, prepared = 0
  const calls = [], credentials = new Map(), dataDir = await mkdtemp(path.join(tmpdir(), 'operator-gripper-'))
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : undefined, suffix = req.url.split('/').pop(), action = req.url.includes('/recovery/') ? `recovery${suffix[0].toUpperCase()}${suffix.slice(1)}` : suffix
    calls.push({ action, body, authorization: req.headers.authorization })
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{}'); return }
    if (failStatus) { res.statusCode = failStatus; res.end('{"secret":"must-not-reflect-provider-body"}'); return }
    if (body && body.expectedNodeSessionId !== node.nodeSessionId) { res.statusCode = 409; res.end('{}'); return }
    if (action === 'inspect') node = { ...node, inspection: inspect(clock), canPrepare: true }
    if (action === 'prepare') { prepared++; node = { ...node, trial: { ...trial(clock, body.targetPosition), ...(prepared > 1 ? { trialId: `trial-${prepared}`, digest: digest(9) } : {}) }, canInspect: false, canPrepare: false, canApprove: true, canStop: true } }
    if (action === 'approve') {
      node = { ...node, trial: { ...node.trial, phase: 'RUNNING' }, canApprove: false }
      const response = structuredClone(node)
      await approvalWait
      if (dropApproval) { req.socket.destroy(); return }
      res.end(JSON.stringify(response)); return
    }
    if (action === 'stop') {
      if (failStop) { req.socket.destroy(); return }
      if (node.trial?.phase === 'OUTCOME_UNKNOWN') { recoveryCancelled = true; node = { ...node, recovery: null, canConfirmRecovery: false } }
      else node = { ...node, trial: { ...node.trial, phase: 'STOPPED', stopStatus: 'STOPPED' }, canInspect: true, canApprove: false, canStop: false }
    }
    if (action === 'recoveryInspect') { recoveryCancelled = false; node = { ...node, recovery: recoveryOffer(node, clock), canConfirmRecovery: true } }
    if (action === 'recoveryConfirm') {
      if (body.confirmed !== true || body.recoveryDigest !== node.recovery?.digest) { res.statusCode = 409; res.end('{}'); return }
      await recoveryWait
      if (recoveryCancelled) { res.statusCode = 409; res.end('{}'); return }
      node = cleared(node, clock)
      if (dropRecovery) { req.socket.destroy(); return }
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
    failStatus = null; failStop = false; dropRecovery = false; node.nodeSessionId = 'node-session-one'
    if (service.snapshot().activeCommissioning.length) {
      const active = service.snapshot().activeCommissioning[0]
      node.trial = structuredClone(active.status?.trial || trial(clock))
      try {
        if (active.status?.trial?.phase === 'OUTCOME_UNKNOWN') {
          node = cleared(unknown(structuredClone(active.status)), clock)
          await service.command('connection.connect', { projectId: active.projectId })
          const current = service.snapshot().activeCommissioning[0]
          await command('recoveryInspect', { trialId: active.trialId, trialDigest: active.status.trial.digest }, current)
        } else await command('stop', { trialId: active.trialId, reason: 'operator-requested-stop' }, active)
      } catch {}
    }
    try { await service.close() } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }) }
  })
  return { get service() { return service }, options, owner, bound, command, prepare, endpoint, calls, dataDir,
    set node(value) { node = value }, get node() { return node }, advance: (ms) => { clock += ms }, disconnect: () => disconnected(),
    failStatus: (value) => { failStatus = value }, failStop: (value) => { failStop = value }, waitApproval: (value) => { approvalWait = value }, dropApproval: () => { dropApproval = true },
    dropRecovery: () => { dropRecovery = true },
    waitRecovery: (value) => { recoveryWait = value },
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

test('recovery seals reject altered evidence and unrelated historical clearance cannot resolve another trial', () => {
  const now = Date.now(), base = unknown({ ...initial(now), trial: trial(now) })
  const offered = { ...base, recovery: recoveryOffer(base, now), canConfirmRecovery: true }
  assert.equal(normalizeGripperCheck(offered).recovery.ready, true)
  for (const mutate of [
    (value) => { value.recovery.positions.gripper += 1 },
    (value) => { value.recovery.nodeSessionId = 'wrong-node-session' },
    (value) => { value.recovery.trialId = 'wrong-trial' },
    (value) => { value.recovery.trialNodeSessionId = 'wrong-origin' },
    (value) => { delete value.canInspectRecovery },
    (value) => { value.recovery.torqueEnabled.gripper = true; value.recovery = seal(Object.fromEntries(Object.entries(value.recovery).filter(([key]) => key !== 'digest'))) },
  ]) { const value = structuredClone(offered); mutate(value); assert.throws(() => normalizeGripperCheck(value)) }
  const resolved = cleared(base, now)
  assert.equal(commissioningUnresolved(normalizeGripperCheck(resolved)), false)
  const altered = structuredClone(resolved); altered.recoveryClearance.priorRevision += 1
  assert.throws(() => normalizeGripperCheck(altered))
  const unrelated = { ...base, recoveryClearance: resolved.recoveryClearance, trial: { ...base.trial, trialId: 'new-unknown-trial', digest: digest(9) } }
  assert.equal(commissioningUnresolved(normalizeGripperCheck(unrelated)), true)
  const afterRestart = { ...resolved, nodeSessionId: 'current-session-after-clearance' }
  assert.equal(commissioningUnresolved(normalizeGripperCheck(afterRestart)), false, 'durable receipt keeps its historical confirmation session')
})

test('owned recovery requires separate inspection and exact explicit confirmation while preserving unknown history', async (t) => {
  const f = await fixture(t); await f.prepare(); f.node = unknown(f.node); await f.command('refresh')
  const body = { trialId: 'trial-one', trialDigest: digest(4) }
  await f.command('recoveryInspect', body)
  const view = f.service.snapshot().workcell.commissioning
  assert.equal(view.status.trial.phase, 'OUTCOME_UNKNOWN')
  assert.equal(view.recoveryStatus.recovery.ready, true)
  assert.equal(view.recoveryFresh, true)
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest: digest(9), confirmed: true }))
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest: view.recoveryStatus.recovery.digest, confirmed: false }))
  await assert.rejects(f.service.agentCall({ agentToken: f.bound.agentToken, name: 'recover_gripper_check', arguments: body, callId: 'fixture-recovery-call' }))
  assert.equal(f.calls.filter((call) => call.action === 'recoveryConfirm').length, 0)
  await f.command('recoveryConfirm', { ...body, recoveryDigest: view.recoveryStatus.recovery.digest, confirmed: true })
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  assert.equal(f.service.snapshot().workcell.commissioning.status.trial.phase, 'OUTCOME_UNKNOWN')
  assert.equal(f.service.snapshot().workcell.commissioning.status.recoveryClearance.trialId, body.trialId)
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest: view.recoveryStatus.recovery.digest, confirmed: true }))
  assert.equal(f.calls.filter((call) => call.action === 'recoveryConfirm').length, 1)
  assert.equal(f.calls.some((call) => call.action === 'approve'), false)
  await f.command('inspect')
  await f.command('prepare', { configurationDigest: digest(1), inspectionDigest: digest(3), targetPosition: 52 })
  const next = f.service.snapshot().workcell.commissioning
  assert.equal(next.status.trial.trialId, 'trial-2')
  assert.equal(next.status.trial.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(next.recoveryStatus, null); assert.equal(next.recoveryFresh, false)
  assert.equal(next.status.recoveryClearance.trialId, body.trialId, 'historical Node receipt remains available without controlling the new plan')
  assert.equal(next.status.canApprove, true)
})

test('restarted Node recovery uses a separate current status and clears only the original owned trial', async (t) => {
  const f = await fixture(t); await f.prepare(); f.node = unknown(f.node); await f.command('refresh')
  f.node = { ...f.node, nodeSessionId: 'restarted-node-session' }
  await f.command('refresh')
  assert.equal(f.service.snapshot().workcell.commissioning.available, false)
  const body = { trialId: 'trial-one', trialDigest: digest(4) }
  await f.command('recoveryInspect', body)
  const view = f.service.snapshot().workcell.commissioning
  assert.equal(view.status.nodeSessionId, 'node-session-one')
  assert.equal(view.recoveryStatus.nodeSessionId, 'restarted-node-session')
  assert.equal(view.recoveryStatus.trialNodeSessionId, 'node-session-one')
  assert.equal(f.service.snapshot().activeCommissioning[0].nodeSessionId, 'node-session-one')
  await f.command('recoveryConfirm', { ...body, recoveryDigest: view.recoveryStatus.recovery.digest, confirmed: true })
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  assert.equal(f.service.snapshot().workcell.commissioning.status.nodeSessionId, 'restarted-node-session')
})

test('authenticated matching metadata refresh keeps recovery available without another inspection or extending offer expiry', async (t) => {
  const f = await fixture(t); await f.prepare(); f.node = unknown(f.node); await f.command('refresh')
  const body = { trialId: 'trial-one', trialDigest: digest(4) }
  await f.command('recoveryInspect', body)
  const recoveryDigest = f.service.snapshot().workcell.commissioning.recoveryStatus.recovery.digest
  f.advance(5001); await f.command('refresh')
  const view = f.service.snapshot().workcell.commissioning
  assert.equal(view.fresh, true); assert.equal(view.recoveryFresh, true)
  assert.equal(f.calls.filter((call) => call.action === 'recoveryInspect').length, 1)
  f.advance(25000); await f.service.command('connection.connect', { projectId: f.owner.projectId }); await f.command('refresh')
  assert.equal(f.service.snapshot().workcell.commissioning.recoveryFresh, false)
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest, confirmed: true }))
  assert.equal(f.calls.filter((call) => call.action === 'recoveryConfirm').length, 0)
})

test('restarted recovery metadata polls preserve original ownership and reject changed or failed evidence', async () => {
  let clock = Date.now()
  const original = unknown({ ...initial(clock), trial: trial(clock) }), current = { ...original, nodeSessionId: 'restarted-node-session' }
  const offered = { ...current, recovery: recoveryOffer(current, clock), canConfirmRecovery: true }
  for (const broken of [null, { ...offered, nodeSessionId: 'another-node-session' }, { ...offered, trialNodeSessionId: 'another-origin' },
    { ...offered, configuration: { ...offered.configuration, digest: digest(9) } }, { ...offered, recovery: { ...offered.recovery, digest: digest(9) } }, { ...offered, recovery: null }]) {
    let response = current, reads = 0
    const controller = createCommissioningController({ initialStatus: original, recoveryOnly: true, now: () => clock, client: {
      async status() { if (!response) throw Error('Synthetic offline'); return response }, async recoveryInspect() { reads++; return offered },
    } })
    try {
      await controller.action('recoveryInspect', { trialId: 'trial-one', trialDigest: digest(4) })
      response = offered; clock += 1000; await controller.refresh()
      assert.equal(controller.snapshot().recoveryFresh, true); assert.equal(controller.snapshot().recoveryReceivedAt, clock)
      assert.equal(controller.snapshot().status.nodeSessionId, original.nodeSessionId)
      response = broken; await controller.refresh()
      assert.equal(controller.snapshot().recoveryFresh, false); assert.equal(controller.snapshot().recoveryAvailable, false)
      assert.equal(controller.snapshot().unresolved, true); assert.equal(reads, 1)
      response = offered; await controller.refresh()
      assert.equal(controller.snapshot().recoveryFresh, false, 'a later read does not restore invalidated confirmation evidence')
    } finally { controller.dispose() }
  }
})

test('persisted-owner metadata cannot release ownership before explicit durable clearance adoption', async () => {
  const now = Date.now(), original = unknown({ ...initial(now), trial: trial(now) })
  const offered = { ...original, recovery: recoveryOffer(original, now), canConfirmRecovery: true }
  let response = original, inspections = 0
  const controller = createCommissioningController({ initialStatus: original, recoveryOnly: true, client: {
    async status() { return response }, async recoveryInspect() { inspections++; return offered },
  } })
  try {
    const body = { trialId: 'trial-one', trialDigest: digest(4) }
    await controller.action('recoveryInspect', body)
    response = cleared(offered, now); await controller.refresh(); await controller.refresh()
    assert.equal(controller.snapshot().unresolved, true)
    await controller.action('recoveryInspect', body)
    assert.equal(controller.snapshot().unresolved, false); assert.equal(inspections, 1)
  } finally { controller.dispose() }
})

test('a lost recovery confirmation retains owner until exact durable status readback without another hardware inspection', async (t) => {
  const f = await fixture(t); await f.prepare(); f.node = unknown(f.node); await f.command('refresh')
  f.node = { ...f.node, nodeSessionId: 'restarted-node-session' }
  const body = { trialId: 'trial-one', trialDigest: digest(4) }
  await f.command('recoveryInspect', body)
  const recoveryDigest = f.service.snapshot().workcell.commissioning.recoveryStatus.recovery.digest
  f.dropRecovery()
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest, confirmed: true }))
  assert.equal(f.service.snapshot().activeCommissioning.length, 1)
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest, confirmed: true }))
  const inspections = f.calls.filter((call) => call.action === 'recoveryInspect').length
  await f.command('recoveryInspect', body)
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  assert.equal(f.calls.filter((call) => call.action === 'recoveryInspect').length, inspections)
  assert.equal(f.calls.filter((call) => call.action === 'recoveryConfirm').length, 1)
})

test('operator restart exposes recovery on the exact selected persisted owner and durable clearance survives reopening', async (t) => {
  const f = await fixture(t)
  const old = unknown({ ...f.node, trial: trial(Date.now()) })
  const record = { projectId: f.owner.projectId, conversationId: f.owner.conversationId, nodeId: 'loopback-fixture-node', connectionGeneration: f.owner.connectionGeneration,
    kind: 'commissioning', trialId: 'trial-one', nodeSessionId: 'node-session-one', status: 'OUTCOME_UNKNOWN', commissioningStatus: old }
  f.node = { ...old, nodeSessionId: 'restarted-node-session' }
  await f.restart([record]); await f.service.command('connection.connect', { projectId: f.owner.projectId })
  const owner = f.service.snapshot().activeCommissioning[0], body = { trialId: 'trial-one', trialDigest: digest(4) }
  await assert.rejects(f.command('recoveryInspect', body, { ...owner, connectionGeneration: 0 }))
  await f.command('recoveryInspect', body, owner)
  const retained = f.service.snapshot().activeCommissioning[0]
  assert.equal(retained.nodeSessionId, 'node-session-one')
  assert.equal(retained.recoveryView.recoveryStatus.nodeSessionId, 'restarted-node-session')
  const other = await f.service.command('session.bind', { projectId: f.owner.projectId, serverId: 'fixture-server', sessionId: 'other-recovery-session' })
  await assert.rejects(f.command('recoveryConfirm', { ...body, recoveryDigest: retained.recoveryStatus.recovery.digest, confirmed: true }, other.binding))
  assert.equal(f.calls.filter((call) => call.action === 'recoveryConfirm').length, 0)
  await f.service.command('session.select', { projectId: f.owner.projectId, conversationId: f.owner.conversationId })
  await f.command('recoveryConfirm', { ...body, recoveryDigest: retained.recoveryStatus.recovery.digest, confirmed: true }, owner)
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  await f.restart([])
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
})

test('persisted owner accepts a matching prior-session durable clearance by status read alone', async (t) => {
  const f = await fixture(t), old = unknown({ ...f.node, trial: trial(Date.now()) })
  const record = { projectId: f.owner.projectId, conversationId: f.owner.conversationId, nodeId: 'loopback-fixture-node', connectionGeneration: f.owner.connectionGeneration,
    kind: 'commissioning', trialId: 'trial-one', nodeSessionId: 'node-session-one', status: 'OUTCOME_UNKNOWN', commissioningStatus: old }
  f.node = { ...cleared(old, Date.now()), nodeSessionId: 'new-node-after-clearance' }
  await f.restart([record]); await f.service.command('connection.connect', { projectId: f.owner.projectId })
  const active = f.service.snapshot().activeCommissioning[0]
  await f.command('recoveryInspect', { trialId: active.trialId, trialDigest: active.status.trial.digest }, active)
  assert.equal(f.service.snapshot().activeCommissioning.length, 0)
  assert.equal(f.calls.some((call) => ['inspect', 'recoveryInspect', 'recoveryConfirm', 'approve'].includes(call.action)), false)
})

test('mismatched restarted recovery status fails before any recovery inspection request', async () => {
  const now = Date.now(), original = unknown({ ...initial(now), trial: trial(now) })
  for (const replacement of [
    { ...original, nodeSessionId: 'restarted', trialNodeSessionId: 'another-original-session' },
    { ...original, nodeSessionId: 'restarted', trial: { ...original.trial, digest: digest(5) } },
    { ...original, nodeSessionId: 'restarted', configuration: { ...original.configuration, deviceIdentity: 'other-device' } },
    { ...original, nodeSessionId: 'restarted', configuration: { ...original.configuration, digest: digest(5) } },
  ]) {
    let reads = 0
    const controller = createCommissioningController({ initialStatus: original, client: { async status() { return replacement }, async recoveryInspect() { reads++; throw Error('must not reach') } } })
    try { await assert.rejects(controller.action('recoveryInspect', { trialId: 'trial-one', trialDigest: digest(4) })); assert.equal(reads, 0); assert.equal(controller.snapshot().unresolved, true) }
    finally { controller.dispose() }
  }
})

test('Stop invalidates a pending recovery inspection and its late offer cannot become confirmable', async () => {
  const now = Date.now(), original = unknown({ ...initial(now), trial: trial(now) })
  let release, reached
  const waiting = new Promise((resolve) => { reached = resolve })
  const controller = createCommissioningController({ initialStatus: original, client: { async status() { return original },
    async recoveryInspect() { reached(); return new Promise((resolve) => { release = resolve }) }, async stop() { return original } } })
  try {
    const pending = controller.action('recoveryInspect', { trialId: 'trial-one', trialDigest: digest(4) })
    await waiting
    await controller.action('stop', { trialId: 'trial-one', reason: 'operator-requested-stop' })
    release({ ...original, recovery: recoveryOffer(original, now), canConfirmRecovery: true }); await pending
    assert.equal(controller.snapshot().recoveryStatus, null)
    assert.equal(controller.snapshot().recoveryFresh, false)
    assert.equal(controller.snapshot().unresolved, true)
  } finally { controller.dispose() }
})

test('Stop independently cancels a restarted Node recovery confirmation without claiming the original Stop succeeded', async () => {
  const now = Date.now(), original = unknown({ ...initial(now), trial: trial(now) }), current = { ...original, nodeSessionId: 'restarted-node-session' }
  let release, reached, cancelled = false, committed = false
  const started = new Promise((resolve) => { reached = resolve }), stopSessions = []
  const offered = { ...current, recovery: recoveryOffer(current, now), canConfirmRecovery: true }
  const controller = createCommissioningController({ initialStatus: original, client: {
    async status() { return current }, async recoveryInspect() { return offered },
    async recoveryConfirm() { reached(); await new Promise((resolve) => { release = resolve }); if (cancelled) throw Error('Node cancellation rejected commit'); committed = true; return cleared(offered, now) },
    async stop(body) { stopSessions.push(body.expectedNodeSessionId); if (body.expectedNodeSessionId === original.nodeSessionId) throw Error('Original Node session rejected'); cancelled = true; return current },
  } })
  try {
    const body = { trialId: 'trial-one', trialDigest: digest(4) }
    await controller.action('recoveryInspect', body)
    const confirming = controller.action('recoveryConfirm', { ...body, recoveryDigest: offered.recovery.digest, confirmed: true })
    await started
    await assert.rejects(controller.action('stop', { trialId: body.trialId, reason: 'operator-requested-stop' }), /unconfirmed/i)
    release(); await confirming
    assert.deepEqual(stopSessions.sort(), ['node-session-one', 'restarted-node-session'])
    assert.equal(cancelled, true); assert.equal(committed, false)
    assert.equal(controller.snapshot().status.nodeSessionId, original.nodeSessionId)
    assert.equal(controller.snapshot().unresolved, true); assert.equal(controller.snapshot().recoveryFresh, false)
  } finally { controller.dispose() }
})

test('ordinary status polling preserves a failed recovery message and cannot make its offer fresh', async () => {
  const now = Date.now(), original = unknown({ ...initial(now), trial: trial(now) })
  const controller = createCommissioningController({ initialStatus: original, client: { async status() { return original }, async recoveryInspect() { throw Error('Synthetic failure') } } })
  try {
    await assert.rejects(controller.action('recoveryInspect', { trialId: 'trial-one', trialDigest: digest(4) }))
    const message = controller.snapshot().message
    await controller.refresh()
    assert.equal(controller.snapshot().message, message)
    assert.equal(controller.snapshot().recoveryFresh, false)
  } finally { controller.dispose() }
})

test('persisted operator owner Stop cancels current-session confirmation and keeps its original unknown record', async (t) => {
  const f = await fixture(t), old = unknown({ ...f.node, trial: trial(Date.now()) })
  const record = { projectId: f.owner.projectId, conversationId: f.owner.conversationId, nodeId: 'loopback-fixture-node', connectionGeneration: f.owner.connectionGeneration,
    kind: 'commissioning', trialId: 'trial-one', nodeSessionId: 'node-session-one', status: 'OUTCOME_UNKNOWN', commissioningStatus: old }
  f.node = { ...old, nodeSessionId: 'restarted-node-session' }
  await f.restart([record]); await f.service.command('connection.connect', { projectId: f.owner.projectId })
  const owner = f.service.snapshot().activeCommissioning[0], body = { trialId: owner.trialId, trialDigest: digest(4) }
  await f.command('recoveryInspect', body, owner)
  let release
  f.waitRecovery(new Promise((resolve) => { release = resolve }))
  const offer = f.service.snapshot().activeCommissioning[0].recoveryStatus.recovery
  const confirming = f.command('recoveryConfirm', { ...body, recoveryDigest: offer.digest, confirmed: true }, owner)
  try {
    for (let attempt = 0; attempt < 100 && !f.calls.some((call) => call.action === 'recoveryConfirm'); attempt++) await delay(5)
    assert.equal(f.calls.some((call) => call.action === 'recoveryConfirm'), true)
    await assert.rejects(f.command('stop', { trialId: body.trialId, reason: 'operator-requested-stop' }, owner))
  } finally { release(); await confirming }
  const stopped = f.calls.filter((call) => call.action === 'stop').map((call) => call.body.expectedNodeSessionId)
  assert.deepEqual(stopped.sort(), ['node-session-one', 'restarted-node-session'])
  assert.equal(f.node.recoveryClearance, null)
  const retained = f.service.snapshot().activeCommissioning[0]
  assert.equal(retained.nodeSessionId, old.nodeSessionId); assert.equal(retained.status.trial.phase, 'OUTCOME_UNKNOWN')
  assert.equal(retained.recoveryView.recoveryFresh, false)
})
