import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { cameraIsFresh, executionReadIsFresh, executionApprovalAvailable } from '../src/harness/workcell-view/view-state.js'
import { configuration, makeRun, route } from './fixtures/execution.js'

class Element {
  constructor(tag = 'div', text = '') { this.tagName = tag; this.textContent = text; this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.replacements = 0; this.classList = { toggle() {} } }
  replaceChildren(...items) { this.replacements += 1; this.children = items }
  append(...items) { this.children.push(...items) }
  add(item) { this.append(item) }
  setAttribute(name, value) { this[name] = value }
  removeAttribute(name) { delete this[name] }
  querySelector(tag) { return this.children.find((item) => item.tagName === tag) }
  querySelectorAll() { return this.children.filter((item) => ['button', 'input'].includes(item.tagName)) }
  get childElementCount() { return this.children.length }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function view(t, handle = () => null) {
  const html = readFileSync(new URL('../src/harness/workcell-view/index.html', import.meta.url), 'utf8')
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]))
  elements.get('camera-empty').append(new Element('h3'), new Element('p'))
  const handlers = new Map(), calls = []
  let streamController
  const stream = new ReadableStream({ start(controller) { streamController = controller } })
  const run = makeRun({ approval: { ...makeRun().approval, expiresAt: new Date(Date.now() + 60000).toISOString() } })
  let state = { contractVersion: 'physicalsystems-workcell-view-v1', physicalExecutionAuthorized: false,
    agent: { status: 'idle', canPrompt: false, pendingChoice: null, model: null }, camera: { availability: 'unchecked' },
    workflow: { nodeOrigin: 'http://127.0.0.1:8876' },
    execution: { availability: 'available', receivedAt: new Date().toISOString(), pending: null, stopPending: false,
      status: { availability: 'available', mode: 'simulation', reason: null }, configurations: [configuration], runs: [run], run,
      canPrepare: false, canApprove: true, canStop: true, canReconcile: false, physicalExecutionAuthorized: false } }
  const source = readFileSync(new URL('../src/harness/workcell-view/app.js', import.meta.url), 'utf8').replace(/^import .* from '\.\/view-state\.js'\r?\n/m, '')
  runInNewContext(source, {
    document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag) },
    location: { hash: '#token=local-view-test', pathname: '/', reload() {} }, history: { replaceState(_a, _b, path) { assert.equal(path, '/') } },
    Option: class extends Element { constructor(text, value) { super('option', text); this.value = value } },
    URL, URLSearchParams, AbortController, AbortSignal, TextDecoder, cameraIsFresh, executionReadIsFresh, executionApprovalAvailable,
    setInterval() {}, setTimeout, clearTimeout, addEventListener: (name, callback) => handlers.set(name, callback),
    fetch: async (path, options) => {
      calls.push({ path, options })
      if (path === '/api/state') return Response.json(state)
      if (path === '/api/events') return new Response(stream)
      return Response.json(await handle(path, JSON.parse(options.body), state) || state)
    },
  })
  await tick(); await tick()
  t.after(() => { handlers.get('pagehide')?.(); streamController.close() })
  return { elements, calls, state: () => state, push(next) { state = next; streamController.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`)) } }
}

test('real view JS requires explicit checkbox and keeps Stop usable while approval is pending', async (t) => {
  let finishApproval
  const pending = new Promise((resolve) => { finishApproval = resolve })
  const ui = await view(t, (path) => path.endsWith('/approve') ? pending : null)
  assert.equal(ui.calls.filter((call) => call.options.method === 'POST').length, 0)
  assert.equal(ui.elements.get('run-approve').disabled, true)
  ui.elements.get('run-confirm').checked = true
  ui.elements.get('run-confirm').onchange()
  assert.equal(ui.elements.get('run-approve').disabled, false)
  ui.elements.get('run-approve').onclick()
  await tick()
  assert.equal(ui.elements.get('run-stop').disabled, false)
  await ui.elements.get('run-stop').onclick()
  const approval = ui.calls.find((call) => call.path.endsWith('/approve'))
  assert.equal(JSON.parse(approval.options.body).approved, true)
  assert.equal(JSON.parse(approval.options.body).expectedRunDigest, ui.state().execution.run.runDigest)
  assert.ok(ui.calls.some((call) => call.path.endsWith('/stop')))
  for (const call of ui.calls) assert.equal(call.options.headers.Authorization, 'Bearer local-view-test')
  finishApproval(ui.state()); await tick()
  assert.match(ui.elements.get('execution-state').textContent, /SIMULATION/)
  assert.match(ui.elements.get('run-confirmation-text').textContent, /will not move hardware/)
})

test('camera/agent updates do not rebuild open execution selectors; changed run clears confirmation', async (t) => {
  const ui = await view(t)
  const replacements = ui.elements.get('configuration-select').replacements
  const histories = ui.elements.get('run-select').replacements
  ui.elements.get('run-confirm').checked = true
  ui.push({ ...ui.state(), agent: { ...ui.state().agent, reply: 'An unrelated update' } })
  await tick()
  assert.equal(ui.elements.get('configuration-select').replacements, replacements)
  assert.equal(ui.elements.get('run-select').replacements, histories)
  assert.equal(ui.elements.get('run-confirm').checked, true)
  ui.push({ ...ui.state(), execution: { ...ui.state().execution, canApprove: false,
    run: { ...ui.state().execution.run, runDigest: route.receiptDigest, phase: 'OUTCOME_UNKNOWN' } } })
  await tick()
  assert.equal(ui.elements.get('run-confirm').checked, false)
  assert.equal(ui.elements.get('run-approve').disabled, true)
  assert.match(ui.elements.get('execution-state').textContent, /OUTCOME UNKNOWN/)
})

test('receipt view distinguishes stored measurement evidence from live readiness or physical success', async (t) => {
  const ui = await view(t)
  ui.push({ ...ui.state(), execution: { ...ui.state().execution,
    configurationReason: '1 local configuration(s) installed. Obtain a successful capability route before selecting one.',
    receipt: { receiptDigest: route.receiptDigest, configurationSnapshotDigest: configuration.configurationDigest, evidenceDigest: configuration.implementationDigest,
      preparation: { stage: 'preparation', at: '2026-09-02T20:00:00.000Z', mode: 'simulation', historical: true, preconditions: 'met', stopped: 'met', verified: 'unknown',
        checks: [{ name: 'markerGeometry', status: 'met', metrics: [{ label: 'Anchor 1 deviation', value: 1.5, unit: 'pixel' }] }] }, verification: null },
  } })
  await tick()
  const flatten = (element) => [element.textContent, ...element.children.map(flatten)].join(' ')
  const details = flatten(ui.elements.get('run-details'))
  assert.match(details, /Shared configuration bytes verified/)
  assert.match(details, /Stored outcome evidence bytes verified/)
  assert.match(details, /SIMULATED · preparation checks · historical/)
  assert.match(details, /Anchor 1 deviation: 1.5 pixel/)
  assert.match(details, /not live readiness/)
  assert.match(details, /HSV brightness is not lux/)
  assert.match(ui.elements.get('configuration-detail').textContent, /1 local configuration/)
})
