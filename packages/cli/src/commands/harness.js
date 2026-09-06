import { createHarnessMode } from '../harness/interactive-mode.js'
import { createHarnessRuntime } from '../harness/application-host.js'
import { startNodeSupervisor } from '../harness/node-supervisor.js'
import { managedNodeEnvironment } from './setup-node.js'

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

async function runHarnessCommand(options) {
  const { initialMessage, createMode } = options
  const host = await createHarnessRuntime({ ...options, showHeader: true })
  const { sdk, runtime } = host
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
    host.stopAcceptingPrompts()
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
