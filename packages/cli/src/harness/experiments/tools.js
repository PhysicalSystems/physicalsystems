import { experimentRequestFailure } from './controller.js'

/** Reviewed assistant surface for synthetic local trials. Operator approval is deliberately absent. */
export const EXPERIMENT_TOOL_ALLOWLIST = Object.freeze([
  'inspect_local_experiment', 'propose_local_experiment', 'run_simulated_trial', 'finish_local_experiment',
])

const id = { type: 'string', minLength: 1, maxLength: 128 }
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })

export function createExperimentTools({ getController, defineTool = (value) => value }) {
  const definitions = [
    ['inspect_local_experiment', 'Inspect local experiment',
      'Read this conversation’s synthetic experiment, fixed fixture, trial budget and recorded results. No hardware discovery or camera access. Simulation results do not establish robot performance.',
      schema({}), (controller) => controller.snapshot()],
    ['propose_local_experiment', 'Propose simulated experiment',
      'Propose a bounded synthetic alignment experiment, only with explicit mode simulation. This fixture is not robot physics, a learned policy or physical execution. Explain the goal, fixture and trial limit, then direct the operator to approve the exact plan in Experiments or /experiment approve. Conversation consent and ask_choice cannot approve. Use a stable requestId to avoid duplicate proposals.',
      schema({ goal: { type: 'string', minLength: 1, maxLength: 1000 }, mode: { type: 'string', enum: ['simulation'] },
        trialLimit: { type: 'integer', minimum: 1, maximum: 10 }, requestId: id }, ['goal', 'mode', 'requestId']),
      (controller, params) => controller.propose(params)],
    ['run_simulated_trial', 'Run simulated trial',
      'Run one synthetic alignment trial within the operator-approved experiment and remaining budget. Use an exact experimentId returned in this conversation and a stable requestId for this trial. Choose offsetMm within [-10,10], inspect the result and explain the next change. This invokes only the fixed synthetic fixture, never Node, cameras, robots or learned controllers. Approval must already exist; never fabricate or bypass it.',
      schema({ experimentId: id, requestId: id, offsetMm: { type: 'number', minimum: -10, maximum: 10 } }, ['experimentId', 'requestId', 'offsetMm']),
      (controller, params) => controller.trial(params)],
    ['finish_local_experiment', 'Finish local experiment',
      'Finish the current synthetic experiment and preserve its recorded result summary. Use the exact experimentId returned in this conversation. No physical outcome or readiness can be inferred.',
      schema({ experimentId: id }, ['experimentId']), (controller, params) => controller.finish(params)],
  ]
  return definitions.map(([name, label, description, parameters, invoke]) => defineTool({
    name, label, description, parameters,
    async execute(_callId, params, signal) {
      if (signal?.aborted) throw new Error('The assistant request was cancelled before the synthetic trial request started')
      const keys = Object.keys(params || {})
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || keys.some((key) => !Object.hasOwn(parameters.properties, key))
        || parameters.required.some((key) => !Object.hasOwn(params, key))) throw new TypeError('Experiment request has unsupported or missing fields')
      let controller, cancel
      try {
        controller = getController()
        if (name === 'run_simulated_trial' && signal) {
          cancel = () => {
            // Cancellation applies only to this conversation's exact synthetic
            // experiment. Never call camera or physical execution Stop.
            try { if (controller.snapshot().current?.id === params.experimentId) controller.stop({ experimentId: params.experimentId }) } catch { /* Operator Stop remains available. */ }
          }
          signal.addEventListener('abort', cancel, { once: true })
          if (signal.aborted) throw new Error('Assistant request cancelled')
        }
        const value = await invoke(controller, params)
        return { content: [{ type: 'text', text: JSON.stringify(value) }],
          details: { displaySummary: `${label} · simulation only` } }
      } catch (error) {
        const known = experimentRequestFailure(error)
        throw Object.assign(new Error(known?.message || 'The local experiment request could not complete. Inspect its current state before retrying; existing files were preserved.'),
          { code: known?.code || 'EXPERIMENT_UNAVAILABLE' })
      } finally { if (cancel) signal.removeEventListener('abort', cancel) }
    },
  }))
}
