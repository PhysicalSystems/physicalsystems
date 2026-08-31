export const PHYSICAL_DISCOVERY_TOOL = 'inspect_physical_system'
export const PHYSICAL_INTENT_TOOL = 'plan_physical_workflow'
export const PHYSICAL_TOOL_ALLOWLIST = Object.freeze([
  PHYSICAL_DISCOVERY_TOOL,
  PHYSICAL_INTENT_TOOL,
])

const STEPS = Object.freeze(['Discover', 'Intent', 'Plan', 'Commission', 'Run', 'Verify'])

function cleanMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function createPhysicalWorkflowState(nodeOrigin) {
  return Object.freeze({
    nodeOrigin,
    status: 'unchecked',
    snapshot: null,
    response: null,
    requestedIntent: null,
    error: null,
  })
}

export function updatePhysicalWorkflow(state, event) {
  if (!state || typeof state !== 'object') throw new TypeError('Physical workflow state is required')
  if (!event || typeof event !== 'object') throw new TypeError('Physical workflow event is required')
  if (event.type === 'checking') {
    return Object.freeze({ ...state, status: 'checking', error: null })
  }
  if (event.type === 'snapshot') {
    return Object.freeze({
      ...state,
      status: 'connected',
      snapshot: event.snapshot,
      response: null,
      requestedIntent: null,
      error: null,
    })
  }
  if (event.type === 'intent') {
    return Object.freeze({
      ...state,
      status: 'connected',
      response: event.response,
      requestedIntent: cleanMessage(event.requestedIntent),
      error: null,
    })
  }
  if (event.type === 'error') {
    return Object.freeze({
      ...state,
      status: 'unavailable',
      snapshot: null,
      response: null,
      error: cleanMessage(event.error?.message || event.error || 'Physical node unavailable'),
    })
  }
  if (event.type === 'plan-error') {
    return Object.freeze({
      ...state,
      status: state.snapshot ? 'connected' : 'unavailable',
      response: null,
      requestedIntent: cleanMessage(event.requestedIntent),
      error: cleanMessage(event.error?.message || event.error || 'Physical plan rejected'),
    })
  }
  if (event.type === 'reset-intent') {
    return Object.freeze({ ...state, response: null, requestedIntent: null, error: null })
  }
  throw new TypeError(`Unknown physical workflow event: ${event.type}`)
}

function stepStates(state) {
  const discovered = Boolean(state.snapshot)
  const interpretation = state.response?.interpretation
  const intentKnown = Boolean(interpretation)
  const planReady = interpretation?.status === 'ready'
  const planNeedsWork = (intentKnown && !planReady) || Boolean(state.snapshot && state.error)
  return [
    state.status === 'checking' ? 'working' : discovered ? 'done' : state.error ? 'blocked' : 'waiting',
    intentKnown ? 'done' : 'waiting',
    planReady ? 'done' : planNeedsWork ? 'blocked' : 'waiting',
    intentKnown ? 'blocked' : 'waiting',
    'locked',
    'locked',
  ]
}

const STATUS_MARK = Object.freeze({
  done: '✓',
  working: '…',
  blocked: '!',
  waiting: '○',
  locked: '—',
})

function fit(value, width) {
  const text = String(value)
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

function deviceDetail(device) {
  if (!device.detected) return 'not detected'
  if (!device.driverReady) return 'driver unavailable'
  if (!device.calibrationReady) return 'calibration unavailable'
  return device.ready ? 'ready' : 'not ready'
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
  if (!interpretation || !grounding || interpretation.status !== 'ready') return null
  const action = cleanMessage(interpretation.action || 'workflow')
  const objectId = cleanMessage(grounding.objectId || 'configured object')
  const source = cleanMessage(grounding.sourceStationId || 'source')
  const destination = cleanMessage(grounding.destinationStationId || 'destination')
  return `Plan · ${action} ${objectId} · ${source} → ${destination}`
}

function nextLine(state) {
  if (state.status === 'checking') return 'Checking the local Agent without opening hardware…'
  if (state.status === 'unavailable') return `Agent unavailable · ${state.error} · run /physical to retry`
  if (!state.snapshot) return 'Run /physical, or describe a physical outcome in the editor.'
  if (state.error) return `Planning blocked · ${state.error}`
  if (!state.response) return 'Describe the physical outcome in the editor, or run /physical.'
  const interpretation = state.response.interpretation
  if (interpretation.status === 'ready') {
    return 'Plan grounded · commissioning evidence is required; physical execution remains locked.'
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
    lines.push(fit(
      `${snapshot.system.displayName} · ${snapshot.nodeName} · ${snapshot.discovery.summary.ready}/${snapshot.discovery.summary.configured} components ready`,
      safeWidth,
    ))
    for (const device of snapshot.discovery.devices) {
      lines.push(fit(`${device.ready ? '✓' : '!'} ${device.deviceId} · ${device.kind} · ${deviceDetail(device)}`, safeWidth))
    }
  } else {
    lines.push(fit(`Local Agent · ${state.nodeOrigin}`, safeWidth))
  }
  const observation = evidenceLine(state.response)
  if (state.requestedIntent) lines.push(fit(`Intent · ${state.requestedIntent}`, safeWidth))
  const plan = planLine(state.response)
  if (plan) lines.push(fit(plan, safeWidth))
  if (observation) lines.push(fit(observation, safeWidth))
  lines.push(fit(nextLine(state), safeWidth))
  return lines
}

export function compactPhysicalSnapshotForModel(snapshot) {
  return {
    nodeName: snapshot.nodeName,
    system: snapshot.system,
    discovery: {
      observedAt: snapshot.discovery.observedAt,
      snapshotDigest: snapshot.discovery.snapshotDigest,
      bindingDigest: snapshot.discoveryBindingDigest,
      summary: snapshot.discovery.summary,
      devices: snapshot.discovery.devices.map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        roles: device.roles,
        capabilities: device.capabilities,
        detected: device.detected,
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
}) {
  const result = (value, summary) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: { displaySummary: summary },
  })
  const inspect = async () => {
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
      description: 'Read the local Physical Systems Agent discovery snapshot. This checks enrolled device identity, driver, and calibration evidence without opening hardware or authorizing movement.',
      parameters: { type: 'object', additionalProperties: false },
      async execute() {
        const snapshot = await inspect()
        return result(compactPhysicalSnapshotForModel(snapshot), 'Inspected local physical system')
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
          const response = await client.interpret(params?.intent, snapshot.discoveryBindingDigest)
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
