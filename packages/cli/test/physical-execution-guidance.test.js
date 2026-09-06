import assert from 'node:assert/strict'
import test from 'node:test'

import { physicalSystemsSystemPrompt } from '../src/chat/pi-session.js'

// Prompt contracts cover the two real-model assessment failures. They do not
// substitute for the separate real-prompt, operator-approved simulation.
test('physical prompt describes the current operator execution path after inspecting its availability', () => {
  const prompt = physicalSystemsSystemPrompt()
  assert.match(prompt, /After a selected route, call inspect_physical_execution/)
  assert.match(prompt, /\/workcell.*Physical run.*configuration.*Prepare invocation/)
  assert.match(prompt, /review.*mode.*digests.*expiry.*approv/i)
  assert.match(prompt, /assistant.*busy.*finish.*operator/i)
  assert.match(prompt, /no preparation, approval, dispatch, stop or reconciliation tools/)
  assert.match(prompt, /Route receipts are proposals/)
  assert.doesNotMatch(prompt, /future execution receipt|future supervised executor|show that Run remains locked/)
})

test('physical prompt reads exact execution evidence and separates inspection failure from uncertain outcomes', () => {
  const prompt = physicalSystemsSystemPrompt()
  assert.match(prompt, /After operator approval.*inspect_physical_execution again/)
  assert.match(prompt, /runId.*exact.*returned.*inspect_physical_execution/)
  assert.match(prompt, /failed or stale inspection.*OUTCOME_UNKNOWN/)
  assert.match(prompt, /missing, unavailable or invalid receipt.*not verified/i)
  assert.match(prompt, /historical.*current readiness/)
  assert.match(prompt, /simulation.*never.*physical.*qualification/i)
  assert.match(prompt, /Never retry.*uncertain.*effect/)
})

test('physical prompt preserves typed routing after candidate-only legacy grounding gaps', () => {
  const prompt = physicalSystemsSystemPrompt()
  assert.match(prompt, /inspect_physical_system.*wait.*inspect_physical_capabilities/)
  assert.match(prompt, /Do not run these inspections in parallel/)
  assert.match(prompt, /Use plan_physical_workflow when the operator's words require grounding/)
  assert.match(prompt, /candidate-only.*legacy.*does not.*typed.*catalog/i)
  assert.match(prompt, /all required typed inputs.*current catalog/)
  assert.match(prompt, /Never fabricate commissioning.*bypass.*gate/)
})
