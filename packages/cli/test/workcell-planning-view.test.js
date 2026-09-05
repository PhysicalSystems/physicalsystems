import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createPhysicalNodeClient, normalizePhysicalCandidateSnapshot, PHYSICAL_CANDIDATE_SNAPSHOT_VERSION,
} from '../src/physical/node-client.js'
import {
  createPhysicalPiTools, createPhysicalWorkflowState, updatePhysicalWorkflow,
} from '../src/physical/workflow.js'
import { view } from './fixtures/workcell-browser.js'

const routes = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url), 'utf8'))

function candidateSnapshot() {
  return {
    contractVersion: PHYSICAL_CANDIDATE_SNAPSHOT_VERSION, nodeName: 'fixture-node',
    observedAt: '2026-09-05T10:00:00.000Z', snapshotDigest: `sha256:${'a'.repeat(64)}`,
    candidates: [{
      candidateId: 'camera-one', displayName: 'Fixture camera', deviceClass: 'camera', transport: 'v4l2',
      providerId: 'fixture-provider', detected: true, observedIdentity: 'fixture-camera-one', identityStability: 'stable',
      adapter: { status: 'available', adapterId: 'fixture-camera-adapter', detail: null },
      capabilities: ['capture-frame'], properties: {}, commissioned: false, ready: false,
    }],
    providers: [{ providerId: 'fixture-provider', status: 'ok', candidateCount: 1, detail: null }],
    summary: { detected: 1, adapterAvailable: 1, setupRequired: 0, commissioned: 0, ready: 0 },
    physicalExecutionAuthorized: false,
  }
}

function discoveredWorkflow() {
  return updatePhysicalWorkflow(createPhysicalWorkflowState('http://127.0.0.1:8876'), {
    type: 'snapshot', snapshot: normalizePhysicalCandidateSnapshot(candidateSnapshot()),
  })
}

function interpretation({ status = 'needs-clarification', questions = [], gaps = [] } = {}) {
  return {
    interpretation: {
      status, action: status === 'unsupported' ? null : 'transfer',
      grounding: { objectId: null, sourceStationId: null, destinationStationId: null },
      workflowIntent: status === 'ready' ? { workflowId: 'fixture-transfer' } : null,
      requiredOperations: [], questions, gaps, interpretationDigest: `sha256:${'b'.repeat(64)}`,
      physicalExecutionAuthorized: false,
    },
    physicalExecutionAuthorized: false,
  }
}

function contents(element) {
  return [element.textContent, ...element.children.map(contents)].filter(Boolean).join('\n')
}

async function showWorkflow(t, workflow) {
  const ui = await view(t)
  await ui.push({ ...ui.state(), workflow })
  assert.equal(ui.requests.length, 0, 'planning display does not request camera frames')
  assert.equal(ui.actions.length, 0, 'planning display does not start capture or execute hardware')
  return { ui, state: ui.elements.get('proposal-state').textContent, text: contents(ui.elements.get('proposal')) }
}

test('candidate-only planning displays its real configuration blocker and preserves the discovered inventory', async (t) => {
  const calls = []
  const client = createPhysicalNodeClient({ fetchImpl: async (url) => {
    calls.push(url.pathname)
    return url.pathname === '/v2/physical/candidates'
      ? Response.json(candidateSnapshot())
      : Response.json({ error: 'commissioned physical system is not configured' }, { status: 409 })
  } })
  let workflow = createPhysicalWorkflowState(client.origin)
  const tools = createPhysicalPiTools({
    defineTool: tool => tool, client,
    onSnapshot: snapshot => { workflow = updatePhysicalWorkflow(workflow, { type: 'snapshot', snapshot }) },
    onPlanError: (error, requestedIntent) => { workflow = updatePhysicalWorkflow(workflow, { type: 'plan-error', error, requestedIntent }) },
  })
  await assert.rejects(tools.find(tool => tool.name === 'plan_physical_workflow').execute('candidate-plan', {
    intent: 'Transfer the container from the source to the destination',
  }), error => error.code === 'PHYSICAL_COMMISSIONING_REQUIRED')
  assert.deepEqual(calls, ['/v2/physical/candidates', '/v1/physical/state'])
  const result = await showWorkflow(t, workflow)
  assert.equal(result.ui.elements.get('device-count').textContent, '1')
  assert.match(contents(result.ui.elements.get('devices')), /Fixture camera/)
  assert.equal(result.state, 'BLOCKED')
  assert.match(result.text, /Planning requires a commissioned physical-system configuration/)
  assert.doesNotMatch(result.text, /A proposal appears after/)
})

test('rejected routes preserve their actual stale or unknown reasons without prescribing commissioning', async (t) => {
  for (const name of ['stale', 'unknown']) await t.test(name, async (t) => {
    const workflow = updatePhysicalWorkflow(discoveredWorkflow(), { type: 'route', receipt: routes[name] })
    const result = await showWorkflow(t, workflow)
    assert.equal(result.state, 'NO ELIGIBLE IMPLEMENTATION')
    assert.match(result.text, new RegExp(`precondition ${name}`))
    assert.doesNotMatch(result.state, /COMMISSIONING|APPROVED/)
    assert.equal(workflow.routeReceipt.physicalExecutionAuthorized, false)
    assert.equal(workflow.routeReceipt.decision.physical_execution_authorized, false)
  })
})

test('selected route remains an implementation proposal without approval or execution', async (t) => {
  const workflow = updatePhysicalWorkflow(discoveredWorkflow(), { type: 'route', receipt: routes.selected })
  const result = await showWorkflow(t, workflow)
  assert.equal(result.state, 'SELECTED · NOT APPROVED')
  assert.match(result.text, /a-waypoint/)
  assert.match(result.text, /not a live authorization/)
  assert.equal(workflow.routeReceipt.physicalExecutionAuthorized, false)
})

test('clarification displays every returned question and gap with a needs-input state', async (t) => {
  const questions = ['Which container should be transferred?', 'Which destination should receive it?']
  const gaps = [
    { gapId: 'robot', kind: 'commissioning-required', detail: 'Robot pick qualification is missing.' },
    { gapId: 'camera', kind: 'configuration-required', detail: 'Camera observation producer is missing.' },
  ]
  const workflow = updatePhysicalWorkflow(discoveredWorkflow(), {
    type: 'intent', requestedIntent: 'Transfer a container', response: interpretation({ questions, gaps }),
  })
  const result = await showWorkflow(t, workflow)
  assert.equal(result.state, 'NEEDS INPUT')
  for (const question of questions) assert.ok(result.text.includes(question))
  for (const gap of gaps) assert.ok(result.text.includes(gap.detail))
})

test('reported setup gaps without questions display a blocked state', async (t) => {
  const workflow = updatePhysicalWorkflow(discoveredWorkflow(), {
    type: 'intent', requestedIntent: 'Transfer a container',
    response: interpretation({ gaps: [{ gapId: 'setup', kind: 'configuration-required', detail: 'No commissioned host configuration is available.' }] }),
  })
  const result = await showWorkflow(t, workflow)
  assert.equal(result.state, 'BLOCKED')
  assert.match(result.text, /No commissioned host configuration is available/)
})

test('unsupported operation and grounded plan states remain distinct from waiting or execution approval', async (t) => {
  for (const [status, expected] of [['unsupported', 'UNSUPPORTED'], ['ready', 'PLAN GROUNDED']]) await t.test(status, async (t) => {
    const workflow = updatePhysicalWorkflow(discoveredWorkflow(), {
      type: 'intent', requestedIntent: 'A bounded operation', response: interpretation({ status }),
    })
    const result = await showWorkflow(t, workflow)
    assert.equal(result.state, expected)
    assert.doesNotMatch(result.state, /APPROVED|RUNNING|VERIFIED/)
  })
})

test('an unavailable capability service preserves its specific error without implying an unsupported operation', async (t) => {
  const workflow = updatePhysicalWorkflow(discoveredWorkflow(), {
    type: 'route-error', error: new Error('Physical node request failed: Pinned Runtime unavailable'),
  })
  const result = await showWorkflow(t, workflow)
  assert.equal(result.state, 'UNAVAILABLE')
  assert.match(result.text, /Pinned Runtime unavailable/)
})

test('the untouched proposal remains waiting until the operator requests a plan', async (t) => {
  const result = await showWorkflow(t, discoveredWorkflow())
  assert.equal(result.state, 'WAITING')
  assert.match(result.text, /A proposal appears after/)
})
