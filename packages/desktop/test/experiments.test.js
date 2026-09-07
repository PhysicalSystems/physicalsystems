// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApplication } from '../src/application.js'
import { createSimulationHost } from '../src/simulation.js'
import { openCatalog } from '../src/catalog.js'
import { unavailableSnapshot, validateCommand } from '../src/bridge-contract.js'

async function fixture(t, { scripted = false, stepMs = 25, decorate = (host) => host, clock = Date.now } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ps-desktop-experiments-')), hosts = []
  const catalog = await openCatalog(dataDir)
  const forbidden = async () => assert.fail('Synthetic experiments cannot access a Node, model or credentials')
  const factory = async (options) => {
    const base = await createSimulationHost({ ...options, projectId: path.basename(options.cwd), stepMs, now: clock })
    const host = decorate(scripted ? base : { ...base, startExperimentGuide: undefined })
    hosts.push(host)
    return host
  }
  const app = await createApplication({ dataDir, catalog, env: {}, hostFactory: factory, simulationFactory: factory, now: () => new Date(clock()).toISOString(),
    secretStore: { read: forbidden, write: forbidden, delete: forbidden }, connections: { attachLocal: forbidden, attachSSH: forbidden }, probeNode: forbidden })
  t.after(async () => {
    for (const host of hosts) { await host.cancel(); const current = host.getExperiments().snapshot().current; if (current) { try { host.getExperiments().stop({ experimentId: current.id }) } catch {} } }
    await app.close(); await catalog.close(); await rm(dataDir, { recursive: true, force: true })
  })
  const scope = () => { const state = app.snapshot(); return { projectId: state.activeProjectId, conversationId: state.activeConversationId, connectionGeneration: state.connectionGeneration } }
  const create = async (name = 'Experiment bench') => { await app.command('project.create', { name, connection: { type: scripted ? 'simulation' : 'local', label: name, nodeUrl: 'http://127.0.0.1:1' } }); return scope() }
  return { app, catalog, hosts, scope, create, dataDir }
}
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await delay(10) }; assert.fail('Expected experiment state was not reached') }
const proposal = (scope, requestId = 'propose-fixture-one') => ({ ...scope, goal: 'Compare synthetic alignment offsets', trialLimit: 2, requestId, mode: 'simulation' })
const approval = (scope, current) => ({ ...scope, experimentId: current.id, expectedDigest: current.planDigest, approved: true })
const inlineApproval = (scope, current, requestId = 'inline-approval-request') => ({ ...approval(scope, current), requestId })
const continuation = (scope, current, requestId = 'inline-continue-request') => ({ ...scope, experimentId: current.id, expectedDigest: current.planDigest, requestId })

// Real synthetic experiment persistence, with a local fake at the model boundary.
// No provider, model session, Node service or device can be reached by this host.
function modelBoundary() {
  const control = { busy: false, error: null, failPrompt: null, approve: null, project: (value) => value,
    calls: [], attempts: [], approvals: [], accepted: new Map(), sessionId: null }
  control.decorate = (host) => {
    const controller = host.getExperiments(), experiments = { ...controller,
      snapshot: () => control.project(controller.snapshot()),
      approve(body) { control.approvals.push(body); return control.approve ? control.approve(controller, body) : controller.approve(body) },
    }
    return { ...host, getExperiments: () => experiments,
      snapshot: () => ({ ...host.snapshot(), busy: control.busy, error: control.error, ...(control.sessionId ? { sessionId: control.sessionId } : {}) }),
      prompt(message, requestId) {
        control.attempts.push({ message, requestId })
        assert.equal(controller.snapshot().current.phase, 'READY', 'Exact approval must be durable before model continuation')
        if (control.failPrompt) throw Object.assign(new Error(control.failPrompt), { code: 'ERR_HARNESS_MODEL_UNAVAILABLE' })
        if (control.accepted.has(requestId)) {
          assert.equal(control.accepted.get(requestId), message)
          return { accepted: true, duplicate: true, requestId }
        }
        assert.equal(control.busy, false, 'A busy model cannot receive another request')
        control.accepted.set(requestId, message); control.calls.push({ message, requestId }); control.busy = true; control.error = null
        return { accepted: true, duplicate: false, requestId }
      },
      async cancel() { control.busy = false; return host.cancel() },
    }
  }
  return control
}

test('inline approval records the exact plan then submits one synthetic continuation without clearing prose', async (t) => {
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  await f.app.command('conversation.saveDraft', { ...scope, draft: 'Keep my unfinished question' })
  const result = await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  assert.equal(result.current.phase, 'READY'); assert.equal(result.continuation.accepted, true); assert.equal(result.continuation.duplicate, false)
  assert.deepEqual(model.approvals, [{ experimentId: planned.id, expectedDigest: planned.planDigest }])
  assert.equal(model.calls.length, 1)
  assert.equal(model.calls[0].message, 'Continue the approved synthetic simulation experiment. Run the remaining trials, compare the measurements, and summarize the result.')
  assert.equal(model.calls[0].message.includes(planned.id), false); assert.equal(model.calls[0].message.includes(planned.planDigest), false)
  assert.equal(f.app.snapshot().conversation.draft, 'Keep my unfinished question')
  const duplicate = await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  assert.equal(duplicate.continuation.duplicate, true); assert.equal(model.calls.length, 1); assert.equal(model.approvals.length, 1)
  model.busy = false
  const retry = await f.app.command('experiment.continue', continuation(scope, planned, 'inline-approval-request'))
  assert.equal(retry.continuation.duplicate, true); assert.equal(model.calls.length, 1)
  await assert.rejects(f.app.command('experiment.continue', { ...continuation(scope, planned, 'inline-approval-request'), expectedDigest: 'changed-digest' }), /request.*different|plan.*match|reviewed plan/i)
})

test('continuation requires existing exact fresh approval and remaining synthetic budget', async (t) => {
  let time = Date.now()
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate, clock: () => time }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned)), /approve this exact|existing.*approval/i)
  assert.equal(model.approvals.length, 0); assert.equal(f.app.snapshot().experiments.current.approvedAt, null)
  await assert.rejects(f.app.command('experiment.approveAndContinue', { ...inlineApproval(scope, planned), approved: false }), /explicitly approve/)
  await assert.rejects(f.app.command('experiment.approveAndContinue', { ...inlineApproval(scope, planned), expectedDigest: 'changed-digest' }), /reviewed plan|plan.*match/i)
  time = planned.expiresAt
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned)), /expired/i)
  time -= 1
  await f.app.command('experiment.approve', approval(scope, planned)); const count = model.approvals.length
  time += 1
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned)), /expired/i)
  time -= 1
  await f.app.command('experiment.trial', { ...scope, experimentId: planned.id, requestId: 'budget-trial-one', offsetMm: 0 })
  await f.app.command('experiment.trial', { ...scope, experimentId: planned.id, requestId: 'budget-trial-two', offsetMm: 1 })
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned)), /trial limit|budget/i)
  assert.equal(model.approvals.length, count); assert.equal(model.calls.length, 0)
})

test('model busy rejects inline approval; a model submission failure retains approval for explicit recovery', async (t) => {
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  model.busy = true
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned)), /assistant.*(?:busy|finish)|current.*request/i)
  assert.equal(f.app.snapshot().experiments.current.phase, 'PROPOSED'); assert.equal(model.approvals.length, 0)
  model.busy = false; model.failPrompt = 'Select a model and connect its provider in Settings before sending a message.'
  const rejected = await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  assert.equal(rejected.current.phase, 'READY'); assert.equal(rejected.continuation.accepted, false); assert.match(rejected.continuation.error, /Select a model/)
  assert.equal(model.calls.length, 0); assert.equal(model.approvals.length, 1)
  model.failPrompt = null
  const accepted = await f.app.command('experiment.continue', continuation(scope, planned, 'inline-approval-request'))
  assert.equal(accepted.continuation.accepted, true); assert.equal(model.calls.length, 1); assert.equal(model.approvals.length, 1)
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned, 'while-model-busy')), /assistant.*(?:busy|finish)|current.*request/i)
  model.busy = false; model.error = 'The assistant request failed.'
  const replay = await f.app.command('experiment.continue', continuation(scope, planned, 'inline-approval-request'))
  assert.equal(replay.continuation.duplicate, true); assert.equal(model.calls.length, 1)
  const recovered = await f.app.command('experiment.continue', continuation(scope, planned, 'explicit-model-recovery'))
  assert.equal(recovered.continuation.accepted, true); assert.equal(model.calls.length, 2); assert.equal(model.approvals.length, 1)
})

test('pending approval permits independent Stop and never submits a late continuation', async (t) => {
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  let settle
  model.approve = async (controller, body) => { const value = controller.approve(body); await new Promise((resolve) => { settle = resolve }); return value }
  const pending = f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  await until(() => Boolean(settle))
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned)), /request is in progress/)
  await f.app.command('experiment.stop', { ...scope, experimentId: planned.id }); settle()
  await assert.rejects(pending, /stopped|Stop|changed/i)
  assert.equal(f.app.snapshot().experiments.current.phase, 'STOPPED'); assert.equal(model.calls.length, 0)
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned)), /approve this exact|existing.*approval|stopped/i)
})

test('a changed session or plan during approval cannot receive a continuation', async (t) => {
  for (const changed of ['session', 'plan']) {
    const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create(changed)
    await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
    model.approve = (controller, body) => {
      const approved = controller.approve(body)
      if (changed === 'session') model.sessionId = 'changed-session-id'
      else model.project = (value) => ({ ...value, current: { ...value.current, planDigest: 'changed-plan-digest' } })
      return approved
    }
    await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned)), /changed|reviewed plan/i)
    assert.equal(model.calls.length, 0)
  }
})

test('inline command scope and malformed fields fail before host creation or approval', async (t) => {
  const f = await fixture(t), first = await f.create()
  await f.app.command('experiment.propose', proposal(first)); const planned = f.app.snapshot().experiments.current
  for (const name of ['experiment.approveAndContinue', 'experiment.continue']) {
    const payload = name.endsWith('approveAndContinue') ? inlineApproval(first, planned) : continuation(first, planned)
    for (const invalid of [{ requestId: 'bad id' }, { connectionGeneration: undefined }, { executor: 'physical' }]) {
      assert.throws(() => validateCommand(name, { ...payload, ...invalid }), /request ID|generation|unsupported fields/i)
      await assert.rejects(f.app.command(name, { ...payload, ...invalid }), /request ID|connection|unsupported fields/i)
    }
    await assert.rejects(f.app.command(name, { ...payload, connectionGeneration: first.connectionGeneration + 1 }), /connection changed/i)
  }
  assert.equal(f.app.snapshot().experiments.current.phase, 'PROPOSED')
  await f.app.command('conversation.create', { projectId: first.projectId }); const second = f.scope()
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(first, planned)), /conversation changed/)
  await f.app.command('connection.disconnect', second); const count = f.hosts.length
  await assert.rejects(f.app.command('experiment.continue', continuation(first, planned)), /conversation changed/)
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(second, planned)), /conversation changed/)
  assert.equal(f.hosts.length, count)
})

test('scripted inline approval starts its guide once and never sends an ordinary model prompt', async (t) => {
  let guides = 0, prompts = 0
  const f = await fixture(t, { scripted: true, stepMs: 70, decorate: (host) => ({ ...host,
    startExperimentGuide(id) { guides += 1; return host.startExperimentGuide(id) },
    prompt() { prompts += 1; assert.fail('Scripted inline continuation must use only its guide') },
  }) }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  const first = await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  assert.equal(first.continuation.accepted, true); assert.equal(first.continuation.mode, 'scripted')
  const duplicate = await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  assert.equal(duplicate.continuation.duplicate, true); assert.equal(guides, 1); assert.equal(prompts, 0)
  await until(() => f.app.snapshot().experiments.current.phase === 'COMPLETED')
  const settledDuplicate = await f.app.command('experiment.continue', continuation(scope, planned, 'inline-approval-request'))
  assert.equal(settledDuplicate.continuation.duplicate, true); assert.equal(guides, 1); assert.equal(prompts, 0)
  assert.equal(f.app.snapshot().experiments.current.trials.length, 2)
})

test('inline approval storage failure and an unconfirmed outcome never reach the model', async (t) => {
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  const directory = path.join(f.dataDir, 'harness', 'experiments'), file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith('.json')))
  const saved = await readFile(file)
  await rm(file); await mkdir(file)
  try {
    await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned)), /evidence could not be saved/)
    assert.equal(f.app.snapshot().experiments.current.phase, 'OUTCOME_UNKNOWN')
    await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned)), /evidence could not be saved/)
    assert.equal(model.calls.length, 0); assert.equal(model.attempts.length, 0)
  } finally { await rm(file, { recursive: true }); await writeFile(file, saved) }
  await f.app.command('experiment.stop', { ...scope, experimentId: planned.id })
  await f.app.command('experiment.propose', proposal(scope, 'after-storage-repair')); const next = f.app.snapshot().experiments.current
  await f.app.command('experiment.approve', approval(scope, next)); const approvals = model.approvals.length
  for (const current of [{ phase: 'OUTCOME_UNKNOWN' }, { stopStatus: 'UNCONFIRMED' }, { approvedAt: null }]) {
    model.project = (value) => ({ ...value, current: { ...value.current, ...current } })
    await assert.rejects(f.app.command('experiment.continue', continuation(scope, next)), /unconfirmed|existing.*approval/i)
  }
  assert.equal(model.calls.length, 0); assert.equal(model.approvals.length, approvals)
})

test('accepted continuation IDs remain deduplicated after host cache eviction and the session limit is bounded', async (t) => {
  const model = modelBoundary(), f = await fixture(t, { decorate: model.decorate }), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  await f.app.command('experiment.approveAndContinue', inlineApproval(scope, planned))
  for (let index = 1; index < 256; index += 1) {
    model.busy = false
    await f.app.command('experiment.continue', continuation(scope, planned, `bounded-continuation-${index}`))
  }
  model.busy = false; model.accepted.clear()
  const replay = await f.app.command('experiment.continue', continuation(scope, planned, 'inline-approval-request'))
  assert.equal(replay.continuation.duplicate, true); assert.equal(model.attempts.length, 256)
  await assert.rejects(f.app.command('experiment.continue', continuation(scope, planned, 'bounded-continuation-overflow')), /request limit/)
  assert.equal(model.attempts.length, 256); assert.equal(model.approvals.length, 1)
  await f.app.command('experiment.stop', { ...scope, experimentId: planned.id })
  await f.app.command('experiment.propose', proposal(scope, 'request-conflict-new-plan')); const next = f.app.snapshot().experiments.current
  await assert.rejects(f.app.command('experiment.approveAndContinue', inlineApproval(scope, next)), /request.*different|different action/i)
  assert.equal(f.app.snapshot().experiments.current.phase, 'PROPOSED')
})

test('offline conversation experiments require exact approval and preserve deduplicated measured results', async (t) => {
  const f = await fixture(t), scope = await f.create()
  assert.equal(f.app.snapshot().projects[0].connection.status, 'offline')
  await f.app.command('experiment.propose', proposal(scope))
  const planned = f.app.snapshot().experiments.current
  assert.equal(planned.phase, 'PROPOSED'); assert.equal(planned.trials.length, 0)
  await f.app.command('experiment.propose', proposal(scope))
  assert.equal(f.app.snapshot().experiments.current.id, planned.id)
  await assert.rejects(f.app.command('experiment.approve', { ...approval(scope, planned), approved: false }), /explicitly approve/)
  await assert.rejects(f.app.command('experiment.approve', { ...approval(scope, planned), expectedDigest: 'changed-plan' }), /plan.*changed|match|digest/i)
  await assert.rejects(f.app.command('experiment.trial', { ...scope, experimentId: planned.id, requestId: 'trial-before-approval', offsetMm: 0 }), /approve this exact/i)
  await f.app.command('experiment.approve', approval(scope, planned))
  await assert.rejects(f.app.command('experiment.trial', { ...scope, experimentId: planned.id, requestId: 'trial-invalid-offset', offsetMm: 11 }), /between -10 and 10/)
  const trial = { ...scope, experimentId: planned.id, requestId: 'trial-measured-one', offsetMm: 1 }
  await f.app.command('experiment.trial', trial)
  await f.app.command('experiment.trial', trial)
  assert.equal(f.app.snapshot().experiments.current.trials.length, 1)
  await assert.rejects(f.app.command('experiment.trial', { ...trial, offsetMm: 2 }), /request.*different|different.*request/i)
  await f.app.command('experiment.trial', { ...trial, requestId: 'trial-measured-two', offsetMm: 3 })
  await f.app.command('experiment.finish', { ...scope, experimentId: planned.id })
  const result = f.app.snapshot().experiments.current
  assert.equal(result.phase, 'COMPLETED'); assert.equal(result.summary.bestOffsetMm, 3); assert.equal(result.summary.bestAlignmentErrorMm, 0)
  assert.equal(f.app.snapshot().workcell.execution.run, null); assert.equal(f.app.snapshot().activeExperiments.length, 0)
  await f.app.command('experiment.propose', proposal(scope, 'propose-second-experiment'))
  assert.equal(f.app.snapshot().experiments.history[0].id, result.id)
  assert.deepEqual(f.app.snapshot().experiments.history[0].trials, result.trials)
})

test('independent Stop interrupts an in-flight experiment request and retains its exact owner across projects', async (t) => {
  const f = await fixture(t, { stepMs: 400 }), first = await f.create('First')
  await f.app.command('experiment.propose', proposal(first)); const current = f.app.snapshot().experiments.current
  await f.app.command('experiment.approve', approval(first, current))
  await assert.rejects(f.app.command('conversation.create', { projectId: first.projectId }), /experiment/)
  await assert.rejects(f.app.close(), /experiment/)
  await f.app.command('conversation.send', { ...first, text: 'Plan a tray transfer', requestId: 'busy-guide-fixture' })
  assert.equal(f.app.snapshot().conversation.busy, true)
  const pending = f.app.command('experiment.trial', { ...first, experimentId: current.id, requestId: 'long-trial-fixture', offsetMm: 0 })
  await until(() => f.app.snapshot().experiments.current.phase === 'RUNNING')
  await assert.rejects(f.app.command('experiment.finish', { ...first, experimentId: current.id }), /request is in progress/)
  await f.app.command('experiment.stop', { ...first, experimentId: current.id }); await pending
  assert.equal(f.app.snapshot().experiments.current.phase, 'STOPPED')
  assert.equal(f.app.snapshot().experiments.current.trials[0].result, null)
  await f.app.command('conversation.cancel', first)
  await f.app.command('experiment.propose', proposal(first, 'second-owned-proposal'))
  const owned = f.app.snapshot().experiments.current
  await f.app.command('experiment.approve', approval(first, owned))
  const second = await f.create('Second')
  assert.equal(f.app.snapshot().activeExperiments[0].conversationId, first.conversationId)
  await assert.rejects(f.app.command('experiment.stop', { ...second, experimentId: owned.id }), /experiment.*changed|current experiment/i)
  await f.app.command('experiment.stop', { ...first, experimentId: owned.id })
  assert.equal(f.app.snapshot().activeProjectId, second.projectId)
  assert.equal(f.app.snapshot().activeExperiments.length, 0)
})

test('stale experiment requests never create a host or change another conversation', async (t) => {
  const f = await fixture(t), first = await f.create()
  await f.app.command('conversation.create', { projectId: first.projectId }); const second = f.scope()
  await assert.rejects(f.app.command('experiment.propose', proposal(first)), /conversation changed/)
  await assert.rejects(f.app.command('experiment.propose', { ...proposal(second), conversationId: undefined }), /conversation changed/)
  assert.equal(f.app.snapshot().experiments.current, null)
  await f.app.command('connection.disconnect', second)
  const count = f.hosts.length
  await assert.rejects(f.app.command('experiment.stop', { ...first, experimentId: 'unknown' }), /conversation changed/)
  assert.equal(f.hosts.length, count)
})

test('scripted simulation proposes from chat and measures then revises only after operator approval', async (t) => {
  const f = await fixture(t, { scripted: true }), scope = await f.create()
  await f.app.command('conversation.send', { ...scope, text: 'Find an alignment approach', requestId: 'alignment-conversation' })
  await until(() => !f.app.snapshot().conversation.busy)
  const current = f.app.snapshot().experiments.current
  assert.equal(current.phase, 'PROPOSED'); assert.equal(current.trials.length, 0)
  await f.app.command('experiment.approve', approval(scope, current))
  await until(() => f.app.snapshot().experiments.current.phase === 'COMPLETED')
  const completed = f.app.snapshot().experiments.current
  assert.deepEqual(completed.trials.map((trial) => trial.offsetMm), [0, 1.5, 2.25, 2.625])
  assert.deepEqual(completed.trials.map((trial) => trial.result.alignmentErrorMm), [3, 1.5, 0.75, 0.375])
  assert.match(f.app.snapshot().conversation.messages.at(-1).text, /scripted synthetic experiment|Scripted synthetic trial/)
  assert.equal(f.app.snapshot().workcell.execution.run, null)
})

test('host-loss projection retains historical experiment evidence and offers no executable claim', () => {
  const previous = { projects: [], experiments: { availability: 'simulation-only', current: { id: 'experiment-one', phase: 'RUNNING', trials: [] } }, activeExperiments: [{ experiment: { id: 'experiment-one', phase: 'RUNNING' }, canStop: true }] }
  const lost = unavailableSnapshot(previous)
  assert.equal(lost.experiments.availability, 'unavailable'); assert.equal(lost.experiments.historical, true)
  assert.equal(lost.activeExperiments[0].canStop, false); assert.equal(lost.activeExperiments[0].statusUnavailable, true)
  assert.equal(lost.experiments.current.phase, 'RUNNING'); assert.equal(previous.experiments.availability, 'simulation-only')
  assert.doesNotThrow(() => validateCommand('experiment.stop', { projectId: 'project-one', conversationId: 'conversation-one', experimentId: 'experiment-one' }))
  assert.throws(() => validateCommand('experiment.stop', { experimentId: 'experiment-one' }), /explicit project/)
  assert.throws(() => validateCommand('experiment.propose', { projectId: 'project-one', conversationId: 'conversation-one', executor: 'anything' }), /unsupported fields/)
  assert.throws(() => validateCommand('experiment.executePhysical', {}), /not supported/)
})

test('unapproved proposals survive conversation navigation without blocking quit or gaining approval', async (t) => {
  const f = await fixture(t), first = await f.create()
  await f.app.command('experiment.propose', proposal(first)); const planned = f.app.snapshot().experiments.current
  assert.equal(f.app.snapshot().activeExperiments.length, 0)
  await f.app.command('conversation.create', { projectId: first.projectId })
  assert.equal(f.app.snapshot().experiments.current, null)
  await f.app.command('conversation.select', first)
  assert.equal(f.app.snapshot().experiments.current.id, planned.id)
  assert.equal(f.app.snapshot().experiments.current.phase, 'PROPOSED')
  assert.equal(f.app.snapshot().experiments.current.approvedAt, null)
  assert.equal(f.app.snapshot().experiments.current.trials.length, 0)
  await f.app.close()
})

test('failed approval persistence blocks all trials until repaired storage records a confirmed Stop', async (t) => {
  const f = await fixture(t), scope = await f.create()
  await f.app.command('experiment.propose', proposal(scope)); const planned = f.app.snapshot().experiments.current
  const directory = path.join(f.dataDir, 'harness', 'experiments'), file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith('.json')))
  const saved = await readFile(file)
  await rm(file); await mkdir(file)
  try {
    await assert.rejects(f.app.command('experiment.approve', approval(scope, planned)), /evidence could not be saved/)
    assert.equal(f.app.snapshot().experiments.current.phase, 'OUTCOME_UNKNOWN')
    assert.equal(f.app.snapshot().activeExperiments.length, 1)
    await assert.rejects(f.app.close(), /experiment/)
  } finally { await rm(file, { recursive: true }); await writeFile(file, saved) }
  await assert.rejects(f.app.command('experiment.trial', { ...scope, experimentId: planned.id, requestId: 'no-trial-after-storage-failure', offsetMm: 0 }), /evidence could not be saved/)
  assert.equal(f.app.snapshot().experiments.current.trials.length, 0)
  await f.app.command('experiment.stop', { ...scope, experimentId: planned.id })
  assert.equal(f.app.snapshot().experiments.current.phase, 'STOPPED')
  assert.equal(f.app.snapshot().experiments.error, null)
  assert.equal(f.app.snapshot().activeExperiments.length, 0)
  await f.app.command('conversation.create', { projectId: scope.projectId })
  await f.app.close()
})
