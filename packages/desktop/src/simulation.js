import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createWorkcellController } from '../../cli/src/harness/workcell-controller.js'
import { createPhysicalWorkflowState } from '../../cli/src/physical/workflow.js'
import { createSetupInspector } from '../../cli/src/harness/setup-inspection.js'
import { normalizePhysicalCapabilityCatalog } from '../../cli/src/physical/route-contracts.js'
import { executionDigest, normalizeExecutionStatus, normalizePhysicalRun, normalizePhysicalRunReceipt, normalizeExecutionSnapshot } from '../../cli/src/physical/execution-contracts.js'

// Generated 1 × 1 synthetic JPEG fixture; no captured camera imagery.
const SYNTHETIC_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5WooopDP/2Q==', 'base64')
const JPEG_DIGEST = `sha256:${createHash('sha256').update(SYNTHETIC_JPEG).digest('hex')}`
const FORMAT = 'physicalsystems-desktop-simulation-session-v1'
const TERMINAL = new Set(['VERIFIED_SUCCESS', 'FAILED', 'CANCELLED', 'BLOCKED'])
const GUIDE = Object.freeze({ provider: 'simulation', id: 'scripted-guide', name: 'Simulation guide (scripted)', scripted: true })
const plain = (value, max = 16_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) throw new Error('Enter a bounded plain-text value')
  return value.trim()
}
const clone = (value) => structuredClone(value)
const coded = (code, message) => Object.assign(new Error(message), { code })

/** A local scripted example, not an AI model or a hardware simulator. Only
 * synthetic public-contract inputs reach the existing operator controllers. */
export async function createSimulationHost({ config, cwd, sessionFile: initialFile, projectId,
  onWorkcell, stepMs = 700, now = Date.now } = {}) {
  if (!config?.configDir || !path.isAbsolute(cwd || '') || !projectId) throw new Error('An isolated simulation project is required')
  const sessionDir = path.join(config.configDir, 'harness-sessions')
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  if (lstatSync(sessionDir).isSymbolicLink()) throw new Error('Simulation sessions cannot use a symbolic-link directory')
  const sessionRoot = realpathSync(sessionDir)
  const listeners = new Set(), requests = new Map(), timers = new Set()
  let sessionFile, sessionId, name, messages = [], runs = new Map(), snapshots = new Map(), runSnapshots = new Map()
  let controller, unsubscribeController, workflow, disposed = false, pending = null, revision = 0, error = null
  const stamp = () => new Date(now()).toISOString()
  const configurationBody = { mode: 'simulation', fixture: 'desktop-tray-transfer-v1', source: 'tray-a', destinations: ['tray-b', 'tray-c'] }
  const configurationDigest = executionDigest(configurationBody)
  const implementationDigest = executionDigest({ mode: 'simulation', implementation: 'scripted-tray-transfer-v1', steps: ['pick', 'transfer', 'place'] })
  const configuration = { configurationId: 'simulation-table', displayName: 'Scripted simulation table', capabilityId: 'transfer-container',
    implementationId: 'scripted-tray-transfer', configurationDigest, implementationDigest, mode: 'simulation' }
  const catalogDigest = executionDigest({ fixture: 'scripted-simulation-catalog' })
  const candidateBindingDigest = executionDigest({ fixture: 'scripted-simulation-devices' })
  const registryDigest = executionDigest({ fixture: 'scripted-simulation-registry' })
  const workcellDigest = executionDigest(configurationBody)
  const capabilityCatalog = normalizePhysicalCapabilityCatalog({ contractVersion: 'experimental-physical-capability-catalog-v1',
    runtimeVersion: '0.2.0', registryDigest, currentCandidateBindingDigest: candidateBindingDigest,
    capabilities: [{ capabilityId: configuration.capabilityId, displayName: 'Scripted tray transfer', definitionDigest: implementationDigest,
      inputFields: ['destination', 'source'].map((name) => ({ name, value_type: 'identifier', required: true, unit: null, minimum: null, maximum: null })),
      preconditions: [], availableForRouting: true, reasonCodes: [] }],
    workcells: [{ workcellId: 'simulation-table', workcellDigest, catalogDigest }], physicalExecutionAuthorized: false })
  const cameraCandidate = { candidateId: 'camera-synthetic-preview', candidateDigest: executionDigest({ kind: 'synthetic', fixture: 'generated-one-pixel' }),
    displayName: 'Synthetic camera · 1 × 1 test image', observedIdentity: '/dev/v4l/by-id/synthetic-desktop-camera', identityStability: 'stable',
    adapter: { status: 'available', adapterId: 'synthetic-preview' } }
  let cameraSession = null, cameraPhase = 'idle', frameSequence = 0
  function assertOpen() { if (disposed) throw new Error('This simulation session has ended') }
  function snapshot() {
    return { revision, sessionFile, sessionId, name, messages: clone(messages), model: GUIDE,
      busy: Boolean(pending), disposed, error, simulation: true, scripted: true,
      workcellSessionId: controller?.snapshot().sessionId || null }
  }
  function emit(type = 'change') {
    if (disposed) return
    revision += 1
    const value = { type, snapshot: snapshot() }
    for (const listener of listeners) { try { listener(value) } catch {} }
  }
  function append(entry) { appendFileSync(sessionFile, JSON.stringify(entry) + '\n', { mode: 0o600 }) }
  function addMessage(role, text) {
    const message = { id: randomUUID(), role, text, scripted: role === 'assistant' }
    messages.push(message); append({ type: 'message', message })
    if (role === 'assistant') controller?.agentMessage({ role, content: [{ type: 'text', text }] })
    emit('message_end')
  }
  function validatedFile(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.dirname(path.resolve(file)) !== path.resolve(sessionDir)
      || path.extname(file) !== '.jsonl') throw new Error('Select a saved simulation conversation from this project')
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(realpathSync(file)) !== sessionRoot || stat.size > 32 * 1024 * 1024) throw new Error('The simulation conversation file is unavailable')
    const entries = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const header = entries[0]
    if (header?.type !== FORMAT || header.projectId !== projectId || header.cwd !== cwd || typeof header.id !== 'string') throw new Error('This simulation conversation belongs to a different project or format')
    return { file: path.resolve(file), entries, header }
  }
  function writeRun(run, preparation, evidence) {
    const normalized = normalizePhysicalRun(run)
    runs.set(run.runId, normalized)
    if (preparation) { runSnapshots.set(run.runId, preparation); snapshots.set(executionDigest(preparation), preparation) }
    if (evidence) snapshots.set(executionDigest(evidence), evidence)
    append({ type: 'run', run: normalized, preparation: runSnapshots.get(run.runId), evidence: evidence || null })
    emit('simulation-run')
    return clone(normalized)
  }
  function evolve(run, phase, type, extra = {}) {
    const next = { ...run, ...extra, phase, revision: run.revision + 1, updatedAt: stamp(),
      events: [...run.events, { sequence: run.events.length + 1, type, at: stamp(), detail: { mode: 'simulation' } }] }
    next.runDigest = executionDigest(next, 'runDigest')
    return next
  }
  function observation(verified = null) {
    return { evidence: { mode: 'simulation', readinessChecks: { configuration: true, sourcePresent: true, destinationClear: true } },
      preconditionsMet: true, verified, stopped: true }
  }
  function knownRun(id, expected) {
    const run = runs.get(id)
    if (!run || (expected && expected.runDigest !== run.runDigest)) throw new Error('The simulation run changed; review it again')
    return run
  }
  const executionClient = {
    async status() { return normalizeExecutionStatus({ contractVersion: 'physicalsystems-execution-status-v1', availability: 'available', mode: 'simulation', configurations: [configuration], reason: null, physicalExecutionAuthorized: false }) },
    async runs() { return { runs: [...runs.values()].map(clone) } },
    async run(id) { return clone(knownRun(id)) },
    async prepare(body, expected) {
      if ([...runs.values()].some((run) => !TERMINAL.has(run.phase)) || body.configurationId !== configuration.configurationId
        || body.expectedConfigurationDigest !== configurationDigest || body.routeReceiptDigest !== workflow.routeReceipt?.receiptDigest
        || expected.mode !== 'simulation') throw new Error('A current simulation proposal and idle simulation controller are required')
      const id = `run-${randomUUID().replaceAll('-', '')}`
      const preparation = { contractVersion: 'physicalsystems-run-snapshot-v1', configurationSnapshotDigest: configurationDigest,
        preparationObservation: observation(), mode: 'simulation' }
      const run = { contractVersion: 'physicalsystems-run-v1', runId: id, revision: 1, phase: 'WAITING_FOR_APPROVAL', stopStatus: 'NOT_REQUESTED', mode: 'simulation',
        capabilityId: configuration.capabilityId, implementationId: configuration.implementationId, implementationDigest,
        configurationId: configuration.configurationId, configurationDigest, routeReceiptDigest: body.routeReceiptDigest,
        inputs: clone(expected.inputs), snapshotDigest: executionDigest(preparation),
        approval: { digest: executionDigest({ runId: id, nonce: randomUUID(), mode: 'simulation' }), expiresAt: new Date(now() + 60_000).toISOString(), approvedAt: null },
        createdAt: stamp(), updatedAt: stamp(), events: [{ sequence: 1, type: 'prepared', at: stamp(), detail: { mode: 'simulation' } }], outcome: null, physicalExecutionAuthorized: false }
      run.runDigest = executionDigest(run)
      return writeRun(run, preparation)
    },
    async approve(id, body, expected) {
      const run = knownRun(id, expected)
      if (body.approved !== true || body.expectedRunDigest !== run.runDigest || body.approvalDigest !== run.approval.digest
        || run.phase !== 'WAITING_FOR_APPROVAL' || now() >= Date.parse(run.approval.expiresAt)
        || workflow.routeReceipt?.receiptDigest !== run.routeReceiptDigest) throw new Error('Explicit approval of the current simulation run is required')
      const running = evolve(run, 'RUNNING', 'approved', { approval: { ...run.approval, approvedAt: stamp() } })
      writeRun(running)
      const virtual = { objectLocation: run.inputs.source, armLocation: run.inputs.source, held: false }
      function scheduleStep(index) {
        const timer = setTimeout(async () => {
          timers.delete(timer)
          if (disposed) return
          const current = runs.get(id)
          if (current?.phase !== 'RUNNING') return
          if (index === 0) { virtual.held = true; virtual.objectLocation = 'gripper' }
          if (index === 1) virtual.armLocation = current.inputs.destination
          if (index === 2) { virtual.objectLocation = virtual.armLocation; virtual.held = false }
          const next = evolve(current, 'RUNNING', ['pick_simulated', 'transfer_simulated', 'place_simulated'][index])
          writeRun(next)
          if (index < 2) scheduleStep(index + 1)
          else {
            const verified = virtual.objectLocation === current.inputs.destination && !virtual.held
            const evidence = { ...observation(verified), virtualState: { ...virtual } }
            const finalPhase = verified ? 'VERIFIED_SUCCESS' : 'FAILED'
            const completed = evolve(runs.get(id), finalPhase, 'simulation_verified', { outcome: {
              status: finalPhase, reason: verified ? 'Three scripted simulation state transitions completed; no hardware was operated.'
                : 'The scripted simulation destination check failed.', evidenceDigest: executionDigest(evidence) } })
            writeRun(completed, null, evidence)
          }
          // Status publication uses the same read path as an external Node.
          try { await controller.executionAction('refresh', {}) } catch {}
        }, stepMs)
        timer.unref?.(); timers.add(timer)
      }
      scheduleStep(0)
      return clone(running)
    },
    async stop(id) {
      const run = knownRun(id)
      if (TERMINAL.has(run.phase)) return clone(run)
      return writeRun(evolve(run, 'CANCELLED', 'stopped', { stopStatus: 'STOP_CONFIRMED', outcome: {
        status: 'CANCELLED', reason: 'The scripted simulation was stopped by the operator.', evidenceDigest: null } }))
    },
    async reconcile(id) { return clone(knownRun(id)) },
    async receipt(id) {
      const run = clone(knownRun(id))
      const value = { contractVersion: 'physicalsystems-run-receipt-v1', run, snapshot: clone(runSnapshots.get(id)), physicalExecutionAuthorized: false }
      value.receiptDigest = executionDigest(value)
      return normalizePhysicalRunReceipt(value)
    },
    async snapshot(digest) {
      const body = digest === configurationDigest ? configurationBody : snapshots.get(digest)
      if (!body) throw new Error('The exact simulation evidence is unavailable')
      return normalizeExecutionSnapshot({ contractVersion: 'physicalsystems-snapshot-v1', snapshotDigest: digest, snapshot: clone(body), physicalExecutionAuthorized: false }, digest)
    },
  }
  const setupInspector = createSetupInspector({ client: { status: executionClient.status },
    getContext: () => ({ generation: workflow?.generation || 0, snapshot: workflow?.snapshot,
      capabilityCatalog: workflow?.capabilityCatalog, routeReceipt: workflow?.routeReceipt, routeRelationship: workflow?.routeReceipt ? 'current' : 'none' }) })
  function cameraStatus() {
    return { phase: cameraPhase, captureSessionId: cameraSession, selectedCandidateId: cameraSession ? cameraCandidate.candidateId : null,
      latestFrameId: cameraPhase === 'live' ? `${cameraSession}-${frameSequence}` : null, frameFresh: cameraPhase === 'live',
      frameAgeMs: cameraPhase === 'live' ? 0 : null, staleAfterMs: 2000, errorCode: null, observationStatus: 'not-configured',
      physicalState: 'unknown', physicalExecutionAuthorized: false, rawFramePersisted: false, availableCameras: [cameraCandidate] }
  }
  const cameraClient = {
    async status() { return cameraStatus() },
    async start(body) {
      if (body?.candidateId !== cameraCandidate.candidateId || body?.expectedCandidateDigest !== cameraCandidate.candidateDigest
        || !['idle', 'stopped'].includes(cameraPhase)) throw new Error('Choose the exact synthetic camera before previewing')
      cameraSession = `camera-${randomUUID()}`; frameSequence = 0; cameraPhase = 'starting'
      return cameraStatus()
    },
    async stop(body) {
      if (body?.expectedCaptureSessionId !== cameraSession) throw new Error('The synthetic camera session changed')
      cameraPhase = 'stopped'
      return cameraStatus()
    },
    async frame() {
      if (!['starting', 'live'].includes(cameraPhase)) return { status: cameraStatus(), frame: null }
      frameSequence += 1; cameraPhase = 'live'
      const source = { kind: 'synthetic', hardwareIdentity: cameraCandidate.observedIdentity, identityStability: 'stable', pixelFormat: 'bgr8', digest: executionDigest({ pixel: [0, 0, 0] }), width: 1, height: 1 }
      return { status: cameraStatus(), frame: { frameId: `${cameraSession}-${frameSequence}`, candidateId: cameraCandidate.candidateId,
        candidateDigest: cameraCandidate.candidateDigest, captureSessionId: cameraSession, sequence: frameSequence,
        jpegBytes: Buffer.from(SYNTHETIC_JPEG), previewDigest: JPEG_DIGEST, source,
        capture: { capturedAtMonotonicNs: String(process.hrtime.bigint()), clockDomain: 'host-monotonic', clockSessionId: `clock-${sessionId}`,
          timestampBasis: 'host-read-window-start', sensorExposureAgeBounded: false },
        preview: { contentType: 'image/jpeg', digest: JPEG_DIGEST, derivedFromSourceDigest: source.digest, width: 1, height: 1, rotationDegrees: 0 },
        analysis: null, observation: null, physicalExecutionAuthorized: false } }
    },
  }
  function discovery() {
    return { contractVersion: 'experimental-physical-candidates-v1', discoveryBindingDigest: candidateBindingDigest,
      nodeName: 'Local scripted simulation', observedAt: stamp(), discovery: { observedAt: stamp(), snapshotDigest: candidateBindingDigest, devices: [
      { deviceId: 'simulation-arm', displayName: 'Simulated robot arm', kind: 'robot', detected: true, readiness: 'simulation', driverReady: true, adapterStatus: 'available', adapterId: 'scripted-simulation' },
      { deviceId: 'simulation-camera', displayName: 'Synthetic preview image', kind: 'camera', detected: true, readiness: 'simulation', driverReady: true, adapterStatus: 'available', adapterId: 'synthetic-preview' },
      { deviceId: 'simulation-gripper', displayName: 'Simulated gripper', kind: 'gripper', detected: true, readiness: 'simulation', driverReady: true, adapterStatus: 'available', adapterId: 'scripted-simulation' },
    ] }, physicalExecutionAuthorized: false }
  }
  function publishWorkflow(next) { workflow = next; controller?.setWorkflow(workflow) }
  function proposal(destination) {
    const executionTarget = { kind: 'scripted-simulation', digest: implementationDigest }
    const request = { contractVersion: 'experimental-physical-route-preview-request-v1', capabilityId: configuration.capabilityId,
      workcellId: 'simulation-table', arguments: [{ name: 'destination', value_type: 'identifier', value: destination }, { name: 'source', value_type: 'identifier', value: 'tray-a' }],
      expectedRegistryDigest: registryDigest, expectedCandidateBindingDigest: candidateBindingDigest, expectedCatalogDigest: catalogDigest, expectedWorkcellDigest: workcellDigest }
    const decision = { contract_version: 'tinyedge-runtime-physical-skill-route-decision-v1', request_id: `simulation-${randomUUID()}`,
      request_digest: executionDigest(request), catalog_digest: catalogDigest, policy_digest: executionDigest({ fixture: 'simulation-policy' }),
      state_digest: candidateBindingDigest, invocation_digest: executionDigest(request.arguments), decision_status: 'selected',
      selected_implementation_id: configuration.implementationId, selected_implementation_digest: implementationDigest, selected_execution_target: executionTarget,
      physical_execution_authorized: false, request_rejection_codes: [], candidates: [{ implementation_id: configuration.implementationId,
        implementation_digest: implementationDigest, execution_target: executionTarget, mechanism: 'scripted-simulation', provider: 'local-example', status: 'selected', rejection_codes: [] }] }
    decision.decision_digest = executionDigest(decision)
    const receipt = { contractVersion: 'experimental-physical-route-receipt-v1', runtimeVersion: '0.2.0', registrySnapshotDigest: registryDigest,
      hostEvidenceDigest: candidateBindingDigest, capabilityId: configuration.capabilityId, workcellId: 'simulation-table', request, decision,
      evaluatedAt: stamp(), observedAt: stamp(), evaluationMonotonicNs: String(process.hrtime.bigint()), assessmentTimestamps: [], policyVersion: 'scripted-simulation-v1',
      implementations: [{ implementationId: configuration.implementationId, qualificationStatus: 'demo_qualified' }], physicalExecutionAuthorized: false }
    receipt.receiptDigest = executionDigest(receipt)
    publishWorkflow({ ...workflow, generation: workflow.generation + 1, routeReceipt: receipt, requestedIntent: `Transfer a simulated tray to ${destination}` })
  }
  function assertSwitchable() {
    assertOpen()
    if (pending) throw coded('ERR_HARNESS_PROMPT_BUSY', 'Finish or cancel the simulation guide question before changing conversations.')
    const state = controller.snapshot()
    if (state.camera.pending || state.camera.stopPending || state.camera.stopUnconfirmed || state.camera.stopCaptureSessionId
      || [...runs.values()].some((run) => !TERMINAL.has(run.phase))) throw coded('ERR_HARNESS_OPERATION_ACTIVE', 'Stop the synthetic preview or unresolved simulation run before changing conversations.')
  }
  function runPrompt(text, requestId) {
    const abort = new AbortController()
    const task = { abort, promise: null }
    pending = task; error = null
    addMessage('user', text); controller.agentStart(text)
    publishWorkflow({ ...workflow, generation: workflow.generation + 1, routeReceipt: null, requestedIntent: text })
    task.promise = (async () => {
      try {
        if (/camera|preview/i.test(text) && !/transfer|place|pick/i.test(text)) {
          addMessage('assistant', 'This is a scripted simulation guide. Choose the synthetic camera in Devices and press Start preview. Basic preview needs no commissioning. The generated 1 × 1 image is a UI test input, not a real camera view.')
        } else if (/transfer|tray|pick|place|plan/i.test(text)) {
          addMessage('assistant', 'This scripted example can transfer a simulated tray from Tray A to one of two destinations. No model or hardware is involved.')
          const answer = await controller.ask({ kind: 'select', question: 'Which simulated destination should receive the tray?', options: ['Tray B', 'Tray C'], signal: abort.signal })
          if (!answer || abort.signal.aborted) {
            addMessage('assistant', 'The simulation planning question was cancelled. No proposal or run was started.')
          } else {
            addMessage('user', answer)
            proposal(answer === 'Tray B' ? 'tray-b' : 'tray-c')
            addMessage('assistant', `Simulation proposal: pick from Tray A, transfer to ${answer}, then place. Review the proposal and choose the simulation configuration in Run. Prepare creates a waiting run; a separate explicit approval starts its three scripted steps.`)
          }
        } else if (/result|receipt|status/i.test(text)) {
          const latest = [...runs.values()].at(-1)
          addMessage('assistant', latest ? `The latest simulation run is ${latest.phase}. Open Run for its exact status and recorded receipt. These results describe synthetic state changes only.`
            : 'No simulation run has been prepared. Ask “Plan a tray transfer” to try the scripted planning and approval flow.')
        } else {
          addMessage('assistant', 'I am the scripted Simulation guide, not an AI model. Try “Plan a tray transfer”, “Preview the camera”, or “Show the run status”. For general conversation, create a local or SSH project and connect a model provider in Settings.')
        }
      } catch { error = 'The scripted simulation request could not be completed. No physical action was attempted.' }
      finally {
        if (pending === task) pending = null
        controller.agentSettled(); emit('request-settled')
      }
    })()
    return { accepted: true, duplicate: false, requestId }
  }
  function makeController() {
    workflow = { ...createPhysicalWorkflowState('simulation://local-scripted-example'), status: 'connected', snapshot: discovery(),
      capabilityCatalog }
    controller = createWorkcellController({ workflow, cameraClient, executionClient, now: stamp,
      refreshWorkflow: async () => publishWorkflow({ ...workflow, status: 'connected', snapshot: discovery() }),
      invalidateWorkflow: () => publishWorkflow({ ...workflow, generation: workflow.generation + 1, routeReceipt: null }),
      sendIntent: (text) => prompt(text, `browser-${randomUUID()}`), canPrompt: () => !disposed && !pending,
      modelLabel: () => GUIDE.name })
    unsubscribeController = controller.subscribe(() => emit('workcell'))
    onWorkcell?.(controller)
  }
  function loadSession(target) {
    messages = []; runs = new Map(); snapshots = new Map(); runSnapshots = new Map(); requests.clear()
    if (target) {
      const saved = validatedFile(target)
      sessionFile = saved.file; sessionId = saved.header.id; name = saved.header.name || 'Simulation conversation'
      for (const entry of saved.entries.slice(1)) {
        if (entry.type === 'message') messages.push(entry.message)
        if (entry.type === 'name') name = entry.name
        if (entry.type === 'run') {
          runs.set(entry.run.runId, normalizePhysicalRun(entry.run))
          if (entry.preparation) { runSnapshots.set(entry.run.runId, entry.preparation); snapshots.set(executionDigest(entry.preparation), entry.preparation) }
          if (entry.evidence) snapshots.set(executionDigest(entry.evidence), entry.evidence)
        }
      }
      for (const run of runs.values()) if (['READY', 'DISPATCHING', 'RUNNING', 'VERIFYING'].includes(run.phase)) {
        writeRun(evolve(run, 'OUTCOME_UNKNOWN', 'simulation_host_restarted', { outcome: {
          status: 'OUTCOME_UNKNOWN', reason: 'The previous scripted simulation host ended before recording a final state. Stop this run before preparing another.', evidenceDigest: null } }))
      }
    } else {
      sessionId = randomUUID(); name = 'Simulation conversation'
      sessionFile = path.join(sessionDir, `${stamp().replaceAll(':', '-').replaceAll('.', '-')}_${sessionId}.jsonl`)
      writeFileSync(sessionFile, JSON.stringify({ type: FORMAT, id: sessionId, cwd, projectId, name, createdAt: stamp() }) + '\n', { flag: 'wx', mode: 0o600 })
      addMessage('assistant', 'Simulation guide · scripted example. This project uses synthetic devices and local state transitions. Try “Plan a tray transfer” to explore questions, proposals, explicit approval, Stop and receipts. No AI model or hardware is connected.')
    }
  }
  function prompt(text, requestId) {
    assertOpen(); text = plain(text)
    if (/^[!/]/.test(text)) throw new Error('Enter a simulation message, not a terminal command')
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error('A bounded unique request ID is required')
    const digest = executionDigest({ text }), prior = requests.get(requestId)
    if (prior) {
      if (prior !== digest) throw coded('ERR_HARNESS_REQUEST_CONFLICT', 'Use a new request ID for a different message.')
      return { accepted: true, duplicate: true, requestId }
    }
    if (pending) throw coded('ERR_HARNESS_PROMPT_BUSY', 'Answer or cancel the current simulation question before sending another message.')
    requests.set(requestId, digest)
    if (requests.size > 256) requests.delete(requests.keys().next().value)
    runPrompt(text, requestId)
    return { accepted: true, duplicate: false, requestId }
  }
  loadSession(initialFile); makeController()
  async function replaceSession(file) {
    assertSwitchable()
    if (file) validatedFile(file)
    unsubscribeController?.(); await controller.dispose(); onWorkcell?.(null)
    cameraSession = null; cameraPhase = 'idle'
    loadSession(file); makeController(); emit('session-changed')
    return snapshot()
  }
  return Object.freeze({ snapshot, prompt,
    getWorkcell: () => controller,
    async inspectSetup() { assertOpen(); return setupInspector.inspect({}) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async cancel() { const task = pending; task?.abort.abort(); await task?.promise; return snapshot() },
    createSession: () => replaceSession(), openSession: (file) => replaceSession(file),
    async renameSession(file, value) {
      assertOpen(); const saved = validatedFile(file); value = plain(value, 120)
      appendFileSync(saved.file, JSON.stringify({ type: 'name', name: value }) + '\n')
      if (file === sessionFile) name = value
      emit('session-renamed'); return snapshot()
    },
    async archiveSession(file, archived = true) {
      assertSwitchable(); const saved = validatedFile(file)
      appendFileSync(saved.file, JSON.stringify({ type: 'archive', archived: Boolean(archived) }) + '\n')
      return snapshot()
    },
    async listSessions({ includeArchived = false } = {}) {
      assertOpen()
      return readdirSync(sessionDir).filter((file) => file.endsWith('.jsonl')).flatMap((basename) => {
        try {
          const saved = validatedFile(path.join(sessionDir, basename))
          const archived = saved.entries.filter((entry) => entry.type === 'archive').at(-1)?.archived === true
          if (archived && !includeArchived) return []
          return [{ path: saved.file, id: saved.header.id, name: saved.entries.filter((entry) => entry.type === 'name').at(-1)?.name || saved.header.name,
            created: saved.header.createdAt, modified: lstatSync(saved.file).mtime.toISOString(),
            messageCount: saved.entries.filter((entry) => entry.type === 'message').length, archived }]
        } catch { return [] }
      })
    },
    async listModels() { return [] },
    async setModel() { throw new Error('The Simulation guide is scripted. Select a local or SSH project to use an AI model.') },
    async dispose() {
      if (disposed) return
      const task = pending; task?.abort.abort(); await task?.promise
      for (const timer of timers) clearTimeout(timer)
      timers.clear(); disposed = true
      setupInspector.dispose()
      await controller.dispose(); unsubscribeController?.(); onWorkcell?.(null); listeners.clear()
    },
  })
}
