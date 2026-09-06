import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHarnessHost, projectHarnessTranscript } from '../src/harness/application-host.js'
import { PHYSICAL_HARNESS_TOOL_ALLOWLIST } from '../src/chat/pi-session.js'
import * as actualSdk from '@tinyedge/pi-runtime'

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'physicalsystems-app-host-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const secretStore = { kind: 'memory', async read() { return null }, async write() {}, async delete() {} }
  return { cwd, config: { configDir: path.join(cwd, 'config') }, secretStore, env: {} }
}

function fakeSdk({ model = { provider: 'fake', id: 'model', name: 'Fake model' }, pendingPrompt = false, preflight, failReplacement = false } = {}) {
  const calls = { prompts: [], tools: [], events: [] }
  let extensionOptions
  let controllerState = { sessionId: 'workcell-fixture', camera: {}, execution: { runs: [] } }
  const controller = { snapshot: () => controllerState, subscribe() { return () => {} }, agentSettled() { calls.agentSettled = (calls.agentSettled || 0) + 1 },
    async ask(value) { calls.questions ||= []; calls.questions.push(value); return 'fixture answer' } }
  const extension = (options) => {
    extensionOptions = options
    options.onSetupInspector?.(async () => { calls.setupReads = (calls.setupReads || 0) + 1; return { physicalExecutionAuthorized: false } })
    return () => {}
  }
  const runtimeModel = {
    async getAvailable() { return model ? [model] : [] },
    getModel(provider, id) { return model?.provider === provider && model.id === id ? model : undefined },
  }
  const sdk = {
    SessionManager: actualSdk.SessionManager, loadSkillsFromDir: actualSdk.loadSkillsFromDir,
    ModelRuntime: { async create(options) { calls.modelOptions = options; return runtimeModel } },
    async createAgentSessionServices(options) {
      calls.serviceCreations = (calls.serviceCreations || 0) + 1
      if (failReplacement && calls.serviceCreations > 1) throw new Error('Synthetic replacement failure')
      calls.resourceOptions = options.resourceLoaderOptions
      return { cwd: options.cwd, agentDir: options.agentDir, diagnostics: [], resourceLoader: { getExtensions: () => ({ errors: [] }) } }
    },
    async createAgentSessionFromServices(options) {
      calls.tools.push(options.tools)
      const listeners = new Set()
      let release
      const session = {
        sessionManager: options.sessionManager, model, messages: [],
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async bindExtensions(bindings) { calls.bindings = bindings; extensionOptions.onWorkcell(controller) },
        async prompt(text, promptOptions) {
          calls.prompts.push({ text, options: promptOptions })
          if (preflight) await preflight
          promptOptions.preflightResult?.(true)
          calls.agentStarts = (calls.agentStarts || 0) + 1
          session.sessionManager.appendMessage({ role: 'user', content: text, timestamp: Date.now() })
          if (pendingPrompt) await new Promise((resolve) => { release = resolve })
          const response = { role: 'assistant', content: [{ type: 'text', text: 'Fixture answer' },
            { type: 'thinking', thinking: 'private fixture reasoning' }], timestamp: Date.now(), stopReason: 'stop' }
          for (const listener of listeners) listener({ type: 'message_update', message: response })
          for (const listener of listeners) listener({ type: 'message_end', message: response })
          // The actual pinned SDK emits message_end before its persistence step.
          session.sessionManager.appendMessage(response)
        },
        async abort() { calls.aborts = (calls.aborts || 0) + 1; release?.() },
        async setModel(value) { session.model = value },
      }
      return { session }
    },
    async createAgentSessionRuntime(factory, options) {
      const initial = await factory(options)
      let rebind
      const runtime = { ...initial,
        setRebindSession(fn) { rebind = fn },
        async newSession() {
          const result = await factory({ ...options, sessionManager: sdk.SessionManager.create(options.cwd, options.sessionManager.getSessionDir()) })
          runtime.session = result.session; await rebind(runtime.session)
          return { cancelled: false }
        },
        async switchSession(file) {
          const result = await factory({ ...options, sessionManager: sdk.SessionManager.open(file, options.sessionManager.getSessionDir(), options.cwd) })
          runtime.session = result.session; await rebind(runtime.session)
          return { cancelled: false }
        },
        async dispose() { calls.disposed = true; extensionOptions.onWorkcell(null) },
      }
      return runtime
    },
  }
  return { sdk, calls, extension, controller, setControllerState(value) { controllerState = value } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('desktop host shares the reviewed allowlist, isolates resources and persists an empty conversation', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk()
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  assert.deepEqual(fake.calls.tools, [[...PHYSICAL_HARNESS_TOOL_ALLOWLIST]])
  for (const key of ['noExtensions', 'noSkills', 'noPromptTemplates', 'noThemes', 'noContextFiles']) assert.equal(fake.calls.resourceOptions[key], true)
  assert.equal(fake.calls.modelOptions.allowModelNetwork, false)
  assert.equal(fake.calls.modelOptions.refreshOnCreate, false)
  assert.equal(fake.calls.modelOptions.modelsPath, null)
  assert.match(fake.calls.resourceOptions.systemPrompt, /Basic camera preview does not require commissioning/)
  assert.match(fake.calls.resourceOptions.systemPrompt, /Map every \/workcell reference above or in a bundled Agent Skill to the Devices panel/)
  assert.match(fake.calls.resourceOptions.systemPrompt, /Provider sign-in and model selection are in Model & app settings/)
  assert.match(fake.calls.resourceOptions.systemPrompt, /Cancel response cancels the assistant only/)
  assert.match(fake.calls.resourceOptions.systemPrompt, /explicit approval of the exact unexpired invocation/)
  assert.equal(fake.calls.bindings.mode, 'rpc')
  assert.equal(await fake.calls.bindings.uiContext.confirm('Approve physical run'), false)
  assert.equal(await fake.calls.bindings.uiContext.select('Which tray?', ['Left', 'Right']), 'fixture answer')
  assert.deepEqual(fake.calls.questions[0], { kind: 'select', question: 'Which tray?', options: ['Left', 'Right'], signal: undefined })
  assert.equal(host.getWorkcell(), fake.controller)
  const state = host.snapshot()
  assert.equal(state.messages.length, 0)
  assert.equal((await host.listSessions()).length, 1)
  assert.equal(JSON.parse((await readFile(state.sessionFile, 'utf8')).split('\n')[0]).id, state.sessionId)
  assert.equal(fake.calls.prompts.length, 0)
  assert.equal(fake.calls.setupReads, undefined)
  assert.deepEqual(await host.inspectSetup(), { physicalExecutionAuthorized: false })
  assert.equal(fake.calls.setupReads, 1)
})

test('desktop prompt reserves the same session, rejects busy conflicts and deduplicates before and after completion', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk({ pendingPrompt: true })
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  const observed = []
  host.subscribe((event) => observed.push(event))
  assert.deepEqual(host.prompt('Inspect the workcell', 'request_123'), { accepted: true, duplicate: false, requestId: 'request_123' })
  assert.equal(host.snapshot().busy, true)
  assert.equal(host.prompt('Inspect the workcell', 'request_123').duplicate, true)
  assert.throws(() => host.prompt('Different message', 'request_123'), { code: 'ERR_HARNESS_REQUEST_CONFLICT' })
  assert.throws(() => host.prompt('Concurrent message', 'request_456'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  await assert.rejects(host.createSession(), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  await host.cancel()
  await settle()
  assert.equal(host.snapshot().busy, false)
  assert.equal(host.prompt('Inspect the workcell', 'request_123').duplicate, true)
  assert.equal(fake.calls.prompts.length, 1)
  assert.equal(fake.calls.prompts[0].options.expandPromptTemplates, false)
  assert.equal(fake.calls.prompts[0].options.source, 'interactive')
  assert.deepEqual(host.snapshot().messages.map((message) => message.role), ['user', 'assistant'])
  assert.ok(observed.some((event) => event.type === 'message_update'))
  assert.equal(observed.find((event) => event.type === 'message_end').snapshot.messages.at(-1).text, 'Fixture answer')
  assert.doesNotMatch(JSON.stringify(observed), /private fixture reasoning/)
  assert.throws(() => host.prompt('/workcell', 'request_789'), /without terminal commands/)
})

test('Cancel during preflight prevents a later agent turn and keeps the request reserved until it settles', async (t) => {
  const options = await fixture(t)
  let release
  const preflight = new Promise((resolve) => { release = resolve })
  const fake = fakeSdk({ preflight })
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  host.prompt('Inspect after authentication', 'request_preflight')
  await host.cancel()
  assert.equal(host.snapshot().busy, true)
  assert.match(host.snapshot().error, /Cancellation requested/)
  assert.throws(() => host.prompt('Competing request', 'request_competing'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  release(); await settle()
  assert.equal(host.snapshot().busy, false)
  assert.equal(host.snapshot().error, null)
  assert.equal(fake.calls.agentStarts, undefined)
  assert.equal(fake.calls.agentSettled, 1)
  assert.deepEqual(host.snapshot().messages, [])
})

test('a failed replacement remains renderable while requests require recovery', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk({ failReplacement: true })
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  await assert.rejects(host.createSession(), /Synthetic replacement failure/)
  assert.equal(host.snapshot().failed, true)
  assert.match(host.snapshot().error, /Disconnect, then connect this project again/)
  assert.equal(host.getWorkcell(), fake.controller)
  assert.throws(() => host.prompt('Do not run', 'request_failed'), {
    code: 'ERR_HARNESS_SESSION_UNAVAILABLE',
    message: 'Disconnect, then connect this project again to restore its conversation.',
  })
})

test('saved conversations resume, rename and archive without losing transcript or accepting unrelated paths', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk()
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  const first = host.snapshot()
  host.prompt('Plan a tray transfer', 'request_first')
  await settle()
  await host.renameSession(first.sessionFile, 'Tray transfer')
  await host.createSession()
  assert.notEqual(host.snapshot().sessionId, first.sessionId)
  await host.openSession(first.sessionFile)
  assert.equal(host.snapshot().name, 'Tray transfer')
  assert.equal(host.snapshot().messages[0].text, 'Plan a tray transfer')
  await host.archiveSession(first.sessionFile)
  assert.equal((await host.listSessions()).length, 1)
  assert.equal((await host.listSessions({ includeArchived: true })).length, 2)
  await host.archiveSession(first.sessionFile, false)
  assert.equal((await host.listSessions()).length, 2)
  const outside = path.join(options.cwd, 'unrelated.jsonl')
  await writeFile(outside, 'unrelated')
  assert.throws(() => host.openSession(outside), /saved Harness sessions/)
  const link = path.join(path.dirname(first.sessionFile), 'linked.jsonl')
  await symlink(outside, link)
  assert.throws(() => host.openSession(link), /regular file/)
  assert.equal(await readFile(outside, 'utf8'), 'unrelated')
  for (const content of ['', JSON.stringify({ type: 'session', version: 1, id: 'legacy', cwd: options.cwd }) + '\n',
    JSON.stringify({ type: 'session', version: 3, id: 'other-project', cwd: path.join(options.cwd, 'other') }) + '\n']) {
    const rejected = path.join(path.dirname(first.sessionFile), 'rejected.jsonl')
    await writeFile(rejected, content)
    assert.throws(() => host.openSession(rejected), /header is invalid|belonging to this project/)
    assert.equal(await readFile(rejected, 'utf8'), content)
  }
})

test('camera and unresolved run ownership prevents conversation replacement while assistant Cancel stays independent', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk()
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  for (const state of [
    { camera: { stopUnconfirmed: true }, execution: { runs: [] } },
    { camera: { stopCaptureSessionId: 'owned-camera' }, execution: { runs: [] } },
    { camera: {}, execution: { runs: [{ phase: 'OUTCOME_UNKNOWN' }] } },
    { camera: {}, execution: { runs: [{ phase: 'WAITING_FOR_APPROVAL' }] } },
  ]) {
    fake.setControllerState(state)
    await assert.rejects(host.createSession(), { code: 'ERR_HARNESS_OPERATION_ACTIVE' })
    await host.cancel()
    assert.deepEqual(fake.controller.snapshot(), state)
  }
  fake.setControllerState({ camera: { status: { captureSessionId: 'stopped-camera', phase: 'stopped' } },
    execution: { runs: [{ phase: 'VERIFIED_SUCCESS' }] } })
  await host.createSession()
})

test('desktop model setup has an actionable missing-model error and only catalog-selected models', async (t) => {
  const options = await fixture(t)
  const fake = fakeSdk({ model: null })
  const host = await createHarnessHost({ ...options, sdk: fake.sdk, createExtension: fake.extension })
  t.after(() => host.dispose())
  assert.throws(() => host.prompt('Hello', 'request_no_model'), { code: 'ERR_HARNESS_MODEL_UNAVAILABLE' })
  assert.deepEqual(await host.listModels(), [])
  await assert.rejects(host.setModel('unknown', 'invented'), /current provider catalog/)
  assert.equal(fake.calls.prompts.length, 0)
})

test('transcript projection retains the full branch while excluding raw tool results, media and private metadata', () => {
  const messages = [
    { role: 'user', content: 'Inspect this' },
    { role: 'assistant', content: [{ type: 'text', text: 'Ready to inspect' }, { type: 'thinking', thinking: 'private' }, { type: 'image', data: 'camera-bytes' }] },
    { role: 'toolResult', toolName: 'inspect_physical_setup', content: [{ type: 'text', text: 'credential fixture' }], details: { displaySummary: 'Setup inspected', secret: 'secret fixture' } },
  ]
  const session = { sessionManager: { getBranch: () => messages.map((message, i) => ({ id: `entry-${i}`, type: 'message', message })) } }
  const projected = projectHarnessTranscript(session)
  assert.equal(projected.length, 3)
  assert.equal(projected[2].text, 'Setup inspected')
  assert.doesNotMatch(JSON.stringify(projected), /private|camera-bytes|credential fixture|secret fixture/)
})

test('actual reviewed Pi SDK creates and resumes a headless host offline with inert physical clients', async (t) => {
  const options = await fixture(t)
  let physicalReads = 0
  const noRead = async () => { physicalReads += 1; throw new Error('No physical access is allowed in this test') }
  const extensionOptions = {
    createPhysicalNodeClientImpl: () => ({ origin: 'http://127.0.0.1:39199', inspect: noRead }),
    createCameraPreviewClientImpl: () => ({ status: noRead, frame: noRead, start: noRead, stop: noRead }),
    createExecutionClientImpl: () => ({ status: noRead, runs: noRead }),
  }
  const host = await createHarnessHost({ ...options, sdk: actualSdk, extensionOptions })
  try {
    const first = host.snapshot()
    assert.ok(host.getWorkcell())
    assert.equal(host.getWorkcell().snapshot().camera.availability, 'unchecked')
    await host.renameSession(first.sessionFile, 'Offline actual SDK')
    await host.createSession()
    await host.openSession(first.sessionFile)
    assert.equal(host.snapshot().name, 'Offline actual SDK')
    assert.equal(host.snapshot().sessionId, first.sessionId)
    assert.equal(physicalReads, 0)
  } finally { await host.dispose() }
})
