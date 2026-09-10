// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { createExperimentController, createExperimentStore, createExperimentTools, experimentRequestFailure,
  workcellRequestFailure, cameraIsFresh, loadVerifiedAgentSkills, createReadAgentSkillTool, assertRunMatches, commissioningUnresolved, normalizeGripperCheck, assertGripperCheckMatches } from '../../operator-core/src/index.js'
import { createNativeSecretStore } from '../../cli/src/auth/secret-store.js'
import * as connectionAdapters from '../../desktop/src/connections.js'
import { agentToolDefinitions, agentToolNames } from './tools.js'
import { createPhysicalContext, createPublicClients } from './physical.js'

const ACTIVE = new Set(['READY', 'RUNNING', 'OUTCOME_UNKNOWN'])
const TERMINAL_RUN = new Set(['VERIFIED_SUCCESS', 'FAILED', 'CANCELLED', 'BLOCKED'])
const CONTINUATION_TEXT = 'Continue the approved synthetic simulation experiment. Run the remaining trials, compare the measurements, and summarize the result.'
const clone = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const checkpoint = (experiment) => hash(experiment.trials.map((trial) => [trial.id, trial.status]))
const fail = (code, message) => Object.assign(new Error(message), { code, operatorServiceError: true })
function text(value, name, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('INVALID_REQUEST', `${name} is invalid`)
  return value.trim()
}
function fields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw fail('INVALID_REQUEST', 'This request has unsupported or missing fields')
}
function clean(value) {
  const json = JSON.stringify(value)
  if (!json || Buffer.byteLength(json) > 1024 * 1024) throw fail('INVALID_REQUEST', 'The request is too large or invalid')
  const result = JSON.parse(json)
  const visit = (item, depth = 0) => {
    if (depth > 20) throw fail('INVALID_REQUEST', 'The request is too deeply nested')
    if (!item || typeof item !== 'object') return
    for (const [key, value] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('INVALID_REQUEST', 'Unsupported request field')
      visit(value, depth + 1)
    }
  }
  visit(result); return result
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw fail('INVALID_REQUEST', 'A bounded unique request ID is required')
  return value
}
function publicError(error) {
  return error?.operatorServiceError ? error : fail('REQUEST_FAILED', experimentRequestFailure(error)?.message || workcellRequestFailure(error)?.message ||
    'The request could not be confirmed. Inspect its current state before retrying.')
}

async function createManagedWorkspace(dataDir, id) {
  // Recheck the real storage ancestry before writing. Do not follow a replaced
  // parent into an unrelated folder or change permissions on existing folders.
  let current = path.parse(dataDir).root
  for (const component of dataDir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('WORKSPACE_UNAVAILABLE', 'The managed workspace requires real directories without symbolic links. Preserve the existing folders and inspect the storage path.')
  }
  const root = path.join(dataDir, 'projects')
  try { await mkdir(root, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('WORKSPACE_UNAVAILABLE', 'The managed workspace requires a real directory without symbolic links. Preserve the existing folder and inspect its storage path.')
  const cwd = path.join(root, id)
  // A newly allocated project ID must never reuse or overwrite an existing path.
  await mkdir(cwd, { mode: 0o700 })
  return cwd
}

/** Trusted host object. Never expose this whole object to the agent process.
 * Only agentCall plus metadata belongs on the narrow authenticated agent route.
 * command/session.bind/agentState belong on the separately trusted host route. */
export async function createOperatorService({ dataDir, secretStore, connections = connectionAdapters,
  clientFactory = createPublicClients, submitContinuation, now = Date.now, stepMs = 50,
  allowDeviceConnections = false, skillPackageRoot } = {}) {
  if (!path.isAbsolute(dataDir || '')) throw new TypeError('An isolated absolute operator data directory is required')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const store = createExperimentStore({ storageDir: path.join(dataDir, 'operator-state'), sessionId: 'operator-service-v1' })
  let saved
  try {
    saved = store.read() || { schemaVersion: 1, revision: 0, projects: [], bindings: [], selection: { projectId: null, conversationId: null }, continuations: [], ownership: [] }
    fields(saved, ['schemaVersion', 'revision', 'projects', 'bindings', 'selection', 'continuations', 'ownership'])
    if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
        !Array.isArray(saved.projects) || saved.projects.length > 256 || !Array.isArray(saved.bindings) || saved.bindings.length > 1024 ||
        !Array.isArray(saved.continuations) || saved.continuations.length > 4096 || !Array.isArray(saved.ownership) || saved.ownership.length > 2048) throw new Error('Invalid operator storage')
    const ids = new Set()
    for (const project of saved.projects) {
      fields(project, ['id', 'name', 'cwd', 'generation', 'connection'], ['id', 'name', 'cwd', 'generation', 'connection'])
      fields(project.connection, ['type', 'label', 'nodeUrl', 'host', 'username', 'port', 'remotePort', 'keyPath', 'knownHostsPath', 'credentialRef', 'expectedNodeId'])
      text(project.id, 'Project ID'); text(project.name, 'Project name'); if (ids.has(project.id) || !path.isAbsolute(project.cwd)) throw new Error('Invalid saved project'); ids.add(project.id)
      if (!['local', 'ssh', 'simulation'].includes(project.connection?.type) || !Number.isSafeInteger(project.generation) || project.generation < 0) throw new Error('Invalid saved connection')
    }
    ids.clear()
    for (const binding of saved.bindings) {
      fields(binding, ['id', 'projectId', 'serverId', 'sessionId', 'title'], ['id', 'projectId', 'serverId', 'sessionId', 'title'])
      text(binding.id, 'Conversation ID'); text(binding.serverId, 'Server ID', 512); text(binding.sessionId, 'Session ID', 256)
      if (ids.has(binding.id) || !saved.projects.some((project) => project.id === binding.projectId)) throw new Error('Invalid saved binding'); ids.add(binding.id)
    }
    for (const record of saved.continuations) {
      fields(record, ['conversationId', 'requestId', 'fingerprint', 'status', 'experimentId', 'planDigest', 'checkpoint'], ['conversationId', 'requestId', 'fingerprint', 'status'])
      requestId(record.requestId)
      if (!ids.has(record.conversationId) || !/^[0-9a-f]{64}$/.test(record.fingerprint) || !['PENDING', 'UNCONFIRMED', 'ACCEPTED'].includes(record.status)) throw new Error('Invalid continuation evidence')
      if (record.experimentId !== undefined) text(record.experimentId, 'Saved experiment identity', 160)
      for (const field of ['planDigest', 'checkpoint']) if (record[field] !== undefined && !/^[0-9a-f]{64}$/.test(record[field])) throw new Error('Invalid continuation binding')
    }
    for (const record of saved.ownership) {
      if (!ids.has(record.conversationId) || !saved.projects.some((project) => project.id === record.projectId) || !['camera', 'execution', 'commissioning'].includes(record.kind)) throw new Error('Invalid ownership evidence')
      text(record.nodeId, 'Saved Node identity', 512)
      if (record.kind === 'commissioning') {
        const status = normalizeGripperCheck(record.commissioningStatus)
        if (status.nodeSessionId !== record.nodeSessionId || status.trial?.trialId !== record.trialId || !commissioningUnresolved(status)) throw new Error('Invalid commissioning ownership evidence')
      }
    }
    fields(saved.selection, ['projectId', 'conversationId'])
    if (saved.selection.projectId && !saved.projects.some((project) => project.id === saved.selection.projectId)) throw new Error('Invalid selection')
    if (saved.selection.conversationId && !saved.bindings.some((entry) => entry.id === saved.selection.conversationId && entry.projectId === saved.selection.projectId)) throw new Error('Invalid selection')
  } catch { store.release(); throw fail('STORAGE_INVALID', 'Operator metadata is invalid. Preserve the files and open a compatible service; no work was replayed.') }
  const serviceId = randomUUID(), contexts = new Map(), links = new Map(), tokens = new Map(), nodeOwners = new Map(), endpointOwners = new Map(), listeners = new Set(), pendingProjects = new Map()
  const secrets = secretStore || createNativeSecretStore({ configDir: path.join(dataDir, 'credentials') })
  let closed = false, closing = false, closePromise, storageFailed = false, revision = 0, catalogPending = false, skillTool
  const project = (id) => saved.projects.find((item) => item.id === id)
  const binding = (id) => saved.bindings.find((item) => item.id === id)
  const fresh = (at) => Number.isFinite(at) && now() >= at && now() - at < 10000
  const bindingScope = (entry) => ({ projectId: entry.projectId, conversationId: entry.id, serverId: entry.serverId, sessionId: entry.sessionId, connectionGeneration: project(entry.projectId).generation })
  const save = () => {
    if (storageFailed) throw fail('STORAGE_UNAVAILABLE', 'Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.')
    saved.revision += 1
    try { store.write(saved) } catch { storageFailed = true; throw fail('STORAGE_UNAVAILABLE', 'Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.') }
  }
  const unresolved = (view) => Boolean(view?.camera?.pending || view?.camera?.stopPending || view?.camera?.stopUnconfirmed || view?.camera?.stopCaptureSessionId ||
    view?.commissioning?.unresolved || view?.commissioning?.pending || view?.commissioning?.stopPending || view?.execution?.pending || view?.execution?.stopPending || [...(view?.execution?.activeRuns || []), ...(view?.execution?.runs || []), ...(view?.execution?.run ? [view.execution.run] : [])].some((run) => !TERMINAL_RUN.has(run.phase) || run.stopStatus === 'STOP_UNCONFIRMED'))
  const requiresRecovery = (record) => record.recovered || (record.status === 'OUTCOME_UNKNOWN' && !(record.kind === 'camera' ? record.captureSessionId : record.kind === 'commissioning' ? record.trialId : record.runId))
  const recoveryOwner = (record) => ({ ...record, ...bindingScope(binding(record.conversationId)),
    projectName: project(record.projectId).name, statusUnavailable: true,
    ...(!(record.kind === 'camera' ? record.captureSessionId : record.kind === 'commissioning' ? record.trialId : record.runId) ? {
      error: 'The operation acknowledgement did not include an identity. Its outcome is unknown. Inspect the original Node and retain its evidence; another camera or run cannot safely be guessed.',
    } : {}) })
  const experimentView = (context, entry) => {
    if (!context || !entry) return null
    const view = context.experiments.snapshot(), current = view.current
    const latest = current && saved.continuations.findLast((record) => record.conversationId === entry.id && record.fingerprint === hash([entry.id, current.id, current.planDigest]))
    return { ...view, continuation: latest ? { requestId: latest.requestId, status: latest.status,
      experimentId: latest.experimentId || current.id, planDigest: latest.planDigest || current.planDigest,
      checkpoint: latest.checkpoint || checkpoint(current) } : null }
  }
  function snapshot() {
    const selected = binding(saved.selection.conversationId), context = contexts.get(selected?.id), selectedProject = project(saved.selection.projectId)
    const selectedLink = links.get(selectedProject?.id), ownsView = Boolean(selected && selectedLink?.physicalOwner === selected.id)
    const view = ownsView ? selectedLink.physical?.workcell.snapshot() : null
    const connected = selectedLink?.status === 'connected' && fresh(selectedLink.observedAt)
    const workcell = view && !connected ? { ...view, camera: { ...view.camera, availability: 'unavailable', frame: null, previewFrameId: null, receivedAt: null },
      execution: { ...view.execution, availability: 'unavailable', canPrepare: false, canApprove: false },
      commissioning: view.commissioning ? { ...view.commissioning, available: false, fresh: false, receivedAt: null } : null } : view
    const owners = [...links].flatMap(([id, link]) => {
      const owner = binding(link.physicalOwner), view = link.physical?.workcell.snapshot()
      if (!owner || !view) return []
      return [{ projectId: id, projectName: project(id).name, conversationId: owner.id, serverId: owner.serverId, sessionId: owner.sessionId,
        connectionGeneration: project(id).generation, statusUnavailable: link.status !== 'connected' || !fresh(link.observedAt), view }]
    })
    return clone({ schemaVersion: 1, serviceId, revision, error: storageFailed ? 'Operator evidence could not be saved; work is blocked.' : null,
      deviceConnectionsEnabled: allowDeviceConnections, activeProjectId: selectedProject?.id || null, activeConversationId: selected?.id || null,
      connectionGeneration: selectedProject?.generation || 0,
      projects: saved.projects.map((item) => {
        const link = links.get(item.id), status = link?.status === 'connected' && item.connection.type !== 'simulation' && !fresh(link.observedAt) ? 'reconnecting' : link?.status || 'offline'
        const camera = link?.physical?.workcell.snapshot().camera, observation = link?.observation
        return { id: item.id, name: item.name, cwd: item.cwd,
          connection: { kind: item.connection.type, label: item.connection.label, status, observedAt: link?.observedAt ? new Date(link.observedAt).toISOString() : null,
            deviceCount: status === 'connected' && item.connection.type === 'simulation' ? 0 : status === 'connected' && fresh(Date.parse(observation?.discovery?.observedAt)) ? observation.discovery.devices.filter((device) => device.detected).length : null,
            inUseCount: status === 'connected' && cameraIsFresh(camera, now()) ? 1 : null, error: link?.error || null },
          conversations: saved.bindings.filter((entry) => entry.projectId === item.id).map(({ id, title, serverId, sessionId }) => ({ id, title, serverId, sessionId })) }
      }),
      conversation: selected ? { id: selected.id, title: selected.title, serverId: selected.serverId, sessionId: selected.sessionId,
        busy: Boolean(context?.busy), error: context?.error || null } : null,
      experiments: experimentView(context, selected), workcell, setupReport: workcell?.setup?.report || null,
      activeExperiments: [...contexts].flatMap(([id, entry]) => {
        const current = entry.experiments.snapshot().current, owner = binding(id)
        return ACTIVE.has(current?.phase) ? [{ ...bindingScope(owner), projectName: project(owner.projectId).name, experiment: current, canStop: true }] : []
      }),
      activeCaptures: [...owners.filter(({ view }) => view.camera.stopCaptureSessionId || view.camera.pending).map(({ view, ...owner }) => ({ ...owner,
        captureSessionId: view.camera.stopCaptureSessionId, pending: view.camera.pending, stopPending: view.camera.stopPending, stopUnconfirmed: view.camera.stopUnconfirmed, canStop: !view.camera.stopPending })),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === 'camera').map((record) => ({ ...recoveryOwner(record), stopUnconfirmed: true,
          canStop: Boolean(record.captureSessionId && links.get(record.projectId)?.status === 'connected') }))],
      activeRuns: [...owners.flatMap(({ view, ...owner }) => (view.execution.activeRuns || []).map((run) => ({ ...owner, run, canStop: !view.execution.stopPending }))),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === 'execution').map((record) => ({ ...recoveryOwner(record),
          run: { runId: record.runId, runDigest: record.runDigest, phase: 'OUTCOME_UNKNOWN' },
          canStop: Boolean(record.runId && links.get(record.projectId)?.status === 'connected') }))],
      activeCommissioning: [...owners.filter(({ view }) => view.commissioning?.unresolved).map(({ view, ...owner }) => ({ ...owner,
        statusUnavailable: owner.statusUnavailable || !view.commissioning.fresh,
        status: view.commissioning.status, trialId: view.commissioning.status?.trial?.trialId || null, nodeSessionId: view.commissioning.status?.nodeSessionId || null,
        canStop: Boolean(view.commissioning.status?.trial && !view.commissioning.stopPending), stopPending: view.commissioning.stopPending })),
        ...saved.ownership.filter((record) => requiresRecovery(record) && record.kind === 'commissioning').map((record) => ({ ...recoveryOwner(record),
          status: record.commissioningStatus || null, trialId: record.trialId || null, nodeSessionId: record.nodeSessionId || null, stopPending: false,
          canStop: Boolean(record.trialId && record.nodeSessionId && links.get(record.projectId)?.status === 'connected') }))],
      recoveryOperations: saved.ownership.filter(requiresRecovery).map(recoveryOwner),
    })
  }
  const emit = () => { if (closed) return; revision += 1; const state = snapshot(); for (const listener of listeners) { try { listener(state) } catch {} } }
  function openContext(entry) {
    if (contexts.has(entry.id)) return contexts.get(entry.id)
    const experiments = createExperimentController({ sessionId: entry.id, storageDir: path.join(dataDir, 'experiments'), now, stepMs })
    const context = { experiments, busy: false, error: null, mutation: null, stopEpoch: 0, physicalStopEpoch: 0, continuation: null, agentToken: randomBytes(32).toString('hex') }
    context.tools = createExperimentTools({ getController: () => experiments })
    context.unsubscribe = experiments.subscribe(emit)
    contexts.set(entry.id, context); return context
  }
  try {
    for (const entry of saved.bindings) openContext(entry)
    for (const record of saved.continuations) if (record.status === 'PENDING') record.status = 'UNCONFIRMED'
    for (const record of saved.ownership) {
      record.recovered = true
      if (nodeOwners.has(record.nodeId) && nodeOwners.get(record.nodeId) !== record.projectId) throw fail('STORAGE_INVALID', 'Saved Node ownership conflicts; preserve the records')
      nodeOwners.set(record.nodeId, record.projectId)
    }
    save()
  } catch (error) { for (const context of contexts.values()) await context.experiments.dispose(); store.release(); throw publicError(error) }
  function scope(body, { physical = false, selected = false, generation = true } = {}) {
    const entry = binding(body.conversationId), p = project(body.projectId)
    if (!p || !entry || entry.projectId !== p.id || (body.serverId !== undefined && entry.serverId !== body.serverId) || (body.sessionId !== undefined && entry.sessionId !== body.sessionId)) throw fail('SCOPE_CHANGED', 'The conversation binding changed. Open the exact project and conversation before acting.')
    if (generation && (!Number.isSafeInteger(body.connectionGeneration) || body.connectionGeneration !== p.generation)) throw fail('CONNECTION_CHANGED', 'The connection changed. Refresh and review the current project state.')
    if (selected && (saved.selection.projectId !== p.id || saved.selection.conversationId !== entry.id)) throw fail('SCOPE_CHANGED', 'The selected conversation changed. Review its current proposal before acting.')
    if (physical && (links.get(p.id)?.status !== 'connected' || !fresh(links.get(p.id)?.observedAt))) throw fail('CONNECTION_UNAVAILABLE', 'Explicitly connect this project and refresh its status before using devices.')
    return { entry, p, context: contexts.get(entry.id) }
  }
  const ensureOpen = (stop = false) => {
    if (closed) throw fail('SERVICE_CLOSED', 'The operator service is closed')
    if (closing && !stop) throw fail('SERVICE_CLOSING', 'The operator service is closing. No new work can start during cleanup.')
    if (storageFailed && !stop) throw fail('STORAGE_UNAVAILABLE', 'Operator evidence could not be saved. Work is blocked; retain the files and resolve owned operations.')
  }
  async function withContext(context, independent, action) {
    if (!independent && context.mutation) throw fail('REQUEST_PENDING', 'Another request in this conversation is in progress; Stop remains available.')
    const token = {}; if (!independent) context.mutation = token
    try { return await action() } finally { if (context.mutation === token) context.mutation = null }
  }

  async function continueExperiment(owner, body, approve) {
    const { entry, context, p } = owner, epoch = context.stopEpoch
    const reviewed = (ready = true) => {
      ensureOpen(); scope(body, { selected: true })
      const state = context.experiments.snapshot(), current = state.current
      if (context.stopEpoch !== epoch) throw fail('STOP_REQUESTED', 'Stop was requested. No continuation will resume this experiment.')
      if (state.error) throw fail('STORAGE_UNAVAILABLE', state.error)
      if (!current || current.id !== body.experimentId || current.planDigest !== body.expectedDigest) throw fail('PLAN_CHANGED', 'The experiment does not match the reviewed plan. Refresh its exact goal and trial budget.')
      if (current.mode !== 'simulation' || current.phase === 'OUTCOME_UNKNOWN' || current.stopStatus === 'UNCONFIRMED') throw fail('OUTCOME_UNKNOWN', 'This experiment is unavailable or its outcome is unconfirmed. Use Stop and retain its evidence.')
      if (now() >= current.expiresAt) throw fail('APPROVAL_EXPIRED', 'This experiment approval has expired. Stop it and propose a new bounded experiment.')
      if (ready && (current.phase !== 'READY' || !Number.isFinite(current.approvedAt))) throw fail('APPROVAL_REQUIRED', 'Review and approve this exact simulation proposal before continuing.')
      return current
    }
    requestId(body.requestId)
    if (approve && body.approved !== true) throw fail('APPROVAL_REQUIRED', 'Review and explicitly approve this exact synthetic experiment.')
    const current = reviewed(false), fingerprint = hash([entry.id, body.experimentId, body.expectedDigest])
    let record = saved.continuations.find((item) => item.conversationId === entry.id && item.requestId === body.requestId)
    const retry = Boolean(record)
    if (record && record.fingerprint !== fingerprint) throw fail('REQUEST_CONFLICT', 'This request ID was used for a different experiment action.')
    const response = (accepted, duplicate, error) => ({ ...context.experiments.snapshot(), continuation: { accepted, duplicate, requestId: body.requestId, mode: 'model', ...(error ? { error } : {}) } })
    if (record?.status === 'ACCEPTED') {
      if (!['READY', 'RUNNING', 'COMPLETED'].includes(current.phase)) throw fail('APPROVAL_REQUIRED', 'This experiment is stopped or interrupted; it cannot resume.')
      return response(true, true)
    }
    if (!approve) reviewed()
    if (!record && saved.continuations.some((item) => item.conversationId === entry.id && item.fingerprint === fingerprint && ['PENDING', 'UNCONFIRMED'].includes(item.status))) {
      throw fail('CONTINUATION_UNCONFIRMED', 'A continuation for this exact plan is still unconfirmed. Check the retained request or use Stop; do not submit another continuation with a new request ID.')
    }
    if (context.busy) throw fail('AGENT_BUSY', 'Wait for the current assistant request to finish or cancel it before continuing.')
    if (current.trials.length >= current.trialLimit) throw fail('TRIAL_LIMIT_REACHED', 'The approved trial limit has been reached. Finish this experiment.')
    if (!record && (saved.continuations.length >= 4096 || saved.continuations.filter((item) => item.conversationId === entry.id).length >= 256)) throw fail('REQUEST_LIMIT', 'The continuation request limit is reached. Finish or Stop and start a new conversation.')
    if (approve && current.phase !== 'READY') context.experiments.approve({ experimentId: body.experimentId, expectedDigest: body.expectedDigest })
    reviewed()
    if (!record) { record = { conversationId: entry.id, requestId: body.requestId, fingerprint, status: 'PENDING',
      experimentId: current.id, planDigest: current.planDigest, checkpoint: checkpoint(current) }; saved.continuations.push(record) }
    record.experimentId ||= current.id; record.planDigest ||= current.planDigest; record.checkpoint ||= checkpoint(current)
    record.status = 'PENDING'; save(); emit()
    const controller = new AbortController(); context.continuation = controller
    try {
      reviewed()
      if (!submitContinuation) throw fail('AGENT_UNAVAILABLE', 'The OpenCode conversation is unavailable. Approval is saved; reconnect it before choosing Continue.')
      const accepted = await submitContinuation({ binding: bindingScope(entry), text: CONTINUATION_TEXT, requestId: body.requestId, retry, signal: controller.signal })
      if (accepted?.accepted !== true) { record.status = 'UNCONFIRMED'; save(); emit(); return response(false, false, accepted?.error || 'The assistant did not confirm accepting the continuation. Inspect its status before retrying with this request ID.') }
      record.status = 'ACCEPTED'; save(); emit(); return response(true, Boolean(accepted.duplicate))
    } catch (error) {
      record.status = 'UNCONFIRMED'; if (!storageFailed) save()
      emit(); return response(false, false, publicError(error).message)
    } finally { if (context.continuation === controller) context.continuation = null }
  }

  // Physical connection/controller integration is deliberately kept below the
  // trusted operator interface; agentCall has no approval/start/stop capability.
  async function connect(p) {
    if (pendingProjects.has(p.id)) throw fail('CONNECTION_PENDING', 'This project connection is being checked.')
    if (p.connection.type !== 'simulation' && !allowDeviceConnections) throw fail('DEVICE_CONNECTIONS_DISABLED', 'Device connections are disabled in this isolated review service. Synthetic experiments remain available.')
    const prior = links.get(p.id)
    if (prior?.status === 'connected' && fresh(prior.observedAt)) return snapshot()
    const task = {}; pendingProjects.set(p.id, task)
    let attached
    try {
      if (p.connection.type === 'simulation') {
        links.set(p.id, { status: 'connected', observedAt: now(), error: null }); emit(); return snapshot()
      }
      if (prior?.physical && unresolved(prior.physical.workcell.snapshot()) && !prior.endpoint) throw fail('OWNERSHIP_UNRESOLVED', 'The original connection has unresolved operations. Retain its owner and inspect recovery.')
      const key = p.connection.type === 'ssh' ? `ssh:${p.connection.username}@${p.connection.host}:${p.connection.port || 22}:${p.connection.remotePort || 8876}` : connections.normalizeLocalEndpoint(p.connection.nodeUrl).replace('localhost', '127.0.0.1')
      if (endpointOwners.has(key) && endpointOwners.get(key) !== p.id) throw fail('NODE_OWNED', 'This Node endpoint already belongs to another project.')
      const credential = p.connection.credentialRef ? JSON.parse(await secrets.read(p.connection.credentialRef) || 'null') : null
      const probeNode = async ({ endpoint, expectedNodeId }) => {
        const clients = clientFactory({ endpoint, credential: credential || {} })
        const [observation] = await Promise.all([clients.node.inspect(), clients.camera.status()])
        if (expectedNodeId && observation.nodeName !== expectedNodeId) throw fail('NODE_CHANGED', 'The responding Node identity changed. Retain the original project owner.')
        return { authenticated: true, nodeId: observation.nodeName, observation }
      }
      clearTimeout(prior?.timer)
      if (prior?.endpoint && !prior.transportLost) attached = { ...prior, identity: await probeNode({ endpoint: prior.endpoint, expectedNodeId: p.connection.expectedNodeId }) }
      else {
        if (prior?.endpoint) await prior.close?.()
        attached = await (p.connection.type === 'ssh' ? connections.attachSSH : connections.attachLocal)(p.connection, { credentialResolver: async () => credential, probeNode,
          ...(prior?.endpoint ? { allocatePort: async () => Number(new URL(prior.endpoint).port) } : {}) })
      }
      if (!attached.identity?.authenticated || !attached.identity.nodeId || (nodeOwners.has(attached.identity.nodeId) && nodeOwners.get(attached.identity.nodeId) !== p.id)) {
        await attached.close?.(); throw fail('NODE_OWNED', 'The authenticated Node is unavailable or owned by another project.')
      }
      if (p.connection.expectedNodeId && p.connection.expectedNodeId !== attached.identity.nodeId) { await attached.close?.(); throw fail('NODE_CHANGED', 'The responding Node identity changed.') }
      p.connection.expectedNodeId = attached.identity.nodeId
      if (!prior) p.generation += 1
      save()
      const link = { ...prior, ...attached, credential, clients: clientFactory({ endpoint: attached.endpoint, credential: credential || {} }), key,
        status: 'connected', observedAt: now(), observation: attached.identity.observation, error: null, transportLost: false }
      prior?.offDisconnect?.()
      link.offDisconnect = attached.onDisconnect?.(() => { link.status = 'offline'; link.observedAt = null; link.transportLost = true; link.error = 'Connection lost. Owned outcomes remain unresolved until the same Node is inspected.'; emit() })
      links.set(p.id, link); endpointOwners.set(key, p.id); nodeOwners.set(attached.identity.nodeId, p.id)
      let failures = 0
      const monitor = async () => {
        if (closed || links.get(p.id) !== link || link.transportLost) return
        try {
          const identity = await probeNode({ endpoint: link.endpoint, expectedNodeId: p.connection.expectedNodeId })
          if (closed || links.get(p.id) !== link || link.transportLost) return
          link.status = 'connected'; link.observedAt = now(); link.observation = identity.observation; link.error = null; failures = 0
        } catch (error) {
          if (closed || links.get(p.id) !== link) return
          failures += 1; link.status = failures >= 5 ? 'offline' : 'reconnecting'; link.error = publicError(error).message
        }
        emit()
        if (!closed && links.get(p.id) === link && failures < 5) { link.timer = setTimeout(monitor, Math.min(4000 * 2 ** failures, 30000)); link.timer.unref?.() }
      }
      link.timer = setTimeout(monitor, 4000); link.timer.unref?.()
      emit(); return snapshot()
    } catch (error) {
      const retained = links.get(p.id) || prior
      const cleanup = attached || error?.connection
      if (cleanup && cleanup !== retained) {
        try { await cleanup.close?.() }
        catch {
          links.set(p.id, { ...retained, ...cleanup, status: 'offline', error: 'Connection cleanup is unconfirmed. Retry Disconnect before replacing its owner.' })
        }
      }
      if (retained) { retained.status = 'offline'; retained.error = publicError(error).message }
      emit(); throw error
    }
    finally { if (pendingProjects.get(p.id) === task) pendingProjects.delete(p.id) }
  }
  function journalPhysical(p, entry, link) {
    const view = link.physical?.workcell.snapshot()
    if (!view) return
    const retained = saved.ownership.filter((record) => record.projectId !== p.id || requiresRecovery(record) ||
      (record.kind === 'camera' && !record.captureSessionId && view.camera.error) || (record.kind === 'execution' && !record.runId && view.execution.error))
      .map((record) => record.projectId === p.id && !record.recovered &&
        ((record.kind === 'camera' && !record.captureSessionId && view.camera.error && !view.camera.pending) ||
        (record.kind === 'execution' && !record.runId && view.execution.error && !view.execution.pending))
        ? { ...record, status: 'OUTCOME_UNKNOWN' } : record)
    const base = { projectId: p.id, conversationId: entry.id, nodeId: p.connection.expectedNodeId, connectionGeneration: p.generation, recovered: false }
    if (view.camera.stopCaptureSessionId || view.camera.pending || view.camera.stopUnconfirmed) retained.push({ ...base, kind: 'camera', captureSessionId: view.camera.stopCaptureSessionId || null, status: view.camera.status?.phase || 'OUTCOME_UNKNOWN' })
    for (const run of view.execution.activeRuns || []) {
      const exact = view.execution.run?.runId === run.runId ? view.execution.run : run
      const pins = Object.fromEntries(['runId', 'mode', 'capabilityId', 'implementationId', 'implementationDigest', 'configurationId', 'configurationDigest', 'routeReceiptDigest', 'snapshotDigest', 'inputs', 'approval'].filter((key) => Object.hasOwn(exact, key)).map((key) => [key, exact[key]]))
      retained.push({ ...base, kind: 'execution', runId: run.runId, runDigest: run.runDigest, pins, status: run.phase })
    }
    if (view.commissioning?.status?.trial && view.commissioning.unresolved) retained.push({ ...base, kind: 'commissioning',
      trialId: view.commissioning.status.trial.trialId, nodeSessionId: view.commissioning.status.nodeSessionId, commissioningStatus: view.commissioning.status, status: view.commissioning.status.trial.phase })
    if (view.execution.pending && !retained.some((record) => record.projectId === p.id && record.kind === 'execution')) retained.push({ ...base, kind: 'execution', runId: null, status: 'REQUEST_PENDING' })
    if (JSON.stringify(retained) !== JSON.stringify(saved.ownership)) { saved.ownership = retained; try { save() } catch {} }
    emit()
  }
  async function physicalContext(owner) {
    const { p, entry, context } = owner, link = links.get(p.id)
    if (!link?.clients) throw fail('DEVICE_UNAVAILABLE', 'This project has no connected device client. The arithmetic synthetic fixture does not provide cameras or hardware.')
    if (saved.ownership.some((record) => record.projectId === p.id && requiresRecovery(record))) throw fail('RECOVERY_REQUIRED', 'The service retained unresolved physical ownership. Inspect the original Node and resolve its exact operation before creating another controller.')
    if (link.physicalOwner !== entry.id) {
      if (link.physical && unresolved(link.physical.workcell.snapshot())) throw fail('NODE_BUSY', `Another conversation owns this Node's active operation. Open its conversation or use its independent Stop.`)
      link.leave?.(); await link.physical?.dispose()
      link.physicalOwner = entry.id
      link.physical = createPhysicalContext({ clients: link.clients, experiments: context.experiments, now,
        canPrompt: () => !context.busy, sendIntent: (text) => submitContinuation?.({ binding: bindingScope(entry), text, requestId: `intent-${randomUUID()}` }),
        onChange: () => journalPhysical(p, entry, link) })
      link.leave = link.physical.workcell.onViewerConnect()
    }
    return link.physical
  }
  async function withPhysical(owner, independent, action) {
    const { p, entry, context } = owner, link = links.get(p.id), epoch = context.physicalStopEpoch
    if (!link) throw fail('CONNECTION_UNAVAILABLE', 'The owned project connection is unavailable')
    if (!independent && link.mutation) throw fail('NODE_BUSY', 'Another conversation is using this Node. Wait for that request; Stop remains available.')
    if (independent && link.physicalOwner !== entry.id && link.pendingOwner !== entry.id) throw fail('SCOPE_CHANGED', 'This conversation does not own the current device operation')
    const token = {}
    if (!independent) { link.mutation = token; link.pendingOwner = entry.id }
    try {
      const physical = await physicalContext(owner)
      if (!independent && context.physicalStopEpoch !== epoch) throw fail('STOP_REQUESTED', 'Stop was requested before the device action started')
      ensureOpen(independent)
      return await action(physical)
    } finally { if (link.mutation === token) { link.mutation = null; link.pendingOwner = null } }
  }
  async function recoveredStop(owner, operation, body) {
    const { p, entry } = owner, link = links.get(p.id)
    const record = saved.ownership.find((item) => item.recovered && item.projectId === p.id && item.conversationId === entry.id &&
      (operation === 'camera.stop' ? item.kind === 'camera' && item.captureSessionId === body.expectedCaptureSessionId :
        operation === 'commissioning.stop' ? item.kind === 'commissioning' && item.trialId === body.trialId : item.kind === 'execution' && item.runId === body.runId))
    if (!record) return null
    if (!link?.clients || link.status !== 'connected' || p.connection.expectedNodeId !== record.nodeId) throw fail('RECOVERY_REQUIRED', 'Reconnect the exact original Node before retrying its owned Stop')
    let confirmed = false
    if (record.kind === 'camera') {
      const status = await link.clients.camera.stop({ expectedCaptureSessionId: record.captureSessionId })
      confirmed = status.phase === 'stopped' && status.captureSessionId === record.captureSessionId
    }
    else if (record.kind === 'commissioning') {
      const status = await link.clients.commissioning.stop({ expectedNodeSessionId: record.nodeSessionId, trialId: record.trialId, reason: 'operator-requested-stop' })
      assertGripperCheckMatches(status, record.commissioningStatus)
      confirmed = status.nodeSessionId === record.nodeSessionId && status.trial?.trialId === record.trialId && status.trial.digest === record.commissioningStatus?.trial?.digest && !commissioningUnresolved(status)
    }
    else {
      const run = await link.clients.execution.stop(record.runId, { reason: 'operator-requested-stop' }, record.pins || { runId: record.runId })
      assertRunMatches(run, { ...record.pins, runId: record.runId })
      confirmed = TERMINAL_RUN.has(run.phase) && run.stopStatus === 'STOP_CONFIRMED'
    }
    if (!confirmed) { emit(); throw fail('STOP_UNCONFIRMED', 'Stop could not be confirmed for the retained operation. Its ownership is preserved; inspect the same Node and retry Stop.') }
    if (confirmed) { saved.ownership = saved.ownership.filter((item) => item !== record); if (!storageFailed) save() }
    emit(); return snapshot()
  }

  async function command(name, input = {}) {
    const independent = name.endsWith('.stop') || name === 'workcell.camera.frame' || name === 'session.agentState'
    try {
      ensureOpen(independent); const body = clean(input)
      if (name === 'project.create') {
        fields(body, ['name', 'cwd', 'connection'], ['name', 'connection'])
        if (catalogPending) throw fail('REQUEST_PENDING', 'A project update is pending')
        catalogPending = true
        try {
          if (saved.projects.length >= 256) throw fail('PROJECT_LIMIT', 'The project limit is reached')
          const connection = body.connection
          fields(connection, ['type', 'label', 'nodeUrl', 'host', 'username', 'port', 'remotePort', 'keyPath', 'knownHostsPath'], ['type'])
          if (!['simulation', 'local', 'ssh'].includes(connection.type)) throw fail('INVALID_CONNECTION', 'Choose simulation, local or SSH')
          if (connection.type === 'local') connection.nodeUrl = connections.normalizeLocalEndpoint(connection.nodeUrl)
          if (connection.type === 'ssh') connectionAdapters.buildSshArgs({ ...connection, remotePort: connection.remotePort || 8876 }, 1)
          const id = `project-${randomUUID()}`, name = text(body.name, 'Project name')
          const cwd = body.cwd ? path.resolve(text(body.cwd, 'Project folder', 2000)) : await createManagedWorkspace(dataDir, id)
          if (body.cwd) await mkdir(cwd, { recursive: true, mode: 0o700 })
          saved.projects.push({ id, name, cwd, generation: 0,
            connection: { ...connection, label: text(connection.label || (connection.type === 'simulation' ? 'Synthetic simulation' : connection.type === 'ssh' ? connection.host : 'This computer'), 'Connection label') } })
          saved.selection = { projectId: id, conversationId: null }; save()
          if (connection.type === 'simulation') links.set(id, { status: 'connected', observedAt: now(), error: null })
          emit(); return snapshot()
        } finally { catalogPending = false }
      }
      if (name === 'session.bind') {
        fields(body, ['projectId', 'serverId', 'sessionId', 'title', 'activate'], ['projectId', 'serverId', 'sessionId'])
        if (body.activate !== undefined && typeof body.activate !== 'boolean') throw fail('INVALID_REQUEST', 'Session activation must be an explicit boolean')
        const p = project(body.projectId); if (!p) throw fail('PROJECT_CHANGED', 'Select an existing project')
        const serverId = text(body.serverId, 'OpenCode server identity', 512), sessionId = text(body.sessionId, 'OpenCode session identity', 256)
        let entry = saved.bindings.find((item) => item.serverId === serverId && item.sessionId === sessionId)
        if (entry && entry.projectId !== p.id) throw fail('SESSION_OWNED', 'This OpenCode session already belongs to another physical project')
        if (!entry) {
          if (saved.bindings.length >= 1024) throw fail('SESSION_LIMIT', 'The conversation binding limit is reached')
          entry = { id: `conversation-${randomUUID()}`, projectId: p.id, serverId, sessionId, title: text(body.title || 'New conversation', 'Conversation title') }
          saved.bindings.push(entry); save(); openContext(entry)
        }
        // Binding a background model call never changes the operator's review
        // context. Selection is separately required by approval and continuation.
        if (body.activate !== false) { saved.selection = { projectId: p.id, conversationId: entry.id }; save() }
        const agentToken = contexts.get(entry.id).agentToken; tokens.set(agentToken, entry.id)
        emit(); return { binding: bindingScope(entry), agentToken, snapshot: snapshot() }
      }
      if (name === 'project.select' || name === 'session.select') {
        fields(body, ['projectId', 'conversationId'], ['projectId'])
        const p = project(body.projectId), entry = body.conversationId ? binding(body.conversationId) : saved.bindings.find((item) => item.projectId === p?.id)
        if (!p || (body.conversationId && entry?.projectId !== p.id)) throw fail('SCOPE_CHANGED', 'The project or conversation changed')
        saved.selection = { projectId: p.id, conversationId: entry?.id || null }; save(); emit(); return snapshot()
      }
      if (name === 'connection.connect' || name === 'connection.disconnect' || name === 'connection.saveCredential') {
        fields(body, ['projectId', 'cameraToken', 'executionToken'], ['projectId'])
        const p = project(body.projectId); if (!p) throw fail('PROJECT_CHANGED', 'Select an existing project')
        if (name === 'connection.connect') return connect(p)
        const link = links.get(p.id)
        if (name === 'connection.saveCredential') {
          if (link?.endpoint || pendingProjects.has(p.id)) throw fail('CONNECTION_ACTIVE', 'Disconnect before replacing Node credentials')
          const credential = { cameraToken: text(body.cameraToken, 'Camera token', 256), executionToken: body.executionToken ? text(body.executionToken, 'Execution token', 256) : '' }
          const reference = p.connection.credentialRef || `operator-${hash([dataDir, p.id]).slice(0, 40)}`
          await secrets.write(reference, JSON.stringify(credential)); p.connection.credentialRef = reference; save(); emit(); return snapshot()
        }
        if (pendingProjects.has(p.id) || (link?.physical && unresolved(link.physical.workcell.snapshot())) || saved.ownership.some((record) => record.projectId === p.id)) throw fail('OWNERSHIP_UNRESOLVED', 'Stop or resolve this project’s owned operation before disconnecting.')
        clearTimeout(link?.timer); link?.leave?.(); await link?.physical?.dispose(); await link?.close?.(); link?.offDisconnect?.()
        if (link?.key) endpointOwners.delete(link.key)
        if (p.connection.expectedNodeId) nodeOwners.delete(p.connection.expectedNodeId)
        links.delete(p.id); p.generation += 1; save(); emit(); return snapshot()
      }
      const owner = scope(body, { generation: name !== 'session.agentState' && name !== 'experiment.stop' && name !== 'experiment.finish' && name !== 'workcell.commissioning.stop' })
      if (name === 'session.agentState') {
        fields(body, ['projectId', 'conversationId', 'serverId', 'sessionId', 'connectionGeneration', 'busy', 'error'], ['serverId', 'sessionId', 'busy'])
        if (typeof body.busy !== 'boolean') throw fail('INVALID_REQUEST', 'Agent busy state must be explicit')
        owner.context.busy = body.busy; owner.context.error = body.error ? text(body.error, 'Agent error', 500) : null
        const link = links.get(owner.p.id)
        if (link?.physicalOwner === owner.entry.id) { if (body.busy) link.physical.workcell.agentStart(''); else link.physical.workcell.agentSettled() }
        emit(); return snapshot()
      }
      if (name.startsWith('experiment.')) {
        const operation = name.slice(11), allowed = {
          propose: ['goal', 'trialLimit', 'requestId', 'mode'], approve: ['experimentId', 'expectedDigest', 'approved'],
          approveAndContinue: ['experimentId', 'expectedDigest', 'approved', 'requestId'], continue: ['experimentId', 'expectedDigest', 'requestId'],
          trial: ['experimentId', 'requestId', 'offsetMm'], finish: ['experimentId'], stop: ['experimentId'],
        }[operation]
        if (!allowed) throw fail('UNSUPPORTED_COMMAND', 'This experiment action is unsupported')
        fields(body, ['projectId', 'conversationId', 'connectionGeneration', 'serverId', 'sessionId', ...allowed])
        if (operation === 'stop') { owner.context.stopEpoch += 1; owner.context.continuation?.abort() }
        return await withContext(owner.context, operation === 'stop', async () => {
          if (operation === 'approveAndContinue' || operation === 'continue') return continueExperiment(owner, body, operation === 'approveAndContinue')
          if (operation === 'approve') {
            scope(body, { selected: true })
            if (body.approved !== true) throw fail('APPROVAL_REQUIRED', 'Explicitly approve this exact synthetic proposal')
          }
          const payload = Object.fromEntries(allowed.filter((key) => key !== 'approved' && Object.hasOwn(body, key)).map((key) => [key, body[key]]))
          const result = await owner.context.experiments[operation](payload); emit(); return result
        })
      }
      if (name.startsWith('workcell.')) {
        const operation = name.slice(9), stop = operation.endsWith('.stop'), frame = operation === 'camera.frame'
        if (!['refresh', 'setup.inspect', 'camera.start', 'camera.stop', 'camera.frame', 'execution.refresh', 'execution.prepare', 'execution.approve', 'execution.stop', 'execution.select', 'execution.receipt', 'execution.reconcile', 'commissioning.refresh', 'commissioning.inspect', 'commissioning.prepare', 'commissioning.approve', 'commissioning.stop'].includes(operation)) throw fail('UNSUPPORTED_COMMAND', 'This workcell action is unsupported')
        if (stop) {
          owner.context.physicalStopEpoch += 1
          const recovered = await recoveredStop(owner, operation, body)
          if (recovered) return recovered
        }
        if (!stop) scope(body, { physical: true })
        const review = ['camera.start', 'execution.prepare', 'execution.approve', 'commissioning.inspect', 'commissioning.prepare', 'commissioning.approve'].includes(operation)
        if (review) scope(body, { selected: true })
        return await withContext(owner.context, stop || frame, () => withPhysical(owner, stop || frame, async (physical) => {
          if (review) scope(body, { selected: true })
          const { projectId, conversationId, serverId, sessionId, connectionGeneration, ...payload } = body
          if (operation === 'refresh') { fields(payload, []); return physical.workcell.refresh() }
          if (operation === 'setup.inspect') return physical.inspectSetup(payload)
          if (operation === 'camera.frame') { fields(payload, ['frameId'], ['frameId']); return { ...await physical.workcell.cameraFrame(text(payload.frameId, 'Frame ID', 128)), id: payload.frameId, ...bindingScope(owner.entry), captureSessionId: physical.workcell.snapshot().camera.stopCaptureSessionId } }
          if (['camera.start', 'execution.prepare'].includes(operation)) {
            saved.ownership.push({ projectId: owner.p.id, conversationId: owner.entry.id, nodeId: owner.p.connection.expectedNodeId,
              connectionGeneration: owner.p.generation, kind: operation.startsWith('camera') ? 'camera' : 'execution',
              captureSessionId: null, runId: null, status: 'REQUEST_PENDING', recovered: false }); save()
          }
          if (operation.startsWith('camera.')) return physical.workcell.cameraAction(operation.slice(7), payload)
          if (operation.startsWith('commissioning.') && !stop) scope(body, { physical: true, selected: review })
          if (operation === 'commissioning.approve') { journalPhysical(owner.p, owner.entry, links.get(owner.p.id)); save() }
          if (operation.startsWith('commissioning.')) return physical.workcell.commissioningAction(operation.slice(14), payload)
          if (operation.startsWith('execution.')) return physical.workcell.executionAction(operation.slice(10), payload)
          throw fail('UNSUPPORTED_COMMAND', 'This workcell action is unsupported')
        }))
      }
      throw fail('UNSUPPORTED_COMMAND', 'This operator command is unsupported')
    } catch (error) { throw publicError(error) }
  }
  async function agentCall(input) {
    try {
      ensureOpen()
      fields(input, ['agentToken', 'name', 'arguments', 'callId', 'signal'], ['agentToken', 'name', 'arguments', 'callId'])
      const { signal, ...payload } = input
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('INVALID_REQUEST', 'The trusted cancellation signal is invalid')
      const checkCancelled = () => { if (signal?.aborted) throw fail('REQUEST_CANCELLED', 'The assistant request was cancelled. Inspect its retained outcome before retrying.') }
      checkCancelled()
      const body = clean(payload)
      fields(body, ['agentToken', 'name', 'arguments', 'callId'], ['agentToken', 'name', 'arguments', 'callId'])
      const id = tokens.get(body.agentToken), entry = binding(id)
      if (!entry || !agentToolNames.includes(body.name)) throw fail('AGENT_FORBIDDEN', 'This agent capability or tool is not available')
      const definition = agentToolDefinitions.find((tool) => tool.name === body.name), args = body.arguments
      fields(args, Object.keys(definition.parameters.properties || {}), definition.parameters.required || [])
      const callId = text(body.callId, 'Tool call ID', 256), stableId = `agent-${hash([entry.serverId, entry.sessionId, callId])}`
      const owner = scope(bindingScope(entry)), context = owner.context
      return await withContext(context, false, async () => {
        checkCancelled()
        let result
        const tool = context.tools.find((tool) => tool.name === body.name)
        if (tool) {
          try { result = await tool.execute(callId, { ...args, ...(['propose_local_experiment', 'run_simulated_trial'].includes(body.name) ? { requestId: stableId } : {}) }, signal) }
          catch (error) { throw fail(error.code || 'EXPERIMENT_UNAVAILABLE', error.message) } // The canonical tool already projects public failures.
        }
        else if (body.name === 'read_agent_skill') {
          skillTool ||= createReadAgentSkillTool({ registry: loadVerifiedAgentSkills({ ...(skillPackageRoot ? { packageRoot: skillPackageRoot } : {}) }) })
          result = await skillTool.execute(callId, args)
        } else {
          scope(bindingScope(entry), { physical: true })
          result = await withPhysical(owner, false, async (physical) => {
            const physicalTool = physical.tools.find((tool) => tool.name === body.name)
            if (physicalTool) return physicalTool.execute(callId, args)
            const value = body.name === 'inspect_physical_setup' ? await physical.inspectSetup(args) : await physical.inspectExecution(args)
            return { content: [{ type: 'text', text: JSON.stringify(value) }] }
          })
        }
        checkCancelled()
        const current = context.experiments.snapshot().current
        return { ...result, details: { ...result.details, physicalSystems: { ...bindingScope(entry),
          ...(tool && current ? { experimentId: current.id, planDigest: current.planDigest } : {}) } } }
      })
    } catch (error) { throw publicError(error) }
  }
  async function close() {
    if (closed) return
    if (closePromise) return closePromise
    if (catalogPending || pendingProjects.size || [...contexts.values()].some((context) => context.mutation || context.continuation || ACTIVE.has(context.experiments.snapshot().current?.phase)) ||
        [...links.values()].some((link) => link.physical && unresolved(link.physical.workcell.snapshot())) || saved.ownership.length) throw fail('OWNERSHIP_UNRESOLVED', 'Stop or resolve the retained operations and pending requests before closing the service.')
    closing = true
    closePromise = (async () => {
      try {
        for (const link of links.values()) {
          clearTimeout(link.timer); link.leave?.(); await link.physical?.dispose()
          link.physical = null; link.physicalOwner = null; link.leave = null
          try { await link.close?.() }
          catch {
            link.status = 'offline'; link.observedAt = null
            link.error = 'Connection cleanup is unconfirmed. Retain this connection and retry closing after its status is resolved.'
            emit(); throw fail('CLEANUP_UNCONFIRMED', link.error)
          }
          link.offDisconnect?.(); link.status = 'offline'; link.observedAt = null; link.transportLost = true
        }
        // A failed transport cleanup leaves experiment controllers usable for
        // inspection and retry instead of half-disposing the conversation.
        for (const context of contexts.values()) { context.unsubscribe(); await context.experiments.dispose() }
        closed = true; tokens.clear(); listeners.clear(); store.release()
      } finally { closing = false; closePromise = null }
    })()
    return closePromise
  }
  return Object.freeze({ snapshot, command, agentCall, close,
    subscribe(listener) { ensureOpen(); if (typeof listener !== 'function') throw new TypeError('A listener is required'); listeners.add(listener); return () => listeners.delete(listener) },
  })
}
