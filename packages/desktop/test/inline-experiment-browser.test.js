import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// Opt-in renderer coverage: Firefox receives only public assets and a fake IPC
// bridge. No model, Node client, equipment, provider account or credential is used.
const enabled = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_TESTS === '1'
test('inline experiment approval and assistant Markdown remain explicit, scoped and inert', { skip: !enabled, timeout: 90_000 }, async (t) => {
  const evidence = process.env.PHYSICALSYSTEMS_DESKTOP_BROWSER_EVIDENCE
  const checks = []
  let session, driver, origin
  const planned = { id: 'experiment-inline-one', goal: 'Compare synthetic alignment offsets', mode: 'simulation', phase: 'PROPOSED', trialLimit: 3, expiresAt: Date.now() + 120000, planDigest: 'inline-fixture-exact-plan-one', trials: [] }
  const userText = '**Keep this user message literal**\n### This is user text\n<img src="/user-fixture.png" onerror="window.__injected=true">'
  const assistantText = '### Review the simulation plan\n\n**Approval is required.** Compare three offsets in this synthetic fixture.\n\n- Review the goal\n- Approve the maximum trial budget\n\n```js\n<script>window.__injected = true</script>\n```\n\n<img src="/assistant-fixture.png" onerror="window.__injected=true">\n\n[Approval instructions](javascript:window.__injected=true) ![fixture image](https://fixture.invalid/image.png)'
  const initial = {
    revision: 1, activeProjectId: 'project-inline', activeConversationId: 'conversation-inline', connectionGeneration: 7,
    projects: [{ id: 'project-inline', name: 'Synthetic alignment lab', connection: { kind: 'simulation', label: 'Local simulation', status: 'offline' }, conversations: [{ id: 'conversation-inline', title: 'Compare synthetic offsets' }, { id: 'conversation-other', title: 'Separate fixture conversation' }] }],
    conversation: { id: 'conversation-inline', title: 'Compare synthetic offsets', busy: false, messages: [{ id: 'user-fixture', role: 'user', text: userText }, { id: 'assistant-fixture', role: 'assistant', text: assistantText }] },
    experiments: { availability: 'simulation-only', revision: 1, current: planned, history: [], physicalExecutionAuthorized: false, fixture: { id: 'synthetic-alignment-v1', name: 'Synthetic alignment', input: { name: 'offsetMm', unit: 'mm', minimum: -10, maximum: 10 }, metric: { name: 'alignmentErrorMm', unit: 'mm', lowerIsBetter: true } } },
    workcell: null, activeExperiments: [], models: [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture model' }], settings: { simulation: false },
  }
  const fixture = `
    window.__errors=[];window.__calls=[];window.__handlers={};window.__injected=false;
    addEventListener('error',e=>window.__errors.push(e.message));
    addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
    window.__state=${JSON.stringify(initial)};window.__listener=null;
    window.__setSnapshot=next=>{window.__state=next;window.__listener?.(next)};
    window.__ack=payload=>({...window.__state.experiments,continuation:{accepted:true,duplicate:false,requestId:payload.requestId,mode:'model'}});
    window.physicalSystems={snapshot:async()=>window.__state,subscribe(fn){window.__listener=fn;return()=>{window.__listener=null}},async command(name,payload){window.__calls.push({name,payload});if(window.__handlers[name])return window.__handlers[name](payload);return name.startsWith('experiment.')?window.__ack(payload):{accepted:true}}};
  `
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(fixture); return }
      const requested = request.url === '/' ? 'index.html' : request.url.slice(1)
      if (!['index.html', 'styles.css', 'app.js', 'workcell.js', 'experiments.js', 'markdown.js', 'view-state.js'].includes(requested)) { response.writeHead(404); response.end(); return }
      const file = requested === 'view-state.js' ? new URL('../../cli/src/harness/workcell-view/view-state.js', import.meta.url) : new URL(`../src/renderer/${requested}`, import.meta.url)
      let data = await readFile(file)
      if (requested === 'index.html') data = Buffer.from(data.toString().replace('<script type="module"', '<script src="./fixture.js"></script><script type="module"'))
      response.writeHead(200, { 'Content-Type': requested.endsWith('.js') ? 'text/javascript' : requested.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(data)
    } catch { response.writeHead(500); response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const assetOrigin = `http://127.0.0.1:${server.address().port}`
  const portServer = createServer()
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const port = portServer.address().port
  await new Promise((resolve) => portServer.close(resolve))
  origin = `http://127.0.0.1:${port}`
  driver = spawn(process.env.PHYSICALSYSTEMS_GECKODRIVER || '/snap/bin/geckodriver', ['--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore', detached: true })
  t.after(async () => {
    if (session) await fetch(`${origin}/session/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {})
    if (driver.pid) { try { process.kill(-driver.pid, 'SIGTERM') } catch {} }
    await new Promise((resolve) => server.close(resolve))
  })
  async function wd(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) })
    const value = await response.json()
    if (!response.ok || value.value?.error) throw new Error(JSON.stringify(value.value))
    return value.value
  }
  async function until(condition, message = 'Browser condition timed out', attempts = 100) {
    for (let i = 0; i < attempts; i++) { if (await condition()) return; await sleep(60) }
    throw new Error(message)
  }
  await until(async () => { try { return (await fetch(origin + '/status')).ok } catch { return false } })
  const created = await wd('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })
  session = created.sessionId
  const js = (script, args = []) => wd(`/session/${session}/execute/sync`, { script, args })
  const click = (selector) => js('const el=document.querySelector(arguments[0]);if(!el||el.disabled)throw new Error("Missing or disabled "+arguments[0]);el.click()', [selector])
  const calls = () => js('return window.__calls')
  const experimentCalls = async () => (await calls()).filter(({ name }) => name.startsWith('experiment.'))
  const cardText = () => js('return document.querySelector("#chat-experiment-card")?.textContent || ""')
  const usable = (selector) => js('const el=document.querySelector(arguments[0]);return Boolean(el&&!el.disabled)', [selector])
  let revision = initial.revision
  const apply = async (changes = {}) => {
    const next = structuredClone({ ...initial, ...changes, revision: ++revision })
    await js('window.__setSnapshot(arguments[0])', [next])
    return next
  }
  const screenshot = async (name) => {
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(`${evidence}/${name}.png`, Buffer.from(await wd(`/session/${session}/screenshot`), 'base64')) }
  }
  await wd(`/session/${session}/window/rect`, { width: 1440, height: 1100 })
  await wd(`/session/${session}/url`, { url: assetOrigin })
  await until(() => js('return Boolean(document.querySelector(".message.assistant"))'), 'Fixture conversation did not render')
  assert.equal(await js('return Boolean(document.querySelector("#transcript #chat-experiment-card"))'), true, 'a controller proposal must have an inline approval card in the chat transcript')
  await t.test('PROPOSED renders an explicit review action without sending a request', async () => {
    assert.equal((await experimentCalls()).length, 0, 'rendering grants no trial authority')
    const text = await cardText()
    assert.match(text, /Compare synthetic alignment offsets/)
    assert.match(text, /SIMULATION ONLY/)
    assert.equal(await js('const label=[...document.querySelectorAll("#chat-experiment-card span")].find(el=>el.textContent==="SIMULATION ONLY");const rect=label?.getBoundingClientRect();return Boolean(rect?.width&&rect?.height&&getComputedStyle(label).visibility!=="hidden")'), true, 'the simulation-only disclosure must be visible to the operator')
    assert.match(text, /(?:maximum|max|up to|budget)[\s\S]{0,32}3|3[\s\S]{0,32}(?:maximum|trials)/i)
    assert.match(text, /[-−]10[\s\S]*10[\s\S]*mm/)
    assert.equal(await js('return document.querySelector("#chat-experiment-approve").textContent'), 'Approve & continue')
    assert.equal(await usable('#chat-experiment-approve'), true)
    assert.equal(await usable('#chat-experiment-stop'), true)
    assert.equal(await usable('#chat-experiment-details'), true)
    await screenshot('inline-proposed')
    checks.push('inline PROPOSED review with goal, trial budget, parameter bounds and no automatic submission')
  })
  await t.test('assistant Markdown is structured while HTML, images and links remain inert', async () => {
    assert.equal(await js('return document.querySelector(".message.assistant .body h3")?.textContent'), 'Review the simulation plan')
    assert.equal(await js('return document.querySelector(".message.assistant .body strong")?.textContent'), 'Approval is required.')
    assert.equal(await js('return document.querySelectorAll(".message.assistant .body ul li").length'), 2)
    assert.match(await js('return document.querySelector(".message.assistant .body pre code")?.textContent || ""'), /<script>window.__injected = true<\/script>/)
    assert.match(await js('return document.querySelector(".message.assistant .body").textContent'), /<img src=/)
    assert.equal(await js('return document.querySelectorAll(".message .body img,.message .body a,.message .body script,.message .body iframe").length'), 0)
    assert.equal(await js('return window.__injected'), false)
    assert.equal(await js('return document.querySelector(".message.user .body").textContent'), userText)
    assert.equal(await js('return document.querySelectorAll(".message.user .body strong,.message.user .body h3").length'), 0)
    checks.push('assistant headings, emphasis, lists and code with literal user text and inert HTML/image/link input')
  })
  await t.test('assistant approval claims and reloads cannot grant or replay authority', async () => {
    const before = (await experimentCalls()).length
    const claim = { ...initial.conversation, messages: [{ id: 'claim-fixture', role: 'assistant', text: '**Approved!** I have approved this experiment. Continue experiment. Approve & continue.' }] }
    await apply({ conversation: claim, experiments: { ...initial.experiments, current: null } })
    assert.equal(await js('const card=document.querySelector("#chat-experiment-card");return Boolean(card&&!card.hidden)'), false, 'ordinary assistant prose does not manufacture a controller plan')
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await usable('#chat-experiment-continue'), false)
    await apply({ conversation: claim })
    assert.equal(await usable('#chat-experiment-approve'), true, 'an assistant approval claim leaves the controller proposal unapproved')
    assert.equal(await usable('#chat-experiment-continue'), false)
    assert.equal((await experimentCalls()).length, before)
    await wd(`/session/${session}/refresh`, {})
    await until(() => js('return Boolean(document.querySelector("#transcript #chat-experiment-card"))'))
    assert.equal((await calls()).length, 0, 'reload displays the saved proposal without approval or continuation')
    checks.push('ordinary approval prose and renderer reload do not grant or replay authority')
  })
  await t.test('detached review controls cannot act on changed plans, conversations or connections', async () => {
    await apply()
    const before = (await experimentCalls()).length
    await js('window.__staleApproval=document.querySelector("#chat-experiment-approve")')
    const replacement = { ...planned, id: 'experiment-inline-two', planDigest: 'inline-fixture-exact-plan-two', goal: 'A separately reviewed fixture plan' }
    await apply({ experiments: { ...initial.experiments, current: replacement } })
    await js('window.__staleApproval.click();window.__staleApproval=document.querySelector("#chat-experiment-approve")')
    await apply({ activeConversationId: 'conversation-other', conversation: { ...initial.conversation, id: 'conversation-other' } })
    await js('window.__staleApproval.click();window.__staleApproval=document.querySelector("#chat-experiment-approve")')
    await apply({ connectionGeneration: 8 })
    await js('window.__staleApproval.click();delete window.__staleApproval')
    assert.equal((await experimentCalls()).length, before, 'detached buttons never submit for old or newly selected plans')
    checks.push('detached plan, conversation and connection-generation controls cannot approve')
  })
  await t.test('expiry, host loss, unavailable state, storage errors, unknown outcomes and busy sessions block approval and continuation', async () => {
    const before = (await experimentCalls()).length
    for (const phase of ['PROPOSED', 'READY']) {
      const current = { ...planned, phase }
      const scenarios = [
        { experiments: { ...initial.experiments, current: { ...current, expiresAt: Date.now() - 1 } } },
        { hostUnavailable: true, experiments: { ...initial.experiments, current } },
        { experiments: { ...initial.experiments, current, availability: 'unavailable' } },
        { experiments: { ...initial.experiments, current, error: 'Experiment evidence could not be saved. Repair storage, then retry Stop.' } },
        { experiments: { ...initial.experiments, current: { ...current, mode: 'physical' } } },
        { conversation: { ...initial.conversation, busy: true }, experiments: { ...initial.experiments, current } },
        { experiments: { ...initial.experiments, current: { ...current, phase: 'OUTCOME_UNKNOWN' } } },
      ]
      for (const scenario of scenarios) {
        await apply(scenario)
        assert.equal(await usable('#chat-experiment-approve'), false, `${phase}: unavailable or unsafe state blocks approval`)
        assert.equal(await usable('#chat-experiment-continue'), false, `${phase}: unavailable or unsafe state blocks continuation`)
        await js('document.querySelector("#chat-experiment-approve")?.click();document.querySelector("#chat-experiment-continue")?.click()')
        if (scenario.conversation?.busy || scenario.experiments.error || scenario.experiments.current.phase === 'OUTCOME_UNKNOWN') assert.equal(await usable('#chat-experiment-stop'), true, 'Stop stays available during assistant activity, storage recovery and unknown trial outcomes')
      }
    }
    assert.equal((await experimentCalls()).length, before)
    checks.push('expired, unavailable, host-loss, nonsimulation, storage-error, unknown-outcome and assistant-busy action guards with independent recovery Stop')
  })
  await t.test('explicit approval submits exact identities once and preserves an independent Stop action', async () => {
    await apply()
    await js('window.__handlers["experiment.approveAndContinue"]=payload=>new Promise(resolve=>{window.__resolveApproval=()=>resolve(window.__ack(payload))})')
    const before = (await experimentCalls()).length
    await js('const button=document.querySelector("#chat-experiment-approve");button.click();button.click()')
    await until(async () => (await experimentCalls()).length > before)
    const approval = (await experimentCalls()).at(-1)
    assert.equal(approval.name, 'experiment.approveAndContinue')
    assert.match(approval.payload.requestId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(approval.payload, { projectId: initial.activeProjectId, conversationId: initial.activeConversationId, connectionGeneration: 7, experimentId: planned.id, expectedDigest: planned.planDigest, requestId: approval.payload.requestId, approved: true })
    assert.equal((await experimentCalls()).length, before + 1, 'double click submits one approval and continuation request')
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await usable('#chat-experiment-continue'), false)
    assert.equal(await usable('#chat-experiment-stop'), true)
    await click('#chat-experiment-stop')
    const stopped = (await experimentCalls()).at(-1)
    assert.equal(stopped.name, 'experiment.stop')
    assert.equal(stopped.payload.projectId, initial.activeProjectId)
    assert.equal(stopped.payload.conversationId, initial.activeConversationId)
    assert.equal(stopped.payload.experimentId, planned.id)
    await apply({ conversation: { ...initial.conversation, busy: true }, experiments: { ...initial.experiments, current: { ...planned, phase: 'READY' } } })
    await js('window.__resolveApproval();delete window.__handlers["experiment.approveAndContinue"]')
    await until(() => usable('#chat-experiment-stop'))
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await usable('#chat-experiment-continue'), false, 'assistant busy blocks repeated continuation after acknowledgement')
    checks.push('exact scoped approval payload, double-click suppression and independent Stop while pending')
  })
  await t.test('READY continues the existing approval and surfaces rejected continuation without reapproving', async () => {
    await apply({ experiments: { ...initial.experiments, current: { ...planned, phase: 'READY' } } })
    await js('window.__handlers["experiment.continue"]=payload=>({...window.__state.experiments,continuation:{accepted:false,duplicate:false,requestId:payload.requestId,mode:"model",error:"Choose a fixture model before continuing."}})')
    const before = (await experimentCalls()).length
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await js('return document.querySelector("#chat-experiment-continue").textContent'), 'Continue experiment')
    await click('#chat-experiment-continue')
    await until(async () => /Choose a fixture model/.test(await cardText()))
    const continued = (await experimentCalls()).at(-1)
    assert.equal(continued.name, 'experiment.continue')
    assert.match(continued.payload.requestId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(continued.payload, { projectId: initial.activeProjectId, conversationId: initial.activeConversationId, connectionGeneration: 7, experimentId: planned.id, expectedDigest: planned.planDigest, requestId: continued.payload.requestId })
    assert.equal((await experimentCalls()).slice(before).some(({ name }) => /approve/.test(name)), false)
    await js('delete window.__handlers["experiment.continue"]')
    checks.push('READY continuation uses its approved plan and renders unaccepted continuation errors')
  })
  await t.test('a timed-out continuation retains its identity and progress through an explicit status retry', async () => {
    // Use a distinct approved plan so this test owns its retry identity. Holding
    // the fake response exercises the production timeout without altering timers.
    const ready = { ...planned, id: 'experiment-timeout-fixture', planDigest: 'inline-timeout-plan', phase: 'READY' }
    await apply({ experiments: { ...initial.experiments, current: ready } })
    await js('window.__handlers["experiment.continue"]=payload=>new Promise(resolve=>{window.__resolveContinuation=()=>resolve(window.__ack(payload))})')
    const before = (await experimentCalls()).length
    await click('#chat-experiment-continue')
    const first = (await experimentCalls()).at(-1)
    assert.equal(await usable('#chat-experiment-continue'), false)
    assert.equal(await usable('#chat-experiment-stop'), true)
    await until(async () => await usable('#chat-experiment-continue') && /Check continuation/.test(await js('return document.querySelector("#chat-experiment-continue").textContent')), 'unconfirmed continuation did not expose an explicit status retry', 150)
    assert.equal((await experimentCalls()).length, before + 1, 'timeout does not automatically retry a continuation')
    await apply({ experiments: { ...initial.experiments, current: ready }, conversation: { ...initial.conversation,
      messages: [...initial.conversation.messages, { id: 'timeout-progress-fixture', role: 'assistant', text: 'The requested comparison is recorded. Review it before another continuation.' }] } })
    await js('window.__handlers["experiment.continue"]=payload=>({...window.__ack(payload),continuation:{...window.__ack(payload).continuation,duplicate:true}})')
    await click('#chat-experiment-continue')
    await until(async () => (await experimentCalls()).length === before + 2)
    const retry = (await experimentCalls()).at(-1)
    assert.deepEqual(retry, first, 'explicit status retry retains operation, plan scope and requestId')
    await until(() => js('return document.querySelector("#chat-experiment-continue")?.textContent==="Continue experiment"'), 'confirmed status retry must retain progress observed since the original request')
    await js('window.__resolveContinuation();delete window.__handlers["experiment.continue"]')
    await click('#chat-experiment-continue')
    await until(async () => (await experimentCalls()).length === before + 3)
    const next = (await experimentCalls()).at(-1)
    assert.notEqual(next.payload.requestId, first.payload.requestId, 'a new explicit continuation after confirmed progress gets a fresh request identity')
    assert.deepEqual({ ...next.payload, requestId: first.payload.requestId }, first.payload)
    checks.push('native response timeout, explicit same-ID status retry retains earlier progress, then a new continuation gets a fresh ID')
  })
  await t.test('a status retry preserves an observed busy cycle even when no message or trial was added', async () => {
    const ready = { ...planned, id: 'experiment-busy-retry-fixture', planDigest: 'inline-busy-retry-plan', phase: 'READY' }
    await apply({ experiments: { ...initial.experiments, current: ready } })
    await js('window.__handlers["experiment.continue"]=()=>Promise.reject(new Error("The continuation response was lost."))')
    const before = (await experimentCalls()).length
    await click('#chat-experiment-continue')
    await until(() => js('return document.querySelector("#chat-experiment-continue")?.textContent==="Check continuation"'))
    const first = (await experimentCalls()).at(-1)
    await apply({ experiments: { ...initial.experiments, current: ready }, conversation: { ...initial.conversation, busy: true } })
    await apply({ experiments: { ...initial.experiments, current: ready } })
    assert.equal((await experimentCalls()).length, before + 1, 'busy and idle snapshots never retry an unconfirmed continuation')
    await js('window.__handlers["experiment.continue"]=payload=>({...window.__ack(payload),continuation:{...window.__ack(payload).continuation,duplicate:true}})')
    await click('#chat-experiment-continue')
    await until(() => js('return document.querySelector("#chat-experiment-continue")?.textContent==="Continue experiment"'), 'confirmed status retry must retain the original observed busy cycle')
    assert.deepEqual((await experimentCalls()).at(-1), first, 'busy-cycle recovery checks the original request identity')
    await js('delete window.__handlers["experiment.continue"]')
    await click('#chat-experiment-continue')
    await until(async () => (await experimentCalls()).length === before + 3)
    assert.notEqual((await experimentCalls()).at(-1).payload.requestId, first.payload.requestId)
    checks.push('same-ID status retry preserves an earlier busy cycle without manufacturing progress or replaying the previous continuation')
  })
  await t.test('an exhausted READY budget offers scoped Finish without approval or another assistant request', async () => {
    const exhausted = { ...planned, id: 'experiment-exhausted-fixture', planDigest: 'inline-exhausted-plan', phase: 'READY', trialLimit: 3,
      trials: [0, 1, 3].map((offsetMm, index) => ({ id: `exhausted-trial-${index + 1}`, offsetMm, status: 'COMPLETED', result: { alignmentErrorMm: 3 - offsetMm } })) }
    await apply({ experiments: { ...initial.experiments, current: exhausted } })
    const before = (await calls()).length
    assert.equal(await js('return document.querySelector("#chat-experiment-continue")'), null, 'an exhausted trial budget cannot start another continuation')
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await usable('#chat-experiment-finish'), true)
    assert.equal(await js('return document.querySelector("#chat-experiment-finish").textContent'), 'Finish experiment')
    await click('#chat-experiment-finish')
    await until(async () => (await calls()).length > before)
    assert.deepEqual((await calls()).slice(before), [{ name: 'experiment.finish', payload: { projectId: initial.activeProjectId, conversationId: initial.activeConversationId, connectionGeneration: 7, experimentId: exhausted.id } }], 'Finish sends only its owner and experiment identity, without approval, continuation or model calls')
    checks.push('exhausted READY trial budget offers exact scoped Finish without reapproval or assistant continuation')
  })
  await t.test('completed results retain a truthful synthetic summary and detailed measurements', async () => {
    const completed = { ...planned, phase: 'COMPLETED', trials: [{ id: 'trial-fixture-one', offsetMm: 0, status: 'COMPLETED', result: { alignmentErrorMm: 3 } }, { id: 'trial-fixture-two', offsetMm: 3, status: 'COMPLETED', result: { alignmentErrorMm: 0 } }], summary: { interpretation: 'The 3 mm offset had the smallest measured error in this synthetic fixture.' } }
    const conversation = { ...initial.conversation, messages: [{ id: 'results-fixture', role: 'assistant', text: '### Synthetic comparison complete\n\n**Best measured offset: 3 mm.** The fixture measured 0 mm error.\n\n- Offset 0 mm: error 3 mm\n- Offset 3 mm: error 0 mm\n\nThese measurements describe the synthetic fixture only.' }] }
    const before = (await experimentCalls()).length
    await apply({ conversation, experiments: { ...initial.experiments, current: completed } })
    assert.equal(await usable('#chat-experiment-approve'), false)
    assert.equal(await usable('#chat-experiment-continue'), false)
    assert.match(await cardText(), /SIMULATION ONLY/)
    await click('#chat-experiment-details')
    assert.equal(await js('return document.querySelector("#inspector").hidden'), false)
    assert.equal(await js('return document.querySelector("[data-tab=experiments]").getAttribute("aria-selected")'), 'true')
    assert.equal(await js('return document.querySelectorAll("#experiment-trials tbody tr").length'), 2)
    assert.match(await js('return document.querySelector("#experiment-best").textContent'), /0 mm error at 3 mm offset/)
    assert.equal((await experimentCalls()).length, before, 'viewing results submits no experiment commands')
    await screenshot('inline-completed-results')
    checks.push('completed synthetic results, measured best offset and navigation to trial details')
  })
  assert.deepEqual(await js('return window.__errors'), [])
  assert.equal(checks.length, 11, 'all inline approval and Markdown regressions passed')
  if (evidence) await writeFile(`${evidence}/inline-browser-result.json`, JSON.stringify({ status: 'PASS', scope: 'Actual renderer in headless Firefox with fixture-only bridge data and ephemeral asset serving; no model, Node, hardware or credentials.', checks, commands: await experimentCalls() }, null, 2))
})
