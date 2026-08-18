import path from 'node:path'

import { createPiCredentialStore } from '../chat/pi-credential-store.js'
import {
  loadOfficialPiSdk,
  TINYEDGE_CHAT_TOOL_ALLOWLIST,
  tinyEdgeSystemPrompt,
} from '../chat/pi-session.js'
import { READ_SCOPE } from '../config.js'
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
  tokenStore,
  secretStore,
  sdk: suppliedSdk,
  cwd = process.cwd(),
  initialMessage,
  createExtension = createTinyEdgePiExtension,
  createMode,
}) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const summary = await tokenStore.summary().catch(() => ({ connected: false }))
  const grantedScopes = summary.connected && Array.isArray(summary.scope) && summary.scope.length
    ? summary.scope
    : [READ_SCOPE]
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
    autoLogin: true,
    showHeader: true,
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
        systemPrompt: tinyEdgeSystemPrompt(grantedScopes),
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
      tools: [...TINYEDGE_CHAT_TOOL_ALLOWLIST],
    })
    return { ...created, services, diagnostics }
  }

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  })
  const Mode = createMode || ((runtimeHost, options) => new sdk.InteractiveMode(runtimeHost, options))
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
  // Official Pi offline-startup semantics prevent background downloads,
  // catalog refreshes, update checks, and install telemetry. They do not block
  // inference through the model selected for the TinyEdge session.
  const restoreEnvironment = isolatePiStartupEnvironment()
  try {
    return await runHarnessCommand(options)
  } finally {
    restoreEnvironment()
  }
}
