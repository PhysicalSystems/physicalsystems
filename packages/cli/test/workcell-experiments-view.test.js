import assert from 'node:assert/strict'
import test from 'node:test'
import { view, tick } from './fixtures/workcell-browser.js'

function experiment(ui, phase = 'PROPOSED', overrides = {}) {
  return { sessionId: 'conversation-one', availability: 'simulation-only', revision: 1, history: [],
    current: { id: 'experiment-one', goal: 'align synthetic fixture', mode: 'simulation', phase,
      planDigest: 'a'.repeat(64), trialLimit: 4, expiresAt: ui.now() + 60_000, trials: [], summary: null, ...overrides } }
}

test('browser binds synthetic approval to exact plan and resets it on expiry and session changes', async t => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), experiments: experiment(ui) })
  const confirm = ui.elements.get('experiment-confirm')
  assert.equal(ui.elements.get('experiment-approve').disabled, true)
  confirm.checked = true; confirm.onchange()
  assert.equal(ui.elements.get('experiment-approve').disabled, false)
  ui.elements.get('experiment-approve').onclick()
  await tick()
  const request = ui.actions.at(-1)
  assert.equal(request.path, '/api/experiments/approve')
  assert.deepEqual(JSON.parse(request.options.body), { experimentId: 'experiment-one', expectedDigest: 'a'.repeat(64) })
  request.resolve(Response.json({ ...ui.state(), experiments: experiment(ui, 'READY') }))
  await tick(); await tick()
  assert.equal(confirm.checked, false)
  await ui.push({ ...ui.state(), experiments: experiment(ui, 'PROPOSED', { expiresAt: ui.now() + 100 }) })
  confirm.checked = true; confirm.onchange()
  await ui.advance(500)
  assert.equal(ui.elements.get('experiment-approve').disabled, true)
  await ui.push({ ...ui.state(), sessionId: 'different-workcell', experiments: { ...experiment(ui), sessionId: 'different-conversation' } })
  assert.equal(confirm.checked, false)
})

test('experiment Stop remains available while the assistant and an ordinary request are busy', async t => {
  const ui = await view(t)
  await ui.push({ ...ui.state(), experiments: experiment(ui, 'RUNNING') })
  ui.elements.get('refresh').onclick()
  await tick()
  assert.equal(ui.actions.at(-1).path, '/api/refresh')
  await ui.push({ ...ui.state(), agent: { ...ui.state().agent, status: 'working' }, experiments: experiment(ui, 'RUNNING') })
  assert.equal(ui.elements.get('experiment-stop').disabled, false)
  ui.elements.get('experiment-stop').onclick()
  await tick()
  assert.equal(ui.actions.at(-1).path, '/api/experiments/stop')
  ui.actions.at(-1).resolve(Response.json({ ...ui.state(), experiments: experiment(ui, 'STOPPED') }))
  await tick(); await tick()
  assert.equal(ui.elements.get('experiment-stop').disabled, true)
  ui.actions[0].resolve(Response.json(ui.state()))
})

test('failed persistence shows retained-outcome recovery and keeps retry Stop available without new proposals', async t => {
  const ui = await view(t)
  const recoveryReason = 'The trial could not persist its outcome. Preserve local evidence, repair storage, then retry Stop. Its unknown result will not be replayed or reported as success.'
  const error = 'Experiment evidence could not be saved. Work is blocked; preserve the local files, repair storage, then retry Stop to save the retained evidence.'
  await ui.push({ ...ui.state(), experiments: { ...experiment(ui, 'OUTCOME_UNKNOWN', { recoveryReason }), error } })
  const displayed = ui.elements.get('experiment-details').children.map(child => child.textContent).join('\n')
  assert.ok(displayed.includes(error))
  assert.ok(displayed.includes(recoveryReason))
  assert.equal(ui.elements.get('experiment-propose').disabled, true)
  assert.equal(ui.elements.get('experiment-approve').disabled, true)
  assert.equal(ui.elements.get('experiment-stop').disabled, false)
})

test('unavailable startup without a current experiment explains repair and never offers an actionable proposal', async t => {
  const ui = await view(t)
  const error = 'Experiment metadata could not be opened. Preserve local files and repair storage before reopening.'
  await ui.push({ ...ui.state(), experiments: { sessionId: 'conversation-one', availability: 'unavailable', current: null, history: [], error } })
  const displayed = ui.elements.get('experiment-details').children.map(child => child.textContent).join('\n')
  assert.ok(displayed.includes(error))
  assert.match(displayed, /repair local storage and reopen/)
  assert.doesNotMatch(displayed, /Ask the assistant to propose/)
  assert.equal(ui.elements.get('experiment-propose').disabled, true)
  assert.equal(ui.elements.get('experiment-state').textContent, 'UNAVAILABLE')
})
