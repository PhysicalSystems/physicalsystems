import { createHash } from 'node:crypto'

// Client-side contract validation only. Eligibility and ordering belong to Runtime.
export const PHYSICAL_CAPABILITY_CATALOG_VERSION = 'experimental-physical-capability-catalog-v1'
export const PHYSICAL_ROUTE_REQUEST_VERSION = 'experimental-physical-route-preview-request-v1'
export const PHYSICAL_ROUTE_RECEIPT_VERSION = 'experimental-physical-route-receipt-v1'
const RUNTIME_DECISION_VERSION = 'tinyedge-runtime-physical-skill-route-decision-v1'
const RUNTIME_REQUEST_VERSION = 'tinyedge-runtime-physical-skill-route-request-v1'
const SCALAR_TYPES = ['boolean', 'integer', 'number', 'string', 'identifier', 'digest']
const REQUEST_FIELDS = [
  'contractVersion', 'capabilityId', 'workcellId', 'arguments',
  'expectedRegistryDigest', 'expectedCandidateBindingDigest',
  'expectedCatalogDigest', 'expectedWorkcellDigest',
]

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function exact(value, keys, label) {
  object(value, label)
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${label} has unsupported or missing fields`)
  return value
}

function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new TypeError(`${label} must be bounded printable text`)
  }
  return value
}

function id(value, label) {
  const result = text(value, label, 128)
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(result)) throw new TypeError(`${label} must be an identifier`)
  return result
}

export function routeDigest(value, label = 'route digest') {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must be a sha256 digest`)
  return value
}

function array(value, label, max = 512) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label} must be a bounded array`)
  return value
}

function distinct(items, key, label) {
  if (new Set(items.map((item) => item[key])).size !== items.length) throw new TypeError(`${label} must be distinct`)
  return items
}

function choice(value, options, label) {
  if (!options.includes(value)) throw new TypeError(`${label} is unsupported`)
  return value
}

function noAuthority(value, label) {
  if (value !== false) throw new TypeError(`${label} cannot authorize physical execution`)
  return false
}

function timestamp(value, label) {
  text(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new TypeError(`${label} must be a UTC timestamp`)
  return value
}

function monotonicText(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError(`${label} must be decimal monotonic nanoseconds`)
  return value
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

function scalar(value, type, label) {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
    return value
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12
      || (type === 'integer' && (!Number.isSafeInteger(value) || Math.abs(value) > 1e12))) {
      throw new TypeError(`${label} must be a finite ${type}`)
    }
    return value
  }
  if (type === 'identifier') return id(value, label)
  if (type === 'digest') return routeDigest(value, label)
  return text(value, label)
}

function inputField(value) {
  const field = exact(value, ['name', 'value_type', 'required', 'unit', 'minimum', 'maximum'], 'physical capability input')
  const type = choice(field.value_type, SCALAR_TYPES, 'physical capability input type')
  if (field.required !== true) throw new TypeError('Physical capability v1 inputs must be required')
  for (const bound of [field.minimum, field.maximum]) {
    if (bound !== null && (typeof bound !== 'number' || !Number.isFinite(bound) || Math.abs(bound) > 1e12)) throw new TypeError('Physical capability bounds must be finite or null')
  }
  if (['number', 'integer'].includes(type)) {
    if (field.unit === null || field.minimum === null || field.maximum === null || field.minimum > field.maximum) throw new TypeError('Physical capability numeric unit and bounds are required')
    if (type === 'integer' && (!Number.isInteger(field.minimum) || !Number.isInteger(field.maximum))) throw new TypeError('Physical capability integer bounds must be integral')
  } else if (field.unit !== null || field.minimum !== null || field.maximum !== null) {
    throw new TypeError('Physical capability nonnumeric input cannot have numeric bounds')
  }
  return {
    name: id(field.name, 'physical capability input name'), value_type: type, required: true,
    unit: field.unit === null ? null : id(field.unit, 'physical capability input unit'),
    minimum: field.minimum, maximum: field.maximum,
  }
}

function requirement(value) {
  const item = exact(value, ['requirement_id', 'requirement_digest', 'maximum_age_ns'], 'physical requirement')
  if (!Number.isSafeInteger(item.maximum_age_ns) || item.maximum_age_ns < 1 || item.maximum_age_ns > 300_000_000_000) throw new TypeError('Physical requirement freshness must be a bounded integer')
  return {
    requirement_id: id(item.requirement_id, 'physical requirement ID'),
    requirement_digest: routeDigest(item.requirement_digest, 'physical requirement digest'),
    maximum_age_ns: item.maximum_age_ns,
  }
}

export function normalizePhysicalCapabilityCatalog(value) {
  const catalog = exact(value, ['contractVersion', 'registryDigest', 'currentCandidateBindingDigest', 'capabilities', 'workcells', 'runtimeVersion', 'physicalExecutionAuthorized'], 'physical capability catalog')
  if (catalog.contractVersion !== PHYSICAL_CAPABILITY_CATALOG_VERSION) throw new TypeError('Unsupported physical capability catalog version')
  if (catalog.runtimeVersion !== '0.2.0') throw new TypeError('Unsupported capability routing Runtime version')
  const capabilities = distinct(array(catalog.capabilities, 'physical capabilities').map((entry) => {
    const capability = exact(entry, ['capabilityId', 'displayName', 'definitionDigest', 'inputFields', 'preconditions', 'availableForRouting', 'reasonCodes'], 'physical capability')
    if (typeof capability.availableForRouting !== 'boolean') throw new TypeError('Physical capability routing availability must be boolean')
    return {
      capabilityId: id(capability.capabilityId, 'physical capability ID'),
      displayName: text(capability.displayName, 'physical capability display name', 256),
      definitionDigest: routeDigest(capability.definitionDigest, 'physical capability definition digest'),
      inputFields: distinct(array(capability.inputFields, 'physical capability inputs', 128).map(inputField), 'name', 'Physical capability input names'),
      preconditions: distinct(array(capability.preconditions, 'physical capability preconditions', 64).map(requirement), 'requirement_id', 'Physical preconditions'),
      availableForRouting: capability.availableForRouting,
      reasonCodes: array(capability.reasonCodes, 'physical capability reasons', 64).map((code) => id(code, 'physical capability reason')),
    }
  }), 'capabilityId', 'Physical capability IDs')
  const workcells = distinct(array(catalog.workcells, 'physical workcells', 64).map((entry) => {
    const workcell = exact(entry, ['workcellId', 'workcellDigest', 'catalogDigest'], 'physical workcell')
    return {
      workcellId: id(workcell.workcellId, 'physical workcell ID'),
      workcellDigest: routeDigest(workcell.workcellDigest, 'physical workcell digest'),
      catalogDigest: workcell.catalogDigest === null ? null : routeDigest(workcell.catalogDigest, 'workcell catalog digest'),
    }
  }), 'workcellId', 'Physical workcell IDs')
  return frozen({
    contractVersion: PHYSICAL_CAPABILITY_CATALOG_VERSION,
    runtimeVersion: catalog.runtimeVersion,
    registryDigest: routeDigest(catalog.registryDigest, 'physical registry digest'),
    currentCandidateBindingDigest: routeDigest(catalog.currentCandidateBindingDigest, 'physical candidate binding digest'),
    capabilities, workcells,
    physicalExecutionAuthorized: noAuthority(catalog.physicalExecutionAuthorized, 'Capability catalog'),
  })
}

export function normalizePhysicalRouteRequest(value) {
  const request = object(value, 'physical route preview request')
  if (Object.keys(request).length !== REQUEST_FIELDS.length || REQUEST_FIELDS.some((key) => !Object.hasOwn(request, key))) {
    throw new TypeError('Physical route preview request has unsupported or missing fields')
  }
  if (request.contractVersion !== PHYSICAL_ROUTE_REQUEST_VERSION) throw new TypeError('Unsupported physical route preview request version')
  const argumentsList = distinct(array(request.arguments, 'physical capability arguments', 128).map((entry) => {
    const argument = object(entry, 'physical capability argument')
    if (Object.keys(argument).length !== 3 || !['name', 'value_type', 'value'].every((key) => Object.hasOwn(argument, key))) throw new TypeError('Physical capability argument has unsupported fields')
    const type = choice(argument.value_type, SCALAR_TYPES, 'physical capability argument type')
    return { name: id(argument.name, 'physical capability argument name'), value_type: type, value: scalar(argument.value, type, 'physical capability argument value') }
  }), 'name', 'Physical capability argument names')
  if (argumentsList.some((argument, index) => index > 0 && argumentsList[index - 1].name > argument.name)) throw new TypeError('Physical capability arguments must be sorted by name')
  return frozen({
    contractVersion: PHYSICAL_ROUTE_REQUEST_VERSION,
    capabilityId: id(request.capabilityId, 'physical capability ID'),
    workcellId: id(request.workcellId, 'physical workcell ID'),
    arguments: argumentsList,
    ...Object.fromEntries(REQUEST_FIELDS.filter((key) => key.startsWith('expected')).map((key) => [key, routeDigest(request[key], key)])),
  })
}

function target(value) {
  const item = exact(value, ['kind', 'digest'], 'capability implementation execution target')
  return { kind: id(item.kind, 'execution target kind'), digest: routeDigest(item.digest, 'execution target digest') }
}

function decision(value) {
  const result = exact(value, ['contract_version', 'request_id', 'request_digest', 'catalog_digest', 'policy_digest', 'state_digest', 'invocation_digest', 'decision_status', 'selected_implementation_id', 'selected_implementation_digest', 'selected_execution_target', 'request_rejection_codes', 'candidates', 'physical_execution_authorized', 'decision_digest'], 'physical route decision')
  if (result.contract_version !== RUNTIME_DECISION_VERSION) throw new TypeError('Unsupported Runtime route decision version')
  noAuthority(result.physical_execution_authorized, 'Route decision')
  const status = choice(result.decision_status, ['selected', 'no_match'], 'physical route status')
  const candidates = distinct(array(result.candidates, 'capability implementation candidates').map((entry) => {
    const candidate = exact(entry, ['implementation_id', 'implementation_digest', 'mechanism', 'provider', 'execution_target', 'status', 'rejection_codes'], 'capability implementation candidate')
    const candidateStatus = choice(candidate.status, ['selected', 'eligible_not_selected', 'rejected'], 'capability implementation status')
    const rejectionCodes = array(candidate.rejection_codes, 'capability implementation rejection codes', 64).map((code) => id(code, 'route rejection code'))
    if ((candidateStatus === 'rejected') !== (rejectionCodes.length > 0)) throw new TypeError('Capability implementation reasons contradict its status')
    return {
      implementation_id: id(candidate.implementation_id, 'capability implementation ID'),
      implementation_digest: routeDigest(candidate.implementation_digest, 'capability implementation digest'),
      mechanism: id(candidate.mechanism, 'capability implementation mechanism'),
      provider: id(candidate.provider, 'capability implementation provider'),
      execution_target: target(candidate.execution_target),
      status: candidateStatus, rejection_codes: rejectionCodes,
    }
  }), 'implementation_id', 'Capability implementation IDs')
  const requestCodes = array(result.request_rejection_codes, 'request rejection codes', 64).map((code) => id(code, 'request rejection code'))
  const { decision_digest: suppliedDigest, ...sealedDecision } = result
  const expectedDigest = `sha256:${createHash('sha256').update(canonicalJson(sealedDecision)).digest('hex')}`
  if (routeDigest(suppliedDigest, 'decision_digest') !== expectedDigest) throw new TypeError('Physical route decision digest does not match its content')
  const selected = candidates.filter((candidate) => candidate.status === 'selected')
  if (status === 'selected') {
    if (selected.length !== 1 || requestCodes.length || selected[0].implementation_id !== result.selected_implementation_id
      || selected[0].implementation_digest !== result.selected_implementation_digest
      || JSON.stringify(selected[0].execution_target) !== JSON.stringify(target(result.selected_execution_target))) {
      throw new TypeError('Physical route selection is inconsistent')
    }
  } else if (selected.length || result.selected_implementation_id !== null || result.selected_implementation_digest !== null
    || result.selected_execution_target !== null || (!requestCodes.length && candidates.some((candidate) => candidate.status !== 'rejected'))) {
    throw new TypeError('No-route decision cannot contain an eligible selection')
  }
  return {
    contract_version: RUNTIME_DECISION_VERSION,
    request_id: id(result.request_id, 'Runtime route request ID'),
    ...Object.fromEntries(['request_digest', 'catalog_digest', 'policy_digest', 'state_digest', 'invocation_digest', 'decision_digest'].map((key) => [key, routeDigest(result[key], key)])),
    decision_status: status,
    selected_implementation_id: selected[0]?.implementation_id ?? null,
    selected_implementation_digest: selected[0]?.implementation_digest ?? null,
    selected_execution_target: selected[0]?.execution_target ?? null,
    request_rejection_codes: requestCodes, candidates, physical_execution_authorized: false,
  }
}

export function normalizePhysicalRouteReceipt(value, expectedRequest = null) {
  const receipt = exact(value, ['contractVersion', 'evaluatedAt', 'observedAt', 'capabilityId', 'workcellId', 'request', 'policyVersion', 'evaluationMonotonicNs', 'assessmentTimestamps', 'implementations', 'registrySnapshotDigest', 'runtimeVersion', 'hostEvidenceDigest', 'hostEvidence', 'runtimeRequest', 'runtimeCatalog', 'decision', 'physicalExecutionAuthorized', 'receiptDigest'], 'physical route receipt')
  if (receipt.contractVersion !== PHYSICAL_ROUTE_RECEIPT_VERSION) throw new TypeError('Unsupported physical route receipt version')
  if (receipt.runtimeVersion !== '0.2.0') throw new TypeError('Unsupported capability routing Runtime version')
  // The node stores the full canonical receipt. Do not re-hash its embedded
  // Runtime request in JS: raw monotonic integers can exceed Number precision.
  // Only the lossless, scalar-free decision is re-hashed here; raw evidence is
  // deliberately excluded from the model-facing display projection.
  object(receipt.hostEvidence, 'host evidence')
  object(receipt.runtimeRequest, 'stored Runtime request')
  object(receipt.runtimeCatalog, 'stored Runtime catalog')
  noAuthority(receipt.physicalExecutionAuthorized, 'Route receipt')
  const request = normalizePhysicalRouteRequest(receipt.request)
  if (expectedRequest !== null && JSON.stringify(request) !== JSON.stringify(normalizePhysicalRouteRequest(expectedRequest))) throw new TypeError('Route receipt does not match the requested capability invocation')
  const routeDecision = decision(receipt.decision)
  if (receipt.capabilityId !== request.capabilityId || receipt.workcellId !== request.workcellId
    || routeDecision.catalog_digest !== request.expectedCatalogDigest) throw new TypeError('Route receipt context does not match its request')
  const storedRequest = receipt.runtimeRequest
  if (storedRequest.contract_version !== RUNTIME_REQUEST_VERSION
    || storedRequest.skill_id !== request.capabilityId || storedRequest.workcell_id !== request.workcellId
    || storedRequest.workcell_digest !== request.expectedWorkcellDigest || storedRequest.manifest_digest !== request.expectedWorkcellDigest
    || storedRequest.catalog_digest !== request.expectedCatalogDigest
    || storedRequest.request_id !== routeDecision.request_id
    || storedRequest.request_digest !== routeDecision.request_digest
    || storedRequest.invocation_digest !== routeDecision.invocation_digest
    || storedRequest.state_digest !== routeDecision.state_digest
    || canonicalJson(storedRequest.arguments) !== canonicalJson(request.arguments)) {
    throw new TypeError('Route decision does not match its stored typed invocation')
  }
  const storedCatalog = receipt.runtimeCatalog
  if (storedCatalog.catalog_digest !== request.expectedCatalogDigest
    || storedCatalog.workcell_id !== request.workcellId || storedCatalog.workcell_digest !== request.expectedWorkcellDigest) throw new TypeError('Stored route catalog context does not match')
  const implementations = distinct(array(receipt.implementations, 'receipt capability implementations').map((entry) => {
    exact(entry, ['implementationId', 'qualificationStatus'], 'capability implementation metadata')
    return {
    implementationId: id(entry.implementationId, 'receipt capability implementation ID'),
    qualificationStatus: choice(entry.qualificationStatus, ['qualified', 'demo_qualified', 'provisional', 'blocked'], 'capability implementation qualification'),
    }
  }), 'implementationId', 'Receipt capability implementation IDs')
  if (implementations.length !== routeDecision.candidates.length
    || implementations.some((entry) => !routeDecision.candidates.some((candidate) => candidate.implementation_id === entry.implementationId))) throw new TypeError('Receipt qualification metadata does not match its candidates')
  const catalogImplementations = array(storedCatalog.implementations, 'stored capability implementations')
  for (const candidate of routeDecision.candidates) {
    const metadata = implementations.find((entry) => entry.implementationId === candidate.implementation_id)
    const implementation = catalogImplementations.find((entry) => entry.implementation_id === candidate.implementation_id)
    if (!implementation || implementation.skill_id !== request.capabilityId
      || implementation.implementation_digest !== candidate.implementation_digest
      || implementation.qualification_status !== metadata.qualificationStatus
      || implementation.mechanism !== candidate.mechanism || implementation.provider !== candidate.provider
      || canonicalJson(implementation.execution_target) !== canonicalJson(candidate.execution_target)) throw new TypeError('Capability implementation metadata does not match its stored catalog')
  }
  const policy = exact(receipt.policyVersion, ['contractVersion', 'policyId', 'policyDigest'], 'route policy version')
  if (policy.contractVersion !== RUNTIME_REQUEST_VERSION) throw new TypeError('Unsupported route policy contract version')
  if (policy.policyDigest !== routeDecision.policy_digest) throw new TypeError('Route policy metadata does not match its decision')
  if (storedRequest.policy?.policy_digest !== policy.policyDigest || storedRequest.policy?.policy_id !== policy.policyId) throw new TypeError('Route policy metadata does not match its stored request')
  return frozen({
    contractVersion: PHYSICAL_ROUTE_RECEIPT_VERSION,
    runtimeVersion: receipt.runtimeVersion,
    registrySnapshotDigest: routeDigest(receipt.registrySnapshotDigest, 'registry snapshot digest'),
    hostEvidenceDigest: routeDigest(receipt.hostEvidenceDigest, 'host evidence digest'),
    receiptDigest: routeDigest(receipt.receiptDigest, 'physical route receipt digest'),
    evaluatedAt: timestamp(receipt.evaluatedAt, 'physical route evaluation time'),
    observedAt: timestamp(receipt.observedAt, 'physical observation time'),
    evaluationMonotonicNs: monotonicText(receipt.evaluationMonotonicNs, 'evaluation time'),
    assessmentTimestamps: distinct(array(receipt.assessmentTimestamps, 'assessment timestamps', 512).map((entry) => {
      exact(entry, ['preconditionId', 'observedMonotonicNs'], 'assessment timestamp')
      return {
      preconditionId: id(entry.preconditionId, 'assessment requirement ID'),
      observedMonotonicNs: entry.observedMonotonicNs === null ? null : monotonicText(entry.observedMonotonicNs, 'assessment observation time'),
      }
    }), 'preconditionId', 'Assessment timestamp IDs'),
    policyVersion: {
      contractVersion: text(policy.contractVersion, 'physical route policy contract version', 128),
      policyId: id(policy.policyId, 'physical route policy ID'),
      policyDigest: routeDigest(policy.policyDigest, 'physical route policy digest'),
    },
    capabilityId: request.capabilityId, workcellId: request.workcellId,
    request, decision: routeDecision, implementations, physicalExecutionAuthorized: false,
  })
}

export function physicalRouteReceiptPath(digest) {
  return `/v2/physical/routes/${routeDigest(digest).slice('sha256:'.length)}`
}
