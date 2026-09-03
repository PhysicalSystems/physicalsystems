import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createMemorySecretStore } from '../src/auth/secret-store.js'
import { loadCuratedAgentSkills, READ_AGENT_SKILL_TOOL } from '../src/harness/agent-skills.js'
import { PHYSICAL_HARNESS_TOOL_ALLOWLIST } from '../src/chat/pi-session.js'
import { installSessionPromptGate } from '../src/harness/session-prompt-gate.js'
import {
  compactTinyEdgeHistory,
  createTinyEdgePiExtension,
  isFreshBenchmarkRequest,
} from '../src/pi-extension.js'

const { loadSkillsFromDir } = await import(new URL('./core/skills.js', import.meta.resolve('@tinyedge/pi-runtime')))

function fakePi() {
  return {
    commands: new Map(),
    handlers: new Map(),
    tools: new Map(),
    activeTools: [],
    registerCommand(name, command) { this.commands.set(name, command) },
    registerTool(tool) { this.tools.set(tool.name, tool) },
    on(name, handler) { this.handlers.set(name, handler) },
    getActiveTools() { return [...this.activeTools] },
    setActiveTools(names) { this.activeTools = [...names] },
  }
}

function fakeContext(messages) {
  return {
    mode: 'tui',
    model: { provider: 'test', id: 'model' },
    ui: {
      notify(message, level) { messages.push({ message, level }) },
      setHeader() {},
    },
  }
}

test('existing Pi extension registers commands and scope-bound TinyEdge tools', async () => {
  const pi = fakePi()
  const messages = []
  let saved = null
  let loginScopesSeen
  const extension = createTinyEdgePiExtension({
    platform: 'win32',
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return saved ? { connected: true, scope: saved.scope.split(' ') } : { connected: false } },
      async load() { return saved }, async save(value) { saved = value }, async clear() { saved = null },
    }),
    loginImpl: async ({ config, tokenStore }) => {
      loginScopesSeen = config.scopes
      await tokenStore.save({ accessToken: 'opaque', resource: config.mcpUrl, scope: config.scopes.join(' ') })
    },
    logoutImpl: async ({ tokenStore }) => tokenStore.clear(),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() { return [{ name: 'list_tasks' }, { name: 'run_benchmark' }] },
        async callTool() { return { structuredContent: {} } },
      },
    }),
    createToolsImpl: ({ allowedTools }) => allowedTools
      .filter((name) => name === 'list_tasks' || name === 'run_benchmark')
      .map((name) => ({ name })),
    defineToolImpl: (value) => value,
  })

  extension(pi)
  assert.deepEqual([...pi.commands.keys()], [
    'tinyedge-login', 'tinyedge-status', 'tinyedge-tools', 'tinyedge-logout',
  ])
  await pi.commands.get('tinyedge-login').handler('--allow-run', fakeContext(messages))
  assert.deepEqual(loginScopesSeen, ['tinyedge:read', 'tinyedge:run'])
  assert.deepEqual([...pi.tools.keys()], ['ask_choice', 'list_tasks', 'run_benchmark'])
  assert.match(messages.at(-1).message, /2 tools available/)

  await pi.commands.get('tinyedge-logout').handler('', fakeContext(messages))
  assert.equal((await pi.commands.get('tinyedge-status').handler('', fakeContext(messages))), undefined)
  assert.match(messages.at(-1).message, /not connected/)
})

test('existing Pi extension uses the Pi-compatible identity tool definition by default', async () => {
  const pi = fakePi()
  const messages = []
  createTinyEdgePiExtension({
    platform: 'win32',
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return { connected: true, scope: ['tinyedge:read'] } },
    }),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() { return [{ name: 'list_devices' }] },
        async callTool() { return { structuredContent: { devices: [] } } },
      },
    }),
    createToolsImpl: ({ sdk }) => [sdk.defineTool({ name: 'list_devices' })],
  })(pi)

  await pi.handlers.get('session_start')({}, fakeContext(messages))
  assert.deepEqual([...pi.tools.keys()], ['ask_choice', 'list_devices'])
})

test('standalone Harness is local-only and blocks shell and unreviewed tools', async () => {
  const pi = fakePi()
  createTinyEdgePiExtension({
    standalone: true,
    createConfigImpl: () => { throw new Error('standalone Harness must not load cloud config') },
    createSecretStoreImpl: () => { throw new Error('standalone Harness must not load cloud credentials') },
    createTokenStoreImpl: () => { throw new Error('standalone Harness must not load cloud tokens') },
    defineToolImpl: (value) => value,
  })(pi)

  assert.deepEqual([...pi.commands.keys()], ['workcell', 'physical'])
  assert.deepEqual([...pi.tools.keys()], [
    'ask_choice', 'inspect_physical_system', 'inspect_physical_capabilities',
    'preview_physical_capability', 'plan_physical_workflow',
  ])
  assert.equal(pi.tools.has(READ_AGENT_SKILL_TOOL), false)

  assert.deepEqual(await pi.handlers.get('user_bash')({ command: 'whoami' }), {
    result: {
      output: 'Shell access is disabled in Physical Systems Harness.',
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  })
  assert.deepEqual(await pi.handlers.get('tool_call')({ toolName: 'bash' }), {
    block: true,
    reason: 'Only reviewed Physical Systems tools are available in this Harness.',
  })
})

test('reviewed Agent Skill reader is registered only with bundled registry and cannot expand the Harness ceiling', async () => {
  const pi = fakePi()
  const messages = []
  const registry = loadCuratedAgentSkills({ loadSkillsFromDir })
  createTinyEdgePiExtension({
    standalone: true,
    agentSkillRegistry: registry,
    createPhysicalNodeClientImpl: () => ({
      origin: 'http://127.0.0.1:8876',
      async inspect() { throw new Error('No physical node configured') },
    }),
  })(pi)
  await pi.handlers.get('session_start')({}, fakeContext(messages))
  assert.deepEqual([...pi.tools.keys()].sort(), [...PHYSICAL_HARNESS_TOOL_ALLOWLIST].sort())
  assert.deepEqual(pi.activeTools.slice().sort(), [...PHYSICAL_HARNESS_TOOL_ALLOWLIST].sort())
  assert.equal(pi.handlers.get('tool_call')({ toolName: READ_AGENT_SKILL_TOOL }), undefined)
  const before = [...pi.activeTools]
  const read = await pi.tools.get(READ_AGENT_SKILL_TOOL).execute('read', { skillId: 'transfer-container' })
  assert.equal(JSON.parse(read.content[0].text).physicalExecutionAuthorized, false)
  assert.deepEqual(pi.activeTools, before)
  for (const toolName of ['bash', 'read', 'write', 'execute_physical_capability', 'install_adapter']) {
    assert.equal(pi.tools.has(toolName), false)
    assert.equal(pi.handlers.get('tool_call')({ toolName }).block, true)
  }
  await assert.rejects(pi.tools.get(READ_AGENT_SKILL_TOOL).execute('bad', {
    skillId: 'transfer-container', path: '/etc/passwd',
  }), /expected only an exact skillId/)
})

test('ordinary new user intent clears an earlier route preview before the agent starts', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url), 'utf8'))
  const pi = fakePi()
  const widgets = new Map()
  const ctx = {
    ...fakeContext([]),
    ui: { ...fakeContext([]).ui, setWidget(name, factory) { widgets.set(name, factory) } },
  }
  createTinyEdgePiExtension({
    standalone: true,
    createPhysicalNodeClientImpl: () => ({
      origin: 'http://127.0.0.1:8876',
      async previewCapability() { return fixture.selected },
    }),
  })(pi)
  await pi.handlers.get('session_start')({}, ctx)
  const { contractVersion: _version, ...params } = fixture.request
  await pi.tools.get('preview_physical_capability').execute('old', params)
  const render = () => widgets.get('tinyedge-physical-workflow')(null, { fg: (_name, text) => text }).render(500).join('\n')
  assert.match(render(), /implementation selected/)
  await pi.handlers.get('before_agent_start')({ prompt: 'Now move a different container to the other station.' }, ctx)
  assert.doesNotMatch(render(), /implementation selected|Route receipt ·/)
  assert.match(render(), /— Run/)
  assert.match(render(), /— Verify/)
})

function createWorkcellFixture(t, overrides = {}) {
  const pi = fakePi()
  const messages = []
  const widgets = new Map()
  const calls = { created: 0, closed: 0, opened: [], intents: [], cameraClients: 0, frames: 0, starts: [], stops: [], inspected: 0, catalogs: 0 }
  const routeFixture = JSON.parse(readFileSync(new URL('./fixtures/physical-route-v1.json', import.meta.url), 'utf8'))
  const snapshot = {
    nodeName: 'test-node', physicalExecutionAuthorized: false,
    discovery: { devices: [], summary: { configured: 0, detected: 0, driverReady: 0, calibrationReady: 0, ready: 0, allReady: false } },
    discoveryBindingDigest: `sha256:${'a'.repeat(64)}`,
  }
  let host
  let cameraStatus = { phase: 'idle', captureSessionId: null }
  const ctx = {
    ...fakeContext(messages), isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      ...fakeContext(messages).ui,
      setWidget(name, factory) { widgets.set(name, factory) },
      async select() { return 'Terminal answer' },
    },
  }
  createTinyEdgePiExtension({
    standalone: true,
    createPhysicalNodeClientImpl: () => ({
      origin: 'http://127.0.0.1:8876',
      async inspect() { calls.inspected += 1; return snapshot },
      async capabilities() { calls.catalogs += 1; return routeFixture.catalog },
      async interpret() { throw new Error('Workcell input must not call a separate interpretation helper') },
    }),
    submitWorkcellIntent: async (text) => { calls.intents.push(text) },
    canSubmitWorkcellIntent: () => true,
    createWorkcellServerImpl: async (options) => {
      host = options.host
      calls.created += 1
      return { openUrl: 'http://127.0.0.1:19876/#test-local-key', async close() { calls.closed += 1 } }
    },
    createCameraPreviewClientImpl: () => {
      calls.cameraClients += 1
      return {
        async frame() { calls.frames += 1; return { status: cameraStatus, frame: null } },
        async start(body) { calls.starts.push(body); cameraStatus = { phase: 'live', captureSessionId: 'test-capture' }; return cameraStatus },
        async stop(body) { calls.stops.push(body); cameraStatus = { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId }; return cameraStatus },
      }
    },
    openWorkcellBrowser: (url) => { calls.opened.push(url) },
    ...overrides,
  })(pi)
  t.after(() => pi.handlers.get('session_shutdown')?.())
  return { pi, ctx, calls, messages, widgets, snapshot, routeFixture, host: () => host }
}

const workcellTick = () => new Promise((resolve) => setImmediate(resolve))

test('workcell view is explicitly opt-in and does not add camera or generic execution tools', async (t) => {
  const { pi, ctx, calls, messages, host } = createWorkcellFixture(t)
  await pi.handlers.get('session_start')({}, ctx)
  assert.equal(calls.created, 0)
  assert.equal(calls.cameraClients, 0)
  assert.equal(calls.frames, 0)
  assert.deepEqual(calls.opened, [])
  const beforeTools = [...pi.tools.keys()]
  await pi.commands.get('workcell').handler('start-camera', ctx)
  assert.match(messages.at(-1).message, /Usage: \/workcell/)
  assert.equal(calls.created, 0)
  await pi.commands.get('workcell').handler('', ctx)
  assert.equal(calls.created, 1)
  assert.equal(calls.cameraClients, 1)
  assert.equal(calls.frames, 0, 'creating the local view does not even read a camera before a viewer attaches')
  assert.equal(calls.starts.length, 0)
  assert.deepEqual(calls.opened, ['http://127.0.0.1:19876/#test-local-key'])
  assert.deepEqual([...pi.tools.keys()], beforeTools)
  for (const name of ['camera_start', 'camera_stop', 'read', 'bash', 'execute_physical_capability', 'prepare_physical_run', 'approve_physical_run', 'stop_physical_run', 'reconcile_physical_run']) {
    assert.equal(pi.tools.has(name), false)
    assert.equal(pi.handlers.get('tool_call')({ toolName: name }).block, true)
  }
  assert.equal(host().snapshot().physicalExecutionAuthorized, false)
  await pi.commands.get('workcell').handler('', ctx)
  assert.equal(calls.created, 1, 'the second open reuses the same local view')
  assert.equal(calls.opened.length, 2)
})

test('execution token is confined to the operator client and does not enter shared agent tools or view snapshots', async (t) => {
  const token = 'synthetic-execution-credential-00000000'
  let supplied, reads = 0
  const { pi, ctx, host } = createWorkcellFixture(t, { env: { PHYSICAL_NODE_EXECUTION_TOKEN: token },
    createExecutionClientImpl(options) {
      supplied = options
      return { async status() { reads += 1; return { availability: 'unavailable', mode: null, configurations: [], reason: 'No commissioned executor' } }, async runs() { return { runs: [] } } }
    } })
  await pi.handlers.get('session_start')({}, ctx)
  assert.equal(supplied, undefined)
  await pi.commands.get('workcell').handler('', ctx)
  assert.equal(supplied.token, token)
  assert.equal(reads, 0)
  await host().executionAction('refresh', {})
  assert.equal(reads, 1)
  assert.equal(JSON.stringify(host().snapshot()).includes(token), false)
  assert.equal(host().snapshot().execution.canPrepare, false)
  assert.equal(host().snapshot().execution.status.reason, 'No commissioned executor')
  for (const tool of pi.tools.values()) assert.equal(JSON.stringify(tool).includes(token), false)
})

test('browser intent dispatches through the existing Harness host and Pi events update its attached view', async (t) => {
  const { pi, ctx, calls, host } = createWorkcellFixture(t)
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  const close = controller.onViewerConnect()
  await controller.submitIntent('Inspect the devices on this workcell')
  await workcellTick()
  assert.deepEqual(calls.intents, ['Inspect the devices on this workcell'])
  assert.equal(calls.inspected, 0, 'the browser does not run a second deterministic planner directly')
  assert.equal(calls.catalogs, 0)
  assert.equal(controller.snapshot().agent.status, 'working')
  await pi.handlers.get('before_agent_start')({ prompt: calls.intents[0] }, ctx)
  await pi.handlers.get('message_update')({ message: {
    role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'I will inspect the attached devices.' }],
  } })
  await pi.handlers.get('tool_execution_start')({ toolName: 'inspect_physical_system', args: { token: 'PRIVATE_ARGUMENT' } })
  assert.equal(controller.snapshot().agent.tool, 'inspect_physical_system')
  await pi.tools.get('inspect_physical_system').execute('inspect-one', {})
  assert.equal(calls.inspected, 1)
  assert.equal(controller.snapshot().workflow.snapshot.nodeName, 'test-node')
  await pi.handlers.get('tool_execution_end')({ toolName: 'inspect_physical_system', result: { secret: 'PRIVATE_RESULT' } })
  await pi.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'The inspected state is displayed.' }] } })
  assert.equal(controller.snapshot().agent.reply, 'The inspected state is displayed.')
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE_/)
  assert.equal(controller.snapshot().agent.status, 'working')
  await pi.handlers.get('agent_settled')()
  assert.equal(controller.snapshot().agent.status, 'idle')
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
  close()
})

test('the single ask_choice tool uses browser selectors only for a browser-owned turn', async (t) => {
  const { pi, ctx, host } = createWorkcellFixture(t)
  let terminalSelections = 0
  ctx.ui.select = async () => { terminalSelections += 1; return 'Inspect' }
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  const close = controller.onViewerConnect()
  const params = { question: 'What should happen next?', options: ['Inspect', 'Stop'] }
  const terminal = await pi.tools.get('ask_choice').execute('terminal-question', params, undefined, undefined, ctx)
  assert.equal(JSON.parse(terminal.content[0].text).selected, 'Inspect')
  assert.equal(terminalSelections, 1)
  await controller.submitIntent('Help me inspect this workcell')
  const browser = pi.tools.get('ask_choice').execute('browser-question', params, undefined, undefined, ctx)
  const pending = controller.snapshot().agent.pendingChoice
  assert.deepEqual(pending.options, ['Inspect', 'Stop', 'Type a different answer'])
  await controller.answerChoice({ choiceId: pending.choiceId, answer: 'Stop' })
  assert.deepEqual(JSON.parse((await browser).content[0].text), { question: params.question, selected: 'Stop', custom: false })
  assert.equal(terminalSelections, 1, 'the browser question did not open a competing terminal selector')
  await pi.handlers.get('agent_settled')()
  await pi.tools.get('ask_choice').execute('terminal-again', params, undefined, undefined, ctx)
  assert.equal(terminalSelections, 2)
  close()
})

test('browser ask_choice custom-answer path remains the existing tool result and abort cancels it', async (t) => {
  const { pi, ctx, host } = createWorkcellFixture(t)
  ctx.ui.select = async () => { throw new Error('Browser-owned questions must not use terminal selection') }
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  const close = controller.onViewerConnect()
  await controller.submitIntent('Ask me which station to inspect')
  const params = { question: 'Which station?', options: ['Source', 'Destination'] }
  const custom = pi.tools.get('ask_choice').execute('custom-question', params, undefined, undefined, ctx)
  await controller.answerChoice({ choiceId: controller.snapshot().agent.pendingChoice.choiceId, answer: 'Type a different answer' })
  await workcellTick()
  const input = controller.snapshot().agent.pendingChoice
  assert.equal(input.kind, 'input')
  await controller.answerChoice({ choiceId: input.choiceId, answer: 'Processing station' })
  assert.deepEqual(JSON.parse((await custom).content[0].text), { question: params.question, selected: 'Processing station', custom: true })
  const abort = new AbortController()
  const cancelled = pi.tools.get('ask_choice').execute('abort-question', params, abort.signal, undefined, ctx)
  abort.abort()
  assert.equal(JSON.parse((await cancelled).content[0].text).cancelled, true)
  close()
})

test('disconnect and session shutdown cancel active browser questions and never reopen a disposed view', async (t) => {
  const { pi, ctx, calls, host } = createWorkcellFixture(t)
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  const close = controller.onViewerConnect()
  await controller.submitIntent('Inspect with my input')
  const params = { question: 'Continue?', options: ['Continue', 'Stop'] }
  const disconnected = pi.tools.get('ask_choice').execute('disconnect', params, undefined, undefined, ctx)
  close()
  assert.equal(JSON.parse((await disconnected).content[0].text).cancelled, true)
  const reconnect = controller.onViewerConnect()
  const shutdown = pi.tools.get('ask_choice').execute('shutdown', params, undefined, undefined, ctx)
  const oldId = controller.snapshot().agent.pendingChoice.choiceId
  await pi.handlers.get('session_shutdown')()
  assert.equal(JSON.parse((await shutdown).content[0].text).cancelled, true)
  await assert.rejects(controller.answerChoice({ choiceId: oldId, answer: 'Continue' }), /no longer current/)
  await assert.rejects(controller.submitIntent('Old session input'), /session ended/)
  await pi.commands.get('workcell').handler('', ctx)
  assert.equal(calls.created, 1)
  assert.equal(calls.closed, 1)
  reconnect()
})

test('model selection updates the view and busy or unconfigured Pi context cannot accept browser input', async (t) => {
  const { pi, ctx, calls, host } = createWorkcellFixture(t)
  ctx.model = null
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  assert.equal(controller.snapshot().agent.model, null)
  await assert.rejects(controller.submitIntent('Inspect the workcell'), /busy or has no model/)
  const selectedContext = { ...ctx, model: { provider: 'new-provider', id: 'new-model' }, hasPendingMessages: () => true }
  await pi.handlers.get('model_select')({}, selectedContext)
  assert.equal(controller.snapshot().agent.model, 'new-provider/new-model')
  await assert.rejects(controller.submitIntent('Inspect the workcell'), /busy or has no model/)
  selectedContext.hasPendingMessages = () => false
  selectedContext.isIdle = () => false
  await assert.rejects(controller.submitIntent('Inspect the workcell'), /busy or has no model/)
  selectedContext.isIdle = () => true
  await controller.submitIntent('Inspect the workcell')
  await workcellTick()
  assert.deepEqual(calls.intents, ['Inspect the workcell'])
})

test('workcell refresh publishes the existing discovery and capability catalog without execution authority', async (t) => {
  const { pi, ctx, calls, host, routeFixture } = createWorkcellFixture(t)
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const state = await host().refresh()
  assert.equal(calls.inspected, 1)
  assert.equal(calls.catalogs, 1)
  assert.equal(state.workflow.snapshot.nodeName, 'test-node')
  assert.deepEqual(state.workflow.capabilityCatalog, routeFixture.catalog)
  assert.equal(state.workflow.routeReceipt, null)
  assert.equal(state.physicalExecutionAuthorized, false)
  assert.equal(calls.starts.length, 0)
})

test('browser availability sees terminal preflight before Pi marks itself busy and does not reset that turn', async (t) => {
  let completeTerminal
  const terminal = new Promise((resolve) => { completeTerminal = resolve })
  const requests = []
  const session = { prompt(text) { requests.push(text); return terminal } }
  const gate = installSessionPromptGate(session)
  t.after(() => gate.restore())
  const { pi, ctx, host } = createWorkcellFixture(t, {
    submitWorkcellIntent: (text) => session.prompt(text),
    canSubmitWorkcellIntent: () => !gate.isBusy(),
  })
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const controller = host()
  const pending = session.prompt('Terminal-owned request')
  assert.equal(ctx.isIdle(), true, 'the regression is specifically before the SDK updates its streaming flag')
  const before = controller.snapshot()
  assert.equal(before.agent.canPrompt, false)
  await assert.rejects(controller.submitIntent('Competing browser request'), /busy or has no model/)
  assert.equal(controller.snapshot().revision, before.revision)
  assert.equal(controller.snapshot().workflow.generation, before.workflow.generation)
  await pi.handlers.get('before_agent_start')({ prompt: 'Terminal-owned request' }, ctx)
  await workcellTick()
  assert.equal(controller.snapshot().agent.intent, 'Terminal-owned request')
  assert.equal(controller.snapshot().agent.status, 'working', 'no browser rejection handler can make the terminal turn look idle')
  assert.deepEqual(requests, ['Terminal-owned request'])
  completeTerminal()
  await pending
  await pi.handlers.get('agent_settled')()
  assert.equal(controller.snapshot().agent.canPrompt, true)
})

test('a host without a shared-session gate availability contract cannot accept browser input', async (t) => {
  const { pi, ctx, calls, host } = createWorkcellFixture(t, { canSubmitWorkcellIntent: null })
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  const before = host().snapshot()
  assert.equal(before.agent.canPrompt, false)
  await assert.rejects(host().submitIntent('Inspect the workcell'), /busy or has no model/)
  assert.equal(host().snapshot().revision, before.revision)
  assert.equal(calls.intents.length, 0)
})

test('concurrent workcell opens create one server and shutdown during open suppresses the browser', async (t) => {
  let releaseServer
  let created = 0
  let closed = 0
  const server = new Promise((resolve) => { releaseServer = resolve })
  const { pi, ctx, calls } = createWorkcellFixture(t, { createWorkcellServerImpl: async () => { created += 1; return server } })
  await pi.handlers.get('session_start')({}, ctx)
  const first = pi.commands.get('workcell').handler('', ctx)
  const second = pi.commands.get('workcell').handler('', ctx)
  const shutdown = pi.handlers.get('session_shutdown')()
  releaseServer({ openUrl: 'http://127.0.0.1:19876/#late', async close() { closed += 1 } })
  await Promise.all([first, second, shutdown])
  assert.equal(created, 1)
  assert.equal(closed, 1)
  assert.deepEqual(calls.opened, [])
  await pi.commands.get('workcell').handler('', ctx)
  assert.equal(created, 1)
})

test('session shutdown disposes owned camera capture even if the local server close fails', async (t) => {
  let controller
  const { pi, ctx, calls } = createWorkcellFixture(t, {
    createWorkcellServerImpl: async ({ host }) => {
      controller = host
      return { openUrl: 'http://127.0.0.1:19876/#test', async close() { throw new Error('server close failure') } }
    },
  })
  await pi.handlers.get('session_start')({}, ctx)
  await pi.commands.get('workcell').handler('', ctx)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: `sha256:${'a'.repeat(64)}` })
  await assert.rejects(pi.handlers.get('session_shutdown')(), /server close failure/)
  assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'test-capture' }])
  await assert.rejects(controller.submitIntent('Late input'), /session ended/)
})

test('standalone Harness renders and drives the local physical workflow inside Pi', async () => {
  const pi = fakePi()
  const messages = []
  const widgets = new Map()
  const calls = []
  const selections = []
  const snapshot = {
    nodeName: 'ubuntu-lab',
    system: { systemId: 'cup-transfer', displayName: 'Cup transfer workcell', workcellId: 'desk-one' },
    discoveryBindingDigest: `sha256:${'c'.repeat(64)}`,
    discovery: {
      observedAt: '2026-08-31T12:00:00.000Z',
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      summary: {
        configured: 2, detected: 2, driverReady: 2, calibrationReady: 2, ready: 2, allReady: true,
      },
      devices: [
        {
          deviceId: 'overhead-camera', kind: 'camera', roles: ['observation'],
          capabilities: ['capture-frame'], configured: true, detected: true,
          driverReady: true, calibrationReady: true, ready: true,
        },
        {
          deviceId: 'so101-follower', kind: 'robot', roles: ['robot-follower'],
          capabilities: ['pick-container'], configured: true, detected: true,
          driverReady: true, calibrationReady: true, ready: true,
        },
      ],
    },
    physicalExecutionAuthorized: false,
  }
  const response = {
    interpretation: {
      status: 'needs-clarification', action: 'transfer',
      grounding: { objectId: 'cup-one', sourceStationId: 'source', destinationStationId: 'destination' },
      workflowIntent: null,
      requiredOperations: [
        { deviceRole: 'robot-follower', operationId: 'pick-container', effect: 'actuating' },
        { deviceRole: 'robot-follower', operationId: 'place-container', effect: 'actuating' },
      ],
      gaps: [{
        gapId: 'robot-manipulation-commissioning',
        kind: 'commissioning-required',
        deviceId: 'so101-follower',
        operationIds: ['pick-container', 'place-container'],
        detail: 'The selected robot requires qualified manipulation operations.',
      }],
      questions: [],
      interpretationDigest: `sha256:${'b'.repeat(64)}`, physicalExecutionAuthorized: false,
    },
    observationEvidence: { kind: 'live-camera', status: 'observed' },
    discoverySnapshotDigest: `sha256:${'d'.repeat(64)}`,
    discoveryBindingDigest: snapshot.discoveryBindingDigest,
    physicalExecutionAuthorized: false,
  }
  const physicalClient = {
    origin: 'http://127.0.0.1:8876',
    async inspect() { calls.push('inspect'); return snapshot },
    async interpret(intent, digest, inspected) {
      calls.push(['interpret', intent, digest, inspected === snapshot])
      return response
    },
  }
  createTinyEdgePiExtension({
    standalone: true,
    showHeader: true,
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({ async summary() { return { connected: false } } }),
    createPhysicalNodeClientImpl: () => physicalClient,
    defineToolImpl: (value) => value,
  })(pi)
  const ctx = {
    mode: 'tui',
    model: { provider: 'test', id: 'model' },
    ui: {
      notify(message, level) { messages.push({ message, level }) },
      setHeader() {},
      setWidget(name, factory) { widgets.set(name, factory) },
      async input() { throw new Error('input should not be requested when command has arguments') },
      async select(question, options) {
        selections.push({ question, options })
        return options[0]
      },
    },
  }

  await pi.handlers.get('session_start')({}, ctx)
  assert.deepEqual(calls, ['inspect'])
  assert.doesNotMatch(messages.map((entry) => entry.message).join('\n'), /TinyEdge account|tinyedge-login|Connect TinyEdge/i)
  assert.equal(pi.commands.has('physical'), true)
  assert.equal(pi.tools.has('inspect_physical_system'), true)
  assert.equal(pi.tools.has('plan_physical_workflow'), true)
  assert.equal(pi.activeTools.includes('plan_physical_workflow'), true)
  assert.equal(pi.handlers.get('tool_call')({ toolName: 'plan_physical_workflow' }), undefined)

  const theme = { fg: (_name, value) => value }
  let widget = widgets.get('tinyedge-physical-workflow')(null, theme).render(120).join('\n')
  assert.match(widget, /2\/2 devices ready/)
  assert.match(widget, /✓ overhead-camera/)
  assert.doesNotMatch(widget, /yellow cup|taught motion/i)

  await pi.commands.get('physical').handler(
    'Move the cup from source station to destination station.',
    ctx,
  )
  assert.deepEqual(calls, [
    'inspect',
    'inspect',
    ['interpret', 'Move the cup from source station to destination station.', snapshot.discoveryBindingDigest, true],
  ])
  widget = widgets.get('tinyedge-physical-workflow')(null, theme).render(120).join('\n')
  assert.match(widget, /✓ Intent/)
  assert.match(widget, /! Plan/)
  assert.match(widget, /◇ Commission/)
  assert.match(widget, /— Run/)
  assert.match(widget, /Resolve reported commissioning gap/)
  assert.match(widget, /local node must supply an eligible method and safe bounds/)
  assert.equal(selections.length, 1)
  assert.match(selections[0].question, /Commissioning gap reported/)
  assert.match(selections[0].options[0], /gap-bound commissioning draft/)
  assert.match(messages.at(-1).message, /No method, bounds, or motion was selected/)
})

test('cloud Pi extension gives a fresh benchmark request a deterministic question-first tool boundary', async () => {
  assert.equal(isFreshBenchmarkRequest('Can you benchmark my Basler camera on my Raspberry Pi?'), true)
  assert.equal(isFreshBenchmarkRequest('Resume my existing Basler benchmark task'), false)
  assert.equal(isFreshBenchmarkRequest('Show the results from my previous benchmark run'), false)

  const pi = fakePi()
  const messages = []
  createTinyEdgePiExtension({
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return { connected: true, scope: ['tinyedge:read'] } },
    }),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() {
          return [{ name: 'list_devices' }, { name: 'list_tasks' }, { name: 'list_models' }]
        },
        async callTool(name) {
          return { structuredContent: { [name === 'list_devices' ? 'devices' : 'items']: [] } }
        },
      },
    }),
    createToolsImpl: ({ allowedTools }) => allowedTools
      .filter((name) => ['list_devices', 'list_tasks', 'list_models'].includes(name))
      .map((name) => ({ name })),
    defineToolImpl: (value) => value,
  })(pi)

  await pi.handlers.get('session_start')({}, fakeContext(messages))
  pi.handlers.get('before_agent_start')({
    prompt: 'Can you benchmark my Basler camera on my Raspberry Pi?',
  })

  assert.equal(pi.handlers.get('tool_call')({ toolName: 'list_devices' }), undefined)
  assert.equal(pi.handlers.get('tool_call')({ toolName: 'ask_choice' }), undefined)
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_devices' }), {
    block: true,
    reason: 'The device was already checked for this request. Ask the user one concise intake question now.',
  })
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_models' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })

  assert.equal(pi.handlers.has('agent_end'), false)
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })
  pi.handlers.get('agent_settled')()
  assert.equal(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), undefined)
})

test('Harness compacts stale TinyEdge tool envelopes before restoring model context', () => {
  const oldEnvelope = {
    content: [{ type: 'text', text: '{"tasks":"duplicated"}' }],
    structuredContent: {
      tasks: [{
        id: 'task-basler',
        title: 'Basler camera benchmark',
        state: 'intake',
        requirements: {
          modelId: 'builtin-yolox-nano-416',
          notes: 'Representative workload trace not yet available.',
        },
      }],
    },
  }
  const original = {
    role: 'toolResult',
    toolCallId: 'old-list',
    toolName: 'list_tasks',
    content: [{ type: 'text', text: JSON.stringify(oldEnvelope) }],
    details: { access_token: 'details-must-not-leak' },
    isError: false,
    timestamp: 1,
  }
  const userMessage = { role: 'user', content: 'hello', timestamp: 2 }

  const compacted = compactTinyEdgeHistory([userMessage, original])
  assert.equal(compacted[0], userMessage)
  assert.notEqual(compacted[1], original)
  assert.deepEqual(JSON.parse(compacted[1].content[0].text), {
    tasks: [{ id: 'task-basler', title: 'Basler camera benchmark' }],
    total: 1,
    truncated: false,
  })
  assert.equal(compacted[1].details.displaySummary, 'Found 1 saved benchmark task')
  assert.deepEqual(compacted[1].details, { displaySummary: 'Found 1 saved benchmark task' })
  assert.doesNotMatch(compacted[1].content[0].text, /yolox|Representative workload|"state"|structuredContent/)
  assert.match(original.content[0].text, /yolox/)
})

test('Harness restores failed or malformed discovery history without leaking or crashing', () => {
  const [failed, malformed] = compactTinyEdgeHistory([
    {
      role: 'toolResult',
      toolCallId: 'failed-list',
      toolName: 'list_devices',
      content: [{ type: 'text', text: 'Bearer secret-value could not list devices' }],
      isError: true,
    },
    {
      role: 'toolResult',
      toolCallId: 'malformed-list',
      toolName: 'list_devices',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, access_token: 'must-not-leak' }) }],
      isError: false,
    },
  ])

  assert.match(failed.content[0].text, /Bearer \[REDACTED\]/)
  assert.doesNotMatch(failed.content[0].text, /secret-value/)
  assert.equal(failed.details.displaySummary, 'TinyEdge request failed')

  assert.equal(malformed.isError, true)
  assert.equal(malformed.details.displaySummary, 'Invalid TinyEdge history entry omitted')
  assert.match(malformed.content[0].text, /history entry omitted/)
  assert.doesNotMatch(malformed.content[0].text, /must-not-leak|access_token/)
})
