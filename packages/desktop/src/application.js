// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createConfig } from '../../cli/src/config.js'
import { createNativeSecretStore } from '../../cli/src/auth/secret-store.js'
import { createPhysicalNodeClient } from '../../cli/src/physical/node-client.js'
import { createCameraPreviewClient } from '../../cli/src/physical/camera-preview-client.js'
import { createHarnessHost } from '../../cli/src/harness/application-host.js'
import { workcellRequestFailure } from '../../cli/src/harness/workcell-controller.js'
import { listProvidersCommand, providerLoginCommand, providerLogoutCommand } from '../../cli/src/commands/provider.js'
import * as connectionAdapters from './connections.js'
import { createSimulationHost } from './simulation.js'
import { validateAuthDestination } from './bridge-contract.js'

const TERMINAL = new Set(['VERIFIED_SUCCESS', 'FAILED', 'CANCELLED', 'BLOCKED'])
const text = (value, label, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`)
  return value.trim()
}
const fresh = (at) => Number.isFinite(Date.parse(at)) && Date.now() - Date.parse(at) >= 0 && Date.now() - Date.parse(at) < 10_000
const unavailable = async () => { throw new Error('Connect the project to inspect its devices.') }
const disconnectedOptions = {
  createPhysicalNodeClientImpl: () => ({ origin: 'http://127.0.0.1:1', inspect: unavailable, capabilities: unavailable, previewCapability: unavailable, routeReceipt: unavailable, interpret: unavailable }),
  createCameraPreviewClientImpl: () => ({ status: unavailable, frame: unavailable, start: unavailable, stop: unavailable }),
  createExecutionClientImpl: () => ({ status: unavailable, runs: unavailable }),
}

export async function createApplication({ dataDir, catalog, connections = connectionAdapters, env = process.env,
  hostFactory = createHarnessHost, simulationFactory = createSimulationHost, secretStore: suppliedSecrets,
  probeNode: suppliedProbe, now = () => new Date().toISOString(), healthIntervalMs = 4000,
  providerCommands = { list: listProvidersCommand, login: providerLoginCommand, logout: providerLogoutCommand }, loginTimeoutMs = 300_000 } = {}) {
  if (!catalog?.transaction || !path.isAbsolute(dataDir || '')) throw new Error('An isolated desktop catalog and data directory are required')
  const config = createConfig({ TINYEDGE_CONFIG_DIR: path.join(dataDir, 'harness') })
  await mkdir(config.configDir, { recursive: true, mode: 0o700 })
  const nativeSecrets = suppliedSecrets || createNativeSecretStore({ configDir: config.configDir })
  const prefix = `desktop-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}-`
  const secrets = Object.fromEntries(['read', 'write', 'delete'].map((method) => [method, (name, ...args) => nativeSecrets[method](prefix + name, ...args)]))
  secrets.kind = nativeSecrets.kind
  const hosts = new Map(), links = new Map(), creating = new Map(), listeners = new Set(), endpointOwners = new Map(), nodeOwners = new Map()
  let revision = 0, closing = false, notice = '', providers = [], loginQuestion = null, loginPending = null
  let mutation = null
  const state = () => catalog.snapshot()
  const project = (id = state().selection.projectId) => state().projects.find((p) => p.id === id && !p.archived)
  const conversation = (id = state().selection.conversationId) => state().conversations.find((c) => c.id === id && !c.archived)
  const profile = (p) => state().connections.find((c) => c.id === p?.connectionId)
  const projectConversation = (p) => conversation(p?.lastConversationId) || state().conversations.find((c) => c.projectId === p?.id && !c.archived)
  const generation = (id) => links.get(id)?.generation || 0
  const workcellFailure = (error) => {
    const failure = workcellRequestFailure(error)
    if (failure?.code === 'model_unavailable') return 'Select a model and connect its provider in Model & app settings before sending a message.'
    if (failure?.code === 'question_expired') return 'This question is no longer current. Use the current question in this conversation.'
    return failure?.message.replace('check the terminal', 'check the selected connection')
  }
  const safeFailure = (error) => error?.publicMessage || workcellFailure(error)
    || (/^(ERR_HARNESS_|SSH_|NODE_|CONNECTION_|INVALID_PROFILE|TINYEDGE_SECRET_SERVICE_UNAVAILABLE)/.test(error?.code || '') ? error.message
      : 'The request could not be completed. Check the selected connection or model settings and try again.')
  const fail = (message) => { const error = new Error(message); error.publicMessage = message; return error }
  const unresolvedRuns = (execution) => [...new Map([...(execution?.activeRuns || []), ...(execution?.runs || []), ...(execution?.run ? [execution.run] : [])]
    .filter((run) => !TERMINAL.has(run.phase) || run.stopStatus === 'STOP_UNCONFIRMED').map((run) => [run.runId, run])).values()]
  function unresolved(host) {
    const wc = host?.getWorkcell()?.snapshot()
    return Boolean(wc?.camera.pending || wc?.camera.stopPending || wc?.camera.stopUnconfirmed
      || wc?.camera.stopCaptureSessionId || wc?.execution.pending || wc?.execution.stopPending
      || unresolvedRuns(wc?.execution).length)
  }
  function snapshot() {
    const stored = state(), p = project(), c = conversation(), entry = hosts.get(p?.id), current = entry?.host
    const consistent = entry?.conversationId === c?.id
    const hs = (consistent ? entry?.switching || current?.snapshot() : null) || {}
    const observedWorkcell = !entry?.switching && consistent ? current?.getWorkcell()?.snapshot() || null : null
    const currentLink = links.get(p?.id), isConnected = currentLink?.status === 'connected' && currentLink.ready && fresh(currentLink.observedAt)
    // Connection loss clears pixels and readiness immediately, while the owned
    // controller retains exact capture/run IDs for Stop and reconciliation.
    const wc = observedWorkcell && !isConnected ? { ...observedWorkcell,
      camera: { ...observedWorkcell.camera, availability: 'unavailable', frame: null, previewFrameId: null, receivedAt: null },
      execution: { ...observedWorkcell.execution, canPrepare: false, canApprove: false } } : observedWorkcell
    return {
      revision, activeProjectId: p?.id || null, activeConversationId: c?.id || null,
      connectionGeneration: generation(p?.id), notice,
      projects: stored.projects.filter((item) => !item.archived).map((item) => {
        const connection = profile(item), link = links.get(item.id), host = hosts.get(item.id)?.host
        const view = host?.getWorkcell()?.snapshot(), observation = link?.observation || view?.workflow?.snapshot
        const observed = observation?.discovery?.observedAt || observation?.observedAt
        const status = link?.status === 'connected' && !link.ready ? 'connecting' : link?.status === 'connected' && !fresh(link.observedAt) ? 'reconnecting' : link?.status || 'offline'
        return { id: item.id, name: item.name, archived: false,
          connection: { id: connection.id, kind: connection.type, label: connection.label, status,
            autoConnect: connection.autoConnect === true,
            error: link?.error || null, observedAt: link?.observedAt || null,
            deviceCount: status === 'connected' && fresh(observed) ? (observation?.discovery?.devices || []).filter((d) => d.detected).length : null,
            inUseCount: status === 'connected' && view?.camera?.status?.phase === 'live' ? 1 : null },
          conversations: stored.conversations.filter((entry) => entry.projectId === item.id && !entry.archived)
            .map(({ id, title, archived }) => ({ id, title, archived })) }
      }),
      conversation: c ? { id: c.id, title: c.title, messages: hs.messages || hs.transcript || [], busy: Boolean(hs.busy || entry?.switching),
        question: wc?.agent?.pendingChoice || null, error: hs.error || (!consistent && entry && !entry.switching ? 'The saved selection could not be confirmed. Choose a conversation again.' : null), draft: c.draft || '', model: hs.model || null } : null,
      workcell: wc, setupReport: entry?.setupReport || null, models: entry?.models || [],
      settings: { providers, loginQuestion, loginPending: Boolean(loginPending), simulation: profile(p)?.type === 'simulation' },
      activeCaptures: [...hosts].flatMap(([id, value]) => {
        const camera = value.host.getWorkcell()?.snapshot()?.camera
        return camera?.stopCaptureSessionId || camera?.pending ? [{ projectId: id, projectName: project(id)?.name,
          connectionGeneration: generation(id), captureSessionId: camera.stopCaptureSessionId,
          statusUnavailable: links.get(id)?.status !== 'connected' || !fresh(links.get(id)?.observedAt),
          pending: camera.pending, stopPending: camera.stopPending, stopUnconfirmed: camera.stopUnconfirmed, canStop: !camera.stopPending }] : []
      }),
      activeRuns: [...hosts].flatMap(([id, value]) => {
        const view = value.host.getWorkcell()?.snapshot()
        return unresolvedRuns(view?.execution).map((run) => ({ projectId: id, projectName: project(id)?.name, connectionGeneration: generation(id), run,
          statusUnavailable: links.get(id)?.status !== 'connected' || !fresh(links.get(id)?.observedAt) || view.execution.availability !== 'available', canStop: !view.execution.stopPending }))
      }),
    }
  }
  function emit() { revision += 1; const value = snapshot(); for (const listener of listeners) { try { listener(value) } catch {} } }
  function sessionPath(reference) {
    if (!reference) return undefined
    if (!/^harness\/harness-sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(reference)) throw fail('The saved session reference is invalid. Its file was preserved.')
    return path.join(dataDir, reference)
  }
  async function persistSession(p, c, host) {
    const hs = host.snapshot()
    await catalog.transaction((draft) => {
      const item = draft.conversations.find((entry) => entry.id === c.id)
      if (item) {
        if (hs.sessionFile) { const reference = path.relative(dataDir, hs.sessionFile).split(path.sep).join('/'); sessionPath(reference); item.sessionFile = reference }
        if (hs.sessionId) item.sessionId = hs.sessionId
        item.updatedAt = now()
      }
    })
  }
  async function ensureHost(p, c = projectConversation(p)) {
    if (hosts.has(p.id)) return hosts.get(p.id).host
    if (creating.has(p.id)) return creating.get(p.id)
    const task = (async () => {
      const connection = profile(p), link = links.get(p.id)
      let entry = null, pendingController = null
      const onWorkcell = (controller) => {
        pendingController = controller
        if (entry) { entry.leave?.(); entry.leave = controller?.onViewerConnect() || null; entry.setupReport = null }
      }
      const options = { config, secretStore: secrets, cwd: p.cwd || path.join(dataDir, 'projects', p.id), sessionFile: c?.projectId === p.id ? sessionPath(c.sessionFile) : undefined, onWorkcell,
        env: { ...env, TINYEDGE_PHYSICAL_NODE_URL: link?.endpoint || 'http://127.0.0.1:1',
          PHYSICAL_NODE_CAMERA_TOKEN: link?.credential?.cameraToken || '', PHYSICAL_NODE_EXECUTION_TOKEN: link?.credential?.executionToken || '' },
        ...(!link || link.status !== 'connected' ? { extensionOptions: disconnectedOptions } : {}) }
      await mkdir(options.cwd, { recursive: true, mode: 0o700 })
      const host = connection.type === 'simulation'
        ? await simulationFactory({ ...options, dataDir: path.join(dataDir, 'simulation'), projectId: p.id })
        : await hostFactory(options)
      entry = { host, unsubscribe: host.subscribe(() => emit()), leave: null, setupReport: null, conversationId: c?.id || null, models: [] }
      hosts.set(p.id, entry)
      entry.leave = (pendingController || host.getWorkcell())?.onViewerConnect()
      if (c?.projectId === p.id) await persistSession(p, c, host)
      if (connection.type !== 'simulation') entry.models = await host.listModels().catch(() => [])
      return host
    })().finally(() => creating.delete(p.id))
    creating.set(p.id, task)
    return task
  }
  async function disposeHost(id) {
    const entry = hosts.get(id)
    if (!entry) return
    if (unresolved(entry.host)) throw fail('Stop or resolve the current camera capture or run before closing this connection.')
    if (entry.host.snapshot().busy) throw fail('Cancel the current assistant response before closing this connection.')
    await entry.host.dispose(); entry.leave?.(); entry.unsubscribe?.(); hosts.delete(id)
  }
  const probeNode = suppliedProbe || (async ({ endpoint, credential, expectedNodeId }) => {
    if (!credential?.cameraToken) throw fail('Save the Node camera authorization token in connection settings before connecting.')
    const client = createPhysicalNodeClient({ baseUrl: endpoint })
    const [observed] = await Promise.all([client.inspect(), createCameraPreviewClient({ baseUrl: endpoint, token: credential.cameraToken }).status()])
    const nodeId = observed.nodeName
    if (expectedNodeId && nodeId !== expectedNodeId) throw fail('The responding Node identity changed. Review the connection before continuing.')
    return { authenticated: true, nodeId, observation: observed }
  })
  function ownIdentity(p, link, identity) {
    if (!identity?.nodeId || identity.authenticated === false) throw fail('Node authorization and identity could not be confirmed.')
    if (nodeOwners.has(identity.nodeId) && nodeOwners.get(identity.nodeId) !== p.id) throw fail('This Node is already owned by another project. Use that project or disconnect it before attaching again.')
    if (link.identity?.nodeId && link.identity.nodeId !== identity.nodeId) throw fail('The responding Node identity changed. Review the connection before continuing.')
    nodeOwners.set(identity.nodeId, p.id)
    link.identity = identity; link.observation = identity.observation || link.observation
  }
  async function closeLink(id) {
    const link = links.get(id)
    if (!link) return
    clearInterval(link.timer)
    link.monitorEpoch = (link.monitorEpoch || 0) + 1
    link.status = 'disconnecting'; link.observedAt = null; emit()
    // Keep the handle and ownership if tunnel cleanup cannot be confirmed.
    try { await link.close?.() }
    catch (error) { link.status = 'offline'; link.error = 'Connection cleanup is unconfirmed. Retry Disconnect before replacing this connection.'; emit(); throw error }
    link.offDisconnect?.()
    endpointOwners.delete(link.identityKey)
    if (nodeOwners.get(link.identity?.nodeId) === id) nodeOwners.delete(link.identity.nodeId)
    Object.assign(link, { generation: link.generation + 1, status: 'offline', ready: false, observedAt: null, credential: null, close: null, endpoint: null })
  }
  function monitor(p, connection, link) {
    clearTimeout(link.timer)
    const epoch = link.monitorEpoch = (link.monitorEpoch || 0) + 1
    let failures = 0
    const current = () => link.monitorEpoch === epoch && !closing && links.get(p.id) === link && !link.transportLost
    const schedule = (delayMs) => {
      if (!current()) return
      link.timer = setTimeout(check, delayMs)
      link.timer.unref?.()
    }
    async function check() {
      if (!current()) return
      try {
        const identity = connection.type !== 'simulation' ? await probeNode({ endpoint: link.endpoint, credential: link.credential, expectedNodeId: link.identity?.nodeId }) : null
        if (!current()) return
        if (identity) ownIdentity(p, link, identity)
        else {
          const observed = hosts.get(p.id)?.host.getWorkcell()?.snapshot()?.workflow?.snapshot
          if (observed) link.observation = { ...observed, discovery: { ...observed.discovery, observedAt: now() } }
        }
        // Health checks never reroute or invalidate an operator's proposal.
        failures = 0
        link.status = 'connected'; link.observedAt = now(); link.error = null
      } catch {
        if (!current()) return
        failures += 1
        link.status = failures >= 5 ? 'offline' : 'reconnecting'
        link.error = failures >= 5
          ? 'Automatic reconnect stopped after five failed checks. Choose Connect to retry the same Node; Stop remains available for owned captures and runs.'
          : `The connection could not be verified. Retrying automatically (${failures} of 4); choose Connect to retry now.`
      }
      if (!current()) return
      emit()
      // Four retries after the first failed check, with capped exponential
      // backoff. A manual Connect starts a new epoch on the same owned link.
      if (failures < 5) schedule(failures ? Math.min(healthIntervalMs * 2 ** (failures - 1), 30_000) : healthIntervalMs)
    }
    schedule(healthIntervalMs)
  }
  async function connect(p) {
    const connection = profile(p), old = links.get(p.id)
    if (old?.status === 'connecting') throw fail('This connection is already being checked.')
    if (old?.status === 'connected' && fresh(old.observedAt)) return
    if (old?.endpoint) {
      clearInterval(old.timer); old.monitorEpoch = (old.monitorEpoch || 0) + 1
      // Recover the same exact endpoint/controller: never abandon an owned run
      // or replace a camera session because its transport disappeared.
      try {
        if (old.transportLost && connection.type === 'ssh') {
          await old.close?.()
          const attached = await connections.attachSSH(connection, { credentialResolver: async () => old.credential, probeNode,
            allocatePort: async () => Number(new URL(old.endpoint).port) })
          try { ownIdentity(p, old, attached.identity) }
          catch (error) {
            try { await attached.close() }
            catch { old.close = attached.close; old.transportLost = true; throw fail('The reconnected Node was not accepted and tunnel cleanup is unconfirmed. Retry Disconnect without replacing its owner.') }
            throw error
          }
          old.offDisconnect?.(); Object.assign(old, attached, { transportLost: false })
          old.offDisconnect = attached.onDisconnect?.(() => { old.transportLost = true; old.status = 'offline'; old.error = 'SSH disconnected. Device and run outcomes are unknown until this connection recovers.'; emit() })
        } else if (connection.type !== 'simulation') ownIdentity(p, old, await probeNode({ endpoint: old.endpoint, credential: old.credential, expectedNodeId: old.identity?.nodeId }))
        old.status = 'connected'; old.error = null; old.observedAt = now()
        if (!old.ready) { await ensureHost(p); await hosts.get(p.id).host.getWorkcell()?.refresh(); old.ready = true }
        monitor(p, connection, old); emit(); return
      } catch (error) {
        const explanation = safeFailure(error)
        old.status = 'offline'
        old.error = error?.code === 'SSH_STOP_UNCONFIRMED' || /cleanup is unconfirmed/i.test(explanation)
          ? explanation
          : `${explanation} Choose Connect to retry the same Node; Stop remains available for owned captures and runs.`
        emit(); throw fail(old.error)
      }
    }
    const identityKey = connection.type === 'ssh' ? `ssh:${connection.username}@${connection.host}:${connection.port || 22}:${connection.remotePort || 8876}`
      : connection.type === 'local' ? connections.normalizeLocalEndpoint(connection.nodeUrl).replace('localhost', '127.0.0.1') : `simulation:${p.id}`
    if (endpointOwners.has(identityKey) && endpointOwners.get(identityKey) !== p.id) throw fail('This Node is already connected in another project. Disconnect that project before attaching a second owner.')
    await disposeHost(p.id)
    const link = { generation: (old?.generation || 0) + 1, status: 'connecting', observedAt: null, error: null, identityKey }
    links.set(p.id, link); endpointOwners.set(identityKey, p.id); emit()
    try {
      const credential = connection.credentialRef ? JSON.parse(await secrets.read(connection.credentialRef) || 'null') : null
      const attached = connection.type === 'simulation' ? { endpoint: 'simulation', identity: { authenticated: true, nodeId: `simulation-${p.id}` }, close: async () => {}, onDisconnect: () => () => {} }
        : await (connection.type === 'ssh' ? connections.attachSSH : connections.attachLocal)(connection, { credentialResolver: async () => credential, probeNode })
      Object.assign(link, { endpoint: attached.endpoint, close: attached.close, credential })
      ownIdentity(p, link, attached.identity)
      Object.assign(link, { status: 'connected', observedAt: now() })
      link.offDisconnect = attached.onDisconnect?.(() => { link.transportLost = true; link.status = 'offline'; link.error = 'Connection lost. Device and run outcomes are unknown until the same Node responds.'; emit() })
      if (connection.type !== 'simulation' && !connection.expectedNodeId) await catalog.transaction((draft) => { draft.connections.find((item) => item.id === connection.id).expectedNodeId = attached.identity.nodeId })
      await ensureHost(p)
      await hosts.get(p.id).host.getWorkcell()?.refresh()
      link.ready = true
      monitor(p, connection, link); emit()
    } catch (error) {
      if (error?.connection) Object.assign(link, error.connection, { transportLost: true })
      link.status = 'offline'; link.error = safeFailure(error)
      if (!hosts.has(p.id)) {
        try { await closeLink(p.id) } catch { link.error = 'Connection cleanup is unconfirmed. Retry Disconnect before replacing this connection.' }
      }
      emit(); throw fail(link.error)
    }
  }
  async function selectConversation(p, c) {
    const oldHost = hosts.get(state().selection.projectId)?.host
    if (oldHost?.snapshot().busy) throw fail('Finish or cancel the assistant response before switching conversations.')
    const host = await ensureHost(p, c)
    const latest = conversation(c.id)
    const entry = hosts.get(p.id), previousId = entry.conversationId, previousFile = host.snapshot().sessionFile
    entry.switching = host.snapshot(); emit()
    try {
      if (latest.sessionFile && host.snapshot().sessionFile !== sessionPath(latest.sessionFile)) await host.openSession(sessionPath(latest.sessionFile))
      else if (!latest.sessionFile) { await host.createSession(); await persistSession(p, c, host) }
      await catalog.transaction((draft) => { draft.selection = { projectId: p.id, conversationId: c.id }; draft.projects.find((item) => item.id === p.id).lastConversationId = c.id })
      entry.conversationId = c.id
    } catch (error) {
      try { if (previousFile && host.snapshot().sessionFile !== previousFile) await host.openSession(previousFile); entry.conversationId = previousId }
      catch { entry.conversationId = null }
      throw error
    } finally { entry.switching = null; emit() }
    emit(); return snapshot()
  }
  function scoped(body, physical = false) {
    const p = project(body.projectId || state().selection.projectId)
    if (!p) throw fail('Select an existing project.')
    if (physical && (body.projectId !== p.id || body.connectionGeneration !== generation(p.id))) throw fail('The connection changed. Refresh and review the current device state.')
    if (body.conversationId && !state().conversations.some((c) => c.id === body.conversationId && c.projectId === p.id && !c.archived)) throw fail('The conversation no longer belongs to this project.')
    return p
  }
  async function runCommand(name, body = {}) {
    if (closing) throw fail('The desktop host is closing.')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Request fields are invalid.')
    if (name === 'project.create') {
      const id = `project-${randomUUID()}`, connectionId = `connection-${randomUUID()}`, conversationId = `conversation-${randomUUID()}`
      const name = text(body.name, 'Project name'), connection = body.connection
      if (!connection || !['simulation', 'local', 'ssh'].includes(connection.type)) throw fail('Choose a local, remote or simulation connection.')
      const cwd = body.cwd ? path.resolve(text(body.cwd, 'Working directory', 2000)) : path.join(dataDir, 'projects', id)
      await catalog.transaction((draft) => {
        draft.projects.push({ id, name, connectionId, cwd, archived: false, collapsed: false, lastConversationId: conversationId })
        draft.connections.push({ ...connection, id: connectionId, label: connection.label || (connection.type === 'simulation' ? 'Local simulation' : connection.type === 'ssh' ? connection.host : 'This computer'), autoConnect: false })
        draft.conversations.push({ id: conversationId, projectId: id, title: 'New conversation', archived: false, draft: '', createdAt: now(), updatedAt: now() })
        draft.selection = { projectId: id, conversationId }
      })
      if (connection.type === 'simulation') await connect(project(id))
      else await ensureHost(project(id), conversation(conversationId))
      emit(); return snapshot()
    }
    if (name === 'settings.get' || name === 'settings.models') {
      providers = await providerCommands.list({ config, modelsPath: null, secretStore: secrets, io: { log() {} } }).catch(() => [])
      const host = hosts.get(state().selection.projectId)?.host
      if (host) hosts.get(state().selection.projectId).models = await host.listModels().catch(() => [])
      emit(); return snapshot()
    }
    if (name === 'settings.providerLogin') {
      if (loginPending) throw fail('A provider sign-in is already in progress.')
      const providerId = text(body.providerId, 'Provider'), authType = body.authType || 'api_key'
      if (!['api_key', 'oauth'].includes(authType)) throw fail('Choose an available provider sign-in method.')
      const controller = new AbortController()
      loginPending = controller
      const active = () => loginPending === controller && !controller.signal.aborted
      const waitingQuestion = () => active() && controller.auth ? { id: randomUUID(), kind: 'oauth', ...controller.auth } : null
      controller.signal.addEventListener('abort', () => {
        controller.answer = null; controller.auth = null
        if (loginPending === controller) {
          loginQuestion = null
          notice = controller.signal.reason?.publicMessage || 'Provider sign-in cancelled.'
          emit()
        }
      }, { once: true })
      const timer = setTimeout(() => controller.abort(fail('Provider sign-in expired. Start a new sign-in in Settings.')), loginTimeoutMs)
      timer.unref?.()
      const operation = providerCommands.login({ config, modelsPath: null, providerId, authType, secretStore: secrets, io: { log() {} },
        interactionFactory: () => ({ signal: controller.signal, prompt: async (question) => {
          controller.signal.throwIfAborted()
          if (!active()) throw fail('This sign-in question expired. Start a new sign-in in Settings.')
          if (question.type === 'secret' && body.apiKey) return body.apiKey
          const signal = question.signal ? AbortSignal.any([controller.signal, question.signal]) : controller.signal
          signal.throwIfAborted()
          return new Promise((resolve, reject) => {
            const id = randomUUID()
            const abort = () => {
              if (controller.answer === answer) controller.answer = null
              if (loginQuestion?.id === id) { loginQuestion = waitingQuestion(); emit() }
              reject(signal.reason)
            }
            const answer = (value) => {
              signal.removeEventListener('abort', abort); controller.answer = null
              loginQuestion = waitingQuestion(); resolve(value); emit()
            }
            signal.addEventListener('abort', abort, { once: true })
            // OAuth adapters may notify and request manual input in the same
            // turn. The browser destination belongs to the whole login flow.
            loginQuestion = { id, question: question.message, kind: question.type, options: question.options || [], ...controller.auth }
            controller.answer = answer
            emit()
          })
        }, notify(event) {
          if (!active()) return
          if (event.type === 'auth_url' || event.type === 'device_code') {
            let url
            try { url = validateAuthDestination(event.url || event.verificationUri) }
            catch { throw fail('The provider supplied an unsupported sign-in URL.') }
            controller.auth = { url, userCode: typeof event.userCode === 'string' ? event.userCode.slice(0, 512) : null,
              instructions: typeof event.instructions === 'string' ? event.instructions.slice(0, 4000) : null }
            loginQuestion = controller.answer && loginQuestion ? { ...loginQuestion, ...controller.auth } : waitingQuestion()
            emit()
          }
        } })
      }).then(async () => { controller.signal.throwIfAborted(); notice = 'Provider connected. Select an available model.'; await runCommand('settings.get') })
        .catch((error) => { notice = controller.signal.aborted ? controller.signal.reason?.publicMessage || 'Provider sign-in cancelled.' : safeFailure(error) })
        .finally(() => { clearTimeout(timer); if (loginPending === controller) { loginPending = null; loginQuestion = null }; emit() })
      controller.operation = operation
      emit(); return { accepted: true }
    }
    if (name === 'settings.providerAnswer') {
      if (!loginPending?.answer || loginPending.signal.aborted || body.questionId !== loginQuestion?.id) throw fail('This sign-in question expired. Use the current question in Settings.')
      if (typeof body.answer !== 'string' || body.answer.length > 16_000) throw fail('Enter a bounded sign-in answer.')
      loginPending.answer(body.answer); return { accepted: true }
    }
    if (name === 'settings.providerCancel') { loginPending?.abort(fail('Provider sign-in cancelled.')); return { accepted: true } }
    if (name === 'settings.openAuthUrl') {
      if (!loginPending || loginPending.signal.aborted || !loginQuestion?.url || body.questionId !== loginQuestion.id) throw fail('This sign-in link expired. Start a new sign-in in Settings.')
      return { url: loginQuestion.url }
    }
    if (name === 'settings.providerLogout') {
      if ([...hosts.values()].some(({ host }) => host.snapshot().busy)) throw fail('Cancel active assistant responses before signing out their provider.')
      await providerCommands.logout({ config, modelsPath: null, providerId: text(body.providerId, 'Provider'), secretStore: secrets, io: { log() {} } }); return runCommand('settings.get')
    }
    const p = scoped(body, name.startsWith('workcell.')), c = conversation(body.conversationId)
    if (name === 'project.rename') { await catalog.transaction((draft) => { draft.projects.find((item) => item.id === p.id).name = text(body.name, 'Project name') }); emit(); return snapshot() }
    if (name === 'project.archive') {
      await disposeHost(p.id); await closeLink(p.id)
      await catalog.transaction((draft) => { draft.projects.find((item) => item.id === p.id).archived = true; if (draft.selection.projectId === p.id) draft.selection = { projectId: null, conversationId: null } }); emit(); return snapshot()
    }
    if (name === 'project.select') { const selected = projectConversation(p); if (!selected) throw fail('Create a conversation for this project.'); return selectConversation(p, selected) }
    if (name === 'conversation.select') { if (!c || c.projectId !== p.id) throw fail('Select a conversation in this project.'); return selectConversation(p, c) }
    if (name === 'conversation.create') {
      const owner = hosts.get(p.id)?.host
      if (owner?.snapshot().busy || unresolved(owner)) throw fail('Finish or cancel the response and resolve the current camera or run before creating another conversation.')
      const id = `conversation-${randomUUID()}`
      await catalog.transaction((draft) => draft.conversations.push({ id, projectId: p.id, title: body.title ? text(body.title, 'Conversation title') : 'New conversation', archived: false, draft: '', createdAt: now(), updatedAt: now() }))
      return selectConversation(p, conversation(id))
    }
    if (name === 'conversation.rename' || name === 'conversation.archive' || name === 'conversation.saveDraft') {
      if (!c || c.projectId !== p.id) throw fail('Select an existing conversation.')
      if (name === 'conversation.archive' && hosts.get(p.id)?.host.snapshot().busy) throw fail('Cancel the response before archiving its conversation.')
      if (name === 'conversation.archive' && hosts.get(p.id)?.conversationId === c.id && unresolved(hosts.get(p.id).host)) throw fail('Stop or resolve this conversation’s camera or run before archiving it.')
      await catalog.transaction((draft) => {
        const item = draft.conversations.find((entry) => entry.id === c.id)
        if (name.endsWith('rename')) item.title = text(body.title, 'Conversation title')
        if (name.endsWith('saveDraft')) { if (typeof body.draft !== 'string' || body.draft.length > 32_000) throw fail('Draft is too long.'); item.draft = body.draft }
        if (name.endsWith('archive')) { item.archived = true; if (draft.selection.conversationId === c.id) draft.selection.conversationId = null }
        item.updatedAt = now()
      }); emit(); return snapshot()
    }
    if (name === 'connection.saveCredential') {
      if (links.get(p.id)?.endpoint) throw fail('Disconnect this project before replacing its Node credentials.')
      const ref = profile(p).credentialRef || `connection-${randomUUID()}`
      await secrets.write(ref, JSON.stringify({ cameraToken: text(body.cameraToken, 'Camera token', 4000), executionToken: body.executionToken ? text(body.executionToken, 'Execution token', 4000) : '' }))
      await catalog.transaction((draft) => { draft.connections.find((item) => item.id === p.connectionId).credentialRef = ref }); return { saved: true }
    }
    if (name === 'connection.setAutoConnect') {
      if (typeof body.enabled !== 'boolean') throw fail('Choose whether to reconnect this saved project on launch.')
      await catalog.transaction((draft) => { draft.connections.find((item) => item.id === p.connectionId).autoConnect = body.enabled })
      emit(); return snapshot()
    }
    if (name === 'connection.connect') { await connect(p); return snapshot() }
    if (name === 'connection.disconnect') {
      await disposeHost(p.id); await closeLink(p.id)
      emit(); return snapshot()
    }
    const host = await ensureHost(p, c)
    if (name === 'settings.selectModel') { await host.setModel(text(body.provider, 'Provider'), text(body.modelId || body.id, 'Model')); emit(); return snapshot() }
    if (name === 'conversation.send') {
      if (state().selection.projectId !== p.id || c?.id !== state().selection.conversationId) throw fail('This conversation is no longer selected. Review it before sending.')
      const accepted = host.prompt(body.text, text(body.requestId, 'Request ID', 128))
      if (accepted.accepted && !accepted.duplicate) {
        await catalog.transaction((draft) => {
          const item = draft.conversations.find((entry) => entry.id === c.id)
          if (item.title === 'New conversation') item.title = body.text.trim().replace(/\s+/gu, ' ').slice(0, 72)
          item.draft = ''; item.updatedAt = now()
        })
        emit()
      }
      return accepted
    }
    if (name === 'conversation.cancel' || name === 'conversation.answer') {
      if (!c || hosts.get(p.id)?.conversationId !== c.id) throw fail('The conversation changed. Use the current conversation’s controls.')
      return name === 'conversation.cancel' ? host.cancel() : host.getWorkcell().answerChoice({ choiceId: body.choiceId, answer: body.answer })
    }
    if (name.startsWith('workcell.')) {
      const view = host.getWorkcell()
      if (!view) throw fail('Connect the project to inspect its workcell.')
      const operation = name.slice('workcell.'.length), { projectId, conversationId, connectionGeneration, ...payload } = body
      const stop = ['camera.stop', 'execution.stop'].includes(operation)
      if (!stop && (links.get(p.id)?.status !== 'connected' || !links.get(p.id)?.ready || !fresh(links.get(p.id)?.observedAt))) throw fail('Reconnect this project before inspecting or preparing another operation. Stop remains available for its owned capture or run.')
      if (!stop && conversationId && hosts.get(p.id)?.conversationId !== conversationId) throw fail('The conversation changed. Review the current device state before acting.')
      if (operation === 'setup.inspect') {
        if (!host.inspectSetup) throw fail('Setup inspection is unavailable in this host. Ask the assistant to inspect physical setup.')
        hosts.get(p.id).setupReport = await host.inspectSetup(); emit(); return hosts.get(p.id).setupReport
      }
      if (operation === 'refresh') { await view.refresh(); emit(); return view.snapshot() }
      if (operation === 'camera.frame') { const packet = await view.cameraFrame(text(payload.frameId, 'Frame ID', 128)); return { id: payload.frameId, contentType: packet.contentType, bytes: new Uint8Array(packet.bytes) } }
      if (operation.startsWith('camera.')) return view.cameraAction(operation.slice(7), payload)
      if (operation.startsWith('execution.')) return view.executionAction(operation.slice(10), payload)
    }
    throw fail('This desktop action is unsupported.')
  }
  async function command(name, body) {
    const independent = ['conversation.cancel', 'conversation.answer', 'settings.providerAnswer', 'settings.providerCancel', 'settings.openAuthUrl', 'workcell.camera.stop', 'workcell.camera.frame', 'workcell.execution.stop'].includes(name)
    if (!independent && mutation) throw fail('Another desktop request is in progress. Wait for it to finish; Stop remains available.')
    const latch = {}; if (!independent) mutation = latch
    try { return await runCommand(name, body) }
    catch (error) { throw fail(safeFailure(error)) }
    finally { if (mutation === latch) mutation = null }
  }
  async function close() {
    if (mutation || creating.size) throw fail('A desktop request is still pending. Wait for it to settle before quitting; Stop and Cancel remain available.')
    if ([...hosts.values()].some(({ host }) => unresolved(host))) throw fail('Stop or resolve the active camera capture or run before quitting.')
    if (loginPending) { loginPending.abort(fail('Provider sign-in cancelled.')); await loginPending.operation }
    closing = true
    try { for (const id of [...hosts.keys()]) await disposeHost(id); for (const id of links.keys()) await closeLink(id) }
    catch (error) { closing = false; throw error }
    listeners.clear()
  }
  // Reading saved history never starts a hardware connection or replays a command.
  const initialProject = project(), initialConversation = conversation()
  if (initialProject && initialConversation) { try { await ensureHost(initialProject, initialConversation) } catch { notice = 'Saved history could not be opened. Check model setup and the local session files.' } }
  // This preference applies only to the saved active project. Reattachment
  // checks identity and reads status; it never replays messages, opens cameras
  // or dispatches runs, and other saved projects stay disconnected.
  queueMicrotask(async () => {
    if (closing || !initialProject || project()?.id !== initialProject.id || !profile(initialProject)?.autoConnect) return
    try { await command('connection.connect', { projectId: initialProject.id }) }
    catch (error) { notice = safeFailure(error); emit() }
  })
  return { snapshot, command, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, close }
}
