import path from 'node:path'

import { createPiCredentialStore } from '../chat/pi-credential-store.js'
import {
  loadOfficialPiSdk,
  PHYSICAL_HARNESS_TOOL_ALLOWLIST,
  physicalSystemsSystemPrompt,
} from '../chat/pi-session.js'
import { createHarnessMode } from '../harness/interactive-mode.js'
import { loadCuratedAgentSkills } from '../harness/agent-skills.js'
import { installSessionPromptGate } from '../harness/session-prompt-gate.js'
import { startNodeSupervisor } from '../harness/node-supervisor.js'
import { managedNodeEnvironment } from './setup-node.js'
import { createTinyEdgePiExtension } from '../pi-extension.js'

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

function isolatePiStartupEnvironment(environment = process.env) {
  const overrides = {
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    // Pi's tmux keyboard probe is independent of its offline mode and spawns a
    // subprocess. Standalone Harness must not inherit that ambient capability.
    TMUX: undefined,
  }
  const previous = new Map(Object.keys(overrides).map((name) => [name, environment[name]]))

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete environment[name]
      else environment[name] = value
    }
  }
}

async function runHarnessCommand({
  config,
  secretStore,
  sdk: suppliedSdk,
  cwd = process.cwd(),
  initialMessage,
  createExtension = createTinyEdgePiExtension,
  createMode,
  env = process.env,
}) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const agentSkillRegistry = loadCuratedAgentSkills({ loadSkillsFromDir: sdk.loadSkillsFromDir })
  const agentDir = path.join(config.configDir, 'pi-internal')
  const sessionDir = path.join(config.configDir, 'harness-sessions')
  const credentials = createPiCredentialStore({ configDir: config.configDir, secretStore })
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const sessionManager = sdk.SessionManager.create(cwd, sessionDir)
  const promptGates = new WeakMap()
  let runtime
  let acceptingPrompts = false
  const extensionFactory = createExtension({
    env,
    standalone: true,
    cloudEnabled: false,
    showHeader: true,
    agentSkillRegistry,
    canSubmitWorkcellIntent: () => Boolean(acceptingPrompts && runtime?.session
      && promptGates.get(runtime.session)?.isBusy() === false),
    submitWorkcellIntent: (text) => {
      if (!acceptingPrompts || !runtime?.session) throw new Error('Harness session is not ready or has ended')
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
        systemPrompt: `${physicalSystemsSystemPrompt()}\n\n${agentSkillRegistry.prompt()}`,
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
  }

  runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  })
  acceptingPrompts = true
  const Mode = createMode || ((runtimeHost, options) => createHarnessMode(sdk, runtimeHost, options))
  let mode
  let runCompleted = false
  let primaryFailure
  try {
    mode = Mode(runtime, { initialMessage, verbose: false })
    await mode.run()
    runCompleted = true
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    acceptingPrompts = false
    let cleanupFailure
    if (!runCompleted) {
      try {
        mode?.stop?.()
      } catch (error) {
        cleanupFailure = error
      }
    }
    try {
      await runtime.dispose()
    } catch (error) {
      cleanupFailure ||= error
    }
    if (!primaryFailure && cleanupFailure) throw cleanupFailure
  }
}

export async function harnessCommand(options) {
  // Official Pi offline-startup semantics prevent background downloads,
  // catalog refreshes, update checks, and install telemetry. They do not block
  // inference through the model selected for the TinyEdge session.
  const restoreEnvironment = isolatePiStartupEnvironment()
  let node, primaryFailure
  try {
    const environment = await (options.managedNodeEnvironmentImpl || managedNodeEnvironment)({ ...options, env: options.env || process.env })
    node = await (options.startNodeSupervisorImpl || startNodeSupervisor)({ env: environment })
    return await runHarnessCommand({ ...options, env: node?.environment || environment })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    try { await node?.dispose() }
    catch (error) {
      // A failed shutdown is itself actionable; never silently force-kill a
      // possibly active physical controller or start its replacement.
      if (!primaryFailure) throw error
      throw new Error('Harness failed and local Node shutdown is unconfirmed. Inspect the existing Node and use the physical stop procedure.')
    } finally { restoreEnvironment() }
  }
}
