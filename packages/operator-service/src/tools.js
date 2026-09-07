// SPDX-License-Identifier: Apache-2.0
import { createExperimentTools, createPhysicalTools, createReadAgentSkillTool } from '../../operator-core/src/index.js'

const unavailable = () => { throw new Error('A bound service context is required') }
const physical = createPhysicalTools({ defineTool: (tool) => tool, client: {} })
const experiment = createExperimentTools({ getController: unavailable })
const descriptions = {
  propose_local_experiment: 'Propose a bounded synthetic alignment experiment, only with explicit mode simulation. This arithmetic fixture is not robot physics, a learned policy or physical execution. Explain the goal, fixture and maximum trial count. The proposal appears as an approval card in this conversation: direct the operator to review that exact card and choose Approve & continue. An operator may also inspect it in Experiments. A chat answer or question response cannot approve, and the agent has no approval tool. The trusted adapter supplies stable request identity; do not ask the operator or model to invent request IDs.',
  run_simulated_trial: 'Run one synthetic alignment trial within the operator-approved experiment and remaining budget. Use the exact experimentId returned in this conversation and offsetMm within [-10,10]. Inspect each result and explain the next change. The trusted adapter derives stable request identity from this tool call. This invokes only the fixed synthetic fixture, never Node, cameras, robots or learned controllers. Exact operator approval must already exist; never fabricate or bypass it.',
}
export const agentToolDefinitions = Object.freeze([...experiment, ...physical, createReadAgentSkillTool({ registry: { read: unavailable } }),
  { name: 'inspect_physical_setup', label: 'Inspect physical setup', description: 'Inspect cached setup evidence and read-only requirements. No discovery, configuration, approval or hardware execution.', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'inspect_physical_execution', label: 'Inspect physical execution', description: 'Inspect recorded execution evidence for an exact known run. This does not prepare, approve, stop or execute equipment.', parameters: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', minLength: 1, maxLength: 128 } } } },
].map(({ name, label, description, parameters }) => {
  const schema = structuredClone(parameters)
  // The trusted adapter supplies stable tool-call identity; model-authored IDs
  // cannot turn a transport retry into a fresh trial or proposal.
  if (schema.properties?.requestId) delete schema.properties.requestId
  if (schema.required) schema.required = schema.required.filter((key) => key !== 'requestId')
  return Object.freeze({ name, label, description: descriptions[name] || description, parameters: schema })
}))

export const agentToolNames = Object.freeze(agentToolDefinitions.map((tool) => tool.name))
