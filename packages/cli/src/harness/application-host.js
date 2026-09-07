import path from 'node:path'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createPiCredentialStore } from '../chat/pi-credential-store.js'
import { redactText } from '../auth/redact.js'
import { loadOfficialPiSdk, PHYSICAL_HARNESS_TOOL_ALLOWLIST, physicalSystemsSystemPrompt } from '../chat/pi-session.js'
import { loadCuratedAgentSkills } from './agent-skills.js'
import { installSessionPromptGate } from './session-prompt-gate.js'
import { createTinyEdgePiExtension } from '../pi-extension.js'

let startupLeases = 0
let startupEnvironment
function acquireOfflineStartup() {
  if (startupLeases++ === 0) {
    startupEnvironment = new Map(['PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'TMUX'].map((key) => [key, process.env[key]]))
    process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1'; delete process.env.TMUX
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (--startupLeases) return
    for (const [key, value] of startupEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    startupEnvironment = null
  }
}

function extensionLoadErrors(services) {
  const result = services.resourceLoader.getExtensions()
  return Array.isArray(result?.errors) ? result.errors : []
}

function startupDiagnostics(services) {
  return [
    ...(Array.isArray(services.diagnostics) ? services.diagnostics : []),
    ...extensionLoadErrors(services).map(() => ({
      type: 'error',
      message: 'The reviewed TinyEdge security extension failed to load.',
    })),
  ]
}

function configuredModel(session, modelRuntime) {
  const model = session?.model
  if (!model || !modelRuntime.getModel?.(model.provider, model.id)) return null
  if (typeof modelRuntime.hasConfiguredAuth === 'function' && !modelRuntime.hasConfiguredAuth(model.provider)) return null
  return model
}

const DESKTOP_OPERATOR_CONTEXT = `Desktop interface context:
This session runs in the Physical Systems desktop application. Map every /workcell reference above or in a bundled Agent Skill to the Devices panel in this application; direct the operator to that panel, without requiring a terminal command. For basic camera preview, open Devices, select the intended observed camera and click Start preview. Opening Devices does not start capture. Basic preview does not require commissioning. Only the operator may start or stop preview; the assistant cannot see the preview image.
Provider sign-in and model selection are in Model & app settings. Conversation messages discuss and plan a task. A proposal is not approval: the separate Run tab contains the existing configuration selection, preparation, explicit approval of the exact unexpired invocation, Stop and receipt controls. Cancel response cancels the assistant only; it never stops a camera or equipment. Use Stop preview or the run Stop control for those separate operations. These interface labels grant no additional tools, hardware authority or configuration permission.`

/** Shared reviewed Pi initialization; no terminal, Node startup, browser or discovery. */
export async function createHarnessRuntime({
  config, secretStore, sdk: suppliedSdk, cwd = process.cwd(),
  createExtension = createTinyEdgePiExtension, env = process.env, showHeader = false,
  sessionDir: suppliedSessionDir, sessionManager: suppliedSessionManager, onWorkcell, onSetupInspector,
  extensionOptions = {}, submitWorkcellIntentImpl, interfaceMode = 'terminal',
}) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const agentSkillRegistry = loadCuratedAgentSkills({ loadSkillsFromDir: sdk.loadSkillsFromDir })
  const agentDir = path.join(config.configDir, 'pi-internal')
  const sessionDir = suppliedSessionDir || path.join(config.configDir, 'harness-sessions')
  const credentials = createPiCredentialStore({ configDir: config.configDir, secretStore })
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials,
    // A desktop workspace must not load or rewrite an ambient Pi models file.
    // The terminal preserves its existing compatibility behavior.
    ...(interfaceMode === 'desktop' ? { modelsPath: null } : {}),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const sessionManager = suppliedSessionManager || sdk.SessionManager.create(cwd, sessionDir)
  const promptGates = new WeakMap()
  let runtime
  let acceptingPrompts = false
  const extensionFactory = createExtension({
    ...Object.fromEntries(['createPhysicalNodeClientImpl', 'createCameraPreviewClientImpl',
      'createExecutionClientImpl', 'physicalFetchImpl'].filter((key) => Object.hasOwn(extensionOptions, key))
      .map((key) => [key, extensionOptions[key]])),
    env,
    standalone: true,
    cloudEnabled: false,
    showHeader,
    ...(onWorkcell ? { onWorkcell } : {}),
    ...(onSetupInspector ? { onSetupInspector } : {}),
    ...(interfaceMode === 'desktop' ? { isWorkcellModelConfigured: () => Boolean(configuredModel(runtime?.session, modelRuntime)) } : {}),
    agentSkillRegistry,
    canSubmitWorkcellIntent: () => Boolean(acceptingPrompts && runtime?.session
      && promptGates.get(runtime.session)?.isBusy() === false),
    submitWorkcellIntent: (text) => {
      if (!acceptingPrompts || !runtime?.session) throw new Error('Harness session is not ready or has ended')
      if (submitWorkcellIntentImpl) return submitWorkcellIntentImpl(text)
      return runtime.session.prompt(text, { expandPromptTemplates: false, source: 'interactive' })
    },
    createConfigImpl: () => config,
    ...(secretStore ? { createSecretStoreImpl: () => secretStore } : {}),
  })

  const createRuntime = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  }) => {
    const restoreStartup = acquireOfflineStartup()
    try {
      const services = await sdk.createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: `${physicalSystemsSystemPrompt()}\n\n${agentSkillRegistry.prompt()}${interfaceMode === 'desktop' ? `\n\n${DESKTOP_OPERATOR_CONTEXT}` : ''}`,
          extensionFactories: [extensionFactory],
        },
      })
      const diagnostics = startupDiagnostics(services)
      if (diagnostics.some((diagnostic) => diagnostic.type === 'error')) {
        throw new Error(diagnostics.find((diagnostic) => diagnostic.type === 'error').message)
      }
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
        // This explicit set is both the initial registry allowlist and the
        // permanent ceiling for tools registered by the reviewed extension.
        tools: [...PHYSICAL_HARNESS_TOOL_ALLOWLIST],
      })
      promptGates.set(created.session, installSessionPromptGate(created.session))
      return { ...created, services, diagnostics }
    } finally { restoreStartup() }
  }

  runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  })
  acceptingPrompts = true
  return { sdk, runtime, modelRuntime, promptGates,
    stopAcceptingPrompts() { acceptingPrompts = false },
  }
}

const ARCHIVE_ENTRY = 'physicalsystems.desktop.session'
const TERMINAL_PHASES = new Set(['VERIFIED_SUCCESS', 'FAILED', 'CANCELLED', 'BLOCKED'])
const cleanText = (value, limit = 32_000) => redactText(String(value ?? ''))
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, limit)

function requestError(code, message) { return Object.assign(new Error(message), { code }) }

/** Renderable transcript only: hidden reasoning, media, tool arguments and provider metadata never cross this boundary. */
export function projectHarnessTranscript(session, streamingMessage) {
  const entries = session.sessionManager.getBranch?.() || []
  const messages = entries.filter((entry) => entry.type === 'message')
    .map((entry) => ({ id: entry.id, message: entry.message }))
  // Fake SDKs and a turn not persisted yet can still expose current session messages.
  if (!messages.length) messages.push(...(session.messages || []).map((message, i) => ({ id: `message-${i}`, message })))
  if (streamingMessage) messages.push({ id: 'streaming', message: streamingMessage })
  return messages.flatMap(({ id, message }) => {
    if (!['user', 'assistant', 'toolResult'].includes(message?.role)) return []
    if (message.role === 'toolResult') return [{ id, role: 'tool', toolName: cleanText(message.toolName, 128),
      text: cleanText(message.details?.displaySummary || (message.isError ? 'Tool request failed' : 'Tool request completed'), 500),
      isError: Boolean(message.isError) }]
    const content = typeof message.content === 'string' ? message.content : (message.content || [])
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    return [{ id, role: message.role, text: cleanText(content), streaming: id === 'streaming',
      isError: message.stopReason === 'error', cancelled: message.stopReason === 'aborted' }]
  })
}

// Pi intentionally defers empty terminal sessions until an assistant replies. A
// saved desktop conversation needs a durable identity before then. Create only
// the new JSONL using public session APIs, never rewrite an existing transcript.
function persistNewSession(manager) {
  const file = manager.getSessionFile()
  if (!file || existsSync(file)) return
  writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 })
  manager.setSessionFile(file)
}

function sessionPathValidator(sessionDir, cwd) {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  if (lstatSync(sessionDir).isSymbolicLink()) throw new Error('The Harness session directory must not be a symbolic link')
  const root = realpathSync(sessionDir)
  return (value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.dirname(path.resolve(value)) !== path.resolve(sessionDir)
      || path.extname(value) !== '.jsonl') throw new Error('Select a conversation from this project’s saved Harness sessions')
    const stat = lstatSync(value)
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(realpathSync(value)) !== root) {
      throw new Error('The saved Harness session must be a regular file inside its session directory')
    }
    const descriptor = openSync(value, 'r')
    let header
    try {
      const prefix = Buffer.alloc(64 * 1024)
      const length = readSync(descriptor, prefix, 0, prefix.length, 0)
      header = JSON.parse(prefix.subarray(0, length).toString('utf8').split('\n')[0])
    } catch { throw new Error('The saved conversation header is invalid. Its existing file has been preserved.') }
    finally { closeSync(descriptor) }
    // Avoid Pi's automatic migration/reinitialization of a selected legacy or
    // empty file, and never resume another project's context via cwd override.
    if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string'
      || typeof header.cwd !== 'string' || path.resolve(header.cwd) !== path.resolve(cwd)) {
      throw new Error('Select a current-format Harness conversation belonging to this project. Existing files are preserved.')
    }
    return path.resolve(value)
  }
}

/**
 * Application-owned Pi host. Construction does not start Node, discovery,
 * camera capture, a browser, or a terminal. The caller owns connection identity
 * and viewer lifetime; physical actions stay on the existing Workcell controller.
 */
export async function createHarnessHost(options) {
  const { config, cwd = process.cwd() } = options
  const sessionDir = path.join(config.configDir, 'harness-sessions')
  const validateSessionPath = sessionPathValidator(sessionDir, cwd)
  const sdk = options.sdk || await loadOfficialPiSdk()
  const sessionManager = options.sessionFile
    ? sdk.SessionManager.open(validateSessionPath(options.sessionFile), sessionDir, cwd)
    : sdk.SessionManager.create(cwd, sessionDir)
  persistNewSession(sessionManager)
  const listeners = new Set()
  const requests = new Map()
  let host, workcell, inspectSetup, unsubscribeWorkcell, unsubscribeSession
  let disposed = false, transition = false, failed = false, pending = null, streamingMessage = null, error = null, revision = 0
  let disposing = null, pendingCancellation = null
  const busy = () => Boolean(transition || pending || host?.promptGates.get(host.runtime.session)?.isBusy())
  const snapshot = () => {
    const session = host?.runtime.session
    const model = host ? configuredModel(session, host.modelRuntime) : null
    return { revision, sessionId: session?.sessionManager.getSessionId() || null,
      sessionFile: session?.sessionManager.getSessionFile() || null,
      name: cleanText(session?.sessionManager.getSessionName() || 'New conversation', 120),
      busy: busy(), disposed, failed, error,
      model: model ? { provider: model.provider, id: model.id,
        name: cleanText(model.name || model.id, 160) } : null,
      messages: session ? projectHarnessTranscript(session, streamingMessage) : [],
      workcellSessionId: workcell?.snapshot().sessionId || null,
    }
  }
  const emit = (type = 'change') => {
    if (disposed) return
    revision += 1
    const event = { type, snapshot: snapshot() }
    for (const listener of listeners) { try { listener(event) } catch { /* Viewers do not own the agent. */ } }
  }
  const assertReady = () => {
    if (disposed) throw new Error('This Harness host has ended')
    if (failed) throw requestError('ERR_HARNESS_SESSION_UNAVAILABLE', 'Disconnect, then connect this project again to restore its conversation.')
  }
  const assertIdle = () => {
    assertReady()
    if (busy()) throw requestError('ERR_HARNESS_PROMPT_BUSY', 'Wait for the current assistant request to finish, or use Cancel before changing conversations or models.')
  }
  function assertNoPhysicalOperation() {
    const state = workcell?.snapshot()
    const camera = state?.camera
    const execution = state?.execution
    if (camera?.pending || camera?.stopPending || camera?.stopUnconfirmed
      || camera?.stopCaptureSessionId || (camera?.status?.captureSessionId && !['idle', 'stopped'].includes(camera.status.phase))
      || execution?.pending || execution?.stopPending || execution?.run?.stopStatus === 'STOP_UNCONFIRMED'
      || [...(execution?.activeRuns || []), ...(execution?.runs || []), ...(execution?.run ? [execution.run] : [])]
        .some((run) => !TERMINAL_PHASES.has(run.phase) || run.stopStatus === 'STOP_UNCONFIRMED')) {
      throw requestError('ERR_HARNESS_OPERATION_ACTIVE', 'Keep this conversation open until the camera or run is confirmed stopped. Use its Stop control; cancelling the assistant does not stop equipment.')
    }
  }
  const onWorkcell = (controller) => {
    unsubscribeWorkcell?.()
    workcell = controller
    unsubscribeWorkcell = controller?.subscribe(() => emit('workcell'))
    options.onWorkcell?.(controller)
  }
  const uiContext = {
    select: (question, answers, opts) => workcell?.ask({ kind: 'select', question, options: answers, signal: opts?.signal }),
    input: (question, _placeholder, opts) => workcell?.ask({ kind: 'input', question, signal: opts?.signal }),
    // No model-requested confirmation can grant execution authority.
    confirm: async () => false,
    notify: (message, level) => { if (level === 'error' || level === 'warning') error = cleanText(message, 500); emit('notice') },
  }
  const bindSession = async (session) => {
    unsubscribeSession?.()
    streamingMessage = null
    persistNewSession(session.sessionManager)
    unsubscribeSession = session.subscribe((event) => {
      if (event.type === 'message_end') {
        // Pi emits message_end before appending it to SessionManager. Publish
        // after that synchronous persistence step so the last streaming answer
        // never disappears while the final transcript entry replaces it.
        queueMicrotask(() => {
          if (host.runtime.session !== session) return
          streamingMessage = null
          emit(event.type)
        })
        return
      }
      if (event.type === 'message_update') streamingMessage = event.message?.role === 'assistant' ? event.message : streamingMessage
      if (event.type === 'agent_end' || event.type === 'agent_settled') streamingMessage = null
      emit(event.type)
    })
    await session.bindExtensions({ mode: 'rpc', uiContext, abortHandler: () => { void session.abort() },
      onError: () => { error = 'An assistant extension request failed. Review the current conversation before retrying.'; emit('error') } })
  }
  // Keep startup offline without inheriting Pi's terminal-only tmux probe. This
  // is a bounded startup scope, not a lifetime mutation of desktop process.env.
  const restoreStartup = acquireOfflineStartup()
  try {
    host = await createHarnessRuntime({ ...options, sdk, cwd, sessionDir, sessionManager, showHeader: false, interfaceMode: 'desktop', onWorkcell,
      onSetupInspector: (inspect) => { inspectSetup = inspect },
      submitWorkcellIntentImpl: (text) => prompt(text, `browser-${randomUUID()}`) })
    host.runtime.setRebindSession(bindSession)
    await bindSession(host.runtime.session)
  } catch (failure) {
    await host?.runtime.dispose()
    throw failure
  } finally {
    restoreStartup()
  }

  async function changeSession(action) {
    assertIdle(); assertNoPhysicalOperation()
    transition = true; error = null; emit('session-changing')
    try {
      const result = await action()
      if (result?.cancelled) throw new Error('The conversation change was cancelled')
      requests.clear()
      return snapshot()
    } catch (failure) {
      failed = true
      error = 'The conversation could not be opened. Disconnect, then connect this project again to restore its conversation.'
      throw failure
    } finally { transition = false; emit('session-changed') }
  }

  function prompt(text, requestId) {
    assertReady()
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000 || /^[!/]/.test(text.trim())
      || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) throw new TypeError('Enter a message of up to 16,000 characters, without terminal commands.')
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new TypeError('A bounded unique request ID is required')
    const digest = createHash('sha256').update(text).digest('hex')
    const prior = requests.get(requestId)
    if (prior) {
      if (prior.digest !== digest) throw requestError('ERR_HARNESS_REQUEST_CONFLICT', 'This request ID was already used for a different message. Submit a new message.')
      return { accepted: true, duplicate: true, requestId }
    }
    assertIdle()
    if (!configuredModel(host.runtime.session, host.modelRuntime)) throw requestError('ERR_HARNESS_MODEL_UNAVAILABLE', 'Select a model and connect its provider in Settings before sending a message.')
    error = null
    requests.set(requestId, { digest })
    if (requests.size > 256) requests.delete(requests.keys().next().value)
    const session = host.runtime.session
    const cancellation = { requested: false }
    pendingCancellation = cancellation
    const operation = session.prompt(text.trim(), { expandPromptTemplates: false, source: 'interactive',
      preflightResult(accepted) {
        if (accepted && cancellation.requested) throw requestError('ERR_HARNESS_PROMPT_CANCELLED', 'The assistant request was cancelled before it started.')
      },
    })
    pending = operation
    emit('request-accepted')
    void operation.catch(() => {
      workcell?.agentSettled()
      if (!disposed && !cancellation.requested) { error = 'The assistant request failed. Check the selected model and provider connection before retrying.'; emit('error') }
    }).finally(() => {
      if (pending === operation) { pending = null; pendingCancellation = null; if (cancellation.requested) error = null }
      emit('request-settled')
    })
    return { accepted: true, duplicate: false, requestId }
  }

  return Object.freeze({
    snapshot,
    subscribe(listener) { assertReady(); listeners.add(listener); return () => listeners.delete(listener) },
    // The coordinator still needs the retained status to render recovery after
    // a failed session replacement. Controller actions enforce their own lifetime.
    getWorkcell() { return workcell },
    async inspectSetup() {
      assertReady()
      if (!inspectSetup) throw new Error('Setup inspection is unavailable for this conversation')
      return inspectSetup()
    },
    prompt,
    async cancel() {
      assertReady()
      if (pendingCancellation) pendingCancellation.requested = true
      await host.runtime.session.abort()
      // Preflight can still be awaiting the credential store. Keep its gate
      // reserved until it settles, but never start that cancelled agent turn.
      if (pending && pendingCancellation) error = 'Cancellation requested; waiting for assistant preflight to settle.'
      emit('cancelled')
      return snapshot()
    },
    async listSessions({ includeArchived = false } = {}) {
      assertReady()
      const listing = await sdk.SessionManager.list(cwd, sessionDir)
      return listing.flatMap((item) => {
        try {
          const file = validateSessionPath(item.path)
          const manager = sdk.SessionManager.open(file, sessionDir, cwd)
          const archived = manager.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === ARCHIVE_ENTRY).at(-1)?.data?.archived === true
          if (archived && !includeArchived) return []
          return [{ path: file, id: item.id, name: cleanText(item.name || (item.messageCount ? item.firstMessage : '') || 'New conversation', 120),
            created: new Date(item.created).toISOString(), modified: new Date(item.modified).toISOString(),
            messageCount: item.messageCount, archived }]
        } catch { return [] }
      })
    },
    createSession() { return changeSession(() => host.runtime.newSession()) },
    openSession(file) { const selected = validateSessionPath(file); return changeSession(() => host.runtime.switchSession(selected, { cwdOverride: cwd })) },
    async renameSession(file, name) {
      assertIdle()
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || cleanText(name, 120) !== name) throw new TypeError('Enter a plain conversation name of up to 120 characters')
      const selected = validateSessionPath(file)
      const manager = selected === host.runtime.session.sessionManager.getSessionFile()
        ? host.runtime.session.sessionManager : sdk.SessionManager.open(selected, sessionDir, cwd)
      manager.appendSessionInfo(name.trim()); emit('session-renamed')
      return snapshot()
    },
    async archiveSession(file, archived = true) {
      assertIdle()
      if (typeof archived !== 'boolean') throw new TypeError('An archive flag is required')
      const selected = validateSessionPath(file)
      if (selected === host.runtime.session.sessionManager.getSessionFile()) assertNoPhysicalOperation()
      const manager = selected === host.runtime.session.sessionManager.getSessionFile()
        ? host.runtime.session.sessionManager : sdk.SessionManager.open(selected, sessionDir, cwd)
      manager.appendCustomEntry(ARCHIVE_ENTRY, { archived }); emit('session-archived')
      return snapshot()
    },
    async listModels() {
      assertReady()
      const available = await host.modelRuntime.getAvailable()
      return available.map((model) => ({ provider: model.provider, id: model.id, name: cleanText(model.name || model.id, 160) }))
    },
    async setModel(provider, modelId) {
      assertIdle()
      const model = host.modelRuntime.getModel(provider, modelId)
      if (!model) throw new Error('Select a model from the current provider catalog')
      transition = true
      try { await host.runtime.session.setModel(model); error = null; return snapshot() }
      finally { transition = false; emit('model-changed') }
    },
    dispose() {
      if (disposing) return disposing
      host.stopAcceptingPrompts()
      if (pendingCancellation) pendingCancellation.requested = true
      disposed = true
      disposing = (async () => {
        await host.runtime.session.abort()
        await pending?.catch(() => {})
        await host.runtime.dispose()
        unsubscribeSession?.(); unsubscribeWorkcell?.(); listeners.clear()
      })()
      return disposing
    },
  })
}
