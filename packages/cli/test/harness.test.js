import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { PHYSICAL_HARNESS_TOOL_ALLOWLIST } from '../src/chat/pi-session.js'
import { harnessCommand } from '../src/commands/harness.js'
import { createTinyEdgeInteractiveMode } from '../src/harness/interactive-mode.js'

const { loadSkillsFromDir } = await import(new URL('./core/skills.js', import.meta.resolve('@tinyedge/pi-runtime')))
const testConfigDir = path.join(tmpdir(), 'physicalsystems-harness-unit-config')

function fakeSdk({ extensionErrors = [], disposeError, onModelRuntimeCreate, promptImpl } = {}) {
  const calls = {}
  class InteractiveMode {}
  const sdk = {
    loadSkillsFromDir,
    ModelRuntime: {
      async create(options) {
        onModelRuntimeCreate?.()
        calls.modelRuntime = options
        return { kind: 'model-runtime' }
      },
    },
    SessionManager: {
      create(cwd, sessionDir) {
        calls.sessionManager = { cwd, sessionDir }
        return { kind: 'session-manager' }
      },
    },
    async createAgentSessionServices(options) {
      calls.services = options
      return {
        diagnostics: [],
        resourceLoader: { getExtensions: () => ({ errors: extensionErrors }) },
      }
    },
    async createAgentSessionFromServices(options) {
      calls.session = options
      const session = { kind: 'session', async prompt(...args) {
        calls.prompts ||= []
        calls.prompts.push({ session: this, args })
        return promptImpl?.(...args)
      } }
      calls.sessions ||= []
      calls.sessions.push(session)
      return { session }
    },
    async createAgentSessionRuntime(factory, options) {
      calls.runtimeOptions = options
      const created = await factory({
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager: options.sessionManager,
      })
      return {
        ...created,
        async replaceSession() {
          const next = await factory({
            cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager,
            sessionStartEvent: { type: 'session_start', reason: 'new' },
          })
          this.session = next.session
          return next.session
        },
        async dispose() {
          calls.disposed = true
          if (disposeError) throw disposeError
        },
      }
    },
    InteractiveMode,
  }
  return { sdk, calls }
}

function restoreEnvironmentAfterTest(t, names) {
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test('native Harness uses Pi runtime with only reviewed TinyEdge resources and tools', async () => {
  const { sdk, calls } = fakeSdk()
  let extensionOptions
  let ran = false
  await harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { throw new Error('standalone Harness must not read cloud auth') } },
    secretStore: { read: async () => null, write: async () => {}, delete: async () => {} },
    sdk,
    cwd: 'C:\\work',
    createExtension(options) {
      extensionOptions = options
      return () => {}
    },
    createMode(runtime, options) {
      assert.equal(runtime.session.kind, 'session')
      assert.equal(options.verbose, false)
      return { async run() { ran = true } }
    },
  })

  assert.equal(ran, true)
  assert.equal(calls.disposed, true)
  assert.deepEqual(calls.session.tools, [...PHYSICAL_HARNESS_TOOL_ALLOWLIST])
  assert.deepEqual(calls.services.resourceLoaderOptions, {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: calls.services.resourceLoaderOptions.systemPrompt,
    extensionFactories: [calls.services.resourceLoaderOptions.extensionFactories[0]],
  })
  assert.match(calls.services.resourceLoaderOptions.systemPrompt, /Physical Systems Harness assistant/)
  assert.doesNotMatch(calls.services.resourceLoaderOptions.systemPrompt, /signed-in user's TinyEdge account/)
  assert.equal(extensionOptions.standalone, true)
  assert.equal(extensionOptions.cloudEnabled, false)
  assert.equal(extensionOptions.autoLogin, undefined)
  assert.equal(extensionOptions.showHeader, true)
  assert.deepEqual(extensionOptions.agentSkillRegistry.summaries.map(({ skillId }) => skillId), [
    'inspect-workcell', 'transfer-container',
  ])
  assert.match(calls.services.resourceLoaderOptions.systemPrompt, /read_agent_skill/)
  assert.match(calls.services.resourceLoaderOptions.systemPrompt, /instruction packages, not hardware capabilities/)
  assert.doesNotMatch(calls.services.resourceLoaderOptions.systemPrompt, /<location>/)
})

test('workcell callbacks use the current gated Harness session rather than creating a second agent', async () => {
  let releaseTerminal
  const terminalPreflight = new Promise((resolve) => { releaseTerminal = resolve })
  const { sdk, calls } = fakeSdk({ promptImpl: (text) => text === 'Terminal preflight' ? terminalPreflight : undefined })
  let extensionOptions
  await harnessCommand({
    config: { configDir: testConfigDir }, sdk, cwd: 'C:\\work',
    createExtension(options) {
      extensionOptions = options
      assert.equal(options.canSubmitWorkcellIntent(), false)
      assert.throws(() => options.submitWorkcellIntent('Not ready'), /not ready/)
      return () => {}
    },
    createMode(runtime) {
      return { async run() {
        assert.equal(extensionOptions.canSubmitWorkcellIntent(), true)
        const firstSession = runtime.session
        const pending = firstSession.prompt('Terminal preflight')
        assert.equal(extensionOptions.canSubmitWorkcellIntent(), false)
        await assert.rejects(extensionOptions.submitWorkcellIntent('Competing browser input'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
        assert.equal(calls.prompts.length, 1)
        releaseTerminal()
        await pending
        assert.equal(extensionOptions.canSubmitWorkcellIntent(), true)
        await extensionOptions.submitWorkcellIntent('Inspect the first workcell')
        assert.equal(calls.prompts[1].session, firstSession)
        assert.deepEqual(calls.prompts[1].args, ['Inspect the first workcell', { expandPromptTemplates: false, source: 'interactive' }])
        assert.equal(calls.sessions.length, 1)

        const nextSession = await runtime.replaceSession()
        assert.notEqual(nextSession, firstSession)
        const secondPending = nextSession.prompt('Terminal preflight')
        assert.equal(extensionOptions.canSubmitWorkcellIntent(), false, 'session replacement installs a fresh gate')
        await assert.rejects(extensionOptions.submitWorkcellIntent('Competing after replacement'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
        await secondPending
        await extensionOptions.submitWorkcellIntent('Inspect the replacement workcell')
        assert.equal(calls.prompts.at(-1).session, nextSession)
        assert.deepEqual(calls.prompts.at(-1).args, ['Inspect the replacement workcell', { expandPromptTemplates: false, source: 'interactive' }])
        assert.equal(calls.sessions.length, 2, 'only the explicit session replacement creates another session')
      } }
    },
  })
  assert.equal(calls.disposed, true)
  assert.equal(extensionOptions.canSubmitWorkcellIntent(), false)
  assert.throws(() => extensionOptions.submitWorkcellIntent('After shutdown'), /has ended/)
})

test('optional owned Node credential goes only to the reviewed extension and closes with Harness', async () => {
  const { sdk, calls } = fakeSdk()
  const env = { PHYSICAL_NODE_EXECUTABLE: 'explicit-test-only' }
  const environment = { ...env, TINYEDGE_PHYSICAL_NODE_URL: 'http://127.0.0.1:39127', PHYSICAL_NODE_EXECUTION_TOKEN: 'private-synthetic-session-token' }
  let closed = 0, extensionOptions
  await harnessCommand({ config: { configDir: testConfigDir }, sdk, env,
    async startNodeSupervisorImpl(options) { assert.equal(options.env, env); return { environment, async dispose() { closed += 1 } } },
    createExtension(options) { extensionOptions = options; return () => {} }, createMode: () => ({ async run() {} }),
  })
  assert.equal(extensionOptions.env, environment)
  assert.equal(env.PHYSICAL_NODE_EXECUTION_TOKEN, undefined)
  assert.equal(calls.services.resourceLoaderOptions.systemPrompt.includes(environment.PHYSICAL_NODE_EXECUTION_TOKEN), false)
  assert.equal(closed, 1)
})

test('owned Node closes after Pi initialization failure and unconfirmed shutdown is not hidden', async () => {
  let closed = 0
  const { sdk } = fakeSdk({ onModelRuntimeCreate() { throw new Error('Pi failed') } })
  await assert.rejects(harnessCommand({ config: { configDir: testConfigDir }, sdk, env: {},
    async startNodeSupervisorImpl() { return { environment: {}, async dispose() { closed += 1; throw new Error('Unconfirmed') } } },
  }), /local Node shutdown is unconfirmed/)
  assert.equal(closed, 1)
})

test('native Harness isolates Pi startup side effects and restores its caller environment', async (t) => {
  const environmentNames = ['PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'TMUX']
  restoreEnvironmentAfterTest(t, environmentNames)
  process.env.PI_OFFLINE = 'caller-offline-value'
  process.env.PI_SKIP_VERSION_CHECK = 'caller-skip-value'
  process.env.TMUX = 'caller-tmux-value'

  const assertIsolated = () => {
    assert.equal(process.env.PI_OFFLINE, '1')
    assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1')
    assert.equal(process.env.TMUX, undefined)
  }
  const { sdk } = fakeSdk({ onModelRuntimeCreate: assertIsolated })
  await harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode: () => ({ async run() { assertIsolated() } }),
  })

  assert.equal(process.env.PI_OFFLINE, 'caller-offline-value')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, 'caller-skip-value')
  assert.equal(process.env.TMUX, 'caller-tmux-value')
})

test('native Harness restores an absent Pi startup environment after initialization fails', async (t) => {
  const environmentNames = ['PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'TMUX']
  restoreEnvironmentAfterTest(t, environmentNames)
  for (const name of environmentNames) delete process.env[name]

  const initializationError = new Error('model runtime failed')
  const { sdk } = fakeSdk({
    onModelRuntimeCreate() {
      assert.equal(process.env.PI_OFFLINE, '1')
      assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1')
      assert.equal(process.env.TMUX, undefined)
      throw initializationError
    },
  })
  await assert.rejects(harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode: () => ({ async run() {} }),
  }), (error) => error === initializationError)

  for (const name of environmentNames) assert.equal(process.env[name], undefined)
})

test('native Harness aborts if the reviewed security extension fails to load', async () => {
  const { sdk } = fakeSdk({ extensionErrors: [{ path: 'inline', error: 'broken' }] })
  await assert.rejects(harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode: () => ({ async run() {} }),
  }), /security extension failed to load/)
})

test('native Harness disposes the runtime if mode construction fails', async () => {
  const { sdk, calls } = fakeSdk()
  await assert.rejects(harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode() { throw new Error('mode construction failed') },
  }), /mode construction failed/)
  assert.equal(calls.disposed, true)
})

test('native Harness stops the TUI and disposes the runtime if run fails', async () => {
  const { sdk, calls } = fakeSdk()
  let stopped = false
  await assert.rejects(harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode: () => ({
      async run() { throw new Error('mode run failed') },
      stop() { stopped = true },
    }),
  }), /mode run failed/)
  assert.equal(stopped, true)
  assert.equal(calls.disposed, true)
})

test('native Harness preserves the run failure if cleanup also fails', async () => {
  const runError = new Error('mode run failed')
  const { sdk, calls } = fakeSdk({ disposeError: new Error('dispose failed') })
  await assert.rejects(harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
    createMode: () => ({
      async run() { throw runError },
      stop() { throw new Error('stop failed') },
    }),
  }), (error) => error === runError)
  assert.equal(calls.disposed, true)
})

test('Harness interactive mode hides Pi changelog, offline tool warnings, and extension inventory', () => {
  class InteractiveMode {
    getChangelogForDisplay() { return 'pi notes' }
    handleChangelogCommand() { this.changelogShown = true }
    showStatus(message) { this.status = message }
    showManagedToolStatus(status) { this.toolStatus = status }
    showLoadedResources(options) { this.resources = options }
  }
  const mode = new (createTinyEdgeInteractiveMode(InteractiveMode))()
  assert.equal(mode.getChangelogForDisplay(), undefined)
  mode.handleChangelogCommand()
  assert.equal(mode.changelogShown, undefined)
  assert.match(mode.status, /tinyedge\.ai\/docs/)
  mode.showManagedToolStatus({
    type: 'warning',
    message: 'ripgrep not found. Offline mode enabled, skipping download.',
  })
  assert.equal(mode.toolStatus, undefined)
  mode.showManagedToolStatus({ type: 'info', message: 'ready' })
  assert.equal(mode.toolStatus.message, 'ready')
  mode.showLoadedResources({ force: true })
  assert.deepEqual(mode.resources, { force: true, extensions: [] })
})

test('native Harness uses the TinyEdge interactive mode wrapper by default', async () => {
  const { sdk } = fakeSdk()
  let constructed
  sdk.InteractiveMode = class {
    constructor(runtime, options) {
      constructed = {
        runtime,
        options,
        changelog: this.getChangelogForDisplay(),
      }
    }
    getChangelogForDisplay() { return 'pi notes' }
    async run() {}
  }
  await harnessCommand({
    config: { configDir: testConfigDir, scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: false } } },
    sdk,
    cwd: 'C:\\work',
    createExtension: () => () => {},
  })
  assert.equal(constructed.changelog, undefined)
  assert.equal(constructed.options.verbose, false)
})
