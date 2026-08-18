import assert from 'node:assert/strict'
import test from 'node:test'

import { TINYEDGE_CHAT_TOOL_ALLOWLIST } from '../src/chat/pi-session.js'
import { harnessCommand } from '../src/commands/harness.js'

function fakeSdk({ extensionErrors = [], disposeError, onModelRuntimeCreate } = {}) {
  const calls = {}
  class InteractiveMode {}
  const sdk = {
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
      return { session: { kind: 'session' } }
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
    tokenStore: { async summary() { return { connected: true, scope: ['tinyedge:read'] } } },
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
  assert.deepEqual(calls.session.tools, [...TINYEDGE_CHAT_TOOL_ALLOWLIST])
  assert.deepEqual(calls.services.resourceLoaderOptions, {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: calls.services.resourceLoaderOptions.systemPrompt,
    extensionFactories: [calls.services.resourceLoaderOptions.extensionFactories[0]],
  })
  assert.equal(extensionOptions.standalone, true)
  assert.equal(extensionOptions.autoLogin, true)
  assert.equal(extensionOptions.showHeader, true)
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
    config: { configDir: 'C:\\TinyEdge', scopes: ['tinyedge:read'] },
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
