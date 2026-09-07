// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createApplication } from '../src/application.js'
import { openCatalog } from '../src/catalog.js'
import { normalizeLocalEndpoint } from '../src/connections.js'

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ps-desktop-app-'))
  let catalog = await openCatalog(dataDir), app
  const secrets = new Map(), created = [], calls = { attach: 0, probe: 0, refresh: 0, close: 0 }, disconnects = []
  const secretStore = { kind: 'memory', read: async (name) => secrets.get(name) || null, write: async (name, value) => { secrets.set(name, value) }, delete: async (name) => { secrets.delete(name) } }
  const hostFactory = async (options) => {
    if (calls.hostWait) await calls.hostWait
    const listeners = new Set(), sessionRoot = path.join(options.config.configDir, 'harness-sessions')
    let sessionId = randomUUID(), sessionFile = options.sessionFile || path.join(sessionRoot, `${sessionId}.jsonl`)
    let busy = false, messages = [], disposed = false, viewers = 0, view, requests = new Map()
    const state = { workflow: { snapshot: { discovery: { observedAt: new Date().toISOString(), devices: [{ detected: true }] } }, routeReceipt: { receiptDigest: 'keep-route' } }, camera: {}, execution: {}, agent: {} }
    const emit = () => { for (const listener of listeners) listener({ type: 'change' }) }
    const replaceView = () => {
      view = { snapshot: () => structuredClone(state), onViewerConnect: () => { viewers++; return () => { viewers-- } },
        refresh: async () => { calls.refresh++; if (options.refreshWait) await options.refreshWait; return view.snapshot() },
        cameraAction: async (action, body) => { calls.camera = { action, body }; if (action === 'stop') { state.camera = { status: { phase: 'stopped' } }; emit() }; return view.snapshot() },
        cameraFrame: async () => ({ bytes: new Uint8Array([1]), contentType: 'image/jpeg' }),
        executionAction: async (action, body) => { calls.execution = { action, body }; return view.snapshot() },
        answerChoice: async (body) => { calls.answer = body; return { accepted: true } } }
      options.onWorkcell?.(view)
    }
    replaceView()
    const host = { options, state, get viewers() { return viewers }, get disposed() { return disposed },
      snapshot: () => ({ sessionId, sessionFile, messages, busy }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, getWorkcell: () => view,
      prompt: (value, requestId) => { if (requests.has(requestId)) return { accepted: true, duplicate: true }; requests.set(requestId, value); messages.push({ id: requestId, role: 'user', text: value }); busy = true; emit(); return { accepted: true } },
      cancel: async () => { busy = false; calls.cancel = (calls.cancel || 0) + 1; emit() },
      createSession: async () => { sessionId = randomUUID(); sessionFile = path.join(sessionRoot, `${sessionId}.jsonl`); messages = calls.newMessage ? [{ id: 'new', role: 'assistant', text: calls.newMessage }] : []; replaceView(); emit() },
      openSession: async (file) => { sessionFile = file; replaceView(); emit() },
      listModels: async () => [], setModel: async () => {}, inspectSetup: async () => ({ physicalReadiness: 'unverified', physicalExecutionAuthorized: false }),
      dispose: async () => { disposed = true }, emit }
    created.push(host); return host
  }
  const probeNode = async () => { calls.probe++; if (calls.failProbe) throw new Error('fixture service unavailable'); return { authenticated: true, nodeId: calls.nodeId || 'fixture-node', observation: { discovery: { observedAt: new Date().toISOString(), devices: [{ detected: true }, { detected: true }] } } } }
  const attach = async (profile, options) => {
    calls.attach++; const identity = await options.probeNode({ endpoint: profile.nodeUrl, credential: await options.credentialResolver() })
    return { endpoint: profile.nodeUrl, identity, close: async () => { calls.close++; if (calls.failClose) throw Object.assign(new Error('Shutdown not confirmed; retry.'), { code: 'SSH_STOP_UNCONFIRMED' }) }, onDisconnect: (fn) => { disconnects.push(fn); return () => {} } }
  }
  const options = { dataDir, catalog, hostFactory, simulationFactory: hostFactory, secretStore, probeNode, healthIntervalMs: 15,
    connections: { normalizeLocalEndpoint, attachLocal: attach, attachSSH: attach },
    providerCommands: { list: async () => [], login: async () => {}, logout: async () => {} }, ...overrides }
  app = await createApplication(options)
  t.after(async () => { for (const host of created) { host.state.camera = {}; host.state.execution = {}; await host.cancel() }; calls.failClose = false; await app.close(); await catalog.close(); await rm(dataDir, { recursive: true, force: true }) })
  const create = async (name = 'Bench', type = 'local', nodeUrl = 'http://127.0.0.1:19999') => {
    await app.command('project.create', { name, connection: { type, label: 'Fixture laptop', nodeUrl } }); return scope()
  }
  const scope = () => { const s = app.snapshot(); return { projectId: s.activeProjectId, conversationId: s.activeConversationId, connectionGeneration: s.connectionGeneration } }
  const connect = async () => { await app.command('connection.saveCredential', { ...scope(), cameraToken: 'camera-secret-fixture', executionToken: 'execution-secret-fixture' }); await app.command('connection.connect', scope()); return scope() }
  return { get app() { return app }, catalog, dataDir, secrets, created, calls, disconnects, create, connect, scope, async reload() { await app.close(); await catalog.close(); catalog = await openCatalog(dataDir); app = await createApplication({ ...options, catalog }); return app } }
}

test('saved conversations use contained references and restart without connecting or replaying', async (t) => {
  const f = await fixture(t); const selected = await f.create()
  const stored = f.catalog.snapshot().conversations[0]
  assert.match(stored.sessionFile, /^harness\/harness-sessions\//)
  assert.equal(f.calls.attach, 0)
  assert.equal(f.created[0].viewers, 1)
  await f.reload()
  assert.equal(f.app.snapshot().activeConversationId, selected.conversationId)
  assert.equal(f.calls.attach, 0)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'offline')
  assert.deepEqual(f.app.snapshot().conversation.messages, [])
  assert.equal(f.created.at(-1).options.sessionFile, path.join(f.dataDir, stored.sessionFile))
  assert.ok(f.created.at(-1).options.extensionOptions.createPhysicalNodeClientImpl)
})

test('new and resumed conversations rebind exactly one Workcell viewer and reject stale cancellation', async (t) => {
  const f = await fixture(t); const old = await f.create()
  await f.app.command('conversation.create', { projectId: old.projectId, title: 'Second conversation' })
  assert.equal(f.created[0].viewers, 1)
  await assert.rejects(f.app.command('conversation.cancel', old), /conversation changed/i)
  await f.app.command('conversation.select', old)
  assert.equal(f.created[0].viewers, 1)
  assert.equal(f.app.snapshot().activeConversationId, old.conversationId)
})

test('authenticated green status clears and recovers without refreshing or retiring a proposal', async (t) => {
  const f = await fixture(t); await f.create(); const scope = await f.connect()
  assert.equal(f.app.snapshot().projects[0].connection.status, 'connected')
  assert.equal(f.app.snapshot().projects[0].connection.deviceCount, 2)
  const initialRefreshes = f.calls.refresh
  const host = f.created.at(-1)
  host.state.camera = { availability: 'available', frame: { id: 'frame' }, previewFrameId: 'frame', stopCaptureSessionId: 'capture-1' }
  f.calls.failProbe = true; await delay(50)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'reconnecting')
  assert.equal(f.app.snapshot().workcell.camera.frame, null)
  assert.equal(f.app.snapshot().activeCaptures[0].captureSessionId, 'capture-1')
  f.calls.failProbe = false; await f.app.command('connection.connect', scope)
  assert.equal(f.app.snapshot().projects[0].connection.error, null)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'connected')
  assert.equal(f.created.at(-1), host, 'recovery keeps the same capture owner')
  assert.equal(f.calls.refresh, initialRefreshes)
  assert.equal(f.app.snapshot().workcell.workflow.routeReceipt.receiptDigest, 'keep-route')
})

test('one owner per authenticated Node, including endpoint aliases', async (t) => {
  const f = await fixture(t); await f.create(); await f.connect()
  await f.create('Alias', 'local', 'http://localhost:19999')
  await f.app.command('connection.saveCredential', { ...f.scope(), cameraToken: 'fixture' })
  await assert.rejects(f.app.command('connection.connect', f.scope()), /already connected/i)
  assert.equal(f.calls.attach, 1)
  await f.create('Another endpoint', 'local', 'http://127.0.0.1:19998')
  await f.app.command('connection.saveCredential', { ...f.scope(), cameraToken: 'fixture' })
  await assert.rejects(f.app.command('connection.connect', f.scope()), /already owned/i)
  assert.equal(f.calls.close, 1, 'duplicate authenticated endpoint is cleaned up')
})

test('Stop stays independent of assistant and ordinary request busy state, ownership prevents close', async (t) => {
  const f = await fixture(t); await f.create(); const scope = await f.connect(); const host = f.created.at(-1)
  host.state.camera = { stopCaptureSessionId: 'capture-1', stopUnconfirmed: true }
  await f.app.command('conversation.send', { ...scope, text: 'Inspect this setup', requestId: 'request-1234' })
  await assert.rejects(f.app.command('connection.disconnect', scope), /Stop or resolve/)
  await assert.rejects(f.app.close(), /Stop or resolve/)
  let resolveRefresh; host.options.refreshWait = new Promise((resolve) => { resolveRefresh = resolve })
  const refresh = f.app.command('workcell.refresh', scope)
  await delay(5)
  await f.app.command('workcell.camera.stop', { ...scope, expectedCaptureSessionId: 'capture-1' })
  assert.equal(f.calls.camera.action, 'stop')
  assert.equal(f.app.snapshot().workcell.camera.status.phase, 'stopped')
  resolveRefresh(); await refresh
  assert.equal(host.disposed, false)
})

test('disconnect advances generation, rejects stale actions and keeps failed cleanup retryable', async (t) => {
  const f = await fixture(t); await f.create(); const scope = await f.connect()
  f.calls.failClose = true
  await assert.rejects(f.app.command('connection.disconnect', scope), /Shutdown not confirmed/)
  assert.equal(f.calls.close, 1)
  f.calls.failClose = false
  await f.app.command('connection.disconnect', scope)
  await assert.rejects(f.app.command('workcell.camera.start', { ...scope, candidateId: 'fixture' }), /connection changed/i)
  assert.equal(f.calls.camera, undefined)
  assert.equal(f.calls.close, 2)
})

test('Node credentials remain in the isolated secret namespace, absent from catalog and snapshot', async (t) => {
  const f = await fixture(t); await f.create(); await f.connect()
  const exposed = JSON.stringify(f.app.snapshot()) + await readFile(path.join(f.dataDir, 'catalog.json'), 'utf8')
  assert.doesNotMatch(exposed, /camera-secret-fixture|execution-secret-fixture/)
  assert.ok([...f.secrets.keys()].every((key) => /^desktop-[a-f0-9]{16}-/.test(key)))
  await assert.rejects(f.app.command('connection.saveCredential', { ...f.scope(), cameraToken: 'replacement' }), /Disconnect/)
})

test('provider question answers are exact, secrets never echoed, cancellation reaches the provider', async (t) => {
  let received, aborted = false
  const f = await fixture(t, { providerCommands: { list: async () => [], logout: async () => {}, login: async ({ interactionFactory }) => {
    const interaction = interactionFactory()
    interaction.signal.addEventListener('abort', () => { aborted = true })
    received = await interaction.prompt({ type: 'secret', message: 'API key' })
  } } })
  await f.app.command('settings.providerLogin', { providerId: 'fixture', authType: 'api_key' })
  const question = f.app.snapshot().settings.loginQuestion
  await assert.rejects(f.app.command('settings.providerAnswer', { questionId: 'expired', answer: 'hidden-secret' }), /expired/)
  await f.app.command('settings.providerAnswer', { questionId: question.id, answer: 'hidden-secret' }); await delay(10)
  assert.equal(received, 'hidden-secret')
  assert.doesNotMatch(JSON.stringify(f.app.snapshot()), /hidden-secret/)
  await f.app.command('settings.providerLogin', { providerId: 'fixture' })
  await f.app.command('settings.providerCancel'); await delay(10)
  assert.equal(aborted, true)
  assert.equal(f.app.snapshot().settings.loginPending, false)
})

test('provider browser destination survives the immediate manual-answer prompt and stays scoped to its question', async (t) => {
  for (const event of [
    { type: 'auth_url', url: 'https://provider.example/authorize?state=fixture', instructions: 'Use the fixture account.' },
    { type: 'device_code', verificationUri: 'https://provider.example/device', userCode: 'FIXTURE-CODE', instructions: 'Enter the displayed code.' },
  ]) await t.test(event.type, async (t) => {
    let received, complete, initialQuestion
    const completing = new Promise((resolve) => { complete = resolve })
    t.after(complete)
    const f = await fixture(t, { providerCommands: { list: async () => [], logout: async () => {}, login: async ({ interactionFactory }) => {
      const interaction = interactionFactory()
      interaction.notify(event)
      initialQuestion = f.app.snapshot().settings.loginQuestion
      received = await interaction.prompt({ type: 'manual_code', message: 'Complete login in your browser, or paste the authorization code / redirect URL here:' })
      await completing
    } } })
    await f.create()
    await f.app.command('settings.providerLogin', { providerId: 'fixture', authType: 'oauth' })
    const question = f.app.snapshot().settings.loginQuestion
    assert.equal(question.kind, 'manual_code')
    assert.equal(question.url, event.url || event.verificationUri)
    assert.equal(question.instructions, event.instructions)
    assert.equal(question.userCode, event.userCode || null)
    assert.notEqual(question.id, initialQuestion.id)
    assert.deepEqual(await f.app.command('settings.openAuthUrl', { questionId: question.id, url: 'https://untrusted.example' }), { url: question.url })
    await assert.rejects(f.app.command('settings.openAuthUrl', { questionId: initialQuestion.id }), /expired/)
    await f.app.command('settings.providerAnswer', { questionId: question.id, answer: 'fixture-manual-response' })
    const waiting = f.app.snapshot().settings.loginQuestion
    assert.equal(waiting.kind, 'oauth')
    assert.equal(waiting.url, question.url)
    assert.equal(f.app.snapshot().settings.loginPending, true)
    await assert.rejects(f.app.command('settings.providerAnswer', { questionId: question.id, answer: 'duplicate' }), /expired/)
    await assert.rejects(f.app.command('settings.openAuthUrl', { questionId: question.id }), /expired/)
    assert.doesNotMatch(JSON.stringify(f.app.snapshot()), /fixture-manual-response/)
    assert.doesNotMatch(await readFile(path.join(f.dataDir, 'catalog.json'), 'utf8'), /fixture-manual-response|provider\.example/)
    complete(); await delay(10)
    assert.equal(received, 'fixture-manual-response')
    assert.equal(f.app.snapshot().settings.loginQuestion, null)
    await assert.rejects(f.app.command('settings.openAuthUrl', { questionId: waiting.id }), /expired/)
  })
})

test('a later provider URL notification preserves the pending answer and its identity', async (t) => {
  let interaction, received
  const f = await fixture(t, { providerCommands: { list: async () => [], logout: async () => {}, login: async ({ interactionFactory }) => {
    interaction = interactionFactory()
    received = await interaction.prompt({ type: 'manual_code', message: 'Paste the fixture code.' })
  } } })
  await f.app.command('settings.providerLogin', { providerId: 'fixture', authType: 'oauth' })
  const before = f.app.snapshot().settings.loginQuestion
  interaction.notify({ type: 'auth_url', url: 'https://provider.example/authorize', instructions: 'Continue in the browser.' })
  const current = f.app.snapshot().settings.loginQuestion
  assert.equal(current.id, before.id)
  assert.equal(current.kind, 'manual_code')
  assert.equal(current.question, before.question)
  assert.equal((await f.app.command('settings.openAuthUrl', { questionId: current.id })).url, current.url)
  await f.app.command('settings.providerAnswer', { questionId: before.id, answer: 'fixture-answer' }); await delay(10)
  assert.equal(received, 'fixture-answer')
})

test('provider cancellation and expiry invalidate browser destinations before delayed cleanup finishes', async (t) => {
  for (const method of ['cancel', 'expire']) await t.test(method, async (t) => {
    let interaction, complete
    const completing = new Promise((resolve) => { complete = resolve })
    t.after(complete)
    const f = await fixture(t, { loginTimeoutMs: method === 'expire' ? 20 : 300_000,
      providerCommands: { list: async () => [], logout: async () => {}, login: async ({ interactionFactory }) => {
        interaction = interactionFactory()
        interaction.notify({ type: 'auth_url', url: 'https://provider.example/authorize' })
        await completing
      } } })
    await f.app.command('settings.providerLogin', { providerId: 'fixture', authType: 'oauth' })
    const question = f.app.snapshot().settings.loginQuestion
    if (method === 'cancel') await f.app.command('settings.providerCancel')
    for (let i = 0; i < 100 && !interaction.signal.aborted; i++) await delay(5)
    assert.equal(interaction.signal.aborted, true)
    assert.equal(f.app.snapshot().settings.loginPending, true, 'the provider operation still owns its cleanup')
    assert.equal(f.app.snapshot().settings.loginQuestion, null)
    await assert.rejects(f.app.command('settings.openAuthUrl', { questionId: question.id }), /expired/)
    interaction.notify({ type: 'auth_url', url: 'https://provider.example/late' })
    assert.equal(f.app.snapshot().settings.loginQuestion, null)
    complete(); await delay(10)
    assert.equal(f.app.snapshot().settings.loginPending, false)
    assert.doesNotMatch(f.app.snapshot().notice, /Provider connected/)
  })
})

test('a late health reply cannot resurrect a disconnected project or reclaim its Node', async (t) => {
  let resolveProbe, probes = 0
  const identity = { authenticated: true, nodeId: 'fixture-node' }
  const f = await fixture(t, { probeNode: async () => { if (++probes === 1) return identity; return new Promise((resolve) => { resolveProbe = resolve }) } })
  await f.create(); const scope = await f.connect()
  for (let i = 0; i < 30 && !resolveProbe; i++) await delay(5)
  assert.ok(resolveProbe)
  await f.app.command('connection.disconnect', scope)
  resolveProbe(identity); await delay(20)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'offline')
  assert.equal(f.app.snapshot().projects[0].connection.observedAt, null)
})

test('quit cannot pass an in-flight host creation and abandon its resources', async (t) => {
  const f = await fixture(t)
  let release; f.calls.hostWait = new Promise((resolve) => { release = resolve })
  const creating = f.create()
  await delay(20)
  await assert.rejects(f.app.close(), /request is still pending/)
  release(); await creating
  assert.equal(f.created.length, 1)
  await f.app.close()
  assert.equal(f.created[0].disposed, true)
})

test('opt-in launch reattachment checks authorization again and restores the last conversation without replay', async (t) => {
  const f = await fixture(t); await f.create(); await f.connect()
  await f.app.command('conversation.create', { projectId: f.scope().projectId, title: 'Last conversation' })
  const last = f.scope().conversationId
  await f.app.command('connection.setAutoConnect', { projectId: f.scope().projectId, enabled: true })
  await f.reload()
  for (let i = 0; i < 100 && f.app.snapshot().projects[0].connection.status !== 'connected'; i++) await delay(10)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'connected')
  assert.equal(f.calls.attach, 2)
  assert.equal(f.app.snapshot().activeConversationId, last)
  assert.deepEqual(f.app.snapshot().conversation.messages, [])
  assert.equal(f.calls.camera, undefined)
  assert.equal(f.calls.execution, undefined)
})

test('background health recovery exhausts a bounded retry budget and Connect recovers the same owner', async (t) => {
  const f = await fixture(t); await f.create(); const scope = await f.connect()
  const host = f.created.at(-1), attached = f.calls.attach, refreshes = f.calls.refresh
  host.state.camera = { stopCaptureSessionId: 'capture-owned', stopUnconfirmed: true }
  f.calls.failProbe = true
  const probesBeforeFailure = f.calls.probe
  for (let i = 0; i < 150 && f.app.snapshot().projects[0].connection.status !== 'offline'; i++) await delay(10)
  const failed = f.app.snapshot().projects[0].connection
  assert.equal(failed.status, 'offline', 'automatic recovery stops after its bounded retry budget')
  assert.match(failed.error, /automatic reconnect stopped.*Connect/i)
  assert.equal(f.calls.probe - probesBeforeFailure, 5, 'one failed health check and four retries')
  const exhaustedProbes = f.calls.probe
  await delay(150)
  assert.equal(f.calls.probe, exhaustedProbes, 'retry exhaustion does not keep probing in the background')
  assert.equal(f.app.snapshot().activeCaptures[0].captureSessionId, 'capture-owned')
  assert.equal(f.app.snapshot().activeCaptures[0].statusUnavailable, true)
  await assert.rejects(f.app.command('connection.connect', scope))
  assert.equal(f.app.snapshot().projects[0].connection.status, 'offline', 'a failed manual retry does not claim background recovery is still running')
  assert.match(f.app.snapshot().projects[0].connection.error, /Choose Connect to retry/i)
  f.calls.failProbe = false
  await f.app.command('connection.connect', scope)
  assert.equal(f.app.snapshot().projects[0].connection.status, 'connected')
  assert.equal(f.app.snapshot().projects[0].connection.error, null)
  assert.equal(f.created.at(-1), host, 'manual recovery retains the exact controller')
  assert.equal(f.app.snapshot().connectionGeneration, scope.connectionGeneration)
  assert.equal(f.calls.attach, attached, 'recovery reuses the same endpoint')
  assert.equal(f.calls.refresh, refreshes, 'recovery does not retire the proposal')
  assert.equal(f.calls.camera, undefined, 'recovery never starts or stops capture implicitly')
})

test('launch reattaches only the selected opted-in project and leaves other saved projects offline', async (t) => {
  const f = await fixture(t); const inactive = await f.create('Inactive project')
  await f.app.command('connection.setAutoConnect', { projectId: inactive.projectId, enabled: true })
  const selected = await f.create('Selected project', 'local', 'http://127.0.0.1:19998')
  await f.app.command('connection.setAutoConnect', { projectId: selected.projectId, enabled: true })
  await f.reload()
  for (let i = 0; i < 100 && f.app.snapshot().projects.find((p) => p.id === selected.projectId).connection.status !== 'connected'; i++) await delay(10)
  const snapshot = f.app.snapshot()
  assert.equal(snapshot.projects.find((p) => p.id === inactive.projectId).connection.status, 'offline')
  assert.equal(snapshot.projects.find((p) => p.id === selected.projectId).connection.status, 'connected')
  assert.equal(f.calls.attach, 1, 'inactive profiles are never attached during startup')
  assert.equal(snapshot.activeConversationId, selected.conversationId)
  assert.deepEqual(snapshot.conversation.messages, [])
  assert.equal(f.calls.camera, undefined)
  assert.equal(f.calls.execution, undefined)
})

test('conversation transitions never label a new transcript with the previous conversation identity', async (t) => {
  const f = await fixture(t); const old = await f.create()
  const seen = []; f.app.subscribe((value) => { seen.push(value) })
  f.calls.newMessage = 'New session only'
  await f.app.command('conversation.create', { projectId: old.projectId, title: 'Second conversation' })
  assert.notEqual(f.scope().conversationId, old.conversationId)
  assert.equal(f.app.snapshot().conversation.messages[0].text, 'New session only')
  for (const snapshot of seen.filter((value) => value.activeConversationId === old.conversationId)) {
    assert.ok(!snapshot.conversation.messages.some((message) => message.text === 'New session only'))
  }
})
