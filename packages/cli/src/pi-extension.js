import { createAuthenticatedMcp } from './auth/session.js'
import { createNativeSecretStore } from './auth/secret-store.js'
import { createTokenStore } from './auth/token-store.js'
import {
  createTinyEdgePiTools,
  TINYEDGE_CHAT_TOOL_ALLOWLIST,
  toolDisplaySummary,
  toolResultContentForModel,
  toolsForScopes,
} from './chat/pi-session.js'
import { createConfig, loginScopes, withScopes } from './config.js'
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { ASK_CHOICE_TOOL, createAskChoiceTool } from './harness/ask-choice.js'
import { createHarnessHeader } from './harness/header.js'
import { READ_AGENT_SKILL_TOOL, createReadAgentSkillTool } from './harness/agent-skills.js'
import { createWorkcellController } from './harness/workcell-controller.js'
import { createWorkcellServer } from './harness/workcell-server.js'
import { createCameraPreviewClient } from './physical/camera-preview-client.js'
import { createExecutionClient } from './physical/execution-client.js'
import { openBrowser } from './auth/open-browser.js'
import {
  promptPhysicalCommissioningDraft,
  recommendPhysicalCommissioningDraft,
} from './physical/exploration.js'
import { createPhysicalNodeClient } from './physical/node-client.js'
import {
  createPhysicalPiTools,
  createPhysicalWorkflowState,
  createPhysicalWorkflowWidget,
  observedPhysicalDevices,
  PHYSICAL_TOOL_ALLOWLIST,
  updatePhysicalWorkflow,
} from './physical/workflow.js'

const NEW_BENCHMARK_INTENT = /\b(?:benchmark(?:ing|ed|s)?|evaluat(?:e|ing|ed|ion)|profil(?:e|ing|ed)|measure(?:ment|ments|d|s|ing)?|test(?:ing|ed|s)?)\b/i
const EXISTING_WORK_INTENT = /\b(?:resume|continue)\b|\b(?:existing|previous|saved)\s+(?:task|benchmark|run|work)\b|\b(?:benchmark\s+)?(?:status|results?|comparison)\b/i
const NEW_INTAKE_TOOL_BLOCK = 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.'
const REPEATED_DEVICE_CHECK_BLOCK = 'The device was already checked for this request. Ask the user one concise intake question now.'
const defineTool = (definition) => definition

export function isFreshBenchmarkRequest(value) {
  const prompt = String(value || '')
  return NEW_BENCHMARK_INTENT.test(prompt) && !EXISTING_WORK_INTENT.test(prompt)
}

export function compactTinyEdgeHistory(messages = []) {
  const tinyEdgeTools = new Set(TINYEDGE_CHAT_TOOL_ALLOWLIST)
  return messages.map((message) => {
    if (message?.role !== 'toolResult' || !tinyEdgeTools.has(message.toolName)) return message
    try {
      return {
        ...message,
        content: [{ type: 'text', text: toolResultContentForModel(message.toolName, message) }],
        details: {
          displaySummary: toolDisplaySummary(message.toolName, message),
        },
      }
    } catch {
      return {
        ...message,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'TinyEdge history entry omitted because its discovery response was invalid',
          }),
        }],
        details: {
          displaySummary: 'Invalid TinyEdge history entry omitted',
        },
        isError: true,
      }
    }
  })
}

function loginFlags(value) {
  const flags = new Set(String(value || '').trim().split(/\s+/).filter(Boolean))
  for (const flag of flags) {
    if (flag !== '--allow-write' && flag !== '--allow-run') {
      throw new Error('Usage: /tinyedge-login [--allow-write] [--allow-run]')
    }
  }
  return {
    allowWrite: flags.has('--allow-write'),
    allowRun: flags.has('--allow-run'),
  }
}

function uiIo(ctx) {
  return {
    log(value) { ctx.ui.notify(String(value), 'info') },
    error(value) { ctx.ui.notify(String(value), 'error') },
  }
}

/**
 * Create the TinyEdge extension for an existing Pi installation. Dependencies
 * are injectable so the package can be verified without credentials/network.
 */
export function createTinyEdgePiExtension({
  env = process.env,
  platform = process.platform,
  createConfigImpl = createConfig,
  createSecretStoreImpl = createNativeSecretStore,
  createTokenStoreImpl = createTokenStore,
  createAuthenticatedMcpImpl = createAuthenticatedMcp,
  createToolsImpl = createTinyEdgePiTools,
  loginImpl = loginCommand,
  logoutImpl = logoutCommand,
  defineToolImpl = defineTool,
  createPhysicalNodeClientImpl = createPhysicalNodeClient,
  physicalNodeUrl = env.TINYEDGE_PHYSICAL_NODE_URL,
  physicalFetchImpl = globalThis.fetch,
  standalone = false,
  autoLogin = false,
  cloudEnabled = !standalone,
  showHeader = false,
  agentSkillRegistry = null,
  submitWorkcellIntent = null,
  canSubmitWorkcellIntent = null,
  createWorkcellServerImpl = createWorkcellServer,
  createCameraPreviewClientImpl = createCameraPreviewClient,
  createExecutionClientImpl = createExecutionClient,
  openWorkcellBrowser = openBrowser,
} = {}) {
  return function tinyEdgeExtension(pi) {
    const config = cloudEnabled ? createConfigImpl(env, platform) : null
    const secretStore = cloudEnabled
      ? createSecretStoreImpl({ configDir: config.configDir, platform })
      : null
    const tokenStore = cloudEnabled
      ? createTokenStoreImpl({ configDir: config.configDir, secretStore })
      : null
    let workcell = null
    let workcellServer = null
    let workcellOpening = null
    let latestContext = null
    let workcellClosing = false
    const askChoiceTool = createAskChoiceTool(defineToolImpl)
    pi.registerTool({
      ...askChoiceTool,
      async execute(callId, params, signal, onUpdate, ctx) {
        if (!workcell?.shouldAskInView()) return askChoiceTool.execute(callId, params, signal, onUpdate, ctx)
        const choiceOwner = workcell
        return askChoiceTool.execute(callId, params, signal, onUpdate, {
          ...ctx,
          ui: {
            ...ctx?.ui,
            select: (question, options) => choiceOwner.ask({ kind: 'select', question, options, signal }),
            input: (question) => choiceOwner.ask({ kind: 'input', question, signal }),
          },
        })
      },
    })
    const physicalEnabled = standalone
    const physicalActiveTools = physicalEnabled
      ? PHYSICAL_TOOL_ALLOWLIST.filter((name) => name !== READ_AGENT_SKILL_TOOL || agentSkillRegistry !== null)
      : []
    const physicalClient = physicalEnabled
      ? createPhysicalNodeClientImpl({
        ...(physicalNodeUrl ? { baseUrl: physicalNodeUrl } : {}),
        fetchImpl: physicalFetchImpl,
      })
      : null
    let physicalState = physicalEnabled
      ? createPhysicalWorkflowState(physicalClient.origin)
      : null
    let physicalContext
    let registeredTools = []
    let headerContext
    let freshBenchmarkTurn = false
    let freshDeviceCheckStarted = false
    const headerState = {
      nodeStatus: physicalState?.status || 'unchecked',
      nodeOrigin: physicalClient?.origin,
      candidateCount: 0,
    }

    function renderPhysicalWorkflowWidget(ctx = physicalContext) {
      if (!physicalEnabled || !ctx || ctx.mode !== 'tui' || typeof ctx.ui?.setWidget !== 'function') return
      physicalContext = ctx
      ctx.ui.setWidget(
        'tinyedge-physical-workflow',
        createPhysicalWorkflowWidget(() => physicalState),
      )
    }

    function transitionPhysical(event, ctx = physicalContext) {
      if (!physicalEnabled) return false
      const nextState = updatePhysicalWorkflow(physicalState, event)
      if (nextState === physicalState) return false
      physicalState = nextState
      workcell?.setWorkflow(physicalState)
      updateHeader({
        nodeStatus: physicalState.status,
        candidateCount: observedPhysicalDevices(physicalState.snapshot).length,
      }, ctx)
      renderPhysicalWorkflowWidget(ctx)
      return true
    }

    async function refreshPhysicalSystem(ctx = physicalContext) {
      transitionPhysical({ type: 'checking' }, ctx)
      try {
        const snapshot = await physicalClient.inspect()
        transitionPhysical({ type: 'snapshot', snapshot }, ctx)
        return snapshot
      } catch (error) {
        transitionPhysical({ type: 'error', error }, ctx)
        throw error
      }
    }

    if (physicalEnabled) {
      if (agentSkillRegistry) {
        const reader = createReadAgentSkillTool({ registry: agentSkillRegistry, defineTool: defineToolImpl })
        pi.registerTool({
          ...reader,
          async execute(...args) {
            const result = await reader.execute(...args)
            transitionPhysical({ type: 'agent-skill', skillId: args[1]?.skillId })
            return result
          },
        })
      }
      const physicalTools = createPhysicalPiTools({
        defineTool: defineToolImpl,
        client: physicalClient,
        onSnapshot(snapshot) {
          transitionPhysical({ type: 'snapshot', snapshot })
        },
        onIntent(response, requestedIntent) {
          transitionPhysical({ type: 'intent', response, requestedIntent })
        },
        onError(error) {
          transitionPhysical({ type: 'error', error })
        },
        onPlanError(error, requestedIntent) {
          transitionPhysical({ type: 'plan-error', error, requestedIntent })
        },
        onCatalog(catalog, generation) { return transitionPhysical({ type: 'capability-catalog', catalog, generation }) },
        onRoute(receipt, generation) { return transitionPhysical({ type: 'route', receipt, generation }) },
        onRouteError(error, generation) { return transitionPhysical({ type: 'route-error', error, generation }) },
        onRouteChecking(type) {
          transitionPhysical({ type })
          return physicalState.generation
        },
      })
      for (const tool of physicalTools) pi.registerTool(tool)
    }

    function renderHeader(ctx = headerContext) {
      if (!showHeader || !ctx || ctx.mode !== 'tui') return
      headerContext = ctx
      ctx.ui.setHeader(createHarnessHeader({
        getState: () => ({ ...headerState, modelConfigured: Boolean(ctx.model) }),
      }))
    }

    function updateHeader(next, ctx) {
      Object.assign(headerState, next)
      renderHeader(ctx)
    }

    async function authenticatedForCurrentScopes() {
      const summary = await tokenStore.summary()
      if (!summary.connected) throw new Error('Run /tinyedge-login first')
      const allowedTools = toolsForScopes(summary.scope)
      const auth = await createAuthenticatedMcpImpl({ config, tokenStore, allowedTools })
      return { ...auth, allowedTools, summary }
    }

    async function registerCurrentTools(ctx, announce = true) {
      const { client, allowedTools } = await authenticatedForCurrentScopes()
      const advertisedTools = await client.listTools()
      // Re-register the complete scope set as one generation so task/run ID
      // discovery state is shared by the tools that depend on it.
      const freshClient = {
        async callTool(name, args) {
          const current = await authenticatedForCurrentScopes()
          return current.client.callTool(name, args)
        },
      }
      const tools = createToolsImpl({
        sdk: { defineTool: defineToolImpl },
        mcpClient: freshClient,
        advertisedTools,
        allowedTools,
      })
      for (const tool of tools) pi.registerTool(tool)
      registeredTools = tools.map((tool) => tool.name)
      const active = standalone
        ? [ASK_CHOICE_TOOL, ...PHYSICAL_TOOL_ALLOWLIST, ...registeredTools]
        : [...new Set([...pi.getActiveTools(), ASK_CHOICE_TOOL, ...registeredTools])]
      pi.setActiveTools(active)
      if (announce) ctx.ui.notify(`TinyEdge connected: ${registeredTools.length} tools available`, 'info')
      return registeredTools
    }

    async function connect(ctx, flags = { allowWrite: false, allowRun: false }) {
      const scopedConfig = withScopes(config, loginScopes(flags))
      await loginImpl({ config: scopedConfig, tokenStore, io: uiIo(ctx) })
      return registerCurrentTools(ctx)
    }

    if (cloudEnabled) pi.registerCommand('tinyedge-login', {
      description: 'Connect TinyEdge: /tinyedge-login [--allow-write] [--allow-run]',
      handler: async (args, ctx) => {
        try {
          const flags = loginFlags(args)
          await connect(ctx, flags)
        } catch (error) {
          ctx.ui.notify(error?.message || String(error), 'error')
        }
      },
    })

    if (cloudEnabled) pi.registerCommand('tinyedge-status', {
      description: 'Show the TinyEdge connection and granted scopes',
      handler: async (_args, ctx) => {
        const summary = await tokenStore.summary()
        if (!summary.connected) {
          ctx.ui.notify('TinyEdge is not connected. Run /tinyedge-login.', 'warning')
          return
        }
        ctx.ui.notify(`TinyEdge connected · ${summary.scope.join(', ')} · ${registeredTools.length} tools`, 'info')
      },
    })

    if (cloudEnabled) pi.registerCommand('tinyedge-tools', {
      description: 'Show TinyEdge tools enabled for this Pi session',
      handler: async (_args, ctx) => {
        const tools = [
          ...physicalActiveTools,
          ...registeredTools,
        ]
        ctx.ui.notify(tools.length ? tools.join('\n') : 'No TinyEdge tools loaded', 'info')
      },
    })

    if (cloudEnabled) pi.registerCommand('tinyedge-logout', {
      description: 'Revoke TinyEdge authorization and remove local credentials',
      handler: async (_args, ctx) => {
        await logoutImpl({ tokenStore, io: uiIo(ctx) })
        const previous = new Set(registeredTools)
        pi.setActiveTools([
          ASK_CHOICE_TOOL,
          ...physicalActiveTools,
          ...pi.getActiveTools().filter((name) => (
            name === ASK_CHOICE_TOOL
            || physicalActiveTools.includes(name)
            || !previous.has(name)
          )),
        ].filter((name, index, names) => names.indexOf(name) === index))
        registeredTools = []
        ctx.ui.notify('TinyEdge disconnected. Registered tools now fail closed.', 'info')
      },
    })

    if (physicalEnabled) {
      pi.registerCommand('workcell', {
        description: 'Open the camera and workflow view for this same Harness session',
        handler: async (args, ctx) => {
          if (String(args || '').trim()) { ctx.ui.notify('Usage: /workcell', 'warning'); return }
          if (workcellClosing) return
          latestContext = ctx
          if (workcellOpening) return workcellOpening
          workcellOpening = (async () => {
            try {
              if (!workcellServer) {
                workcell = createWorkcellController({
                  workflow: physicalState,
                  refreshWorkflow: async () => {
                    await refreshPhysicalSystem(latestContext)
                    transitionPhysical({ type: 'catalog-checking' })
                    const generation = physicalState.generation
                    try { transitionPhysical({ type: 'capability-catalog', catalog: await physicalClient.capabilities(), generation }) }
                    catch (error) { transitionPhysical({ type: 'route-error', error, generation }) }
                  },
                  invalidateWorkflow: () => transitionPhysical({ type: 'reset-intent' }),
                  sendIntent: (text) => {
                    if (typeof submitWorkcellIntent !== 'function') throw new Error('This host cannot submit to the shared Harness session')
                    return submitWorkcellIntent(text)
                  },
                  canPrompt: () => Boolean(latestContext?.model && latestContext?.isIdle?.()
                    && !latestContext?.hasPendingMessages?.() && typeof submitWorkcellIntent === 'function'
                    && typeof canSubmitWorkcellIntent === 'function' && canSubmitWorkcellIntent() === true),
                  modelLabel: () => latestContext?.model ? `${latestContext.model.provider}/${latestContext.model.id}` : null,
                  cameraClient: createCameraPreviewClientImpl({ baseUrl: physicalClient.origin, token: env.PHYSICAL_NODE_CAMERA_TOKEN, fetchImpl: physicalFetchImpl }),
                  executionClient: createExecutionClientImpl({ baseUrl: physicalClient.origin, token: env.PHYSICAL_NODE_EXECUTION_TOKEN, fetchImpl: physicalFetchImpl }),
                })
                workcellServer = await createWorkcellServerImpl({ host: workcell })
              }
              if (workcellClosing) return
              await openWorkcellBrowser(workcellServer.openUrl)
              ctx.ui.notify('Workcell view opened for this Harness session. Camera capture and any available run approval require separate explicit operator actions.', 'info')
            } catch (error) {
              ctx.ui.notify(error?.message || 'Could not open the workcell view', 'warning')
            }
          })().finally(() => { workcellOpening = null })
          return workcellOpening
        },
      })
      pi.registerCommand('physical', {
        description: 'Discover the local workcell and describe a physical outcome',
        handler: async (args, ctx) => {
          let snapshot
          try {
            snapshot = await refreshPhysicalSystem(ctx)
          } catch (error) {
            ctx.ui.notify(error?.message || String(error), 'warning')
            return
          }
          if (!observedPhysicalDevices(snapshot).length) {
            ctx.ui.notify('No hardware was observed. Connect a device and run /physical again.', 'warning')
            return
          }
          const supplied = String(args || '').replace(/\s+/g, ' ').trim()
          let intent = supplied
          if (!intent) {
            if (typeof ctx.ui?.input !== 'function') {
              ctx.ui.notify('Type /physical followed by the physical outcome.', 'info')
              return
            }
            intent = String(await ctx.ui.input(
              'What should this physical system accomplish?',
              'Describe the physical outcome',
            ) || '').replace(/\s+/g, ' ').trim()
          }
          if (!intent) return
          transitionPhysical({ type: 'reset-intent' }, ctx)
          try {
            const response = await physicalClient.interpret(
              intent,
              snapshot.discoveryBindingDigest,
              snapshot,
            )
            transitionPhysical({ type: 'intent', response, requestedIntent: intent }, ctx)
            const interpretation = response.interpretation
            const recommendation = recommendPhysicalCommissioningDraft(response)
            if (recommendation) {
              ctx.ui.notify(
                'The local node reported a commissioning gap. Preparing a bound draft cannot start motion.',
                'info',
              )
              const proposal = await promptPhysicalCommissioningDraft(ctx, response)
              if (proposal?.decision === 'declined') {
                transitionPhysical({ type: 'exploration-declined' }, ctx)
                ctx.ui.notify('Commissioning paused. Physical execution remains locked.', 'warning')
              } else if (proposal) {
                transitionPhysical({ type: 'exploration', exploration: proposal }, ctx)
                ctx.ui.notify(
                  `Commissioning draft prepared for ${proposal.operationIds.length} reported operation${proposal.operationIds.length === 1 ? '' : 's'}. No method, bounds, or motion was selected.`,
                  'info',
                )
              } else {
                ctx.ui.notify('Commissioning draft was not prepared. Execution remains locked.', 'warning')
              }
            } else if (interpretation.status === 'ready') {
              ctx.ui.notify('Physical workflow grounded. Execution remains locked.', 'info')
            } else if (interpretation.questions?.length) {
              ctx.ui.notify(interpretation.questions[0], 'warning')
            } else if (interpretation.gaps?.length) {
              ctx.ui.notify(interpretation.gaps[0].detail, 'warning')
            } else {
              ctx.ui.notify(`Physical workflow is ${interpretation.status}.`, 'warning')
            }
          } catch (error) {
            transitionPhysical({ type: 'plan-error', error, requestedIntent: intent }, ctx)
            ctx.ui.notify(error?.message || String(error), 'error')
          }
        },
      })
    }

    pi.on('before_agent_start', (event, ctx) => {
      latestContext = ctx || latestContext
      if (physicalEnabled) transitionPhysical({ type: 'reset-intent' })
      workcell?.agentStart(event.prompt)
      freshBenchmarkTurn = cloudEnabled && isFreshBenchmarkRequest(event.prompt)
      freshDeviceCheckStarted = false
    })

    pi.on('context', (event) => ({
      messages: compactTinyEdgeHistory(event.messages),
    }))

    // A low-level agent run can end before Pi retries, compacts, or drains a
    // queued follow-up. Keep the intake boundary until the full request settles.
    pi.on('agent_settled', () => {
      workcell?.agentSettled()
      freshBenchmarkTurn = false
      freshDeviceCheckStarted = false
    })

    if (physicalEnabled) {
      pi.on('message_update', (event) => { workcell?.agentMessage(event.message) })
      pi.on('message_end', (event) => { workcell?.agentMessage(event.message) })
      pi.on('tool_execution_start', (event) => { workcell?.agentTool(event.toolName) })
      pi.on('tool_execution_end', () => { workcell?.agentTool(null) })
      pi.on('model_select', (_event, ctx) => { latestContext = ctx; workcell?.modelChanged() })
      pi.on('session_shutdown', async () => {
        workcellClosing = true
        await workcellOpening
        const closingServer = workcellServer
        const closingController = workcell
        workcellServer = null
        workcell = null
        latestContext = null
        try { await closingServer?.close() }
        finally { await closingController?.dispose() }
      })
    }

    if (standalone) {
      pi.on('user_bash', () => ({
        result: {
          output: 'Shell access is disabled in Physical Systems Harness.',
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      }))

    }

    pi.on('tool_call', (event) => {
      if (event.toolName === ASK_CHOICE_TOOL) return undefined
      if (freshBenchmarkTurn && event.toolName === 'list_devices'
        && registeredTools.includes(event.toolName)) {
        if (freshDeviceCheckStarted) {
          return { block: true, reason: REPEATED_DEVICE_CHECK_BLOCK }
        }
        freshDeviceCheckStarted = true
        return undefined
      }
      if (freshBenchmarkTurn && registeredTools.includes(event.toolName)
        && event.toolName !== 'list_devices') {
        return { block: true, reason: NEW_INTAKE_TOOL_BLOCK }
      }
      if (!standalone || registeredTools.includes(event.toolName)
        || physicalActiveTools.includes(event.toolName)) return undefined
      return { block: true, reason: 'Only reviewed Physical Systems tools are available in this Harness.' }
    })

    pi.on('session_start', async (_event, ctx) => {
      workcellClosing = false
      latestContext = ctx
      pi.setActiveTools([...new Set([
        ASK_CHOICE_TOOL,
        ...physicalActiveTools,
        ...pi.getActiveTools(),
      ])])
      renderHeader(ctx)
      renderPhysicalWorkflowWidget(ctx)
      if (physicalEnabled && showHeader) {
        try {
          await refreshPhysicalSystem(ctx)
        } catch {
          // The persistent widget carries the unavailable state. The Harness
          // remains usable for local intent entry and /physical can retry explicitly.
        }
      }
      if (cloudEnabled) {
        try {
          const summary = await tokenStore.summary()
          if (summary.connected) await registerCurrentTools(ctx, false)
          else if (autoLogin) {
            ctx.ui.notify('Connect TinyEdge in the browser to load cloud tools.', 'info')
            try {
              await connect(ctx)
            } catch (error) {
              ctx.ui.notify(`TinyEdge is not connected: ${error?.message || String(error)}. Run /tinyedge-login to try again.`, 'warning')
            }
          }
        } catch (error) {
          ctx.ui.notify(`TinyEdge tools unavailable: ${error?.message || String(error)}`, 'warning')
        }
      }
      if (!ctx.model) {
        ctx.ui.notify('Choose a model provider with /login to start chatting.', 'warning')
      }
    })
  }
}

export default createTinyEdgePiExtension()
