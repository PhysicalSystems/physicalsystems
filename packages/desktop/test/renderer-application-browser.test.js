import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createApplication } from '../src/application.js'
import { openCatalog } from '../src/catalog.js'

const enabled = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_TESTS === '1'
test('actual desktop application completes the browser simulation journey with approval, receipts and camera cleanup', { skip: !enabled, timeout: 120_000 }, async (t) => {
  const evidence = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_EVIDENCE
  const dataDir = await mkdtemp(path.join(tmpdir(), 'physicalsystems-desktop-browser-'))
  const catalog = await openCatalog(dataDir), commands = [], unexpected = []
  const forbidden = (name) => async () => { unexpected.push(name); throw new Error(`Forbidden in a simulation browser test: ${name}`) }
  const application = await createApplication({ dataDir, catalog, env: {},
    secretStore: { read: async () => null, write: forbidden('credential write'), delete: forbidden('credential deletion') },
    hostFactory: forbidden('real model host'), connections: { attachLocal: forbidden('local Node'), attachSSH: forbidden('SSH') }, probeNode: forbidden('live Node probe') })
  let driver, session, origin
  const fixture = `window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));const api=async(path,payload)=>{const response=await fetch('/api/'+path,{method:payload===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});const value=await response.json();if(!response.ok)throw new Error(value.error);return value};window.physicalSystems={snapshot:()=>api('snapshot'),command:(name,payload)=>api('command',{name,payload}),subscribe(fn){let busy=false;const timer=setInterval(async()=>{if(busy)return;busy=true;try{fn(await api('snapshot'))}catch{}finally{busy=false}},100);return()=>clearInterval(timer)}};`
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/snapshot') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(application.snapshot())); return }
      if (request.url === '/api/command') {
        let data = ''; for await (const chunk of request) data += chunk
        const { name, payload } = JSON.parse(data)
        if (name === 'project.create' && payload?.connection?.type !== 'simulation') throw new Error('Only explicit simulation profiles are permitted in this test.')
        if (/^settings\.provider|^connection\.saveCredential/.test(name)) throw new Error('Provider and credential changes are forbidden in this test.')
        commands.push(name)
        const result = await application.command(name, payload)
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result, (_, value) => ArrayBuffer.isView(value) ? Array.from(value) : value)); return
      }
      if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(fixture); return }
      const requested = request.url === '/' ? 'index.html' : request.url.slice(1)
      if (!['index.html','styles.css','app.js','workcell.js','view-state.js'].includes(requested)) { response.writeHead(404); response.end(); return }
      const file = requested === 'view-state.js' ? new URL('../../cli/src/harness/workcell-view/view-state.js', import.meta.url) : new URL(`../src/renderer/${requested}`, import.meta.url)
      let data = await readFile(file)
      if (requested === 'index.html') data = Buffer.from(data.toString().replace("connect-src 'none'", "connect-src 'self'").replace('<script type="module"', '<script src="./fixture.js"></script><script type="module"'))
      response.writeHead(200, { 'Content-Type': requested.endsWith('.js') ? 'text/javascript' : requested.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(data)
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })) }
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
    await sleep(100)
    const state = application.snapshot()
    if (state.conversation?.busy) await application.command('conversation.cancel', { projectId: state.activeProjectId, conversationId: state.activeConversationId }).catch(() => {})
    for (const owner of state.activeCaptures || []) await application.command('workcell.camera.stop', { projectId: owner.projectId, connectionGeneration: owner.connectionGeneration, expectedCaptureSessionId: owner.captureSessionId }).catch(() => {})
    for (const owner of state.activeRuns || []) await application.command('workcell.execution.stop', { projectId: owner.projectId, connectionGeneration: owner.connectionGeneration, runId: owner.run.runId, reason: 'operator-requested-stop' }).catch(() => {})
    await sleep(100); await application.close(); await catalog.close(); await rm(dataDir, { recursive: true, force: true })
  })
  async function wd(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) }); const value = await response.json()
    if (!response.ok || value.value?.error) throw new Error(JSON.stringify(value.value)); return value.value
  }
  async function until(condition, label) { for (let i=0;i<160;i++) { if (await condition()) return; await sleep(75) }; throw new Error(`Browser condition timed out: ${label || ''}; ${JSON.stringify({ commands, conversation: application.snapshot().conversation, agent: application.snapshot().workcell?.agent, notice: session ? await wd(`/session/${session}/execute/sync`, { script: 'return {notice:document.querySelector("#app-notice").textContent,errors:window.__errors}', args: [] }).catch(() => null) : null })}`) }
  await until(async () => { try { return (await fetch(origin + '/status')).ok } catch { return false } }, 'driver startup')
  const created = await wd('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } }); session = created.sessionId
  const js = (script, args = []) => wd(`/session/${session}/execute/sync`, { script, args })
  const click = async (selector) => { const element = await wd(`/session/${session}/element`, { using: 'css selector', value: selector }); await wd(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {}) }
  const set = (selector, value) => js('const el=document.querySelector(arguments[0]);el.value=arguments[1];el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))', [selector,value])
  await wd(`/session/${session}/window/rect`, { width: 1440, height: 1000 }); await wd(`/session/${session}/url`, { url: assetOrigin })
  await until(() => js('return document.querySelector("#transcript").textContent.includes("Your physical workspace.")'), 'empty onboarding')
  assert.deepEqual(commands, [])
  await click('#new-project'); await set('#field-name', 'Browser simulation'); await set('#field-type', 'simulation'); await click('#dialog .primary')
  await until(() => js('return document.querySelector("#connection-summary").textContent.includes("connected") && !document.querySelector("#composer").hidden && !document.querySelector("#dialog").open'), 'simulation project connected')
  assert.equal(application.snapshot().projects[0].connection.kind, 'simulation')
  assert.equal(application.snapshot().workcell.workflow.snapshot.discovery.devices.length, 3)
  const originalConversation = application.snapshot().activeConversationId
  await set('#message', 'Plan a tray transfer'); await click('#send-message')
  await until(() => js('return !document.querySelector("#question").hidden'), 'destination question')
  assert.equal(application.snapshot().workcell.execution.run, null)
  await click('#question button')
  await until(() => js('return document.querySelector("#transcript").textContent.includes("Simulation proposal:")'), 'scripted proposal')
  await click('.proposal-card button'); assert.match(await js('return document.querySelector("#proposal").textContent'), /transfer-container/)
  await click('.capability-entry summary'); assert.match(await js('return document.querySelector(".capability-entry").textContent'), /destination: identifier/); await click('.proposal-card .primary'); await click('#execution-refresh')
  await until(() => js('return [...document.querySelector("#configuration-select").options].some(o=>o.value==="simulation-table")'), 'configuration options')
  await set('#configuration-select', 'simulation-table'); await click('#run-prepare')
  await until(() => js('return !document.querySelector("#run-confirmation").hidden'), 'waiting for approval')
  assert.equal(application.snapshot().workcell.execution.run.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(await js('return document.querySelector("#run-approve").disabled'), true)
  await click('#run-confirm'); await click('#run-approve')
  await until(() => application.snapshot().workcell.execution.run.phase === 'VERIFIED_SUCCESS', 'three simulated steps completed')
  await click('#run-receipt')
  await until(() => js('return document.querySelector("#run-details").textContent.includes("Verified stored receipt integrity")'), 'stored receipt verified')
  assert.equal(application.snapshot().workcell.execution.run.mode, 'simulation')
  assert.match(application.snapshot().workcell.execution.run.outcome.reason, /no hardware was operated/)
  const runId = application.snapshot().workcell.execution.run.runId
  assert.equal(await js('return document.querySelector(".technical-evidence").open'), false, 'technical evidence starts collapsed')
  assert.equal(await js('return document.querySelector(".technical-evidence").textContent.includes(arguments[0])', [application.snapshot().workcell.execution.run.runDigest]), true, 'the exact run digest remains inspectable')
  assert.equal(await js('return [...document.querySelectorAll("#run-details>p")].some(el=>el.textContent.includes("sha256:"))'), false, 'hashes do not obscure the primary result')
  // Reading history must not hide a second unresolved invocation or bind Stop
  // to the terminal run currently displayed in the inspector.
  const historicalDigest = application.snapshot().workcell.execution.run.runDigest
  const historicalReceipt = application.snapshot().workcell.execution.receipt.receiptDigest
  await click('#run-prepare')
  await until(() => application.snapshot().workcell.execution.run.phase === 'WAITING_FOR_APPROVAL', 'second waiting simulation run')
  const waitingRunId = application.snapshot().workcell.execution.run.runId
  await set('#run-select', runId)
  await until(() => application.snapshot().workcell.execution.run.runId === runId, 'historical run selected while another waits')
  await click('#run-receipt')
  await until(() => application.snapshot().workcell.execution.receipt?.receiptDigest === historicalReceipt, 'historical receipt reloaded')
  assert.equal(await js('return document.querySelector("#run-stop").disabled'), true, 'selected terminal history cannot be stopped')
  await until(() => js('return !document.querySelector("#active-operation").hidden && !document.querySelector("#active-operation .stop").disabled'), 'global Stop retains the other owner')
  await click('#active-operation .stop')
  await until(() => !application.snapshot().activeRuns.length, 'nonselected waiting run stopped')
  assert.equal(application.snapshot().workcell.execution.runs.find((run) => run.runId === waitingRunId).stopStatus, 'STOP_CONFIRMED')
  assert.equal(application.snapshot().workcell.execution.run.runDigest, historicalDigest)
  assert.equal(application.snapshot().workcell.execution.receipt.receiptDigest, historicalReceipt)
  await js('document.querySelector("#inspector").scrollTop=0')
  if (evidence) { await mkdir(evidence, { recursive: true }); const shot = await wd(`/session/${session}/screenshot`); await writeFile(`${evidence}/desktop-application-simulation-receipt.png`, Buffer.from(shot, 'base64')) }
  await click('[data-tab="devices"]'); await set('#camera-select', 'camera-synthetic-preview'); await click('#camera-start')
  await until(() => js('const img=document.querySelector("#preview");return !img.hidden && img.naturalWidth===1'), 'synthetic image decoded')
  assert.match(await js('return document.querySelector("#frame-kind").textContent'), /SYNTHETIC TEST FRAME/)
  assert.equal(application.snapshot().activeCaptures.length, 1)
  await click('#camera-stop')
  assert.equal(await js('return document.querySelector("#preview").hidden'), true, 'Stop clears pixels immediately')
  await until(() => application.snapshot().workcell.camera.status.phase === 'stopped' && !application.snapshot().activeCaptures.length, 'capture released')
  assert.equal(await js('return document.querySelector("#preview").hasAttribute("src")'), false)
  await click('#conversation-menu'); await set('#field-title', 'Verified simulation transfer'); await click('#dialog .primary')
  await until(() => js('return document.querySelector("#conversation-title").textContent==="Verified simulation transfer"'), 'conversation renamed')
  await click('.new-conversation'); await until(() => application.snapshot().activeConversationId !== originalConversation, 'new conversation selected')
  assert.equal(application.snapshot().conversation.messages.length, 1, 'a new simulation conversation starts with its explicit scripted-guide introduction')
  await js('const button=[...document.querySelectorAll(".conversation-link")].find(el=>el.textContent==="Verified simulation transfer");button.click()')
  await until(() => application.snapshot().activeConversationId === originalConversation && application.snapshot().conversation.messages.length >= 4, 'original saved transcript selected')
  await wd(`/session/${session}/refresh`, {})
  await until(() => js('return document.querySelector("#transcript").textContent.includes("Simulation proposal:")'), 'browser reload restores transcript')
  assert.equal(application.snapshot().workcell.camera.status.phase, 'idle', 'reopening saved history does not restart preview')
  await click('[data-tab="run"]'); await click('#execution-refresh')
  await until(() => js('return [...document.querySelector("#run-select").options].some(o=>o.value===arguments[0])', [runId]), 'persistent run history restored')
  await set('#run-select', runId)
  await until(() => js('return document.querySelector("#execution-state").textContent.includes("VERIFIED SUCCESS")'), 'stored run selected')
  assert.deepEqual(unexpected, []); assert.deepEqual(await js('return window.__errors'), [])
  if (evidence) await writeFile(`${evidence}/renderer-application-result.json`, JSON.stringify({ status: 'PASS', scope: 'Actual renderer + createApplication + catalog + existing Workcell/execution controllers + scripted simulation host; no Electron transport, AI model or physical hardware verification.', checks: ['empty onboarding has no commands', 'explicit simulation project', 'discovery', 'conversation and destination question', 'proposal', 'prepare waits for separate exact approval', 'three scripted transitions', 'receipt integrity', 'synthetic image decode and Stop clearing/release', 'rename and new conversation', 'saved transcript and run history after browser reload'], commands, unexpectedExternalCalls: unexpected }, null, 2))
})
