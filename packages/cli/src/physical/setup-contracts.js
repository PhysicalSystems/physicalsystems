import { executionFields, executionHash, executionText } from './execution-contracts.js'

export const SETUP_REQUIREMENTS_VERSION = 'physicalsystems-setup-requirements-v1'
export const SETUP_REQUIREMENTS_MAX_BYTES = 64 * 1024
const SCOPES = ['registry-implementation', 'implementation-artifact', 'operating-conditions', 'robot-calibration-artifact',
  'camera-calibration', 'waypoint-catalog', 'installed-source', 'capture-source', 'dependency-artifact', 'qualification-record', 'installed-configuration', 'installed-dependency']
const KINDS = ['configuration', 'registry', 'binding', 'driver', 'calibration', 'artifact', 'qualification', 'observation', 'stop', 'procedure']
const STATES = ['present', 'missing', 'unverified', 'failed', 'stale']
const SOURCES = ['registry', 'installed-configuration', 'provider-contract', 'not-exposed']
const EFFECTS = ['software-read-only', 'hardware-validation', 'operator-configuration']
const DEPENDENCIES = ['lerobot', 'tinyedge-runtime', 'numpy', 'opencv-python-headless', 'pyserial', 'feetech-servo-sdk']
const OBSERVATIONS = {
  'maximum-source-exposure-age': 'ns', 'observation-maximum-age': 'seconds', 'capture-read-timeout': 'ns',
  'capture-maximum-frame-age': 'ns', 'capture-exposure-timestamp-bound': 'ns', 'capture-width': 'pixels',
  'capture-height': 'pixels', 'minimum-detection-score': 'ratio', 'maximum-validity': 'ns',
}
const check = (value) => { if (!value) throw new TypeError('Setup response failed contract validation') }
const choice = (value, choices) => { check(choices.includes(value)); return value }
const array = (value, maximum) => { check(Array.isArray(value) && value.length <= maximum); return value }
const integer = (value) => { check(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000); return value }
const unique = (values) => check(new Set(values).size === values.length)
const nullable = (value, validate) => { if (value !== null) validate(value) }
const id = (value) => check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
function timestamp(value) {
  executionText(value, 64)
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19))
  return value
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function requirement(value) {
  executionFields(value, ['requirementId', 'kind', 'label', 'state', 'reason', 'evidence', 'procedure'])
  id(value.requirementId); choice(value.kind, KINDS)
  executionText(value.label, 120); executionText(value.reason, 360)
  choice(value.state, STATES)
  executionFields(value.evidence, ['source', 'sourceUpdatedAt', 'mode'])
  choice(value.evidence.source, SOURCES)
  nullable(value.evidence.sourceUpdatedAt, timestamp)
  choice(value.evidence.mode, ['physical', 'simulation', 'unknown'])
  if (value.evidence.source === 'not-exposed') {
    check(value.state === 'unverified' && value.evidence.sourceUpdatedAt === null && value.evidence.mode === 'unknown')
  }
  executionFields(value.procedure, ['procedureId', 'label', 'description', 'effect', 'requiresApproval'])
  id(value.procedure.procedureId); executionText(value.procedure.label, 120); executionText(value.procedure.description, 480)
  choice(value.procedure.effect, EFFECTS)
  check(typeof value.procedure.requiresApproval === 'boolean')
  check(value.procedure.requiresApproval === (value.procedure.effect !== 'software-read-only'))
}
function constraint(value) {
  executionFields(value, ['kind', 'name', 'value', 'unit', 'source', 'sourceUpdatedAt'])
  choice(value.kind, ['dependency-version', 'observation-limit', 'precondition', 'precondition-age', 'implementation-precondition', 'implementation-precondition-age'])
  id(value.name); choice(value.source, ['registry', 'installed-configuration']); nullable(value.sourceUpdatedAt, timestamp)
  if (value.kind === 'dependency-version') {
    choice(value.name, DEPENDENCIES)
    check(typeof value.value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,95}$/.test(value.value)
      && value.unit === null && value.source === 'installed-configuration')
  } else if (['precondition', 'implementation-precondition'].includes(value.kind)) {
    executionHash(value.value); check(value.unit === null && value.source === 'registry')
  } else if (['precondition-age', 'implementation-precondition-age'].includes(value.kind)) {
    check(Number.isSafeInteger(value.value) && value.value > 0 && value.value <= 300_000_000_000
      && value.unit === 'ns' && value.source === 'registry')
  } else {
    check(Object.hasOwn(OBSERVATIONS, value.name) && value.unit === OBSERVATIONS[value.name] && value.source === 'installed-configuration'
      && typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER)
    if (value.unit === 'ns' || value.unit === 'pixels' || value.unit === 'count') check(Number.isSafeInteger(value.value))
    if (value.unit === 'ratio') check(value.value <= 1)
  }
}
function implementation(value) {
  executionFields(value, ['provider', 'capabilityId', 'implementationId', 'workcellId', 'configurationId', 'registeredImplementation', 'profileStatus', 'bindings', 'requirements', 'constraints'])
  nullable(value.provider, (item) => choice(item, ['so101-waypoints-v1']))
  for (const name of ['capabilityId', 'implementationId', 'workcellId', 'configurationId']) nullable(value[name], id)
  check(typeof value.registeredImplementation === 'boolean' && value.registeredImplementation === (value.implementationId !== null))
  choice(value.profileStatus, ['available', 'unavailable'])
  if (value.profileStatus === 'available') check(value.provider !== null)
  array(value.bindings, 32).forEach((binding) => {
    executionFields(binding, ['scope', 'id', 'digest'])
    choice(binding.scope, SCOPES); id(binding.id); executionHash(binding.digest)
  })
  unique(value.bindings.map((binding) => `${binding.scope}:${binding.id}`))
  array(value.requirements, 16).forEach(requirement)
  unique(value.requirements.map((item) => item.requirementId))
  array(value.constraints, 32).forEach(constraint)
  unique(value.constraints.map((item) => `${item.kind}:${item.name}`))
}

/** Validated public projection only; no private configuration or readiness evaluation. */
export function normalizeSetupRequirements(value) {
  executionFields(value, ['contractVersion', 'inspectedAt', 'maximumAgeMs', 'nodeSessionId', 'registryDigest', 'registryUpdatedAt',
    'mode', 'inspectionOnly', 'physicalExecutionAuthorized', 'implementations', 'truncation'])
  check(value.contractVersion === SETUP_REQUIREMENTS_VERSION && value.inspectionOnly === true && value.physicalExecutionAuthorized === false)
  timestamp(value.inspectedAt)
  check(Number.isSafeInteger(value.maximumAgeMs) && value.maximumAgeMs > 0 && value.maximumAgeMs <= 30_000)
  id(value.nodeSessionId)
  nullable(value.registryDigest, executionHash); nullable(value.registryUpdatedAt, timestamp)
  choice(value.mode, ['discovery', 'simulation', 'physical'])
  array(value.implementations, 8).forEach(implementation)
  unique(value.implementations.map((item) => JSON.stringify([item.provider, item.capabilityId, item.implementationId, item.workcellId, item.configurationId])))
  executionFields(value.truncation, ['implementationsOmitted', 'requirementsOmitted', 'bindingsOmitted', 'constraintsOmitted'])
  Object.values(value.truncation).forEach(integer)
  check(Buffer.byteLength(JSON.stringify(value)) <= SETUP_REQUIREMENTS_MAX_BYTES)
  return freeze(value)
}
