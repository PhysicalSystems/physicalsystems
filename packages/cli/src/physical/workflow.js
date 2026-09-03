import { READ_AGENT_SKILL_TOOL } from '../harness/agent-skills.js'
import { PHYSICAL_ROUTE_REQUEST_VERSION, normalizePhysicalRouteRequest, physicalRouteReceiptPath } from './route-contracts.js'

export const PHYSICAL_DISCOVERY_TOOL = 'inspect_physical_system'
export const PHYSICAL_INTENT_TOOL = 'plan_physical_workflow'
export const PHYSICAL_CAPABILITIES_TOOL = 'inspect_physical_capabilities'
export const PHYSICAL_ROUTE_TOOL = 'preview_physical_capability'
export const PHYSICAL_TOOL_ALLOWLIST = Object.freeze([
  PHYSICAL_DISCOVERY_TOOL,
  PHYSICAL_INTENT_TOOL,
  PHYSICAL_CAPABILITIES_TOOL,
  PHYSICAL_ROUTE_TOOL,
  READ_AGENT_SKILL_TOOL,
])

const STEPS = Object.freeze(['Discover', 'Intent', 'Plan', 'Commission', 'Run', 'Verify'])

function cleanMessage(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function createPhysicalWorkflowState(nodeOrigin) {
  return Object.freeze({
    nodeOrigin,
    generation: 0,
    status: 'unchecked',
    snapshot: null,
    response: null,
    requestedIntent: null,
    exploration: null,
    agentSkillId: null,
    capabilityCatalog: null,
    routeReceipt: null,
    routeError: null,
    error: null,
  })
}

export function updatePhysicalWorkflow(state, event) {
  if (!state || typeof state !== 'object') throw new TypeError('Physical workflow state is required')
  if (!event || typeof event !== 'object') throw new TypeError('Physical workflow event is required')
  if (event.generation !== undefined && event.generation !== state.generation) return state
  if (['checking', 'catalog-checking', 'route-checking', 'snapshot', 'intent', 'error', 'plan-error', 'reset-intent'].includes(event.type)) {
    state = { ...state, generation: state.generation + 1 }
  }
  if (event.type === 'checking') {
    return Object.freeze({ ...state, status: 'checking', error: null, routeReceipt: null, routeError: null, capabilityCatalog: null })
  }
  if (event.type === 'agent-skill') return Object.freeze({ ...state, agentSkillId: cleanMessage(event.skillId) })
  if (event.type === 'catalog-checking') return Object.freeze({ ...state, capabilityCatalog: null, routeReceipt: null, routeError: null })
  if (event.type === 'route-checking') return Object.freeze({ ...state, routeReceipt: null, routeError: null })
  if (event.type === 'capability-catalog') {
    if (event.catalog?.physicalExecutionAuthorized !== false) throw new TypeError('Physical capability catalog cannot authorize execution')
    return Object.freeze({ ...state, capabilityCatalog: event.catalog, routeReceipt: null, routeError: null })
  }
  if (event.type === 'route') {
    if (event.receipt?.physicalExecutionAuthorized !== false || event.receipt?.decision?.physical_execution_authorized !== false) throw new TypeError('Physical route preview cannot authorize execution')
    return Object.freeze({ ...state, routeReceipt: event.receipt, routeError: null })
  }
  if (event.type === 'route-error') return Object.freeze({ ...state, capabilityCatalog: null, routeReceipt: null, routeError: cleanMessage(event.error?.message || event.error) })
  if (event.type === 'snapshot') {
    return Object.freeze({
      ...state,
      status: 'connected',
      snapshot: event.snapshot,
      response: null,
      requestedIntent: null,
      exploration: null,
      capabilityCatalog: null,
      routeReceipt: null,
      routeError: null,
      error: null,
    })
  }
  if (event.type === 'intent') {
    return Object.freeze({
      ...state,
      status: 'connected',
      response: event.response,
      requestedIntent: cleanMessage(event.requestedIntent),
      exploration: null,
      routeReceipt: null,
      routeError: null,
      error: null,
    })
  }
  if (event.type === 'exploration') {
    if (!state.response) throw new TypeError('Physical commissioning requires a grounded intent')
    if (!event.exploration
      || event.exploration.status !== 'draft'
      || event.exploration.physicalExecutionAuthorized !== false
      || event.exploration.method !== null
      || event.exploration.durationMinutes !== null
      || event.exploration.maxTrials !== null
      || event.exploration.methodSelectionRequired !== true
      || event.exploration.boundsSelectionRequired !== true
      || event.exploration.requiresLocalApproval !== true
      || event.exploration.interpretationDigest
        !== state.response.interpretation?.interpretationDigest) {
      throw new TypeError('A non-authorizing physical commissioning draft is required')
    }
    return Object.freeze({ ...state, exploration: event.exploration, error: null })
  }
  if (event.type === 'exploration-declined') {
    if (!state.response) throw new TypeError('Physical commissioning requires a grounded intent')
    return Object.freeze({
      ...state,
      exploration: Object.freeze({
        status: 'declined',
        physicalExecutionAuthorized: false,
      }),
      error: null,
    })
  }
  if (event.type === 'error') {
    return Object.freeze({
      ...state,
      status: 'unavailable',
      snapshot: null,
      response: null,
      exploration: null,
      capabilityCatalog: null,
      routeReceipt: null,
      routeError: null,
      error: cleanMessage(event.error?.message || event.error || 'Physical node unavailable'),
    })
  }
  if (event.type === 'plan-error') {
    return Object.freeze({
      ...state,
      status: state.snapshot ? 'connected' : 'unavailable',
      response: null,
      requestedIntent: cleanMessage(event.requestedIntent),
      exploration: null,
      routeReceipt: null,
      routeError: null,
      error: cleanMessage(event.error?.message || event.error || 'Physical plan rejected'),
    })
  }
  if (event.type === 'reset-intent') {
    return Object.freeze({ ...state, response: null, requestedIntent: null, exploration: null, capabilityCatalog: null, routeReceipt: null, routeError: null, error: null })
  }
  throw new TypeError(`Unknown physical workflow event: ${event.type}`)
}

function stepStates(state) {
  const discovered = Boolean(state.snapshot)
  const interpretation = state.response?.interpretation
  const intentSubmitted = Boolean(state.requestedIntent || state.routeReceipt)
  const planReady = state.routeReceipt ? state.routeReceipt.decision.decision_status === 'selected' : hasGroundedPlan(interpretation)
  const planNeedsWork = (intentSubmitted && !planReady) || Boolean(state.snapshot && state.error) || Boolean(state.routeError)
  const commissioningDraft = state.exploration?.status === 'draft'
  return [
    state.status === 'checking' ? 'working' : discovered ? 'done' : state.error ? 'blocked' : 'waiting',
    intentSubmitted ? 'done' : 'waiting',
    planReady ? 'done' : planNeedsWork ? 'blocked' : 'waiting',
    commissioningDraft ? 'draft' : intentSubmitted ? 'blocked' : 'waiting',
    'locked',
    'locked',
  ]
}

const STATUS_MARK = Object.freeze({
  done: '✓',
  working: '…',
  blocked: '!',
  draft: '◇',
  waiting: '○',
  locked: '—',
})

function fit(value, width) {
  const text = String(value)
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

function deviceDetail(device) {
  if (device.readiness === 'detected') return 'detected · adapter not found'
  if (device.readiness === 'adapter-available') return 'detected · adapter available'
  if (device.readiness === 'setup-required') return 'detected · adapter setup required'
  if (device.readiness === 'commissioned') return 'commissioned · readiness checks pending'
  if (device.readiness === 'ready') return 'ready'
  if (!device.driverReady) return 'detected · adapter unavailable'
  if (!device.calibrationReady) return 'detected · commissioning required'
  return device.ready ? 'ready' : 'detected · not ready'
}

export function observedPhysicalDevices(snapshot) {
  const devices = snapshot?.discovery?.devices
  return Array.isArray(devices) ? devices.filter((device) => device?.detected === true) : []
}

function evidenceLine(response) {
  const evidence = response?.observationEvidence
  if (!evidence || typeof evidence !== 'object') return null
  if (evidence.kind === 'live-camera') {
    return evidence.status ? `Observation · camera ${cleanMessage(evidence.status)}` : 'Observation · live camera'
  }
  if (evidence.kind === 'static-state') return 'Observation · configured state (not live camera evidence)'
  return null
}

function planLine(response) {
  const interpretation = response?.interpretation
  const grounding = interpretation?.grounding
  if (!hasGroundedPlan(interpretation)) return null
  const action = cleanMessage(interpretation.action || 'workflow')
  if (grounding?.objectId && grounding?.sourceStationId && grounding?.destinationStationId) {
    return `Plan · ${action} ${cleanMessage(grounding.objectId)} · ${cleanMessage(grounding.sourceStationId)} → ${cleanMessage(grounding.destinationStationId)}`
  }
  const operationCount = Array.isArray(interpretation.requiredOperations)
    ? interpretation.requiredOperations.length
    : 0
  return `Plan · ${action}${operationCount ? ` · ${operationCount} required operation${operationCount === 1 ? '' : 's'}` : ''}`
}

function groundingLine(response) {
  const interpretation = response?.interpretation
  const grounding = interpretation?.grounding
  if (!interpretation || !grounding || hasGroundedPlan(interpretation)) return null
  if (!grounding.objectId || !grounding.sourceStationId || !grounding.destinationStationId) return null
  const action = cleanMessage(interpretation.action || 'workflow')
  return `Grounding · ${action} ${cleanMessage(grounding.objectId)} · ${cleanMessage(grounding.sourceStationId)} → ${cleanMessage(grounding.destinationStationId)}`
}

function explorationLines(exploration) {
  if (!exploration) return []
  if (exploration.status === 'declined') {
    return ['Commissioning · no draft prepared · physical execution remains locked']
  }
  if (exploration.status !== 'draft') return []
  const gaps = (exploration.gapIds || []).map(cleanMessage).join(', ')
  const operations = (exploration.operationIds || []).map(cleanMessage).join(', ')
  return [
    `Commissioning draft · ${cleanMessage(exploration.label)}`,
    `Bound evidence · ${gaps || 'reported gap'} · operations: ${operations || 'reported operations'}`,
    'Required next · local node must supply an eligible method and safe bounds',
    'Gate · draft only · local review and approval required before any motion',
  ]
}

function hasGroundedPlan(interpretation) {
  return Boolean(interpretation?.status === 'ready' && interpretation.workflowIntent)
}

function nextLine(state) {
  if (state.status === 'checking') return 'Checking the local Physical Systems node without opening hardware…'
  if (state.routeError) return `Capability preview blocked · ${state.routeError}`
  if (state.routeReceipt) return state.routeReceipt.decision.decision_status === 'selected'
    ? 'Implementation proposed · preview only · Run and Verify remain locked.'
    : 'No eligible capability implementation · resolve the reported gaps before requesting another preview.'
  if (state.status === 'unavailable') return `Physical Systems node unavailable · ${state.error} · run /physical to retry`
  if (!state.snapshot) return 'Run /physical, or describe a physical outcome in the editor.'
  if (!observedPhysicalDevices(state.snapshot).length) {
    return 'No hardware observed · connect a device and run /physical to refresh.'
  }
  if (state.error) return `Planning blocked · ${state.error}`
  if (!state.response) return 'Describe the physical outcome in the editor, or run /physical.'
  const interpretation = state.response.interpretation
  if (state.exploration?.status === 'draft') {
    return 'Commissioning draft ready · method and bounds remain unresolved; execution remains locked.'
  }
  if (state.exploration?.status === 'declined') {
    return 'Commissioning paused · no draft prepared; physical execution remains locked.'
  }
  if (interpretation.status === 'ready') {
    return 'Plan grounded · the physical execution endpoint remains locked.'
  }
  if (interpretation.questions?.length) return `Needs input · ${cleanMessage(interpretation.questions[0])}`
  if (interpretation.gaps?.length) return `Commissioning gap · ${cleanMessage(interpretation.gaps[0].detail)}`
  return `Plan ${cleanMessage(interpretation.status)} · physical execution is locked.`
}

export function renderPhysicalWorkflow(state, width = 100) {
  const safeWidth = Number.isInteger(width) && width > 20 ? width : 100
  const marks = stepStates(state)
  const progress = STEPS.map((step, index) => `${STATUS_MARK[marks[index]]} ${step}`).join('  ')
  const lines = [
    'PHYSICAL WORKFLOW',
    fit(progress, safeWidth),
  ]
  if (state.snapshot) {
    const { snapshot } = state
    const devices = observedPhysicalDevices(snapshot)
    const ready = devices.filter((device) => device.ready).length
    lines.push(fit(
      `Physical Systems node · ${snapshot.nodeName} · ${ready}/${devices.length} devices ready`,
      safeWidth,
    ))
    for (const device of devices) {
      const label = device.displayName || device.deviceId
      lines.push(fit(`${device.ready ? '✓' : '!'} ${label} · ${device.kind} · ${deviceDetail(device)}`, safeWidth))
    }
    const providerErrors = snapshot.discovery.providerErrors || []
    if (providerErrors.length) {
      lines.push(fit(`Discovery partial · ${providerErrors.length} provider${providerErrors.length === 1 ? '' : 's'} reported issues`, safeWidth))
    }
  } else {
    lines.push(fit(`Physical Systems node · ${state.nodeOrigin}`, safeWidth))
  }
  const observation = evidenceLine(state.response)
  if (state.agentSkillId) lines.push(fit(`Agent Skill · ${state.agentSkillId} · instructions only`, safeWidth))
  if (state.capabilityCatalog) lines.push(fit(`Physical capabilities · ${state.capabilityCatalog.capabilities.length} registered · ${state.capabilityCatalog.capabilities.filter((item) => item.availableForRouting).length} typed for routing`, safeWidth))
  if (state.requestedIntent) lines.push(fit(`Intent · ${state.requestedIntent}`, safeWidth))
  const plan = planLine(state.response)
  const grounding = groundingLine(state.response)
  if (plan) lines.push(fit(plan, safeWidth))
  if (grounding) lines.push(fit(grounding, safeWidth))
  if (observation) lines.push(fit(observation, safeWidth))
  for (const line of explorationLines(state.exploration)) lines.push(fit(line, safeWidth))
  for (const line of physicalRouteLines(state.routeReceipt)) lines.push(fit(line, safeWidth))
  lines.push(fit(nextLine(state), safeWidth))
  return lines
}

const ROUTE_REASON_LABELS = Object.freeze({
  precondition_unknown: 'Required physical state is unknown',
  precondition_missing: 'Required observation is missing',
  precondition_violated: 'A required physical condition is not met',
  precondition_stale: 'Required observation is stale',
  precondition_from_future: 'Observation timing is invalid',
  precondition_invocation_mismatch: 'Observation belongs to a different invocation',
  precondition_state_mismatch: 'Observation belongs to a different physical state',
  precondition_requirement_mismatch: 'Observation does not establish the required condition',
  qualification_status_not_allowed: 'Qualification does not meet local policy',
  qualification_missing: 'Qualification evidence is missing',
  qualification_mismatch: 'Qualification evidence no longer matches',
  calibration_missing: 'Required calibration is missing',
  calibration_mismatch: 'Calibration has changed',
  artifact_missing: 'Implementation artifact is unavailable',
  artifact_mismatch: 'Implementation artifact has changed',
  dependency_missing: 'A required dependency is missing',
  dependency_mismatch: 'A required dependency has changed',
  implementation_blocked: 'Capability implementation is blocked by local qualification or policy',
  execution_target_unavailable: 'Execution target is unavailable',
  execution_target_mismatch: 'Execution target does not match',
  operator_approval_required: 'Separate operator approval is required',
})

export function physicalRouteReason(code) {
  return ROUTE_REASON_LABELS[code] || `Host rejection: ${cleanMessage(code)}`
}

export function physicalRouteLines(receipt) {
  if (!receipt) return []
  const decision = receipt.decision
  const lines = [
    `Physical capability · ${cleanMessage(receipt.capabilityId)} · workcell ${cleanMessage(receipt.workcellId)}`,
    `Invocation · ${receipt.request.arguments.map((argument) => `${argument.name}=${cleanMessage(argument.value)}`).join(' · ')}`,
    `Route preview · ${decision.decision_status === 'selected' ? 'implementation selected' : 'no eligible implementation'}`,
  ]
  for (const candidate of decision.candidates) {
    const qualification = receipt.implementations.find((entry) => entry.implementationId === candidate.implementation_id)?.qualificationStatus
    lines.push(`Capability implementation · ${cleanMessage(candidate.implementation_id)} · ${cleanMessage(candidate.status)}`)
    lines.push(`  Method · ${cleanMessage(candidate.mechanism)} · provider ${cleanMessage(candidate.provider)} · qualification ${cleanMessage(qualification)}`)
    if (candidate.status === 'selected') lines.push('  Eligible under the evaluated local policy; not approved for execution')
    for (const code of candidate.rejection_codes) lines.push(`  ! ${physicalRouteReason(code)}`)
  }
  for (const code of decision.request_rejection_codes) lines.push(`! ${physicalRouteReason(code)}`)
  lines.push(`Evidence evaluated · ${receipt.evaluatedAt} · policy ${cleanMessage(receipt.policyVersion.policyId)}`)
  lines.push(`Route receipt · ${receipt.receiptDigest}`)
  return lines
}

export function compactPhysicalSnapshotForModel(snapshot) {
  const devices = observedPhysicalDevices(snapshot)
  return {
    discovery: {
      observedAt: snapshot.discovery.observedAt,
      snapshotDigest: snapshot.discovery.snapshotDigest,
      bindingDigest: snapshot.discoveryBindingDigest,
      summary: {
        observed: devices.length,
        adapterReady: devices.filter((device) => device.driverReady).length,
        commissioned: devices.filter((device) => device.calibrationReady).length,
        ready: devices.filter((device) => device.ready).length,
        allReady: devices.length > 0 && devices.every((device) => device.ready),
      },
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        transport: device.transport ?? null,
        roles: device.roles,
        capabilities: device.capabilities,
        detected: device.detected,
        adapterStatus: device.adapterStatus ?? null,
        commissioningStatus: device.commissioningStatus ?? null,
        readiness: device.readiness ?? (device.ready ? 'ready' : 'setup-required'),
        driverReady: device.driverReady,
        calibrationReady: device.calibrationReady,
        ready: device.ready,
      })),
    },
    physicalExecutionAuthorized: false,
  }
}

export function compactPhysicalIntentForModel(response) {
  const interpretation = response.interpretation
  const observation = response.observationEvidence || {}
  return {
    status: interpretation.status,
    action: interpretation.action ?? null,
    grounding: interpretation.grounding,
    workflowIntent: interpretation.workflowIntent,
    requiredOperations: interpretation.requiredOperations,
    gaps: interpretation.gaps,
    questions: interpretation.questions,
    interpretationDigest: interpretation.interpretationDigest,
    discoverySnapshotDigest: response.discoverySnapshotDigest,
    discoveryBindingDigest: response.discoveryBindingDigest,
    observationEvidence: {
      kind: observation.kind ?? null,
      status: observation.status ?? null,
      observationDigest: observation.observationDigest ?? null,
      cameraOpened: observation.cameraOpened === true,
      rawFramePersisted: observation.rawFramePersisted === true,
      physicalExecutionAuthorized: false,
      claim: observation.claim ?? null,
    },
    physicalExecutionAuthorized: false,
  }
}

export function createPhysicalPiTools({
  defineTool,
  client,
  onSnapshot,
  onIntent,
  onError,
  onPlanError,
  onCatalog,
  onRoute,
  onRouteError,
  onRouteChecking,
}) {
  const result = (value, summary) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: { displaySummary: summary },
  })
  const inspect = async () => {
    onRouteChecking?.('checking')
    try {
      const snapshot = await client.inspect()
      onSnapshot?.(snapshot)
      return snapshot
    } catch (error) {
      onError?.(error)
      throw error
    }
  }
  return [
    defineTool({
      name: PHYSICAL_DISCOVERY_TOOL,
      label: 'Inspect physical system',
      description: 'Read the local Physical Systems node discovery snapshot. It reports only observed device candidates and their adapter, commissioning, and readiness state without opening hardware or authorizing movement.',
      parameters: { type: 'object', additionalProperties: false },
      async execute() {
        const snapshot = await inspect()
        return result(compactPhysicalSnapshotForModel(snapshot), 'Inspected local physical system')
      },
    }),
    defineTool({
      name: PHYSICAL_CAPABILITIES_TOOL,
      label: 'Inspect physical capabilities',
      description: 'Read the node\'s registered physical capabilities, typed input contracts and workcell bindings. This is not device execution, qualification or an Agent Skill catalog. Use exact returned identifiers and digests for route previews; do not invent missing capabilities.',
      parameters: { type: 'object', additionalProperties: false },
      async execute(_toolCallId, params = {}) {
        const generation = onRouteChecking?.('catalog-checking')
        try {
          if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) throw new TypeError('Physical capability inspection accepts no inputs')
          const catalog = await client.capabilities()
          if (onCatalog?.(catalog, generation) === false) throw new Error('Capability catalog superseded by a newer workflow request')
          return result(catalog, 'Inspected registered physical capabilities')
        } catch (error) {
          onRouteError?.(error, generation)
          throw error
        }
      },
    }),
    defineTool({
      name: PHYSICAL_ROUTE_TOOL,
      label: 'Preview physical capability',
      description: 'Request the local node\'s deterministic capability implementation selection for one typed invocation. Copy context digests from inspect_physical_capabilities. The node supplies live evidence and policy; callers cannot provide readiness, qualification or approval. This only produces a route receipt and never moves hardware.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['capabilityId', 'workcellId', 'arguments', 'expectedRegistryDigest', 'expectedCandidateBindingDigest', 'expectedCatalogDigest', 'expectedWorkcellDigest'],
        properties: {
          capabilityId: { type: 'string', minLength: 1, maxLength: 128 },
          workcellId: { type: 'string', minLength: 1, maxLength: 128 },
          arguments: {
            type: 'array', maxItems: 128, description: 'Typed arguments sorted by their exact field name, with no duplicates.',
            items: {
              type: 'object', additionalProperties: false, required: ['name', 'value_type', 'value'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 128 },
                value_type: { type: 'string', enum: ['boolean', 'integer', 'number', 'string', 'identifier', 'digest'] },
                value: { anyOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string', maxLength: 512 }] },
              },
            },
          },
          ...Object.fromEntries(['expectedRegistryDigest', 'expectedCandidateBindingDigest', 'expectedCatalogDigest', 'expectedWorkcellDigest'].map((name) => [name, { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }])),
        },
      },
      async execute(_toolCallId, params) {
        const generation = onRouteChecking?.('route-checking')
        try {
          if (!params || typeof params !== 'object' || Array.isArray(params) || Object.hasOwn(params, 'contractVersion')) throw new TypeError('Use only the declared capability preview tool inputs')
          const request = normalizePhysicalRouteRequest({ ...params, contractVersion: PHYSICAL_ROUTE_REQUEST_VERSION })
          const receipt = await client.previewCapability(request)
          if (onRoute?.(receipt, generation) === false) throw new Error('Capability preview superseded by a newer workflow request')
          return result({ ...receipt, receiptUrl: `${client.origin}${physicalRouteReceiptPath(receipt.receiptDigest)}` }, 'Previewed capability implementation selection; no movement')
        } catch (error) {
          onRouteError?.(error, generation)
          throw error
        }
      },
    }),
    defineTool({
      name: PHYSICAL_INTENT_TOOL,
      label: 'Plan physical workflow',
      description: 'Ground one operator-described physical outcome against a fresh local discovery snapshot and observation. This can expose questions and commissioning gaps but cannot authorize or execute motion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['intent'],
        properties: {
          intent: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'The operator\'s physical outcome in their own words.',
          },
        },
      },
      async execute(_toolCallId, params) {
        const snapshot = await inspect()
        try {
          const response = await client.interpret(
            params?.intent,
            snapshot.discoveryBindingDigest,
            snapshot,
          )
          onIntent?.(response, params?.intent)
          return result(compactPhysicalIntentForModel(response), 'Grounded physical workflow intent')
        } catch (error) {
          onPlanError?.(error, params?.intent)
          throw error
        }
      },
    }),
  ]
}

export function createPhysicalWorkflowWidget(getState) {
  return (_tui, theme) => ({
    invalidate() {},
    render(width) {
      return renderPhysicalWorkflow(getState(), width).map((line, index) => {
        if (index === 0) return theme.fg('accent', line)
        if (line.startsWith('✓')) return theme.fg('success', line)
        if (line.startsWith('!') || line.includes('unavailable')) return theme.fg('warning', line)
        return index === 1 ? theme.fg('muted', line) : line
      })
    },
  })
}
