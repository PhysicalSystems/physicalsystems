// Synthetic public-contract data. No device paths, images or real calibration.
export const setupAt = '2026-09-06T12:00:00.000Z'
export const setupHash = (value = 'a') => `sha256:${value.repeat(64)}`
export function setupRequirement(overrides = {}) {
  return { requirementId: 'robot-calibration-validation', kind: 'calibration', label: 'Validate robot calibration',
    state: 'unverified', reason: 'A declared calibration digest does not establish physical calibration validity.',
    evidence: { source: 'not-exposed', sourceUpdatedAt: null, mode: 'unknown' },
    procedure: { procedureId: 'so101-calibration-review-v1', label: 'Review calibration evidence',
      description: 'The operator reviews the exact calibration and its validation evidence through the implementation procedure.',
      effect: 'hardware-validation', requiresApproval: true }, ...overrides }
}
export function setupRequirements(overrides = {}) {
  return { contractVersion: 'physicalsystems-setup-requirements-v1', inspectedAt: setupAt, maximumAgeMs: 30_000,
    nodeSessionId: 'setup-0123456789abcdef0123456789abcdef', registryDigest: setupHash('d'), registryUpdatedAt: '2026-09-01T12:00:00.000Z',
    mode: 'physical', inspectionOnly: true, physicalExecutionAuthorized: false,
    implementations: [{ provider: 'so101-waypoints-v1', capabilityId: 'transfer-container', implementationId: 'a-waypoint',
      workcellId: 'workcell-one', configurationId: 'table-one', registeredImplementation: true, profileStatus: 'available',
      bindings: [{ scope: 'robot-calibration-artifact', id: 'robot-calibration', digest: setupHash('b') }],
      requirements: [setupRequirement()], constraints: [] }],
    truncation: { implementationsOmitted: 0, requirementsOmitted: 0, bindingsOmitted: 0, constraintsOmitted: 0 }, ...overrides }
}
