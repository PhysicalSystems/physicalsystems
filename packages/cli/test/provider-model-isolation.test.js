// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemorySecretStore } from '../src/auth/secret-store.js'
import { createProviderRuntime, listProvidersCommand, listProviderModelsCommand, providerLoginCommand, providerLogoutCommand } from '../src/commands/provider.js'

for (const isolated of [false, true]) test(`provider model configuration ${isolated ? 'accepts an explicit isolated catalog' : 'preserves the terminal default'}`, async () => {
  const initializations = []
  let refreshed = false
  const provider = { id: 'fixture', name: 'Fixture provider', auth: { apiKey: { login() {} } } }
  const runtime = {
    getProviders: () => [provider], getProvider: () => provider,
    getProviderAuthStatus: () => ({ configured: refreshed }),
    async getAvailable() { refreshed = true; return [] }, async login() {}, async logout() {},
  }
  const options = { config: { configDir: '/unused-fixture' }, secretStore: createMemorySecretStore(),
    sdk: { ModelRuntime: { async create(value) { initializations.push(value); return runtime } } }, io: { log() {} },
    ...(isolated ? { modelsPath: null } : {}) }
  await createProviderRuntime(options)
  const listing = await listProvidersCommand(options)
  assert.equal(listing[0].configured, isolated, 'isolated provider listing refreshes the auth snapshot before displaying it')
  await listProviderModelsCommand(options)
  await providerLoginCommand({ ...options, providerId: 'fixture', authType: 'api_key', interactionFactory: () => ({}) })
  await providerLogoutCommand({ ...options, providerId: 'fixture' })
  assert.equal(initializations.length, 5)
  for (const initialization of initializations) {
    assert.equal(Object.hasOwn(initialization, 'modelsPath'), isolated)
    if (isolated) assert.equal(initialization.modelsPath, null)
    assert.equal(initialization.allowModelNetwork, false)
    assert.equal(initialization.refreshOnCreate, false)
  }
})
