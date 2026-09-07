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
  const fixture = `window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));window.__calls=[];window.__commandErrors={};window.__commandSnapshots={};window.__state=${JSON.stringify(initial)};window.__listener=null;window.__setSnapshot=next=>{window.__state=next;window.__listener?.(next)};window.physicalSystems={snapshot:async()=>window.__state,subscribe(fn){window.__listener=fn;return()=>{window.__listener=null}},async command(name,payload){window.__calls.push({name,payload});if(window.__commandErrors[name])throw new Error(window.__commandErrors[name]);if(window.__commandSnapshots[name]){const next=window.__commandSnapshots[name];window.__setSnapshot(next);return next}return name.startsWith('workcell.')?window.__state.workcell:{accepted:true}}};`
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(fixture); return }
      const requested = request.url === '/' ? 'index.html' : request.url.slice(1)
      if (!['index.html','styles.css','app.js','workcell.js','experiments.js','markdown.js','view-state.js'].includes(requested)) { response.writeHead(404); response.end(); return }
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
  const hover = async (selector, edge = false) => {
    const rect = await js('return document.querySelector(arguments[0]).getBoundingClientRect().toJSON()', [selector])
    await wd(`/session/${session}/actions`, { actions: [{ type: 'pointer', id: 'sidebar-pointer', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: 0, y: 0 }, { type: 'pointerMove', origin: 'viewport', x: Math.round(edge ? rect.right - 2 : rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), duration: 30 }] }] })
  }
  const escapePopover = () => js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
  const screenshot = async (name) => { if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(`${evidence}/${name}.png`, Buffer.from(await wd(`/session/${session}/screenshot`), 'base64')) } }
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
  const sidebarChecks = []
  await t.test('project creation is a compact heading action available on hover and focus', async () => {
    try {
      assert.equal(await js('return Boolean(document.querySelector("#new-project").closest(".projects-heading"))'), true)
      assert.equal(await js('return document.querySelector("#new-project").getAttribute("aria-label")'), 'New project')
      assert.doesNotMatch(await js('return document.querySelector("#new-project").textContent'), /New project/)
      await hover('.projects-heading')
      assert.ok(await js('const button=document.querySelector("#new-project"),rect=button.getBoundingClientRect(),style=getComputedStyle(button);return rect.width<=48&&rect.height<=48&&style.visibility!=="hidden"&&Number(style.opacity)>0'), 'hover reveals a small heading button')
      await js('document.querySelector("#new-project").focus()')
      assert.ok(await js('const button=document.querySelector("#new-project"),style=getComputedStyle(button);return document.activeElement===button&&style.visibility!=="hidden"&&Number(style.opacity)>0'), 'keyboard focus keeps project creation available')
      sidebarChecks.push('compact project heading action')
    } finally { await escapePopover() }
  })
  await t.test('project rows expose connection details without an independent dot action or title close control', async () => {
    const previousConnection = state.projects[1].connection
    try {
      assert.equal(await js('return document.querySelector("button.project-status")'), null)
      assert.equal(await js('return document.querySelectorAll(".project-toggle .dot").length'), 2)
      assert.equal(await js('return [...document.querySelectorAll(".project-toggle .dot")].every(dot=>dot.getAttribute("aria-hidden")==="true"&&getComputedStyle(dot).pointerEvents==="none")'), true)
      await hover('.project-row[data-project-id="project-one"]', true)
      await until(() => js('return !document.querySelector("#project-popover").hidden'))
      assert.equal(await js('return document.querySelector("#project-popover h3").textContent'), 'Assembly bench')
      assert.equal(await js('return [...document.querySelectorAll("#project-popover button")].some(button=>button.textContent.trim()==="×"||/close/i.test(button.getAttribute("aria-label")||""))'), false)
      assert.match(await js('return document.querySelector("#project-popover").textContent'), /2 devices detected · 0 camera previews active/)
      await screenshot('project-row-popover')
      await click('#project-popover .device-count')
      await until(async () => (await calls()).at(-1)?.name === 'project.select')
      assert.equal((await calls()).at(-1).payload.projectId, 'project-one')
      assert.equal(await js('return document.querySelector("#inspector").hidden'), false)
      assert.equal(await js(`return document.querySelector('[data-tab="devices"]').getAttribute("aria-selected")`), 'true')
      state.revision++; state.projects[1].connection = { ...previousConnection, status: 'connected', deviceCount: 3, inUseCount: 1 }
      await js('window.__setSnapshot(arguments[0])', [state]); await hover('.project-row[data-project-id="project-two"]', true)
      assert.match(await js('return document.querySelector("#project-popover").textContent'), /3 devices detected · 1 camera preview active/)
      await click('#devices-toggle')
      assert.equal(await js('return document.querySelector("#inspector").hidden'), true)
      await hover('.project-row[data-project-id="project-two"]', true)
      const beforeRejectedSelection = (await calls()).length
      await js('window.__commandErrors["project.select"]="The project could not be selected. Retry after the current operation finishes."')
      await click('#project-popover .device-count')
      await until(async () => (await calls()).slice(beforeRejectedSelection).some((item) => item.name === 'project.select'))
      assert.equal(await js('return window.__state.activeProjectId'), 'project-one')
      assert.equal(await js('return document.querySelector("#inspector").hidden'), true, 'a rejected project selection never opens the previous project’s Devices panel')
      assert.equal((await calls()).slice(beforeRejectedSelection).some((item) => item.name.startsWith('connection.') || item.name.startsWith('workcell.')), false)
      const selectedState = { ...state, revision: state.revision + 1, activeProjectId: 'project-two', activeConversationId: 'conversation-three', conversation: { id: 'conversation-three', title: 'Test a transfer', busy: false, messages: [] } }
      await js('delete window.__commandErrors["project.select"];window.__commandSnapshots["project.select"]=arguments[0]', [selectedState])
      await hover('.project-row[data-project-id="project-two"]', true); await click('#project-popover .device-count')
      await until(() => js('return window.__state.activeProjectId==="project-two"&&!document.querySelector("#inspector").hidden'))
      state.revision = selectedState.revision
      assert.doesNotMatch(await js('return document.querySelector("#app-notice").textContent'), /The project could not be selected/, 'confirmed retry clears its own obsolete navigation failure')
      assert.equal((await calls()).at(-1).payload.conversationId, undefined, 'inactive project routing never inherits the current conversation')
      const unrelatedState = { ...selectedState, revision: selectedState.revision + 1, notice: 'An unrelated fixture service notice' }
      await js('window.__setSnapshot(arguments[0]);window.__commandSnapshots["project.select"]=arguments[0]', [unrelatedState])
      const beforeSameProject = (await calls()).length
      await hover('.project-row[data-project-id="project-two"]', true); await click('#project-popover .device-count')
      await until(async () => (await calls()).slice(beforeSameProject).some((item) => item.name === 'project.select') && await js('return document.querySelector("#project-popover").hidden'))
      assert.equal(await js('return document.querySelector("#app-notice").textContent'), 'An unrelated fixture service notice', 'successful navigation never clears a different notice')
      state.revision = unrelatedState.revision
      assert.equal(await js(`return document.querySelector('[data-tab="devices"]').getAttribute("aria-selected")`), 'true')
      await js(`document.querySelector('.project-row[data-project-id="project-one"] .project-toggle').focus()`)
      assert.equal(await js('return document.querySelector("#project-popover").hidden'), false, 'keyboard focus exposes the same connection details')
      await escapePopover(); assert.equal(await js('return document.querySelector("#project-popover").hidden'), true)
      sidebarChecks.push('whole project row hover, decorative connection dot and scoped Devices routing')
    } finally {
      state.revision++; state.projects[1].connection = previousConnection
      await js('window.__commandErrors={};window.__commandSnapshots={};window.__setSnapshot(arguments[0])', [state])
      if (await js(`return document.querySelector('.project-row[data-project-id="project-two"] .project-toggle').getAttribute("aria-expanded")==="true"`)) await click('.project-row[data-project-id="project-two"] .project-toggle')
      await escapePopover()
    }
  })
  await t.test('row compose icons create conversations in expanded and collapsed projects without toggling them', async () => {
    try {
      assert.equal(await js('return document.querySelectorAll(".project-row button.new-conversation").length'), 2)
      assert.equal(await js('return document.querySelectorAll(".project-conversations .new-conversation").length'), 0)
      for (const project of state.projects) {
        const selector = `.project-row[data-project-id="${project.id}"] .new-conversation`
        assert.equal(await js('return document.querySelector(arguments[0]).textContent.trim()', [selector]), '')
        assert.ok(await js('return Boolean(document.querySelector(arguments[0]+" svg"))', [selector]))
        assert.equal(await js('return document.querySelector(arguments[0]).getAttribute("aria-label")', [selector]), `New conversation in ${project.name}`)
        const expandedBefore = await js('return document.querySelector(arguments[0]).getAttribute("aria-expanded")', [`.project-row[data-project-id="${project.id}"] .project-toggle`])
        const beforeCreate = (await calls()).length
        await click(selector)
        await until(async () => (await calls()).slice(beforeCreate).some((item) => item.name === 'conversation.create'))
        const created = (await calls()).slice(beforeCreate).find((item) => item.name === 'conversation.create')
        assert.equal(created.payload.projectId, project.id)
        if (project.id !== state.activeProjectId) assert.equal(created.payload.conversationId, undefined)
        assert.equal(await js('return document.querySelector(arguments[0]).getAttribute("aria-expanded")', [`.project-row[data-project-id="${project.id}"] .project-toggle`]), expandedBefore, 'compose does not expand or collapse the project')
      }
      sidebarChecks.push('project-row compose icons and exact project scope')
    } finally { await escapePopover() }
  })
  assert.equal(await js('return document.querySelectorAll(".project-toggle svg").length'), 2)
  assert.equal(await js('return document.querySelectorAll(".conversation-link").length'), 2)
  const before = (await calls()).length
  await click('.project-toggle'); assert.equal(await js('return document.querySelectorAll(".conversation-link").length'), 0)
  assert.equal((await calls()).length, before, 'collapse only changes navigation')
  await click('.project-toggle'); await hover('.project-row[data-project-id="project-one"]')
  assert.match(await js('return document.querySelector("#project-popover").textContent'), /2 devices detected · 0 (?:in use|camera previews active)/)
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
  await t.test('device presence distinguishes missing and unknown devices and clears stale green indicators on disconnect', async () => {
    const originalDevices = state.workcell.workflow.snapshot.discovery.devices, originalStatus = state.projects[0].connection.status
    try {
      state.revision++; state.workcell.workflow.snapshot.discovery.devices = [...originalDevices, { deviceId: 'fixture-missing', displayName: 'Missing camera', kind: 'camera', detected: false }, { deviceId: 'fixture-unverified', displayName: 'Unverified device', kind: 'unknown' }]
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelectorAll("#devices .device-row").length'), 4, 'reported missing devices remain inspectable')
      assert.equal(await js('return document.querySelector("#device-count").textContent'), '2 detected in last scan')
      assert.match(await js(`return document.querySelector('[data-device-id="fixture-missing"]').textContent`), /Not detected in last scan/)
      assert.match(await js(`return document.querySelector('[data-device-id="fixture-unverified"]').textContent`), /Presence unverified/)
      assert.equal(await js('return document.querySelectorAll("#devices .device-indicator:not(.unavailable)").length'), 2)
      state.revision++; state.projects[0].connection.status = 'offline'
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelectorAll("#devices .device-indicator.unavailable").length'), 4, 'same-workflow disconnect clears every green device indicator')
      assert.equal(await js('return [...document.querySelectorAll("#devices .device-presence")].every(row=>row.textContent.includes("Connection unavailable"))'), true)
      state.revision++; state.projects[0].connection.status = 'connected'
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelectorAll("#devices .device-indicator:not(.unavailable)").length'), 2)
      assert.equal(await js('return [...document.querySelectorAll("#devices .device-presence")].some(row=>row.textContent.includes("Connection unavailable"))'), false)
      sidebarChecks.push('truthful device presence and same-workflow connection recovery')
    } finally {
      state.revision++; state.workcell.workflow.snapshot.discovery.devices = originalDevices; state.projects[0].connection.status = originalStatus
      await js('window.__setSnapshot(arguments[0])', [state])
    }
  })
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
  await screenshot('compact-project-sidebar')
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
  await wd(`/session/${session}/window/rect`, { width: 1440, height: 1000 })
  const settingsChecks = []
  await t.test('manual authorization retains its browser action, safe URL fallback and typed answer', async () => {
    try {
      const authUrl = 'https://login.example.invalid/authorize?state=fixture-only&redirect_uri=https%3A%2F%2Flocal.example.invalid%2Fcallback'
      state.revision++; state.settings = { providers: [], loginPending: true, loginQuestion: { id: 'manual-one', kind: 'manual_code', question: 'Complete sign-in in your browser, or paste the authorization code / redirect URL here:', url: authUrl } }
      const beforePrompt = (await calls()).length
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal((await calls()).length, beforePrompt, 'receiving an authorization prompt never opens a browser or submits an answer automatically')
      assert.equal(await js('return document.querySelector("#provider-open-auth")?.textContent'), 'Open sign-in page')
      assert.equal(await js('return document.querySelector("#provider-auth-url")?.value'), authUrl)
      assert.equal(await js('return document.querySelector("#provider-auth-url")?.readOnly'), true)
      assert.equal(await js('return document.querySelector("label[for=field-provider-answer]")?.textContent'), 'Authorization code or redirect URL')
      await set('#field-provider-answer', 'fixture-partial-answer')
      state.revision++; state.settings.loginQuestion.question = 'Updated sign-in instructions <img src=x onerror=alert(1)>'
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelector("#field-provider-answer").value'), 'fixture-partial-answer', 'same-question snapshots preserve typing')
      assert.match(await js('return document.querySelector("#dialog-content").textContent'), /Updated sign-in instructions <img/)
      assert.equal(await js('return document.querySelector("#dialog-content img")'), null, 'provider instructions render as text')
      assert.equal((await calls()).length, beforePrompt)
      await js('window.__commandErrors["settings.openAuthUrl"]="The browser could not be opened. Use the sign-in address below."')
      await click('#provider-open-auth')
      await until(() => js('return document.querySelector("#dialog [role=alert]")?.textContent.includes("browser could not be opened")'))
      assert.deepEqual((await calls()).at(-1), { name: 'settings.openAuthUrl', payload: { projectId: 'project-one', conversationId: 'conversation-one', connectionGeneration: 7, questionId: 'manual-one' } }, 'only the question identity crosses IPC; the renderer never submits a URL')
      assert.equal(await js('return document.querySelector("#field-provider-answer").value'), 'fixture-partial-answer')
      assert.equal(await js('return document.querySelector("#provider-open-auth").disabled'), false, 'opening can be retried')
      await screenshot('provider-sign-in-retry')
      await js('delete window.__commandErrors["settings.openAuthUrl"]')
      await click('#provider-open-auth')
      assert.doesNotMatch(await js('return document.querySelector("#app-notice").textContent'), /browser could not be opened/, 'successful retry does not leave a stale background failure notice')
      await set('#field-provider-answer', 'fixture-only-authorization-answer'); await click('#dialog .primary')
      assert.equal((await calls()).at(-1).name, 'settings.providerAnswer')
      assert.equal((await calls()).at(-1).payload.questionId, 'manual-one')
      assert.equal((await calls()).at(-1).payload.answer, 'fixture-only-authorization-answer')
      assert.equal(await js('return document.querySelector("#field-provider-answer").value'), '', 'submitted answers are cleared immediately')
      assert.doesNotMatch(await js('return document.querySelector("#transcript").textContent'), /fixture-only-authorization-answer/)
      const afterAnswer = (await calls()).length
      state.revision++; await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal((await calls()).length, afterAnswer, 'a repeated prompt does not resubmit an answer')
      settingsChecks.push('manual authorization retry and retained typing')
    } finally {
      await js('window.__commandErrors={}')
      state.revision++; state.settings.loginQuestion = null; state.settings.loginPending = false
      await js('window.__setSnapshot(arguments[0]);document.querySelector("#dialog").close()', [state])
    }
  })
  state.revision++; state.conversation.model = { provider: 'provider-b', id: 'same-model', name: 'Shared model' }
  state.models = [{ provider: 'provider-a', id: 'same-model', name: 'Shared model' }, { provider: 'provider-b', id: 'same-model', name: 'Shared model' }, ...Array.from({ length: 80 }, (_, i) => ({ provider: 'provider-a', id: `catalog-${i}`, name: `Catalog model ${i}` }))]
  state.settings = { providers: [{ id: 'provider-a', name: 'Alpha provider', apiKey: true, oauth: false, configured: false }, { id: 'provider-b', name: 'Beta provider', apiKey: true, oauth: true, configured: true }, { id: 'provider-xss', name: 'Provider <img src=x onerror=alert(1)>', apiKey: true, oauth: false, configured: false }], loginQuestion: null, loginPending: false }
  await js('window.__setSnapshot(arguments[0])', [state])
  await t.test('model picker searches grouped models and selects exact provider/model identity', async () => {
    try {
      await click('#model-settings')
      assert.equal(await js('return document.querySelector("#dialog h2").textContent'), 'Choose a model')
      assert.equal(await js('return document.querySelectorAll(".model-group").length'), 2)
      assert.equal(await js('return document.querySelectorAll("button.model-option").length'), 82)
      assert.equal(await js(`return document.querySelector('button.model-option[data-provider="provider-b"][data-model-id="same-model"]').getAttribute("aria-pressed")`), 'true')
      assert.equal(await js(`return document.querySelector('button.model-option[data-provider="provider-a"][data-model-id="same-model"]').getAttribute("aria-pressed")`), 'false')
      assert.ok(await js('const node=document.querySelector("#model-list");return node&&["auto","scroll"].includes(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight&&node.clientHeight>0&&node.getBoundingClientRect().height<innerHeight'), 'the catalog has a bounded scroll area')
      await screenshot('model-picker')
      for (const query of ['Beta', 'provider-b']) {
        await set('#field-model-search', query)
        assert.equal(await js('return document.querySelectorAll("button.model-option").length'), 1, 'search includes provider display name and identifier')
        assert.equal(await js('return document.querySelector("button.model-option").dataset.provider'), 'provider-b')
      }
      await set('#field-model-search', 'catalog-79')
      assert.equal(await js('return document.querySelector("button.model-option").dataset.modelId'), 'catalog-79', 'search includes model identifier')
      await set('#field-model-search', 'Shared model')
      assert.equal(await js('return document.querySelectorAll("button.model-option").length'), 2, 'search includes model display name')
      await set('#field-model-search', 'unmatched-fixture-query')
      assert.equal(await js('return document.querySelectorAll("button.model-option").length'), 0)
      assert.match(await js('return document.querySelector("#dialog").textContent'), /No models/i)
      await set('#field-model-search', 'Shared model')
      await js('window.__commandErrors["settings.selectModel"]="The conversation is busy. Cancel or wait before changing models."')
      await click('button.model-option[data-provider="provider-a"][data-model-id="same-model"]')
      await until(() => js('return document.querySelector("#dialog [role=alert]")?.textContent.includes("conversation is busy")'))
      assert.equal(await js('return document.querySelector("#dialog").open'), true, 'selection errors remain visible in the chooser')
      assert.doesNotMatch(await js('return document.querySelector("#app-notice").textContent'), /conversation is busy/, 'inline model errors do not create a stale background notice')
      assert.equal((await calls()).at(-1).payload.provider, 'provider-a')
      assert.equal((await calls()).at(-1).payload.modelId, 'same-model')
      await js('delete window.__commandErrors["settings.selectModel"]')
      await set('#field-model-search', '')
      const input = await wd(`/session/${session}/element`, { using: 'css selector', value: '#field-model-search' })
      const inputId = input['element-6066-11e4-a52e-4f735466cecf']
      await wd(`/session/${session}/element/${inputId}/click`, {})
      await wd(`/session/${session}/element/${inputId}/value`, { text: 'Shared model' })
      const keys = (values) => wd(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'model-picker-keyboard', actions: values.flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] })
      await keys(['\uE015'])
      assert.equal(await js('return document.activeElement.dataset.provider'), 'provider-a', 'ArrowDown leaves search for the first matching model')
      await keys(['\uE015'])
      assert.equal(await js('return document.activeElement.dataset.provider'), 'provider-b', 'keyboard navigation crosses provider groups')
      await keys(['\uE011', '\uE007'])
      await until(() => js('return !document.querySelector("#dialog").open'))
      assert.equal((await calls()).at(-1).name, 'settings.selectModel')
      assert.equal((await calls()).at(-1).payload.provider, 'provider-a', 'duplicate model ids never select the other provider')
      settingsChecks.push('searchable grouped model picker and exact selection')
    } finally { await js('window.__commandErrors={};document.querySelector("#dialog").close()') }
  })
  await t.test('provider management prioritizes connected providers and keeps sign-in actions scoped', async () => {
    try {
      await click('#model-settings'); await click('#model-manage')
      assert.equal(await js('return document.querySelector("#dialog h2").textContent'), 'Model & app settings')
      assert.equal(await js('return document.querySelectorAll("details.provider-row").length'), 3)
      assert.equal(await js('return document.querySelector("details.provider-row").dataset.providerId'), 'provider-b', 'connected providers appear first')
      assert.equal(await js('return [...document.querySelectorAll("details.provider-row")].filter(item=>item.open).length'), 0, 'provider actions are collapsed until requested')
      assert.equal(await js('return document.querySelector("#dialog-content img")'), null)
      assert.match(await js('return document.querySelector("#dialog-content").textContent'), /Provider <img/)
      assert.ok(await js('const node=document.querySelector("#provider-list");return node&&["auto","scroll"].includes(getComputedStyle(node).overflowY)&&Number.isFinite(parseFloat(getComputedStyle(node).maxHeight))'), 'provider management has a bounded scroll area')
      await screenshot('provider-management')
      await set('#field-provider-search', 'Alpha')
      assert.equal(await js('return document.querySelectorAll("details.provider-row").length'), 1)
      assert.equal(await js('return document.querySelector("details.provider-row").dataset.providerId'), 'provider-a')
      await set('#field-provider-search', 'provider-b')
      assert.equal(await js('return document.querySelectorAll("details.provider-row").length'), 1)
      await click('details.provider-row summary')
      const beforeLogin = (await calls()).length
      await js('const row=document.querySelector("details.provider-row");[...row.querySelectorAll("button")].find(button=>button.textContent==="Browser sign in").click()')
      await until(async () => (await calls()).length > beforeLogin)
      assert.equal((await calls()).at(-1).name, 'settings.providerLogin')
      assert.equal((await calls()).at(-1).payload.providerId, 'provider-b')
      assert.equal((await calls()).at(-1).payload.authType, 'oauth')
      await set('#field-provider-search', 'unmatched-fixture-query')
      assert.equal(await js('return document.querySelectorAll("details.provider-row").length'), 0)
      assert.match(await js('return document.querySelector("#dialog").textContent'), /No providers/i)
      await set('#field-provider-search', 'provider-b')
      state.revision++; state.hostUnavailable = true; await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return [...document.querySelectorAll("details.provider-row button")].every(button=>button.disabled)'), true, 'host loss disables provider actions even when the catalog is unchanged')
      state.revision++; state.hostUnavailable = false; await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return [...document.querySelectorAll("details.provider-row button")].every(button=>!button.disabled)'), true, 'host recovery restores provider actions')
      state.revision++; state.settings.loginPending = true; state.settings.loginQuestion = null
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.match(await js('return document.querySelector("#dialog [role=status]")?.textContent'), /Waiting for provider sign-in/)
      assert.equal(await js('return [...document.querySelectorAll("details.provider-row button")].every(button=>button.disabled)'), true, 'pending sign-in keeps ordinary provider actions blocked')
      await click('#provider-pending-cancel')
      assert.equal((await calls()).at(-1).name, 'settings.providerCancel', 'slow startup remains explicitly cancelable before a prompt exists')
      assert.match(await js('return document.querySelector("#dialog [role=status]").textContent'), /Waiting for the provider to finish cleanup/)
      settingsChecks.push('searchable collapsed provider management, host recovery and pending cancellation')
    } finally {
      state.revision++; state.hostUnavailable = false; state.settings.loginPending = false
      await js('window.__setSnapshot(arguments[0]);document.querySelector("#dialog").close()', [state])
    }
  })
  await t.test('empty model catalogs explain provider setup and the scripted simulation', async () => {
    const previousModels = state.models, previousModel = state.conversation.model, previousKind = state.projects[0].connection.kind
    try {
      state.revision++; state.models = []; state.conversation.model = null
      await js('window.__setSnapshot(arguments[0])', [state]); await click('#model-settings')
      assert.equal(await js('return document.querySelector("#field-model")'), null, 'an empty dropdown is never offered')
      assert.match(await js('return document.querySelector("#dialog").textContent'), /No models available/i)
      assert.equal(await js('return document.querySelector("#model-manage")?.textContent'), 'Manage providers')
      await js('document.querySelector("#dialog").close()')
      state.revision++; state.projects[0].connection.kind = 'simulation'
      await js('window.__setSnapshot(arguments[0])', [state]); await click('#model-settings')
      const text = await js('return document.querySelector("#dialog").textContent')
      assert.match(text, /Simulation uses a scripted guide/i)
      assert.doesNotMatch(text, /sign in.*(?:required|fix)|(?:must|need to) sign in/i)
      assert.equal(await js('return document.querySelectorAll("button.model-option").length'), 0)
      await screenshot('simulation-model-guidance')
      settingsChecks.push('actionable empty catalog and truthful simulation guidance')
    } finally {
      state.revision++; state.models = previousModels; state.conversation.model = previousModel; state.projects[0].connection.kind = previousKind
      await js('window.__setSnapshot(arguments[0]);document.querySelector("#dialog").close()', [state])
    }
  })
  assert.equal(settingsChecks.length, 4, 'all settings browser regressions passed')
  const slashChecks = []
  const messageKeys = async (values) => {
    await js('document.querySelector("#message").focus()')
    await wd(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'composer-keyboard', actions: values.flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] })
  }
  const slashStage = () => js('const menu=document.querySelector("#slash-menu");return !menu||menu.hidden ? null : menu.dataset.stage')
  const openSlashProviders = async () => { await set('#message', '/model'); await messageKeys(['\uE007']); assert.equal(await slashStage(), 'providers') }
  const cleanupSlash = async () => {
    await js('window.__commandErrors={}')
    state.revision++; state.hostUnavailable = false; state.conversation.busy = false
    await js('window.__setSnapshot(arguments[0])', [state])
    for (let i = 0; i < 3 && await slashStage(); i++) await messageKeys(['\uE00C'])
  }
  await t.test('composer model command uses searchable keyboard stages without sending or storing the command', async () => {
    try {
      await set('#message', 'Keep this unsent draft')
      await until(async () => (await calls()).some((item) => item.name === 'conversation.saveDraft' && item.payload.draft === 'Keep this unsent draft'))
      const beforeSlash = (await calls()).length
      await set('#message', '/mo')
      assert.equal(await slashStage(), 'commands')
      assert.equal(await js('return document.querySelector("#slash-options").getAttribute("role")'), 'listbox')
      assert.equal(await js('return document.querySelector("#message").getAttribute("aria-controls")'), 'slash-options')
      assert.equal(await js('return document.querySelector("#message").getAttribute("aria-expanded")'), 'true')
      assert.ok(await js('const id=document.querySelector("#message").getAttribute("aria-activedescendant");const option=document.getElementById(id);return option?.getAttribute("role")==="option"&&option.getAttribute("aria-selected")==="true"'))
      await messageKeys(['\uE007'])
      assert.equal(await slashStage(), 'providers')
      assert.equal(await js('return document.querySelector("#message").value'), '', 'the command is consumed locally')
      const firstProvider = await js('return document.querySelector("#message").getAttribute("aria-activedescendant")')
      await messageKeys(['\uE015'])
      assert.notEqual(await js('return document.querySelector("#message").getAttribute("aria-activedescendant")'), firstProvider, 'ArrowDown changes the active provider without moving focus')
      assert.equal(await js('return document.activeElement.id'), 'message')
      await messageKeys(['\uE013'])
      assert.equal(await js('return document.querySelector("#message").getAttribute("aria-activedescendant")'), firstProvider)
      await set('#message', 'Beta')
      assert.equal(await js('return document.querySelectorAll(".slash-provider").length'), 1)
      assert.equal(await js('return document.querySelector(".slash-provider").dataset.provider'), 'provider-b')
      await screenshot('composer-model-providers')
      await messageKeys(['\uE007'])
      assert.equal(await slashStage(), 'models')
      await set('#message', 'same-model')
      assert.equal(await js('return document.querySelectorAll(".slash-model").length'), 1)
      assert.equal(await js('return document.querySelector(".slash-model").dataset.provider'), 'provider-b')
      assert.equal(await js('return document.activeElement.id'), 'message', 'keyboard focus stays in the composer')
      await screenshot('composer-model-options')
      await sleep(700)
      assert.equal((await calls()).slice(beforeSlash).filter((item) => item.name === 'conversation.saveDraft').length, 0, 'command and filter text never become saved conversation drafts')
      await messageKeys(['\uE007'])
      await until(async () => await slashStage() === null)
      const selected = (await calls()).slice(beforeSlash).filter((item) => item.name === 'settings.selectModel')
      assert.equal(selected.length, 1)
      assert.deepEqual(selected[0].payload, { projectId: 'project-one', conversationId: 'conversation-one', connectionGeneration: 7, provider: 'provider-b', modelId: 'same-model' })
      assert.equal(await js('return document.querySelector("#message").value'), 'Keep this unsent draft', 'model selection preserves the preceding ordinary draft')
      assert.notEqual(await js('return document.querySelector("#message").getAttribute("aria-expanded")'), 'true')
      assert.equal(await js('return document.querySelector("#message").getAttribute("aria-activedescendant")'), null, 'closing removes the reference to the detached option')
      assert.equal((await calls()).slice(beforeSlash).some((item) => item.name === 'conversation.send' || item.name === 'settings.providerLogin' || item.name.startsWith('connection.') || item.name.startsWith('workcell.')), false, 'model commands cause no chat submission, connection, login or hardware action')
      slashChecks.push('composer keyboard model command, exact identity and draft preservation')
    } finally { await cleanupSlash() }
  })
  await t.test('composer model command supports Tab, Send, click, back and Escape', async () => {
    try {
      const beforeSlash = (await calls()).length
      await set('#message', '/')
      assert.equal(await slashStage(), 'commands')
      await messageKeys(['\uE004'])
      assert.equal(await slashStage(), 'providers', 'Tab accepts the model command suggestion')
      await messageKeys(['\uE00C'])
      assert.equal(await slashStage(), null)
      assert.equal(await js('return document.querySelector("#message").value'), 'Keep this unsent draft')
      await set('#message', '/model'); await click('#send-message')
      assert.equal(await slashStage(), 'providers', 'Send handles the exact command locally')
      await click('.slash-provider[data-provider="provider-a"]')
      assert.equal(await slashStage(), 'models')
      await click('#slash-back'); assert.equal(await slashStage(), 'providers')
      await click('.slash-provider[data-provider="provider-a"]'); await messageKeys(['\uE00C'])
      assert.equal(await slashStage(), 'providers', 'Escape from models returns to providers')
      await set('#message', 'unmatched-fixture-query')
      assert.equal(await js('return document.querySelectorAll(".slash-provider").length'), 0)
      assert.match(await js('return document.querySelector("#slash-menu").textContent'), /No providers/i)
      await messageKeys(['\uE00C'])
      assert.equal(await slashStage(), null)
      assert.equal((await calls()).slice(beforeSlash).some((item) => item.name === 'conversation.send' || item.name === 'settings.selectModel'), false)
      slashChecks.push('composer command completion, pointer navigation and cancellation')
    } finally { await cleanupSlash() }
  })
  await t.test('composer model errors stay inline and busy, host and context changes prevent stale selection', async () => {
    const originalConversation = state.conversation, originalConversationId = state.activeConversationId
    try {
      await openSlashProviders(); await click('.slash-provider[data-provider="provider-a"]')
      await js('window.__commandErrors["settings.selectModel"]="Model change could not be saved. Retry when the conversation is available."')
      await click('.slash-model[data-provider="provider-a"][data-model-id="same-model"]')
      await until(() => js('return document.querySelector("#slash-error")?.textContent.includes("could not be saved")'))
      assert.equal(await slashStage(), 'models')
      assert.equal(await js('return document.querySelector("#slash-error").getAttribute("role")'), 'alert')
      assert.equal((await calls()).at(-1).payload.provider, 'provider-a', 'pointer selection keeps the exact provider for a duplicate model id')
      assert.equal((await calls()).at(-1).payload.modelId, 'same-model')
      assert.doesNotMatch(await js('return document.querySelector("#app-notice").textContent'), /Model change could not be saved/)
      await js('window.__commandErrors={}')
      for (const unavailable of ['busy', 'host']) {
        const beforeGate = (await calls()).length
        state.revision++; if (unavailable === 'busy') state.conversation.busy = true; else state.hostUnavailable = true
        await js('window.__setSnapshot(arguments[0])', [state])
        assert.ok(await js('return document.querySelector("#slash-menu").hidden || [...document.querySelectorAll(".slash-model,.slash-provider")].every(button=>button.disabled)'), `${unavailable} state prevents model selection`)
        assert.equal((await calls()).slice(beforeGate).some((item) => item.name === 'settings.selectModel' || item.name === 'conversation.send'), false)
        await cleanupSlash(); await openSlashProviders(); await click('.slash-provider[data-provider="provider-a"]')
      }
      await set('#message', 'same-model')
      await js(`window.__staleSlashChoice=document.querySelector('.slash-model[data-provider="provider-a"][data-model-id="same-model"]')`)
      const beforeContext = (await calls()).length
      state.revision++; state.activeConversationId = 'conversation-two'; state.conversation = { id: 'conversation-two', title: 'Inspect the camera', busy: false, messages: [], draft: 'Another conversation draft' }
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await slashStage(), null, 'conversation changes close the previous model command')
      await js('window.__staleSlashChoice.click();delete window.__staleSlashChoice')
      assert.equal((await calls()).slice(beforeContext).some((item) => item.name === 'settings.selectModel' || item.name === 'conversation.send'), false, 'detached choices never target a new conversation')
      assert.equal(await js('return document.querySelector("#message").value'), 'Another conversation draft')
      state.revision++; state.activeConversationId = originalConversationId; state.conversation = originalConversation
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelector("#message").value'), 'Keep this unsent draft', 'leaving an open model filter never overwrites the original conversation draft')
      slashChecks.push('inline model errors and busy, host and context gates')
    } finally {
      state.revision++; state.activeConversationId = originalConversationId; state.conversation = originalConversation
      await js('window.__setSnapshot(arguments[0])', [state]); await cleanupSlash()
    }
  })
  await t.test('composer retains normal Enter and Shift+Enter behavior for messages and unknown slash text', async () => {
    try {
      const beforeMessage = (await calls()).length
      await set('#message', '/unrecognized-fixture-command')
      assert.equal(await slashStage(), null)
      await messageKeys(['\uE007'])
      await until(async () => (await calls()).slice(beforeMessage).some((item) => item.name === 'conversation.send'))
      assert.equal((await calls()).slice(beforeMessage).find((item) => item.name === 'conversation.send').payload.text, '/unrecognized-fixture-command')
      await until(() => js('return document.querySelector("#message").value===""'))
      const beforeNewline = (await calls()).length
      await set('#message', 'First line')
      await js('const input=document.querySelector("#message");input.focus();input.setSelectionRange(input.value.length,input.value.length)')
      await wd(`/session/${session}/actions`, { actions: [{ type: 'key', id: 'composer-keyboard', actions: [{ type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }, { type: 'keyUp', value: '\uE008' }] }] })
      assert.equal(await js('return document.querySelector("#message").value'), 'First line\n')
      assert.equal((await calls()).slice(beforeNewline).some((item) => item.name === 'conversation.send'), false, 'Shift+Enter creates a newline without sending')
      await set('#message', 'First line\nSecond line'); await messageKeys(['\uE007'])
      await until(async () => (await calls()).slice(beforeNewline).some((item) => item.name === 'conversation.send'))
      assert.equal((await calls()).slice(beforeNewline).find((item) => item.name === 'conversation.send').payload.text, 'First line\nSecond line')
      slashChecks.push('ordinary and unknown slash messages and Shift+Enter preserved')
    } finally { await cleanupSlash() }
  })
  assert.equal(slashChecks.length, 4, 'all composer slash regressions passed')
  assert.equal(sidebarChecks.length, 4, 'all project sidebar regressions passed')
  await t.test('experiment review remains scoped, expiry blocks approval and unknown evidence stays truthful', async () => {
    const previous = { experiments: state.experiments, activeConversationId: state.activeConversationId, conversation: state.conversation, settings: state.settings }
    try {
      const planned = { id: 'experiment-fixture-one', goal: 'Compare alignment', mode: 'simulation', phase: 'PROPOSED', trialLimit: 2, expiresAt: Date.now() + 60000, planDigest: 'exact-fixture-plan', trials: [] }
      state.revision++; state.settings = { simulation: false }; state.experiments = { availability: 'simulation-only', revision: 1, current: planned, history: [] }
      await js('window.__setSnapshot(arguments[0])', [state]); await click('[data-tab="experiments"]')
      assert.equal(await js('return document.querySelector("#experiment-approve").disabled'), true)
      await click('#experiment-confirm')
      await js('window.__staleExperimentApproval=document.querySelector("#experiment-approve")')
      const beforeChange = (await calls()).length
      state.revision++; state.activeConversationId = 'conversation-two'; state.conversation = { id: 'conversation-two', messages: [], busy: false }; state.experiments = { availability: 'simulation-only', revision: 1, current: null, history: [] }
      await js('window.__setSnapshot(arguments[0]);window.__staleExperimentApproval.click()', [state])
      assert.equal((await calls()).slice(beforeChange).some((item) => item.name.startsWith('experiment.')), false, 'detached approval never targets a different conversation')
      state.revision++; state.experiments.current = { ...planned, expiresAt: Date.now() - 10 }
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelector("#experiment-approve").disabled'), true)
      assert.match(await js('return document.querySelector("#experiments").textContent'), /proposal expired/)
      state.revision++; state.conversation.busy = true; state.experiments = { ...state.experiments, revision: 2, error: 'Experiment evidence could not be saved.', current: { ...planned, phase: 'OUTCOME_UNKNOWN', recoveryReason: 'Preserve the local files and inspect recovery.', trials: [{ id: 'unknown-trial', offsetMm: 3, status: 'OUTCOME_UNKNOWN', result: { alignmentErrorMm: 0 }, error: 'Runner cleanup is unconfirmed.' }] } }
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelector("#experiment-best")'), null, 'uncertain measurements are never declared best results')
      assert.match(await js('return document.querySelector("#experiments").textContent'), /evidence could not be saved[\s\S]*Preserve the local files/)
      assert.match(await js('return document.querySelector("#experiment-trials").textContent'), /Runner cleanup is unconfirmed/)
      assert.equal(await js('return document.querySelector("#experiment-stop").disabled'), false, 'assistant busy never blocks experiment Stop')
      await js('window.__commandErrors["experiment.stop"]="Stop remains unconfirmed; inspect the same experiment."')
      await click('#experiment-stop')
      await until(() => js('return document.querySelector("#experiment-error")?.textContent.includes("Stop remains unconfirmed")'))
      const stopped = (await calls()).at(-1)
      assert.equal(stopped.name, 'experiment.stop'); assert.equal(stopped.payload.conversationId, 'conversation-two'); assert.equal(stopped.payload.experimentId, planned.id)
      state.revision++; state.hostUnavailable = true; state.experiments.availability = 'unavailable'
      await js('window.__setSnapshot(arguments[0])', [state])
      assert.equal(await js('return document.querySelector("#experiment-stop").disabled'), true)
      assert.match(await js('return document.querySelector("#experiments").textContent'), /Displayed records are historical/)
    } finally {
      Object.assign(state, previous); state.revision++; state.hostUnavailable = false; state.conversation.busy = false
      await js('window.__commandErrors={};delete window.__staleExperimentApproval;window.__setSnapshot(arguments[0])', [state]); await click('[data-tab="devices"]')
    }
  })
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
  if (evidence) await writeFile(`${evidence}/renderer-browser-result.json`, JSON.stringify({ status: 'PASS', scope: 'Actual renderer in headless Firefox with an injected bridge fixture; no model, Node, camera or robot access.', viewports, checks: ['empty onboarding', 'simulation profile creation', 'folder icons and nested conversation collapse', 'project popover and device count', 'scoped send and cancellation', 'question answer', 'exact camera identity selection and independent Stop', 'cross-project request scope', 'responsive light/dark layouts', 'host-loss stale run status', 'experiment scope, expired approval, independent Stop, storage recovery messages and unknown outcomes', ...settingsChecks, ...slashChecks, ...sidebarChecks], commands: (await calls()).map(({name})=>name) }, null, 2))
})
