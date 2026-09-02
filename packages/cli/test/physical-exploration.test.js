import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHYSICAL_COMMISSIONING_DECLINE_LABEL,
  createPhysicalCommissioningDraft,
  promptPhysicalCommissioningDraft,
  recommendPhysicalCommissioningDraft,
} from '../src/physical/exploration.js'

function responseFixture({
  status = 'needs-clarification',
  grounding = {
    objectId: 'sample-one',
    sourceStationId: 'source',
    destinationStationId: 'destination',
  },
  gaps = [{
    gapId: 'robot-manipulation-commissioning',
    kind: 'commissioning-required',
    deviceId: 'robot-one',
    operationIds: ['pick-container', 'place-container'],
    detail: 'The selected device requires qualified operations.',
  }],
  questions = [],
} = {}) {
  return {
    interpretation: {
      status,
      grounding,
      gaps,
      questions,
      interpretationDigest: `sha256:${'a'.repeat(64)}`,
      physicalExecutionAuthorized: false,
    },
    physicalExecutionAuthorized: false,
  }
}

test('creates only a gap-bound commissioning draft from exact node evidence', () => {
  const response = responseFixture()
  assert.deepEqual(recommendPhysicalCommissioningDraft(response), {
    label: 'Resolve reported commissioning gap',
    reason: 'The selected device requires qualified operations.',
    gapIds: ['robot-manipulation-commissioning'],
    deviceIds: ['robot-one'],
    operationIds: ['pick-container', 'place-container'],
    bindings: [{
      gapId: 'robot-manipulation-commissioning',
      deviceId: 'robot-one',
      operationIds: ['pick-container', 'place-container'],
    }],
  })

  const draft = createPhysicalCommissioningDraft(response)
  assert.equal(draft.status, 'draft')
  assert.equal(draft.proposalKind, 'commissioning-gap-resolution-v1')
  assert.equal(draft.interpretationDigest, `sha256:${'a'.repeat(64)}`)
  assert.deepEqual(draft.gapIds, ['robot-manipulation-commissioning'])
  assert.deepEqual(draft.deviceIds, ['robot-one'])
  assert.deepEqual(draft.operationIds, ['pick-container', 'place-container'])
  assert.deepEqual(draft.bindings, [{
    gapId: 'robot-manipulation-commissioning',
    deviceId: 'robot-one',
    operationIds: ['pick-container', 'place-container'],
  }])
  assert.equal(draft.method, null)
  assert.equal(draft.durationMinutes, null)
  assert.equal(draft.maxTrials, null)
  assert.equal(draft.methodSelectionRequired, true)
  assert.equal(draft.boundsSelectionRequired, true)
  assert.equal(draft.requiresLocalApproval, true)
  assert.equal(draft.physicalExecutionAuthorized, false)
  assert.equal(Object.isFrozen(draft), true)
  assert.doesNotMatch(JSON.stringify(draft), /leader arm|fixed camera|SO-101|Bayesian|recommended/i)
})

test('does not draft a remedy for questions, mixed gaps, missing evidence, or ready work', () => {
  const ineligible = [
    null,
    responseFixture({ status: 'ready', gaps: [] }),
    responseFixture({ questions: ['Which destination should be used?'] }),
    responseFixture({ gaps: [{
      gapId: 'device-offline', kind: 'device-unavailable', deviceId: 'robot-one',
      operationIds: ['pick-container'], detail: 'The device is offline.',
    }] }),
    responseFixture({ gaps: [
      responseFixture().interpretation.gaps[0],
      {
        gapId: 'identity', kind: 'qualification-blocked', deviceId: 'robot-one',
        operationIds: ['pick-container'], detail: 'Identity evidence is missing.',
      },
    ] }),
    responseFixture({ gaps: [{
      gapId: 'missing-device-binding', kind: 'commissioning-required', deviceId: null,
      operationIds: ['pick-container'], detail: 'A device binding is required.',
    }] }),
  ]

  for (const response of ineligible) {
    assert.equal(recommendPhysicalCommissioningDraft(response), null)
  }
  assert.throws(
    () => createPhysicalCommissioningDraft(ineligible[2]),
    /not eligible/,
  )
})

test('commissioning evidence is operation-bound and does not require transfer geometry', () => {
  const response = responseFixture({
    grounding: { objectId: null, sourceStationId: null, destinationStationId: null },
    gaps: [{
      gapId: 'camera-qualification',
      kind: 'commissioning-required',
      deviceId: 'camera-one',
      operationIds: ['capture-frame'],
      detail: 'The camera requires a qualified capture operation.',
    }],
  })
  assert.deepEqual(recommendPhysicalCommissioningDraft(response)?.operationIds, ['capture-frame'])
})

test('prompt prepares or declines the same evidence-bound draft without choosing a remedy', async () => {
  const calls = []
  const ctx = {
    ui: {
      async select(prompt, choices) {
        calls.push({ prompt, choices })
        return choices[0]
      },
    },
  }
  const draft = await promptPhysicalCommissioningDraft(ctx, responseFixture())
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /Commissioning gap reported/)
  assert.match(calls[0].choices[0], /gap-bound commissioning draft/)
  assert.equal(calls[0].choices[1], PHYSICAL_COMMISSIONING_DECLINE_LABEL)
  assert.equal(draft.method, null)
  assert.equal(draft.physicalExecutionAuthorized, false)

  const declined = await promptPhysicalCommissioningDraft({
    ui: { async select() { return PHYSICAL_COMMISSIONING_DECLINE_LABEL } },
  }, responseFixture())
  assert.deepEqual(declined, { decision: 'declined' })

  assert.equal(await promptPhysicalCommissioningDraft({
    ui: { async select() { return null } },
  }, responseFixture()), null)
  assert.equal(await promptPhysicalCommissioningDraft({}, responseFixture()), null)
})
