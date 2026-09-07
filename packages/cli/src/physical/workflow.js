import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { observedPhysicalDevices, physicalRouteLines } from './workflow-core.js'
export * from './workflow-core.js'
export { createPhysicalTools as createPhysicalPiTools } from './workflow-core.js'

const STEPS = Object.freeze(['Discover', 'Intent', 'Plan', 'Commission', 'Run', 'Verify'])

function cleanMessage(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
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
    'unassessed',
    'unassessed',
  ]
}

const STATUS_MARK = Object.freeze({
  done: '✓',
  working: '…',
  blocked: '!',
  draft: '◇',
  waiting: '○',
  unassessed: '—',
})

function fit(value, width) {
  // Device labels are data, never terminal control sequences or extra rows.
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
  return stripTerminalSequences(truncateToWidth(text, width, '…'))
}

function terminalWidth(width) {
  return Number.isInteger(width) ? Math.max(0, width) : 100
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
    return ['Commissioning · no draft prepared · no execution authorized by this draft']
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
    ? 'Implementation proposed · not approved · review execution in /workcell.'
    : 'No eligible capability implementation · resolve the reported gaps before requesting another preview.'
  if (state.status === 'unavailable') return `Physical Systems node unavailable · ${state.error} · run /physical to retry`
  if (state.error) return `Planning blocked · ${state.error}`
  if (!state.snapshot) return 'Run /physical, or describe a physical outcome in the editor.'
  if (!observedPhysicalDevices(state.snapshot).length) {
    return 'No hardware observed · connect a device and run /physical to refresh.'
  }
  if (!state.response) return 'Describe the physical outcome in the editor, or run /physical.'
  const interpretation = state.response.interpretation
  if (state.exploration?.status === 'draft') {
    return 'Commissioning draft ready · method and bounds remain unresolved; local review required.'
  }
  if (state.exploration?.status === 'declined') {
    return 'Commissioning paused · no draft prepared; local review required.'
  }
  if (interpretation.status === 'ready') {
    return 'Plan grounded · route and review an implementation before execution approval.'
  }
  if (interpretation.questions?.length) return `Needs input · ${cleanMessage(interpretation.questions[0])}`
  if (interpretation.gaps?.length) return `Commissioning gap · ${cleanMessage(interpretation.gaps[0].detail)}`
  return `Plan ${cleanMessage(interpretation.status)} · not an execution approval.`
}

export function renderPhysicalWorkflow(state, width = 100) {
  const safeWidth = terminalWidth(width)
  const marks = stepStates(state)
  const progress = STEPS.map((step, index) => `${STATUS_MARK[marks[index]]} ${step}`).join('  ')
  const lines = [
    fit('PHYSICAL WORKFLOW', safeWidth),
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
      const identity = label === device.deviceId ? label : `${label} [${device.deviceId}]`
      lines.push(fit(`${device.ready ? '✓' : '!'} ${identity} · ${device.kind} · ${deviceDetail(device)}`, safeWidth))
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
  // Explicit cached details retain every reported requirement, even when the
  // compact status or a commissioning draft highlights only the next step.
  for (const question of state.response?.interpretation?.questions || []) {
    lines.push(fit(`Question · ${cleanMessage(question)}`, safeWidth))
  }
  for (const gap of state.response?.interpretation?.gaps || []) {
    lines.push(fit(`Reported gap · ${cleanMessage(gap.detail)}`, safeWidth))
  }
  for (const line of explorationLines(state.exploration)) lines.push(fit(line, safeWidth))
  for (const line of physicalRouteLines(state.routeReceipt)) lines.push(fit(line, safeWidth))
  lines.push(fit(nextLine(state), safeWidth))
  return lines
}

/** Persistent status only. The complete cached report is available on demand. */
export function renderPhysicalWorkflowSummary(state, width = 100) {
  const safeWidth = terminalWidth(width)
  const marks = stepStates(state)
  const progress = STEPS.slice(0, 4).map((step, index) => `${STATUS_MARK[marks[index]]} ${step}`).join('  ')
  const current = marks[3] === 'draft' ? 3 : marks[2] !== 'waiting' ? 2 : marks[1] !== 'waiting' ? 1 : 0
  const devices = observedPhysicalDevices(state.snapshot)
  const providerErrors = state.snapshot?.discovery?.providerErrors?.length || 0
  const status = state.snapshot ? `${devices.length} observed` : state.status
  const next = providerErrors ? `Discovery partial (${providerErrors}) · ${nextLine(state)}` : nextLine(state)
  return [
    `Physical · ${status}`,
    visibleWidth(progress) <= safeWidth ? progress : `${STATUS_MARK[marks[current]]} ${STEPS[current]}`,
    safeWidth >= 24 ? '/workcell · run controls' : 'Run: /workcell',
    next,
    '/physical-details · inventory, plan and gaps',
  ].map((line) => fit(line, safeWidth))
}

export function createPhysicalWorkflowWidget(getState) {
  return (_tui, theme) => ({
    invalidate() {},
    render(width) {
      return renderPhysicalWorkflowSummary(getState(), width).map((line, index) => {
        if (index === 0) return theme.fg('accent', line)
        if (line.startsWith('!') || /unavailable|blocked|partial/i.test(line)) return theme.fg('warning', line)
        return index === 1 || index === 2 || index === 4 ? theme.fg('muted', line) : line
      })
    },
  })
}
