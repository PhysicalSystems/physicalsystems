import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// Opt-in actual-browser coverage. The only endpoint is an ephemeral asset server;
// all bridge data is injected, and no Node/model/hardware client is constructed.
const enabled = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_TESTS === '1'
test('desktop renderer presents saved projects and routes operator interactions through scoped IPC', { skip: !enabled, timeout: 90_000 }, async (t) => {
  const evidence = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_EVIDENCE, viewports = []
  let driver, session, origin
  const initial = { revision: 1, projects: [], activeProjectId: null, activeConversationId: null, connectionGeneration: 0, conversation: null, workcell: null, models: [], settings: {} }
  const fixture = `window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));window.__calls=[];window.__state=${JSON.stringify(initial)};window.__listener=null;window.__setSnapshot=next=>{window.__state=next;window.__listener?.(next)};window.physicalSystems={snapshot:async()=>window.__state,subscribe(fn){window.__listener=fn;return()=>{window.__listener=null}},async command(name,payload){window.__calls.push({name,payload});return name.startsWith('workcell.')?window.__state.workcell:{accepted:true}}};`
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(fixture); return }
      const requested = request.url === '/' ? 'index.html' : request.url.slice(1)
      if (!['index.html','styles.css','app.js','workcell.js','view-state.js'].includes(requested)) { response.writeHead(404); response.end(); return }
      const file = requested === 'view-state.js' ? new URL('../../cli/src/harness/workcell-view/view-state.js', import.meta.url) : new URL(`../src/renderer/${requested}`, import.meta.url)
      let data = await readFile(file)
      if (requested === 'index.html') data = Buffer.from(data.toString().replace('<script type="module"', '<script src="./fixture.js"></script><script type="module"'))
      response.writeHead(200, { 'Content-Type': requested.endsWith('.js') ? 'text/javascript' : requested.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(data)
    } catch { response.writeHead(500); response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const assetOrigin = `http://127.0.0.1:${server.address().port}`
  const portServer = createServer(); await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise((resolve) => portServer.close(resolve))
  origin = `http://127.0.0.1:${port}`
  driver = spawn(process.env.PHYSICALSYSTEMS_GECKODRIVER || '/snap/bin/geckodriver', ['--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore', detached: true })
  t.after(async () => {
    if (session) await fetch(`${origin}/session/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {})
    if (driver.pid) { try { process.kill(-driver.pid, 'SIGTERM') } catch {} }
    await new Promise((resolve) => server.close(resolve))
  })
  async function wd(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) }); const value = await response.json()
    if (!response.ok || value.value?.error) throw new Error(JSON.stringify(value.value)); return value.value
  }
  async function until(condition) { for (let i=0;i<100;i++) { if (await condition()) return; await sleep(60) }; throw new Error('Browser condition timed out') }
  await until(async () => { try { return (await fetch(origin + '/status')).ok } catch { return false } })
  const created = await wd('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } }); session = created.sessionId
  const js = (script, args = []) => wd(`/session/${session}/execute/sync`, { script, args })
  const click = (selector) => js('const el=document.querySelector(arguments[0]);if(!el||el.disabled)throw new Error("Missing or disabled "+arguments[0]);el.click()', [selector])
  const set = (selector, value) => js('const el=document.querySelector(arguments[0]);el.value=arguments[1];el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))', [selector,value])
  const calls = () => js('return window.__calls')
  await wd(`/session/${session}/window/rect`, { width: 1440, height: 1000 })
  await wd(`/session/${session}/url`, { url: assetOrigin })
  await until(() => js('return document.querySelector("#transcript").textContent.includes("Your physical workspace.")'))
  assert.equal((await calls()).length, 0, 'onboarding never connects equipment')
  await click('#new-project'); await set('#field-name', 'Fixture project'); await set('#field-type', 'simulation'); await click('#dialog .primary')
  await until(async () => (await calls()).some((item) => item.name === 'project.create'))
  assert.deepEqual((await calls()).at(-1).payload.connection, { type: 'simulation', label: 'Fixture project' })
  const state = { ...initial, revision: 2, activeProjectId: 'project-one', activeConversationId: 'conversation-one', connectionGeneration: 7,
    projects: [{ id: 'project-one', name: 'Assembly bench', connection: { kind: 'ssh', label: 'Robot laptop', status: 'connected', deviceCount: 2, inUseCount: 0 }, conversations: [{ id: 'conversation-one', title: 'Plan a tray transfer' }, { id: 'conversation-two', title: 'Inspect the camera' }] }, { id: 'project-two', name: 'Simulation lab', connection: { kind: 'simulation', label: 'Local simulation', status: 'offline' }, conversations: [{ id: 'conversation-three', title: 'Test a transfer' }] }],
    conversation: { id: 'conversation-one', title: 'Plan a tray transfer', busy: false, messages: [{ id: 'm1', role: 'user', text: 'What is needed for a transfer?' }, { id: 'm2', role: 'assistant', text: 'Inspect the registered capability and its setup requirements before preparing a run.' }] }, models: [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture model' }] }
  await js('window.__setSnapshot(arguments[0])', [state])
  assert.equal(await js('return document.querySelectorAll(".project-toggle svg").length'), 2)
  assert.equal(await js('return document.querySelectorAll(".conversation-link").length'), 2)
  const before = (await calls()).length
  await click('.project-toggle'); assert.equal(await js('return document.querySelectorAll(".conversation-link").length'), 0)
  assert.equal((await calls()).length, before, 'collapse only changes navigation')
  await click('.project-toggle'); await click('.project-status')
  assert.match(await js('return document.querySelector("#project-popover").textContent'), /2 devices detected · 0 in use/)
  await click('#project-popover .device-count')
  assert.equal((await calls()).at(-1).name, 'project.select')
  assert.equal(await js('return document.querySelector("#inspector").hidden'), false)
  await set('#message', 'Please inspect setup'); await click('#send-message')
  await until(async () => (await calls()).some((item) => item.name === 'conversation.send'))
  const send = (await calls()).find((item) => item.name === 'conversation.send')
  assert.equal(send.payload.projectId, 'project-one'); assert.equal(send.payload.conversationId, 'conversation-one'); assert.match(send.payload.requestId, /^[0-9a-f-]{36}$/)
  state.revision++; state.conversation.busy = true; await js('window.__setSnapshot(arguments[0])', [state]); await click('#cancel-message')
  assert.equal((await calls()).at(-1).name, 'conversation.cancel')
  state.revision++; state.conversation.busy = false; state.conversation.question = { choiceId: 'choice-one', kind: 'select', question: 'Which tray?', options: ['Left tray','Right tray'] }; await js('window.__setSnapshot(arguments[0])', [state]); await click('#question button')
  assert.deepEqual((await calls()).at(-1).payload, { projectId: 'project-one', conversationId: 'conversation-one', connectionGeneration: 7, choiceId: 'choice-one', answer: 'Left tray' })
  await js('document.querySelectorAll(".project-toggle")[1].click()'); await js('document.querySelectorAll(".new-conversation")[1].click()')
  const create = (await calls()).at(-1); assert.equal(create.payload.projectId, 'project-two'); assert.equal(create.payload.conversationId, undefined, 'another project never inherits the selected conversation id')
  state.revision++; state.conversation.question = null; await js('window.__setSnapshot(arguments[0])', [state])
  state.revision++
  state.workcell = { contractVersion: 'physicalsystems-workcell-view-v1', physicalExecutionAuthorized: false, revision: 1, sessionId: 'fixture-session', agent: { status: 'idle', canPrompt: true },
    workflow: { snapshot: { nodeName: 'Robot laptop', discovery: { observedAt: new Date().toISOString(), devices: [{ deviceId: 'fixture-camera', displayName: 'Overhead camera', kind: 'camera', detected: true, readiness: 'preview available' }, { deviceId: 'fixture-arm', displayName: 'Robot arm', kind: 'robot', detected: true, readiness: 'setup unverified' }] } } },
    camera: { availability: 'available', status: { phase: 'idle', availableCameras: [{ candidateId: 'fixture-camera', candidateDigest: 'fixture-camera-digest', displayName: 'Overhead camera', identityStability: 'stable' }] } }, execution: { availability: 'unavailable', configurations: [], runs: [] } }
  state.workcell.workflow.routeReceipt = { capabilityId: 'tray-transfer', evaluatedAt: new Date().toISOString(), request: { arguments: [] }, decision: { decision_status: 'no_match', request_rejection_codes: ['missing_argument'], candidates: [{ implementation_id: 'fixture-implementation', mechanism: 'fixture', provider: 'fixture', status: 'rejected', rejection_codes: ['calibration_missing', 'artifact_mismatch'] }] } }
  state.workcell.workflow.capabilityCatalog = { capabilities: [{ capabilityId: 'tray-transfer', displayName: 'Tray transfer', availableForRouting: true, inputFields: [{ name: 'destination', value_type: 'identifier', required: true }], preconditions: [], reasonCodes: [] }] }
  await js('window.__setSnapshot(arguments[0])', [state])
  const proposal = await js('return document.querySelector(".proposal-card").textContent')
  assert.match(proposal, /Proposed capability/); assert.match(proposal, /Tray transfer/); assert.match(proposal, /missing argument/); assert.match(proposal, /calibration missing/); assert.match(proposal, /artifact mismatch/)
  assert.match(proposal, /Ask for the missing or corrected input/)
  await click('.proposal-card button')
  assert.equal(await js(`return document.querySelector('[data-tab="setup"]').getAttribute("aria-selected")`), 'true')
  await click('.capability-entry summary')
  assert.match(await js('return document.querySelector(".capability-entry").textContent'), /destination: identifier · required/)
  await click('[data-tab="devices"]')
  assert.equal(await js('return document.querySelectorAll("#devices .device-row").length'), 2)
  assert.equal(await js('return document.querySelector("#camera-start").disabled'), true, 'camera selection is explicit')
  await set('#camera-select', 'fixture-camera'); await click('#camera-start')
  await until(async () => (await calls()).some((item) => item.name === 'workcell.camera.start'))
  const cameraStart = (await calls()).find((item) => item.name === 'workcell.camera.start')
  assert.equal(cameraStart.payload.candidateId, 'fixture-camera'); assert.equal(cameraStart.payload.expectedCandidateDigest, 'fixture-camera-digest')
  state.revision++; state.workcell.revision++; state.workcell.agent.status = 'working'; state.workcell.camera.pending = 'start'; state.conversation.busy = true
  await js('window.__setSnapshot(arguments[0])', [state]); await click('#camera-stop')
  assert.equal((await calls()).at(-1).name, 'workcell.camera.stop', 'Stop remains independent while assistant works')
  state.revision++; state.workcell.revision++; state.workcell.agent.status = 'idle'; state.workcell.camera.pending = null; state.workcell.camera.status.phase = 'stopped'; state.conversation.busy = false
  await js('window.__setSnapshot(arguments[0])', [state])
  assert.equal(await js('return document.querySelector("#app-notice").hidden'), true, 'confirmed Stop clears its obsolete notice')
  for (const width of [1440, 1024, 736, 500]) {
    await wd(`/session/${session}/window/rect`, { width, height: 900 })
    for (const theme of ['light', 'dark']) {
      await js('document.documentElement.style.colorScheme=arguments[0]', [theme])
      const geometry = await js('return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector(".main").getBoundingClientRect().toJSON(),panel:document.querySelector("#inspector").getBoundingClientRect().toJSON(),errors:window.__errors}')
      viewports.push({ requestedWidth: width, actualWidth: geometry.viewport, theme }); assert.equal(geometry.viewport, width, 'the requested viewport is actually tested'); assert.deepEqual(geometry.errors, []); assert.ok(geometry.scroll <= geometry.viewport, `no horizontal overflow at ${width} ${theme}`)
      if (geometry.viewport > 950) assert.ok(geometry.panel.left >= geometry.main.right - 1, 'devices sit right of the chat')
      else assert.ok(geometry.panel.top < geometry.main.bottom, 'drawer does not stack below the composer')
      if (evidence && width === 1440) { await mkdir(evidence, { recursive: true }); const shot = await wd(`/session/${session}/screenshot`); await writeFile(`${evidence}/desktop-renderer-${width}-${theme}.png`, Buffer.from(shot,'base64')) }
    }
  }
  state.revision++; state.settings = { providers: [{ id: 'fixture', name: 'Fixture provider', apiKey: true, oauth: false, configured: false }], loginPending: true, loginQuestion: { id: 'login-one', kind: 'secret', question: 'Enter the provider credential' } }; await js('window.__setSnapshot(arguments[0])', [state])
  assert.equal(await js('return document.querySelector("#field-provider-answer").type'), 'password')
  await set('#field-provider-answer', 'fixture-only-not-a-credential'); await click('#dialog .primary')
  assert.equal((await calls()).at(-1).name, 'settings.providerAnswer')
  assert.equal(await js('return document.querySelector("#field-provider-answer").value'), '')
  assert.doesNotMatch(await js('return document.querySelector("#transcript").textContent'), /fixture-only-not-a-credential/)
  state.revision++; state.settings.loginQuestion = null; state.settings.loginPending = false; await js('window.__setSnapshot(arguments[0])', [state]); await js('document.querySelector("#dialog").close()')
  state.revision++; state.hostUnavailable = true; state.workcell = null; state.activeRuns = [{ projectId: 'project-one', projectName: 'Assembly bench', connectionGeneration: 7, run: { runId: 'run-one', mode: 'simulation', phase: 'RUNNING' }, canStop: false, statusUnavailable: true }]; await js('window.__setSnapshot(arguments[0])', [state])
  assert.equal(await js('return document.querySelector("#message").disabled'), true)
  assert.match(await js('return document.querySelector("#active-operation").textContent'), /last observed RUNNING · current state unavailable/)
  assert.equal(await js('return document.querySelector("#active-operation button").disabled'), true)
  assert.deepEqual(await js('return window.__errors'), [])
  if (evidence) await writeFile(`${evidence}/renderer-browser-result.json`, JSON.stringify({ status: 'PASS', scope: 'Actual renderer in headless Firefox with an injected bridge fixture; no model, Node, camera or robot access.', viewports, checks: ['empty onboarding', 'simulation profile creation', 'folder icons and nested conversation collapse', 'project popover and device count', 'scoped send and cancellation', 'question answer', 'exact camera identity selection and independent Stop', 'cross-project request scope', 'responsive light/dark layouts', 'host-loss stale run status'], commands: (await calls()).map(({name})=>name) }, null, 2))
})
