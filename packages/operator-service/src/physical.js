// SPDX-License-Identifier: Apache-2.0
import { createPhysicalNodeClient, createCameraPreviewClient, createExecutionClient, createSetupRequirementsClient, createCommissioningClient,
  createWorkcellController, createSetupInspector, createSetupView, createExecutionInspector,
  createPhysicalWorkflowState, updatePhysicalWorkflow, createPhysicalTools } from '../../operator-core/src/index.js'

/** Constructors are inert. Only explicit connected-project requests read Node. */
export function createPublicClients({ endpoint, credential = {}, fetchImpl = globalThis.fetch }) {
  return Object.freeze({
    node: createPhysicalNodeClient({ baseUrl: endpoint, fetchImpl }),
    camera: createCameraPreviewClient({ baseUrl: endpoint, token: credential.cameraToken, fetchImpl }),
    execution: createExecutionClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl }),
    commissioning: createCommissioningClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl }),
    setup: createSetupRequirementsClient({ baseUrl: endpoint, token: credential.executionToken, fetchImpl }),
  })
}

export function createPhysicalContext({ clients, experiments, now, onChange, canPrompt, sendIntent }) {
  let workflow = createPhysicalWorkflowState(clients.node.origin), workcell, setupView
  let setupContext = { generation: 0, snapshot: null, capabilityCatalog: null, routeReceipt: null, routeRelationship: 'none' }
  const transition = (event) => {
    const next = updatePhysicalWorkflow(workflow, event)
    if (next === workflow) return false
    workflow = next
    setupContext = { generation: setupContext.generation + 1, snapshot: workflow.snapshot, capabilityCatalog: workflow.capabilityCatalog,
      routeReceipt: workflow.routeReceipt, routeRelationship: workflow.routeReceipt ? 'current' : 'none' }
    setupView?.contextChanged(); workcell?.setWorkflow(workflow); onChange()
    return true
  }
  const setupInspector = createSetupInspector({ client: { status: () => clients.execution.status() },
    requirementsClient: clients.setup, getContext: () => setupContext, now })
  setupView = createSetupView({ inspector: setupInspector, getContext: () => setupContext, now, onChange: () => workcell?.setupChanged() })
  const executionInspector = createExecutionInspector({ client: clients.execution, now,
    getContext: () => ({ generation: workflow.generation, route: workflow.routeReceipt, selectedRun: workcell?.snapshot().execution.run || null }) })
  const tools = createPhysicalTools({ defineTool: (tool) => tool, client: clients.node,
    onSnapshot: (snapshot) => transition({ type: 'snapshot', snapshot }),
    onIntent: (response, requestedIntent) => transition({ type: 'intent', response, requestedIntent }),
    onError: (error) => transition({ type: 'error', error }),
    onPlanError: (error, requestedIntent) => transition({ type: 'plan-error', error, requestedIntent }),
    onCatalog: (catalog, generation) => transition({ type: 'capability-catalog', catalog, generation }),
    onRoute: (receipt, generation) => transition({ type: 'route', receipt, generation }),
    onRouteError: (error, generation) => transition({ type: 'route-error', error, generation }),
    onRouteChecking: (type) => { transition({ type }); return workflow.generation },
  })
  workcell = createWorkcellController({ workflow, cameraClient: clients.camera, executionClient: clients.execution, commissioningClient: clients.commissioning,
    now: () => new Date(now()).toISOString(), canPrompt, sendIntent,
    getExperiments: () => experiments, getSetupView: () => setupView.snapshot(), inspectSetup: () => setupView.inspect({}),
    invalidateWorkflow: () => transition({ type: 'reset-intent' }),
    refreshWorkflow: async () => {
      await tools.find((tool) => tool.name === 'inspect_physical_system').execute()
      await tools.find((tool) => tool.name === 'inspect_physical_capabilities').execute('', {})
    },
  })
  const unsubscribe = workcell.subscribe(onChange)
  return Object.freeze({ workcell, tools, clients,
    inspectSetup: (args, options) => setupView.inspect(args, options),
    inspectExecution: (args, options) => executionInspector.inspect(args, options),
    async dispose() { unsubscribe(); setupView.dispose(); executionInspector.dispose(); await workcell.dispose() },
  })
}
