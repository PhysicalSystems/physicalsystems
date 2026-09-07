import assert from 'node:assert/strict'
import test from 'node:test'
import { camera, startedAt, tick, view } from './fixtures/workcell-browser.js'

const contents = (element) => [element.textContent, ...element.children.map(contents)].filter(Boolean).join('\n')
const descendants = (element) => [element, ...element.children.flatMap(descendants)]
const setupText = (ui) => contents(ui.elements.get('setup-report'))
const hash = `sha256:${'a'.repeat(64)}`
function report({ status = 'available', observedAt = startedAt, mode = 'physical', description = 'Review the exact calibration evidence with the operator.' } = {}) {
  return {
    contractVersion: 'physicalsystems-setup-inspection-v1',
    inspection: { status: 'available', reasonCode: 'inspected', observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(observedAt + 5000).toISOString(), message: 'Setup records inspected without refreshing hardware.' },
    checks: [{ id: 'configuration', status: 'missing', message: 'No exact local configuration is reported.', action: 'Review the required local configuration.', reasonCodes: ['configuration_missing'] }],
    requestBlockers: [{ code: 'missing_argument', message: 'A typed input is missing.', action: 'Ask the operator for the destination.' }],
    implementations: [{ implementationId: 'waypoints-a', checks: [{ id: 'state', status: 'unverified', message: 'Current state is unknown.', action: 'Obtain trusted observations with separate approval.', reasonCodes: ['precondition_unknown'] }] }],
    configurations: [], counts: { configurations: 0, implementations: 1, configurationTruncated: false, implementationTruncated: false },
    sources: { route: { relationship: 'current' } }, limitations: ['Inventory does not establish physical readiness.'],
    physicalReadiness: 'unverified', physicalExecutionAuthorized: false,
    implementationSetup: { status, report: status === 'available' ? {
      contractVersion: 'physicalsystems-setup-requirements-v1', inspectedAt: new Date(observedAt - 1000).toISOString(), maximumAgeMs: 30000,
      nodeSessionId: 'node-session-one', registryDigest: hash, registryUpdatedAt: new Date(observedAt - 10000).toISOString(), mode,
      inspectionOnly: true, physicalExecutionAuthorized: false, truncation: { implementationsOmitted: 0, requirementsOmitted: 0, bindingsOmitted: 0, constraintsOmitted: 0 },
      implementations: [{ provider: 'so101-waypoints-v1', registeredImplementation: true, capabilityId: 'transfer', implementationId: 'waypoints-a', workcellId: 'cell-a', configurationId: null,
        profileStatus: 'available', bindings: [{ scope: 'registry-implementation', id: 'waypoints-a', digest: hash }], constraints: [],
        requirements: [{ requirementId: 'robot-calibration', kind: 'calibration', label: 'Robot calibration', state: 'unverified',
          reason: 'A calibration record does not prove physical validation.',
          evidence: { source: 'registry', sourceUpdatedAt: new Date(observedAt - 10000).toISOString(), mode },
          procedure: { procedureId: 'verify-calibration', label: 'Validate calibration', description, effect: 'hardware-validation', requiresApproval: true } }] }],
    } : null },
  }
}
const setup = (value, rest = {}) => ({ pending: false, report: value, error: null, ...rest })

test('setup inspection is explicit, bounded, duplicate-safe and sends an empty action only', async (t) => {
  const ui = await view(t)
  await ui.push(ui.state())
  const button = ui.elements.get('setup-inspect')
  assert.ok(button, 'an explicit Inspect setup button exists')
  assert.equal(ui.actions.length, 0, 'opening workcell never inspects or configures hardware')
  button.onclick(); button.onclick()
  await tick()
  assert.equal(ui.actions.length, 1)
  assert.equal(ui.actions[0].path, '/api/setup/inspect')
  assert.equal(ui.actions[0].options.body, '{}')
  assert.equal(button.disabled, true)
  await ui.advance(6500)
  assert.equal(ui.actions[0].options.signal.aborted, true)
  assert.match(ui.elements.get('setup-detail').textContent, /timed out|retry/i)
  assert.equal(button.disabled, false)
  ui.actions[0].resolve(Response.json({ ...ui.state(), setup: setup(report({ observedAt: ui.now() })) }))
  await tick(); await tick()
  assert.doesNotMatch(setupText(ui), /Robot calibration/, 'late expired responses cannot restore a report')
  button.onclick(); await tick()
  assert.equal(ui.actions.length, 2)
})

test('terminal-updated setup report displays all blockers, exact requirements and evidence times without any action', async (t) => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), setup: setup(report()) })
  const text = setupText(ui)
  for (const expected of ['No exact local configuration', 'Current state is unknown', 'A typed input is missing', 'Ask the operator for the destination',
    'Robot calibration', 'Validate calibration', 'Review the exact calibration evidence', '2026-09-05T09:59:50.000Z', 'unverified']) assert.ok(text.includes(expected), expected)
  assert.match(text, /separate approval/i)
  assert.match(ui.elements.get('setup-detail').textContent, /readiness|authorization/i)
  assert.equal(ui.actions.length, 0)
  assert.equal(ui.requests.length, 0)
  assert.equal(ui.elements.get('run-prepare').disabled, true)
})

test('provider procedure text is inert plain text and never becomes a link, command or control', async (t) => {
  const ui = await view(t)
  const description = '<img src=x onerror=alert(1)> https://provider.invalid/execute `sudo move-robot`'
  await ui.push({ ...ui.state(), setup: setup(report({ description })) })
  assert.ok(setupText(ui).includes(description))
  assert.equal(descendants(ui.elements.get('setup-report')).some((element) => ['a', 'img', 'script', 'button', 'input', 'iframe'].includes(element.tagName)), false)
  assert.equal(ui.actions.length, 0)
})

test('unsupported legacy setup and temporarily unavailable setup remain different and actionable', async (t) => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), setup: setup(report({ status: 'unsupported' })) })
  assert.match(setupText(ui), /does not expose|unsupported/i)
  assert.doesNotMatch(setupText(ui), /missing hardware|install now|commission now/i)
  await ui.push({ ...ui.state(), setup: setup(report({ status: 'unavailable' })) })
  assert.match(setupText(ui), /unavailable|connection/i)
  assert.match(setupText(ui), /retry|inspect again/i)
})

test('a snapshot does not renew expiry and useful procedures remain explicitly historical', async (t) => {
  const ui = await view(t), value = report()
  await ui.push({ ...ui.state(), setup: setup(value) })
  await ui.advance(4500)
  await ui.push({ ...ui.state(), setup: setup(value) })
  await ui.advance(500)
  assert.equal(ui.elements.get('setup-state').textContent, 'EXPIRED · HISTORICAL')
  assert.match(setupText(ui), /Previously reported Robot calibration: unverified/)
  assert.match(setupText(ui), /Review the exact calibration evidence/)
  assert.match(setupText(ui), /original expiry 2026-09-05T10:00:05.000Z/)
  assert.match(ui.elements.get('setup-detail').textContent, /Inspect|inspect/)
})

test('older Node report expiry wins over a newer Harness inventory timestamp', async (t) => {
  const ui = await view(t), value = report()
  value.implementationSetup.report.inspectedAt = new Date(startedAt - 29900).toISOString()
  await ui.push({ ...ui.state(), setup: setup(value) })
  await ui.advance(500)
  assert.equal(ui.elements.get('setup-state').textContent, 'EXPIRED · HISTORICAL')
  assert.match(setupText(ui), /Previously reported Robot calibration/)
  assert.match(ui.elements.get('setup-detail').textContent, /historical guidance only/)
})

test('disconnect clears report details and session changes cannot reuse an old report or pending response', async (t) => {
  const ui = await view(t), value = report()
  await ui.push({ ...ui.state(), setup: setup(value) })
  await ui.disconnect()
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
  assert.equal(ui.elements.get('setup-inspect').disabled, true)
  await ui.advance(1000)
  await ui.push(ui.state())
  ui.elements.get('setup-inspect').onclick(); await tick()
  const request = ui.actions.at(-1)
  await ui.push({ ...ui.state(), sessionId: 'harness-two', setup: setup(null) })
  assert.equal(request.options.signal.aborted, true)
  request.resolve(Response.json({ ...ui.state(), sessionId: 'harness-one', setup: setup(value) }))
  await tick(); await tick()
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
})

test('camera selection immediately retires the displayed inspection and requires a new one', async (t) => {
  const ui = await view(t), value = report()
  await ui.push({ ...ui.state(), setup: setup(value) })
  ui.elements.get('camera-select').onchange({ target: { value: 'another-camera' } })
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
  await ui.push({ ...ui.state(), setup: setup(value) })
  assert.doesNotMatch(setupText(ui), /Robot calibration/, 'unchanged snapshots cannot revive retired inspection')
  assert.equal(ui.actions.length, 0)
})

test('setup errors are safe and retryable without blocking camera Stop or ordinary actions', async (t) => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, status: 'working' } })
  const button = ui.elements.get('setup-inspect')
  assert.equal(button.disabled, false, 'read-only inspection does not depend on assistant busy state')
  button.onclick(); await tick()
  ui.actions.at(-1).resolve(Response.json({ error: '<secret provider diagnostic>' }, { status: 503 }))
  await tick(); await tick()
  assert.doesNotMatch(ui.elements.get('setup-detail').textContent, /secret provider diagnostic/)
  assert.match(ui.elements.get('setup-detail').textContent, /retry|Inspect|inspect/)
  assert.equal(button.disabled, false)
  await ui.push({ ...ui.state(), setup: setup(null, { pending: true }) })
  assert.equal(button.disabled, true, 'terminal-owned read prevents a duplicate browser request')
})

test('simulation requirements and retired routes retain explicit evidence limits', async (t) => {
  const ui = await view(t), value = report({ mode: 'simulation' })
  value.sources.route.relationship = 'retired'
  await ui.push({ ...ui.state(), setup: setup(value) })
  assert.match(setupText(ui), /SIMULATION/)
  assert.match(setupText(ui), /previous proposal|historical/i)
  assert.match(setupText(ui), /does not qualify|not physical/i)
  assert.equal(ui.elements.get('run-prepare').disabled, true)
})

test('a new shared terminal report clears a stale local setup request error', async (t) => {
  const ui = await view(t)
  ui.elements.get('setup-inspect').onclick(); await tick()
  ui.actions.at(-1).resolve(Response.json({ error: 'unavailable' }, { status: 503 }))
  await tick(); await tick()
  assert.equal(ui.elements.get('setup-state').textContent, 'UNAVAILABLE')
  await ui.push({ ...ui.state(), setup: setup(report()) })
  assert.equal(ui.elements.get('setup-state').textContent, 'AVAILABLE')
  assert.match(setupText(ui), /Robot calibration/)
})

test('a pending setup read cannot disable or delay camera Stop', async (t) => {
  const ui = await view(t)
  await ui.show(camera(1))
  ui.elements.get('setup-inspect').onclick(); await tick()
  assert.equal(ui.elements.get('camera-stop').disabled, false)
  ui.elements.get('camera-stop').onclick(); await tick()
  assert.deepEqual(ui.actions.map((request) => request.path), ['/api/setup/inspect', '/api/camera/stop'])
  assert.equal(ui.elements.get('preview').hidden, true)
  assert.deepEqual(JSON.parse(ui.actions[1].options.body), { expectedCaptureSessionId: 'capture-one' })
})

test('provider-only guidance and omitted rows cannot appear to be a complete registered implementation', async (t) => {
  const ui = await view(t), value = report()
  const node = value.implementationSetup.report
  node.implementations[0].registeredImplementation = false
  node.implementations[0].implementationId = null
  node.truncation = { implementationsOmitted: 2, requirementsOmitted: 4, bindingsOmitted: 3, constraintsOmitted: 5 }
  await ui.push({ ...ui.state(), setup: setup(value) })
  assert.match(setupText(ui), /provider setup profile only/)
  assert.match(setupText(ui), /not an installed or registered implementation/)
  assert.match(setupText(ui), /2 implementation rows, 4 requirement rows, 3 binding rows and 5 constraint rows omitted/)
})

test('pagehide aborts a setup read and its late response cannot render data or restore controls', async (t) => {
  const ui = await view(t)
  ui.elements.get('setup-inspect').onclick(); await tick()
  const request = ui.actions.at(-1)
  await ui.close()
  assert.equal(request.options.signal.aborted, true)
  request.resolve(Response.json({ ...ui.state(), setup: setup(report()) }))
  await tick(); await tick()
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
  assert.equal(ui.elements.get('setup-inspect').disabled, true)
})

test('server-retained expired guidance survives reconnect without becoming a fresh inspection', async (t) => {
  const ui = await view(t), value = report()
  await ui.push({ ...ui.state(), setup: setup(value) })
  await ui.advance(5000)
  await ui.push({ ...ui.state(), setup: { pending: false, report: null, historicalReport: value, error: 'Setup inspection expired. Inspect again.' } })
  assert.equal(ui.elements.get('setup-state').textContent, 'EXPIRED · HISTORICAL')
  assert.match(setupText(ui), /Previously reported configuration: missing/)
  await ui.disconnect()
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
  await ui.advance(1000)
  await ui.push(ui.state())
  assert.match(setupText(ui), /Previously reported Robot calibration/)
  assert.equal(ui.elements.get('setup-state').textContent, 'EXPIRED · HISTORICAL')
  assert.equal(ui.elements.get('run-prepare').disabled, true)
  ui.elements.get('camera-select').onchange({ target: { value: 'another-camera' } })
  await ui.push(ui.state())
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
})

test('missing, future or malformed timestamps cannot make historical guidance look fresh', async (t) => {
  const ui = await view(t)
  for (const mutate of [value => { value.inspection.observedAt = new Date(startedAt + 1000).toISOString() },
    value => { value.inspection.expiresAt = 'invalid' }, value => { value.implementationSetup.report.maximumAgeMs = -1 }]) {
    const value = report(); mutate(value)
    await ui.push({ ...ui.state(), setup: setup(value) })
    assert.equal(ui.elements.get('setup-state').textContent, 'UNAVAILABLE')
    assert.doesNotMatch(setupText(ui), /Robot calibration/)
  }
})

test('exact version and observation constraints retain names, units, source times and historical limits', async (t) => {
  const ui = await view(t), value = report()
  const constraints = value.implementationSetup.report.implementations[0].constraints
  for (const [kind, name, constraintValue, unit] of [['dependency-version', 'numpy', '2.2.0', null],
    ['observation-limit', 'observation-maximum-age', 0.2, 'seconds'],
    ['observation-limit', 'capture-width', 640, 'pixels'],
    ['precondition', 'object-in-source', hash, null],
    ['precondition-age', 'object-in-source', 200000000, 'ns'],
    ['implementation-precondition', 'robot-in-start-pose', hash, null],
    ['implementation-precondition-age', 'robot-in-start-pose', 100000000, 'ns']]) constraints.push({ kind, name, value: constraintValue, unit,
    source: kind.includes('precondition') ? 'registry' : 'installed-configuration', sourceUpdatedAt: '2026-09-05T09:58:00.000Z' })
  await ui.push({ ...ui.state(), setup: setup(value) })
  for (const text of ['Declared dependency-version · numpy: 2.2.0', 'observation-maximum-age: 0.2 seconds', 'capture-width: 640 pixels',
    `precondition · object-in-source: ${hash}`, 'precondition-age · object-in-source: 200000000 ns',
    `implementation-precondition · robot-in-start-pose: ${hash}`, 'implementation-precondition-age · robot-in-start-pose: 100000000 ns',
    'Source: installed-configuration · source record 2026-09-05T09:58:00.000Z', 'Source: registry',
    'not observed state or evidence that validation passed']) assert.ok(setupText(ui).includes(text), text)
  await ui.advance(5000)
  assert.match(setupText(ui), /Previously declared dependency-version · numpy: 2.2.0/)
  assert.equal(ui.elements.get('setup-state').textContent, 'EXPIRED · HISTORICAL')
  assert.equal(ui.elements.get('run-prepare').disabled, true)
  assert.equal(ui.actions.length, 0)
})

test('an empty constraints array is unverified rather than a claim that no versions or state limits are needed', async (t) => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), setup: setup(report()) })
  assert.match(setupText(ui), /Exact dependency versions and observation constraints are not exposed/)
  assert.match(setupText(ui), /they remain unverified/)
})

test('an omitted setup projection directs the operator to the terminal and keeps the workcell connected', async (t) => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), setup: setup(report()) })
  const next = { ...ui.state() }; delete next.setup
  await ui.push(next)
  assert.equal(ui.elements.get('setup-state').textContent, 'UNAVAILABLE')
  assert.match(ui.elements.get('setup-detail').textContent, /use \/physical-setup in the terminal/)
  assert.doesNotMatch(setupText(ui), /Robot calibration/)
  assert.equal(ui.elements.get('connection-state').textContent, 'Connected to Harness')
  assert.equal(ui.actions.length, 0)
})
