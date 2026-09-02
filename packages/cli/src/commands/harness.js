import path from 'node:path'

import { createPiCredentialStore } from '../chat/pi-credential-store.js'
import {
  loadOfficialPiSdk,
  PHYSICAL_HARNESS_TOOL_ALLOWLIST,
  physicalSystemsSystemPrompt,
} from '../chat/pi-session.js'
import { createHarnessMode } from '../harness/interactive-mode.js'
import { ensurePhysicalNode } from '../physical/node-supervisor.js'
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
  physicalNodeUrl,
  createExtension = createTinyEdgePiExtension,
  createMode,
}) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const agentDir = path.join(config.configDir, 'pi-internal')
  const sessionDir = path.join(config.configDir, 'harness-sessions')
  const credentials = createPiCredentialStore({ configDir: config.configDir, secretStore })
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const sessionManager = sdk.SessionManager.create(cwd, sessionDir)
  const extensionFactory = createExtension({
    standalone: true,
    cloudEnabled: false,
    showHeader: true,
    physicalNodeUrl,
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
        systemPrompt: physicalSystemsSystemPrompt(),
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
    return { ...created, services, diagnostics }
  }

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  })
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
  const {
    ensurePhysicalNodeImpl = ensurePhysicalNode,
    env = process.env,
    fetchImpl = globalThis.fetch,
    physicalNodeSupervisorOptions = {},
  } = options
  let physicalNode
  let restoreEnvironment = () => {}
  let primaryFailure
  try {
    physicalNode = await ensurePhysicalNodeImpl({
      env,
      fetchImpl,
      ...physicalNodeSupervisorOptions,
    })
    if (!physicalNode?.origin || typeof physicalNode.dispose !== 'function') {
      throw new Error('Physical Systems node supervisor returned an invalid lifecycle')
    }
    // Official Pi offline-startup semantics prevent background downloads,
    // catalog refreshes, update checks, and install telemetry. They do not block
    // inference through the model selected for the TinyEdge session.
    restoreEnvironment = isolatePiStartupEnvironment()
    return await runHarnessCommand({ ...options, physicalNodeUrl: physicalNode.origin })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let cleanupFailure
    try {
      await physicalNode?.dispose()
    } catch (error) {
      cleanupFailure = error
    } finally {
      restoreEnvironment()
    }
    if (!primaryFailure && cleanupFailure) throw cleanupFailure
  }
}
