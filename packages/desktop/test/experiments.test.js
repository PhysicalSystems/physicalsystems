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

async function fixture(t, { scripted = false, stepMs = 25 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ps-desktop-experiments-')), hosts = []
  const catalog = await openCatalog(dataDir)
  const forbidden = async () => assert.fail('Synthetic experiments cannot access a Node, model or credentials')
  const factory = async (options) => {
    const host = await createSimulationHost({ ...options, projectId: path.basename(options.cwd), stepMs })
    hosts.push(host)
    return scripted ? host : { ...host, startExperimentGuide: undefined }
  }
  const app = await createApplication({ dataDir, catalog, env: {}, hostFactory: factory, simulationFactory: factory,
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
