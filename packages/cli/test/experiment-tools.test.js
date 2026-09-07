import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createExperimentController } from '../src/harness/experiments/controller.js'
import { createExperimentTools, EXPERIMENT_TOOL_ALLOWLIST } from '../src/harness/experiments/tools.js'
import { createWorkcellController } from '../src/harness/workcell-controller.js'

async function fixture(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'experiment-tools-'))
  const controller = createExperimentController({ sessionId: 'tools-session', storageDir, stepMs: 0 })
  t.after(async () => { await controller.dispose(); await rm(storageDir, { recursive: true, force: true }) })
  const tools = new Map(createExperimentTools({ getController: () => controller }).map(tool => [tool.name, tool]))
  const invoke = async (name, params = {}) => JSON.parse((await tools.get(name).execute('call', params)).content[0].text)
  return { controller, tools, invoke }
}

test('assistant can propose and measure only after exact operator approval; approval cannot be supplied as a tool field', async t => {
  const { controller, tools, invoke } = await fixture(t)
  assert.deepEqual([...tools.keys()], EXPERIMENT_TOOL_ALLOWLIST)
  assert.equal(tools.has('approve_local_experiment'), false)
  for (const params of [{ goal: 'align', requestId: 'p' }, { goal: 'align', mode: 'physical', requestId: 'p' },
    { goal: 'align', mode: 'simulation', requestId: 'p', approved: true }]) {
    await assert.rejects(invoke('propose_local_experiment', params))
  }
  const proposed = await invoke('propose_local_experiment', { goal: 'align synthetic target', mode: 'simulation', trialLimit: 2, requestId: 'proposal' })
  const experimentId = proposed.current.id
  assert.equal(proposed.physicalExecutionAuthorized, false)
  await assert.rejects(invoke('run_simulated_trial', { experimentId, requestId: 'trial-1', offsetMm: 0 }), { code: 'APPROVAL_REQUIRED' })
  controller.approve({ experimentId, expectedDigest: proposed.current.planDigest })
  const first = await invoke('run_simulated_trial', { experimentId, requestId: 'trial-1', offsetMm: 0 })
  const duplicate = await invoke('run_simulated_trial', { experimentId, requestId: 'trial-1', offsetMm: 0 })
  assert.equal(duplicate.current.trials.length, 1)
  assert.equal(first.current.trials[0].result.alignmentErrorMm, 3)
  const second = await invoke('run_simulated_trial', { experimentId, requestId: 'trial-2', offsetMm: 3 })
  assert.equal(second.current.trials[1].result.alignmentErrorMm, 0)
  const complete = await invoke('finish_local_experiment', { experimentId })
  assert.equal(complete.current.phase, 'COMPLETED')
  assert.equal(complete.current.summary.bestOffsetMm, 3)
})

test('browser shares the exact experiment controller and Stop bypasses assistant and pending-choice busy state', async t => {
  const { controller, invoke } = await fixture(t)
  const workcell = createWorkcellController({ workflow: {}, getExperiments: () => controller })
  const unsubscribe = controller.subscribe(workcell.experimentsChanged)
  t.after(async () => { unsubscribe(); await workcell.dispose() })
  const proposed = await invoke('propose_local_experiment', { goal: 'align', mode: 'simulation', requestId: 'shared' })
  workcell.agentStart('working on another response')
  const experimentId = proposed.current.id
  await workcell.experimentAction('approve', { experimentId, expectedDigest: proposed.current.planDigest })
  assert.equal((await invoke('inspect_local_experiment')).current.phase, 'READY')
  assert.equal(workcell.snapshot().experiments.current.id, experimentId)
  await workcell.experimentAction('stop', { experimentId })
  assert.equal(controller.snapshot().current.phase, 'STOPPED')
  assert.equal(workcell.snapshot().agent.status, 'working')
  await assert.rejects(workcell.experimentAction('trial', { experimentId, requestId: 'forged', offsetMm: 3 }), /Unsupported/)
})

test('tool cancellation stops only its exact synthetic trial and a stale abort cannot stop a later experiment', async t => {
  const { controller } = await fixture(t)
  const tools = new Map(createExperimentTools({ getController: () => controller }).map(tool => [tool.name, tool]))
  const current = controller.propose({ goal: 'cancel synthetic work', mode: 'simulation', requestId: 'cancel-proposal' }).current
  controller.approve({ experimentId: current.id, expectedDigest: current.planDigest })
  const cancellation = new AbortController()
  const pending = tools.get('run_simulated_trial').execute('trial', { experimentId: current.id, requestId: 'cancel-trial', offsetMm: 0 }, cancellation.signal)
  cancellation.abort()
  await pending
  assert.equal(controller.snapshot().current.phase, 'STOPPED')
  const next = controller.propose({ goal: 'new synthetic work', mode: 'simulation', requestId: 'next-proposal' }).current
  const oldSignal = new AbortController()
  controller.approve({ experimentId: next.id, expectedDigest: next.planDigest })
  await tools.get('run_simulated_trial').execute('finished', { experimentId: next.id, requestId: 'finished-trial', offsetMm: 3 }, oldSignal.signal)
  oldSignal.abort()
  assert.equal(controller.snapshot().current.phase, 'READY')
})

test('untrusted storage errors never enter experiment model output', async () => {
  const tool = createExperimentTools({ getController: () => { throw new Error('secret=private-data /private/path') } })[0]
  await assert.rejects(tool.execute('inspect', {}), error => {
    assert.doesNotMatch(error.message, /private-data|private\/path/)
    assert.match(error.message, /Inspect its current state/)
    return true
  })
})
