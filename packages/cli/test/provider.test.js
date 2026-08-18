import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import lockfile from 'proper-lockfile'

import { createMemorySecretStore } from '../src/auth/secret-store.js'
import { createPiCredentialStore } from '../src/chat/pi-credential-store.js'
import {
  listProviderModelsCommand,
  listProvidersCommand,
  providerLoginCommand,
  providerLogoutCommand,
} from '../src/commands/provider.js'

const execFileAsync = promisify(execFile)

function providerSdk(capture) {
  const provider = {
    id: 'openai',
    name: 'OpenAI',
    auth: { oauth: {}, apiKey: { login() {} } },
  }
  const runtime = {
    getProviders: () => [provider],
    getProvider: (id) => id === provider.id ? provider : undefined,
    getProviderAuthStatus: () => ({ configured: capture.configured }),
    getAvailable: async () => [{ provider: 'openai', id: 'gpt-test' }],
    async login(providerId, authType, interaction) {
      capture.login = { providerId, authType }
      interaction.notify({ type: 'auth_url', url: 'https://provider.example/authorize' })
      const answer = await interaction.prompt({ type: 'secret', message: 'API key' })
      capture.answer = answer
      capture.configured = true
    },
    async logout(providerId) { capture.logout = providerId; capture.configured = false },
  }
  return { ModelRuntime: { create: async (options) => { capture.credentials = options.credentials; return runtime } } }
}

test('Pi provider credentials are encrypted-store backed and expose metadata only', async () => {
  const secrets = createMemorySecretStore()
  const store = createPiCredentialStore({ configDir: 'C:\\test', secretStore: secrets })
  await store.modify('openai', async () => ({ type: 'api_key', key: 'provider-secret' }))
  assert.equal((await store.read('openai')).key, 'provider-secret')
  assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'api_key' }])
  await store.delete('openai')
  assert.equal(await store.read('openai'), undefined)
})

test('Pi provider credential mutations serialize across store instances', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tinyedge-pi-credentials-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const values = new Map()
  const secrets = {
    kind: 'test-persistent',
    async read(name) { return values.get(name) ?? null },
    async write(name, value) { values.set(name, String(value)) },
    async delete(name) { values.delete(name) },
  }
  const first = createPiCredentialStore({ configDir, secretStore: secrets })
  const second = createPiCredentialStore({ configDir, secretStore: secrets })
  let activeMutations = 0
  let maximumActiveMutations = 0

  const credential = (key) => async () => {
    activeMutations += 1
    maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations)
    await new Promise((resolve) => setTimeout(resolve, 40))
    activeMutations -= 1
    return { type: 'api_key', key }
  }

  await Promise.all([
    first.modify('openai', credential('openai-secret')),
    second.modify('anthropic', credential('anthropic-secret')),
  ])

  assert.equal(maximumActiveMutations, 1)
  assert.deepEqual((await first.list()).map(({ providerId }) => providerId).sort(), ['anthropic', 'openai'])
})

test('Pi provider credential mutations serialize across processes', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tinyedge-pi-process-lock-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const secretPath = path.join(configDir, 'provider-credentials.json')
  const moduleUrl = new URL('../src/chat/pi-credential-store.js', import.meta.url).href
  const childSource = (providerId, key) => `
    import { readFile, rm, writeFile } from 'node:fs/promises'
    import { createPiCredentialStore } from ${JSON.stringify(moduleUrl)}
    const secretPath = ${JSON.stringify(secretPath)}
    const secrets = {
      kind: 'test-persistent',
      async read() {
        try { return await readFile(secretPath, 'utf8') }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error }
      },
      async write(_name, value) { await writeFile(secretPath, String(value), 'utf8') },
      async delete() { await rm(secretPath, { force: true }) },
    }
    const store = createPiCredentialStore({ configDir: ${JSON.stringify(configDir)}, secretStore: secrets })
    await store.modify(${JSON.stringify(providerId)}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { type: 'api_key', key: ${JSON.stringify(key)} }
    })
  `

  await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '--eval', childSource('openai', 'openai-secret')]),
    execFileAsync(process.execPath, ['--input-type=module', '--eval', childSource('anthropic', 'anthropic-secret')]),
  ])

  const stored = JSON.parse(await readFile(secretPath, 'utf8'))
  assert.deepEqual(Object.keys(stored).sort(), ['anthropic', 'openai'])
})

test('Pi provider credential operations honor an aborted signal', async () => {
  const store = createPiCredentialStore({
    configDir: 'C:\\test',
    secretStore: createMemorySecretStore(),
  })
  const controller = new AbortController()
  controller.abort(new Error('credential operation cancelled'))
  await assert.rejects(store.list({ signal: controller.signal }), /credential operation cancelled/)
})

test('Pi provider credential operations reject promptly on in-flight abort without committing', async () => {
  const store = createPiCredentialStore({
    configDir: 'C:\\test',
    secretStore: createMemorySecretStore(),
  })
  const controller = new AbortController()
  let started
  let release
  const callbackStarted = new Promise((resolve) => { started = resolve })
  const callbackGate = new Promise((resolve) => { release = resolve })
  const operation = store.modify('openai', async () => {
    started()
    await callbackGate
    return { type: 'api_key', key: 'must-not-be-written' }
  }, { signal: controller.signal })

  await callbackStarted
  controller.abort(new Error('credential operation cancelled'))
  await assert.rejects(operation, /credential operation cancelled/)
  release()
  assert.equal(await store.read('openai'), undefined)
})

test('an aborted Pi provider mutation releases its persistent lock before the callback settles', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tinyedge-pi-abort-lock-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const values = new Map()
  const secrets = {
    kind: 'test-persistent',
    async read(name) { return values.get(name) ?? null },
    async write(name, value) { values.set(name, String(value)) },
    async delete(name) { values.delete(name) },
  }
  const first = createPiCredentialStore({ configDir, secretStore: secrets })
  const second = createPiCredentialStore({ configDir, secretStore: secrets })
  const controller = new AbortController()
  let callbackStarted
  let releaseCallback
  const started = new Promise((resolve) => { callbackStarted = resolve })
  const callbackGate = new Promise((resolve) => { releaseCallback = resolve })
  const firstOperation = first.modify('openai', async () => {
    callbackStarted()
    await callbackGate
    return { type: 'api_key', key: 'late-first-secret' }
  }, { signal: controller.signal })

  await started
  controller.abort(new Error('credential operation cancelled'))
  await assert.rejects(firstOperation, /credential operation cancelled/)

  let deadline
  try {
    const secondCredential = await Promise.race([
      second.modify('openai', async () => ({ type: 'api_key', key: 'second-secret' })),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('second credential store did not acquire the lock')), 2_000)
      }),
    ])
    assert.equal(secondCredential.key, 'second-secret')
  } finally {
    clearTimeout(deadline)
    releaseCallback()
  }

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await second.read('openai')).key, 'second-secret')
})

test('Pi provider credential store refuses to write after lock compromise', async (t) => {
  const originalLock = lockfile.lock
  let compromise
  lockfile.lock = async (_target, options) => {
    compromise = options.onCompromised
    return async () => {}
  }
  t.after(() => { lockfile.lock = originalLock })
  let writes = 0
  const store = createPiCredentialStore({
    configDir: 'C:\\test',
    secretStore: {
      kind: 'test-persistent',
      async read() { return null },
      async write() { writes += 1 },
      async delete() {},
    },
  })

  await assert.rejects(store.modify('openai', async () => {
    const error = Object.assign(new Error('credential lock compromised'), { code: 'ECOMPROMISED' })
    compromise(error)
    return { type: 'api_key', key: 'must-not-be-written' }
  }), /credential lock compromised/)
  assert.equal(writes, 0)
})

test('provider onboarding uses the official Pi runtime without printing credentials', async () => {
  const capture = { configured: false }
  const logs = []
  const shared = {
    config: { configDir: 'C:\\test' },
    sdk: providerSdk(capture),
    secretStore: createMemorySecretStore(),
    io: { log: (value) => logs.push(String(value)) },
  }
  await listProvidersCommand(shared)
  assert.match(logs.join('\n'), /openai/)
  await providerLoginCommand({
    ...shared,
    providerId: 'openai',
    authType: 'oauth',
    interactionFactory: () => ({
      prompt: async () => 'provider-secret',
      notify: (event) => logs.push(event.type),
    }),
  })
  assert.deepEqual(capture.login, { providerId: 'openai', authType: 'oauth' })
  assert.doesNotMatch(logs.join('\n'), /provider-secret/)
  assert.deepEqual(await listProviderModelsCommand(shared), ['openai/gpt-test'])
  await providerLogoutCommand({ ...shared, providerId: 'openai' })
  assert.equal(capture.logout, 'openai')
})
