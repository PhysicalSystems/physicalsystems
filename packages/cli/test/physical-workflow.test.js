import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactPhysicalIntentForModel,
  compactPhysicalSnapshotForModel,
  createPhysicalPiTools,
  createPhysicalWorkflowState,
  renderPhysicalWorkflow,
  updatePhysicalWorkflow,
} from '../src/physical/workflow.js'

function snapshotFixture({ ready = true } = {}) {
  return {
    nodeName: 'ubuntu-lab',
    system: { systemId: 'cup-transfer', displayName: 'Cup transfer workcell', workcellId: 'desk-one' },
    discovery: {
      observedAt: '2026-08-31T12:00:00.000Z',
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      summary: {
        configured: 1,
        detected: ready ? 1 : 0,
        driverReady: ready ? 1 : 0,
        calibrationReady: 1,
        ready: ready ? 1 : 0,
        allReady: ready,
      },
      devices: [{
        deviceId: 'overhead-camera',
        kind: 'camera',
        roles: ['observation'],
        capabilities: ['capture-frame'],
        configured: true,
        detected: ready,
        driverReady: ready,
        calibrationReady: true,
        ready,
        stableIdentity: '/dev/v4l/by-id/private-path',
      }],
    },
    discoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
    physicalExecutionAuthorized: false,
  }
}

function intentFixture({ status = 'ready', gaps = [], questions = [] } = {}) {
  return {
    interpretation: {
      status,
      action: status === 'unsupported' ? null : 'transfer',
      grounding: { objectId: 'cup-one', sourceStationId: 'source', destinationStationId: 'destination' },
      workflowIntent: status === 'ready' ? { workflowId: 'transfer-one-cup' } : null,
      requiredOperations: [{ operationId: 'pick-container', effect: 'actuating' }],
      gaps,
      questions,
      interpretationDigest: `sha256:${'b'.repeat(64)}`,
      physicalExecutionAuthorized: false,
    },
    observationEvidence: { kind: 'live-camera', status: 'observed' },
    discoverySnapshotDigest: `sha256:${'a'.repeat(64)}`,
    discoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
    physicalExecutionAuthorized: false,
  }
}

test('workflow renders actual discovery separately from configuration', () => {
  let state = createPhysicalWorkflowState('http://127.0.0.1:8876')
  assert.match(renderPhysicalWorkflow(state).join('\n'), /○ Discover/)
  state = updatePhysicalWorkflow(state, { type: 'snapshot', snapshot: snapshotFixture({ ready: false }) })
  const rendered = renderPhysicalWorkflow(state).join('\n')
  assert.match(rendered, /✓ Discover/)
  assert.match(rendered, /! overhead-camera · camera · not detected/)
  assert.match(rendered, /0\/1 components ready/)
  assert.doesNotMatch(rendered, /yellow|taught motion/i)
})

test('workflow exposes grounded plan but keeps run and verify locked', () => {
  let state = createPhysicalWorkflowState('http://127.0.0.1:8876')
  state = updatePhysicalWorkflow(state, { type: 'snapshot', snapshot: snapshotFixture() })
  state = updatePhysicalWorkflow(state, {
    type: 'intent', response: intentFixture(), requestedIntent: 'Move the cup',
  })
  const rendered = renderPhysicalWorkflow(state).join('\n')
  assert.match(rendered, /✓ Intent/)
  assert.match(rendered, /✓ Plan/)
  assert.match(rendered, /! Commission/)
  assert.doesNotMatch(rendered, /✓ Commission/)
  assert.match(rendered, /— Run/)
  assert.match(rendered, /— Verify/)
  assert.match(rendered, /Intent · Move the cup/)
  assert.match(rendered, /Plan · transfer cup-one · source → destination/)
  assert.match(rendered, /commissioning evidence is required/)
  assert.match(rendered, /execution remains locked/)
})

test('workflow shows the first real question or commissioning gap', () => {
  let state = createPhysicalWorkflowState('http://127.0.0.1:8876')
  state = updatePhysicalWorkflow(state, { type: 'snapshot', snapshot: snapshotFixture() })
  state = updatePhysicalWorkflow(state, {
    type: 'intent',
    response: intentFixture({
      status: 'needs-clarification',
      gaps: [{ gapId: 'missing-skill', kind: 'capability', detail: 'pick-container is not commissioned' }],
      questions: ['Which destination station should receive the container?'],
    }),
    requestedIntent: 'Move it',
  })
  const rendered = renderPhysicalWorkflow(state).join('\n')
  assert.match(rendered, /! Plan/)
  assert.match(rendered, /! Commission/)
  assert.match(rendered, /Needs input · Which destination/)
})

test('a rejected plan preserves fresh discovery without calling the Agent unavailable', () => {
  let state = createPhysicalWorkflowState('http://127.0.0.1:8876')
  state = updatePhysicalWorkflow(state, { type: 'snapshot', snapshot: snapshotFixture() })
  state = updatePhysicalWorkflow(state, {
    type: 'plan-error', error: new Error('intent is outside the bounded grammar'), requestedIntent: 'Do anything',
  })
  const rendered = renderPhysicalWorkflow(state).join('\n')
  assert.match(rendered, /✓ Discover/)
  assert.match(rendered, /! Plan/)
  assert.match(rendered, /Planning blocked · intent is outside/)
  assert.doesNotMatch(rendered, /Agent unavailable/)
})

test('model projections omit local device paths and never grant execution', () => {
  const snapshot = compactPhysicalSnapshotForModel(snapshotFixture())
  assert.equal(snapshot.discovery.devices[0].stableIdentity, undefined)
  assert.doesNotMatch(JSON.stringify(snapshot), /private-path/)
  assert.equal(snapshot.physicalExecutionAuthorized, false)

  const intent = compactPhysicalIntentForModel(intentFixture())
  assert.equal(intent.physicalExecutionAuthorized, false)
  assert.equal(intent.status, 'ready')
  const staticResponse = intentFixture()
  staticResponse.observationEvidence = {
    kind: 'static-state', status: 'configured', sourcePath: '/private/workcell/state.json',
  }
  assert.doesNotMatch(JSON.stringify(compactPhysicalIntentForModel(staticResponse)), /private\/workcell/)
})

test('local physical tools refresh discovery before grounding intent', async () => {
  const calls = []
  const events = []
  const snapshot = snapshotFixture()
  const response = intentFixture()
  const tools = createPhysicalPiTools({
    defineTool: (definition) => definition,
    client: {
      async inspect() { calls.push('inspect'); return snapshot },
      async interpret(intent, digest) { calls.push(['interpret', intent, digest]); return response },
    },
    onSnapshot(value) { events.push(['snapshot', value]) },
    onIntent(value, intent) { events.push(['intent', value, intent]) },
  })

  const plan = tools.find((tool) => tool.name === 'plan_physical_workflow')
  const result = await plan.execute('call-1', { intent: 'Move the cup' })
  assert.deepEqual(calls, [
    'inspect',
    ['interpret', 'Move the cup', snapshot.discoveryBindingDigest],
  ])
  assert.deepEqual(events.map((entry) => entry[0]), ['snapshot', 'intent'])
  assert.equal(JSON.parse(result.content[0].text).physicalExecutionAuthorized, false)
})

test('workflow truncates long terminal lines to the available width', () => {
  let state = createPhysicalWorkflowState('http://127.0.0.1:8876')
  state = updatePhysicalWorkflow(state, { type: 'snapshot', snapshot: snapshotFixture() })
  for (const line of renderPhysicalWorkflow(state, 48)) assert.ok(line.length <= 48)
})
