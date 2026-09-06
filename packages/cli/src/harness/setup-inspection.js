import { executionDigest, executionFields, executionHash, executionId, normalizeExecutionStatus } from '../physical/execution-contracts.js'
import { normalizePhysicalCapabilityCatalog, normalizePhysicalRouteRequest, PHYSICAL_ROUTE_RECEIPT_VERSION } from '../physical/route-contracts.js'

const MAX_AGE = 5000, MAX_ROWS = 32, MAX_IMPLEMENTATIONS = 16
const ROUTE_KEYS = ['contractVersion', 'runtimeVersion', 'registrySnapshotDigest', 'hostEvidenceDigest', 'receiptDigest', 'evaluatedAt', 'observedAt',
  'evaluationMonotonicNs', 'assessmentTimestamps', 'policyVersion', 'capabilityId', 'workcellId', 'request', 'decision', 'implementations', 'physicalExecutionAuthorized']
const DECISION_KEYS = ['contract_version', 'request_id', 'request_digest', 'catalog_digest', 'policy_digest', 'state_digest', 'invocation_digest', 'decision_status',
  'selected_implementation_id', 'selected_implementation_digest', 'selected_execution_target', 'request_rejection_codes', 'candidates', 'physical_execution_authorized', 'decision_digest']
const GROUPS = Object.freeze({
  implementation: ['implementation_blocked'], configuration: ['manifest_mismatch'],
  dependencies: ['dependency_missing', 'dependency_mismatch'], calibration: ['calibration_missing', 'calibration_mismatch'],
  artifacts: ['artifact_missing', 'artifact_mismatch'], execution_target: ['execution_target_unavailable', 'execution_target_mismatch'],
  state: ['precondition_missing', 'precondition_unknown', 'precondition_violated', 'precondition_stale', 'precondition_from_future',
    'precondition_invocation_mismatch', 'precondition_state_mismatch', 'precondition_requirement_mismatch'],
  qualification: ['qualification_missing', 'qualification_mismatch', 'qualification_status_not_allowed'],
})
const ACTIONS = Object.freeze({
  implementation: 'Ask the operator or implementation provider to inspect this exact implementation and the reported block. Do not select a fallback automatically.',
  configuration: 'Review the exact capability and implementation configuration with the operator. Configuration changes require a separate approved setup step.',
  dependencies: 'Ask the Node or implementation provider for the exact required drivers and dependency bindings, then verify their installed versions and health through an approved procedure.',
  calibration: 'Ask for this implementation\'s exact calibration requirements and validation procedure. A matching hash or commissioned flag does not validate the physical calibration.',
  artifacts: 'Ask for this implementation\'s exact required artifacts and validation procedure. Do not invent taught positions, paths, controller parameters or artifact bindings.',
  execution_target: 'Have the operator verify the exact configured execution target and its connection through the supported setup procedure; do not dispatch a test command.',
  state: 'Obtain fresh, trusted observations for the exact invocation through the supported observation source. Unknown, stale or violated state must remain blocked; do not open a camera automatically.',
  qualification: 'Review the qualification record and its underlying evidence for this exact physical setup and policy. Simulation or a declared status does not qualify physical operation.',
  unclassified: 'Ask the Node or implementation provider to explain the reported code. Do not infer a repair or bypass the block.',
})
const LIMITATIONS = Object.freeze([
  'This is a read-only setup inventory and explanation of cached records. It does not establish current readiness, approval or permission to execute.',
  'The public capability and normalized route contracts do not expose exact per-implementation driver, calibration or artifact requirements. Unreported details remain unverified.',
  'Route decisions, qualification metadata and discovery observations describe their recorded context and times. A new inspection does not refresh those observations.',
  'Simulation configurations, route qualification labels, matching digests and discovery compatibility flags do not qualify physical operation.',
  'Preparation, approval, Stop, calibration and configuration changes remain in their existing operator-controlled workflows.',
])
const MESSAGES = Object.freeze({
  inspected: 'Setup records inspected without refreshing discovery, routing, configuration or hardware.',
  partial: 'Only part of the setup can be inspected from the available records. Resolve the listed evidence gaps; no readiness is assumed.',
  unavailable: 'Setup evidence is unavailable. Check the local Node connection and obtain discovery and capability records; no missing hardware or calibration is inferred.',
  invalid_request: 'Setup inspection accepts an empty object only. Do not supply paths, URLs, identifiers or execution actions.',
  inspection_busy: 'A setup status read is still pending. No duplicate request was started; wait for it to settle.',
  inspection_timeout: 'Setup status inspection timed out. No readiness is inferred; wait for the bounded read to settle before retrying.',
  inspection_cancelled: 'Setup inspection was cancelled. No hardware or configuration action was requested.',
  context_changed: 'The cached discovery, catalog or route context changed during inspection. Inspect again in the current context.',
  inspection_expired: 'The setup inspection expired before completion. Inspect again; no current readiness is inferred.',
  disposed: 'This setup inspection session has ended.',
})
const check = (value) => { if (!value) throw new TypeError('Invalid cached setup contract') }
const array = (value, maximum) => { check(Array.isArray(value) && value.length <= maximum); return value }
const unique = (values) => check(new Set(values).size === values.length)
const timestamp = (value) => {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19))
  return value
}
const reasonCodes = (value) => array(value, 64).map(executionId)
const finding = (id, status, message, action, codes = []) => ({ id, status, reasonCodes: [...codes], message, action })
const target = (value) => {
  executionFields(value, ['kind', 'digest']); executionId(value.kind); executionHash(value.digest)
  return value
}

// Accept only the intentionally narrowed public projection. In particular, do
// not parse raw hostEvidence/runtimeCatalog/runtimeRequest to invent bindings.
function routeProjection(value) {
  executionFields(value, ROUTE_KEYS)
  check(value.contractVersion === PHYSICAL_ROUTE_RECEIPT_VERSION && value.runtimeVersion === '0.2.0' && value.physicalExecutionAuthorized === false)
  for (const key of ['registrySnapshotDigest', 'hostEvidenceDigest', 'receiptDigest']) executionHash(value[key])
  timestamp(value.observedAt); timestamp(value.evaluatedAt)
  const request = normalizePhysicalRouteRequest(value.request), decision = value.decision
  check(value.capabilityId === request.capabilityId && value.workcellId === request.workcellId)
  executionFields(decision, DECISION_KEYS)
  check(decision.contract_version === 'tinyedge-runtime-physical-skill-route-decision-v1' && decision.physical_execution_authorized === false)
  executionId(decision.request_id)
  for (const key of ['request_digest', 'catalog_digest', 'policy_digest', 'state_digest', 'invocation_digest', 'decision_digest']) executionHash(decision[key])
  check(executionDigest(decision, 'decision_digest') === decision.decision_digest && decision.catalog_digest === request.expectedCatalogDigest)
  check(['selected', 'no_match'].includes(decision.decision_status))
  const codes = reasonCodes(decision.request_rejection_codes)
  const candidates = array(decision.candidates, 512).map((item) => {
    executionFields(item, ['implementation_id', 'implementation_digest', 'mechanism', 'provider', 'execution_target', 'status', 'rejection_codes'])
    executionId(item.implementation_id); executionHash(item.implementation_digest); executionId(item.mechanism); executionId(item.provider); target(item.execution_target)
    check(['selected', 'eligible_not_selected', 'rejected'].includes(item.status))
    reasonCodes(item.rejection_codes)
    check((item.status === 'rejected') === (item.rejection_codes.length > 0))
    return item
  })
  unique(candidates.map((item) => item.implementation_id))
  const selected = candidates.filter((item) => item.status === 'selected')
  if (decision.decision_status === 'selected') {
    check(selected.length === 1 && !codes.length && decision.selected_implementation_id === selected[0].implementation_id
      && decision.selected_implementation_digest === selected[0].implementation_digest
      && executionDigest(target(decision.selected_execution_target)) === executionDigest(selected[0].execution_target))
  } else check(!selected.length && decision.selected_implementation_id === null && decision.selected_implementation_digest === null
    && decision.selected_execution_target === null && (codes.length || candidates.every((item) => item.status === 'rejected')))
  const qualifications = array(value.implementations, 512).map((item) => {
    executionFields(item, ['implementationId', 'qualificationStatus']); executionId(item.implementationId)
    check(['qualified', 'demo_qualified', 'provisional', 'blocked'].includes(item.qualificationStatus)); return item
  })
  unique(qualifications.map((item) => item.implementationId))
  check(qualifications.length === candidates.length && qualifications.every((item) => candidates.some((candidate) => candidate.implementation_id === item.implementationId)))
  return { request, decision, candidates, qualifications, receiptDigest: value.receiptDigest,
    capabilityId: request.capabilityId, workcellId: request.workcellId, observedAt: value.observedAt, evaluatedAt: value.evaluatedAt }
}
function discoveryProjection(value) {
  check(['experimental-physical-candidates-v1', 'experimental-physical-node-state-v1'].includes(value.contractVersion) && value.physicalExecutionAuthorized === false)
  executionHash(value.discoveryBindingDigest); executionHash(value.discovery.snapshotDigest); timestamp(value.discovery.observedAt)
  const devices = array(value.discovery.devices, 512).map((item) => {
    executionId(item.deviceId)
    check(typeof item.detected === 'boolean')
    if (item.adapterId != null) executionId(item.adapterId)
    if (item.adapterStatus != null) check(['available', 'unavailable', 'setup-required'].includes(item.adapterStatus))
    return { deviceId: item.deviceId, adapterId: item.adapterId ?? null, presence: item.detected ? 'observed' : 'not_observed',
      adapterRegistration: item.adapterStatus === 'available' ? 'present' : item.adapterStatus === 'unavailable' ? 'missing' : 'unverified',
      driverHealth: 'unverified', calibration: 'unverified', historical: true }
  })
  unique(devices.map((item) => item.deviceId))
  return { devices, observedAt: value.discovery.observedAt, digest: value.discovery.snapshotDigest,
    partial: Boolean(array(value.discovery.providerErrors ?? [], 64).length) }
}
function empty(code, status = 'unavailable') {
  return { contractVersion: 'physicalsystems-setup-inspection-v1',
    inspection: { status, reasonCode: code, observedAt: null, expiresAt: null, message: MESSAGES[code] },
    service: { availability: 'unavailable', mode: null, configurationInventory: 'unverified' },
    sources: { discovery: { status: 'unavailable', observedAt: null, digest: null, total: 0, shown: 0, truncated: false, historical: true },
      catalog: { status: 'unavailable', observedAt: null, registryDigest: null, total: 0, shown: 0, truncated: false, historical: true },
      route: { status: 'unavailable', receiptDigest: null, evaluatedAt: null, observedAt: null, capabilityId: null, workcellId: null, decisionStatus: null, relationship: 'none', historical: true } },
    devices: [], capabilities: [], configurations: [], implementations: [], checks: [], requestBlockers: [],
    counts: { configurations: null, implementations: 0, configurationTruncated: false, implementationTruncated: false },
    limitations: [...LIMITATIONS], physicalReadiness: 'unverified', physicalExecutionAuthorized: false }
}
function requestBlocker(code) {
  if (['missing_argument', 'unknown_argument', 'argument_type_mismatch', 'argument_out_of_bounds'].includes(code)) return {
    code, message: 'The route request has a missing, unknown or invalid typed input.', action: 'Inspect the capability input schema and ask the operator for the missing or corrected argument. Do not guess a value.' }
  if (['policy_incomplete', 'policy_unknown_implementation'].includes(code)) return {
    code, message: 'The routing policy does not completely identify the intended implementations.', action: 'Ask the Node or setup owner to review the exact routing policy. Do not reorder or select fallback implementations automatically.' }
  if (['catalog_mismatch', 'skill_definition_mismatch', 'workcell_mismatch'].includes(code)) return {
    code, message: 'The route request no longer matches its catalog or workcell context.', action: 'Obtain the current capability catalog and review a new route request before using its result.' }
  if (code === 'unknown_skill') return { code, message: 'The requested capability is unsupported in the reported catalog.', action: 'Inspect the supported capabilities and ask which supported outcome the operator intends.' }
  return { code, message: 'The Node reported an unclassified request blocker.', action: ACTIONS.unclassified }
}
function implementationProjection(candidate, route, service) {
  const metadata = route.qualifications.find((item) => item.implementationId === candidate.implementation_id)
  const installed = service?.availability === 'available' ? service.configurations.filter((item) => item.capabilityId === route.capabilityId
    && item.implementationId === candidate.implementation_id) : null
  const checks = Object.entries(GROUPS).map(([id, codes]) => {
    const reported = candidate.rejection_codes.filter((code) => codes.includes(code))
    let status = 'unverified', message = 'Exact requirements and their validation evidence are not exposed by the public setup contracts.'
    if (id === 'implementation') { status = 'present'; message = 'This implementation record is present in the cached route decision; current availability is not established.' }
    if (id === 'qualification') { status = 'present'; message = 'Qualification status metadata is present in the cached route record; underlying physical qualification evidence is not exposed.' }
    if (id === 'configuration') {
      status = installed === null ? 'unverified' : installed.length ? 'present' : 'missing'
      message = installed === null ? 'Configuration inventory is unavailable; no missing configuration is inferred.'
        : installed.length ? 'A configuration registration matches this capability and implementation ID. It does not establish current readiness or verify calibration.'
          : service.configurations.length ? 'Installed configurations do not match this capability and implementation ID.' : 'No execution configurations were reported by the available status service.'
    }
    if (id === 'state') message = 'Fresh state and readiness have not been inspected. Cached routing observations cannot establish the current state.'
    if (id === 'artifacts' && candidate.mechanism === 'taught-waypoints') message = 'The route names a taught-waypoints mechanism, but exact taught artifacts and their validation evidence are not exposed.'
    if (reported.length) {
      status = reported.some((code) => code.endsWith('_missing') || code === 'execution_target_unavailable') ? 'missing' : 'unverified'
      message = 'The cached Node route reports the listed blockers for this implementation. Missing, mismatched, stale and policy-rejected evidence must be distinguished using those codes.'
    }
    return finding(id, status, message, ACTIONS[id], reported)
  })
  const unknown = candidate.rejection_codes.filter((code) => !Object.values(GROUPS).some((codes) => codes.includes(code)))
  if (unknown.length) checks.push(finding('unclassified', 'unverified', 'The Node reported additional implementation blockers whose meaning is not defined by this client.', ACTIONS.unclassified, unknown))
  return { capabilityId: route.capabilityId, implementationId: candidate.implementation_id, implementationDigest: candidate.implementation_digest,
    routingStatus: candidate.status, recordedQualificationStatus: metadata.qualificationStatus, mode: installed?.length ? service.mode : null,
    historical: true, checks }
}
function project(current, service, startedAt) {
  const result = empty('inspected', 'available')
  result.inspection.observedAt = new Date(startedAt).toISOString(); result.inspection.expiresAt = new Date(startedAt + MAX_AGE).toISOString()
  let discovery, catalog, route, partial = !service || service.availability !== 'available'
  if (service) {
    result.service = { availability: service.availability, mode: service.mode,
      configurationInventory: service.availability === 'available' ? 'reported' : 'unverified' }
    if (service.availability === 'available') {
      result.counts.configurations = service.configurations.length
      result.counts.configurationTruncated = service.configurations.length > MAX_ROWS
    }
  }
  try { if (current.snapshot) discovery = discoveryProjection(current.snapshot) } catch { result.sources.discovery.status = 'invalid' }
  if (discovery) {
    result.devices = discovery.devices.slice(0, MAX_ROWS)
    result.sources.discovery = { status: discovery.partial ? 'partial' : 'cached', observedAt: discovery.observedAt, digest: discovery.digest,
      total: discovery.devices.length, shown: result.devices.length, truncated: discovery.devices.length > MAX_ROWS, historical: true }
    partial ||= discovery.partial
  } else partial = true
  try { if (current.capabilityCatalog) catalog = normalizePhysicalCapabilityCatalog(current.capabilityCatalog) } catch { result.sources.catalog.status = 'invalid' }
  if (catalog) {
    result.capabilities = catalog.capabilities.slice(0, MAX_ROWS).map((item) => ({ capabilityId: item.capabilityId, availableForRouting: item.availableForRouting,
      preconditionCount: item.preconditions.length, reasonCodes: [...item.reasonCodes] }))
    result.sources.catalog = { status: 'cached', observedAt: null, registryDigest: catalog.registryDigest,
      total: catalog.capabilities.length, shown: result.capabilities.length, truncated: catalog.capabilities.length > MAX_ROWS, historical: true }
  } else partial = true
  try {
    if (current.routeReceipt) {
      check(current.routeRelationship === undefined || ['current', 'retired'].includes(current.routeRelationship))
      route = routeProjection(current.routeReceipt)
    }
  } catch { result.sources.route.status = 'invalid' }
  if (route && catalog) {
    const workcell = catalog.workcells.find((item) => item.workcellId === route.workcellId)
    if (route.request.expectedRegistryDigest !== catalog.registryDigest || route.request.expectedCandidateBindingDigest !== catalog.currentCandidateBindingDigest
      || !catalog.capabilities.some((item) => item.capabilityId === route.capabilityId) || !workcell
      || workcell.workcellDigest !== route.request.expectedWorkcellDigest || workcell.catalogDigest !== route.request.expectedCatalogDigest) {
      route = null; result.sources.route.status = 'context_mismatch'
    }
  }
  if (route) {
    result.sources.route = { status: 'cached', receiptDigest: route.receiptDigest, evaluatedAt: route.evaluatedAt, observedAt: route.observedAt,
      capabilityId: route.capabilityId, workcellId: route.workcellId, decisionStatus: route.decision.decision_status,
      relationship: current.routeRelationship ?? 'current', historical: true }
    result.requestBlockers = route.decision.request_rejection_codes.map(requestBlocker)
    result.counts.implementations = route.candidates.length; result.counts.implementationTruncated = route.candidates.length > MAX_IMPLEMENTATIONS
    // Show the Node-selected record even when alternatives exceed the display
    // bound. This changes presentation only; it never selects an implementation.
    const candidates = [...route.candidates.filter((item) => item.status === 'selected'), ...route.candidates.filter((item) => item.status !== 'selected')]
    result.implementations = candidates.slice(0, MAX_IMPLEMENTATIONS).map((candidate) => implementationProjection(candidate, route, service))
  } else partial = true
  if (service?.availability === 'available') {
    const matchesSelected = (item) => route && item.capabilityId === route.capabilityId && item.implementationId === route.decision.selected_implementation_id
    const configurations = [...service.configurations.filter(matchesSelected), ...service.configurations.filter((item) => !matchesSelected(item))]
    result.configurations = configurations.slice(0, MAX_ROWS).map(({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode }) =>
      ({ configurationId, capabilityId, implementationId, configurationDigest, implementationDigest, mode }))
  }
  result.checks = [
    finding('execution_service', service?.availability === 'available' ? 'present' : 'unverified', 'Execution status describes the reported service mode and configuration inventory, not physical readiness.', 'Check the local Node connection and inspect the exact reported mode before reviewing a configuration.'),
    finding('discovery', discovery ? 'present' : 'unverified', 'Cached device discovery can report adapter registration; it does not test driver health or calibration.', 'Obtain a discovery report if needed; opening cameras or testing hardware requires separate approval.'),
    finding('capability_catalog', catalog ? 'present' : 'unverified', 'Capability records declare supported inputs and common preconditions; they do not enumerate every implementation requirement.', 'Inspect the local capability catalog and choose a supported capability without inventing requirements.'),
    finding('route', route ? 'present' : 'unverified', result.sources.route.relationship === 'retired'
      ? 'These records belong to a previous proposal. They explain historical setup evidence; no current route or preparation eligibility is restored.'
      : 'Implementation comparisons are scoped to the cached route and retain the reported blockers for each displayed candidate.',
    'Obtain and review a current capability route for the intended typed invocation before operator preparation. Setup inspection cannot restore a retired proposal.'),
  ]
  partial ||= result.counts.configurationTruncated || result.counts.implementationTruncated || result.sources.discovery.truncated || result.sources.catalog.truncated
  if (partial) {
    const code = !service && !discovery && !catalog && !route ? 'unavailable' : 'partial'
    result.inspection.status = code; result.inspection.reasonCode = code; result.inspection.message = MESSAGES[code]
  }
  return result
}
function identity(value) {
  return [value.generation, value.snapshot, value.snapshot?.discoveryBindingDigest, value.capabilityCatalog, value.capabilityCatalog?.registryDigest,
    value.capabilityCatalog?.currentCandidateBindingDigest, value.routeReceipt, value.routeReceipt?.receiptDigest, value.routeReceipt?.decision?.decision_digest, value.routeRelationship]
}

/** Status-only, operator-neutral inventory. No discovery refresh, route preview,
 * filesystem access, execution history, hardware call or readiness evaluator. */
export function createSetupInspector({ client, getContext = () => ({}), now = Date.now, readTimeoutMs = MAX_AGE } = {}) {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > MAX_AGE) throw new TypeError('Invalid setup inspection timeout')
  let disposed = false, pending = null
  async function inspect(args = {}, { signal } = {}) {
    if (disposed) return empty('disposed', 'disposed')
    if (signal?.aborted) return empty('inspection_cancelled')
    try { executionFields(args, []) } catch { return empty('invalid_request', 'invalid_request') }
    if (pending) return empty('inspection_busy', 'busy')
    let current, original
    try { current = getContext() || {}; original = identity(current) } catch { return empty('unavailable') }
    const startedAt = now(), attempt = { active: true, cancel: null, code: null }
    let timer
    const fail = (code) => empty(code, code === 'disposed' ? 'disposed' : ['context_changed', 'inspection_expired'].includes(code) ? 'stale' : 'unavailable')
    const guard = () => {
      if (disposed) throw 'disposed'
      if (!attempt.active) throw attempt.code
      const latest = identity(getContext() || {})
      if (original.some((value, index) => !Object.is(value, latest[index]))) throw 'context_changed'
      if (now() < startedAt || now() - startedAt >= MAX_AGE) throw 'inspection_expired'
    }
    const interrupted = new Promise((resolve) => { attempt.cancel = (code) => {
      if (attempt.active) { attempt.active = false; attempt.code = code; clearTimeout(timer); resolve(fail(code)) }
    } })
    pending = attempt
    timer = setTimeout(() => attempt.cancel('inspection_timeout'), readTimeoutMs)
    const abort = () => attempt.cancel('inspection_cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    const work = (async () => {
      try {
        guard()
        let service = null
        try { if (client) service = normalizeExecutionStatus(await client.status()) } catch { /* Fixed partial/unavailable projection; no provider diagnostics. */ }
        guard()
        const result = project(current, service, startedAt)
        guard()
        return result
      } catch (code) { return fail(Object.hasOwn(MESSAGES, code) ? code : 'unavailable') }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (pending === attempt) pending = null }
    })()
    return Promise.race([work, interrupted])
  }
  return Object.freeze({ inspect, dispose() { disposed = true; pending?.cancel('disposed') } })
}
