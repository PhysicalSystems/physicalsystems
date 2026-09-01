export const PHYSICAL_COMMISSIONING_DECLINE_LABEL = 'Not now · keep physical execution locked'

const PREPARE_DRAFT_LABEL = 'Prepare a gap-bound commissioning draft · no method or motion selected'

function grounded(interpretation) {
  const value = interpretation?.grounding
  return Boolean(value?.objectId && value?.sourceStationId && value?.destinationStationId)
}

function commissioningEvidence(response) {
  const interpretation = response?.interpretation
  if (interpretation?.status !== 'needs-clarification' || !grounded(interpretation)) return null
  if (!interpretation.interpretationDigest) return null
  if (Array.isArray(interpretation.questions) && interpretation.questions.length) return null
  const gaps = Array.isArray(interpretation.gaps) ? interpretation.gaps : []
  if (!gaps.length || gaps.some((gap) => gap?.kind !== 'commissioning-required')) return null
  if (gaps.some((gap) => !gap?.gapId || !gap?.deviceId
    || !Array.isArray(gap.operationIds) || !gap.operationIds.length)) return null
  const bindings = Object.freeze(gaps.map((gap) => Object.freeze({
    gapId: gap.gapId,
    deviceId: gap.deviceId,
    operationIds: Object.freeze([...gap.operationIds]),
  })))
  return Object.freeze({
    interpretationDigest: interpretation.interpretationDigest,
    gapIds: Object.freeze(gaps.map((gap) => gap.gapId).sort()),
    deviceIds: Object.freeze([...new Set(gaps.map((gap) => gap.deviceId))].sort()),
    operationIds: Object.freeze([
      ...new Set(gaps.flatMap((gap) => gap.operationIds)),
    ].sort()),
    bindings,
    reason: gaps[0].detail || 'The local node reported an unresolved commissioning gap.',
  })
}

export function recommendPhysicalCommissioningDraft(response) {
  const evidence = commissioningEvidence(response)
  if (!evidence) return null
  return Object.freeze({
    label: 'Resolve reported commissioning gap',
    reason: evidence.reason,
    gapIds: evidence.gapIds,
    deviceIds: evidence.deviceIds,
    operationIds: evidence.operationIds,
    bindings: evidence.bindings,
  })
}

export function createPhysicalCommissioningDraft(response) {
  const evidence = commissioningEvidence(response)
  if (!evidence) throw new TypeError('This physical intent is not eligible for a commissioning draft')
  return Object.freeze({
    status: 'draft',
    proposalKind: 'commissioning-gap-resolution-v1',
    label: 'Resolve reported commissioning gap',
    reason: evidence.reason,
    interpretationDigest: evidence.interpretationDigest,
    gapIds: evidence.gapIds,
    deviceIds: evidence.deviceIds,
    operationIds: evidence.operationIds,
    bindings: evidence.bindings,
    method: null,
    durationMinutes: null,
    maxTrials: null,
    methodSelectionRequired: true,
    boundsSelectionRequired: true,
    requiresLocalApproval: true,
    physicalExecutionAuthorized: false,
  })
}

export async function promptPhysicalCommissioningDraft(ctx, response) {
  const recommendation = recommendPhysicalCommissioningDraft(response)
  if (!recommendation || typeof ctx?.ui?.select !== 'function') return null
  const selected = await ctx.ui.select(
    `Commissioning gap reported · ${recommendation.reason}`,
    [PREPARE_DRAFT_LABEL, PHYSICAL_COMMISSIONING_DECLINE_LABEL],
  )
  if (selected == null) return null
  if (selected === PHYSICAL_COMMISSIONING_DECLINE_LABEL) {
    return Object.freeze({ decision: 'declined' })
  }
  if (selected !== PREPARE_DRAFT_LABEL) {
    throw new TypeError('Physical commissioning selection was not recognized')
  }
  return createPhysicalCommissioningDraft(response)
}
