import { createInterface } from 'node:readline/promises'

import { openBrowser as openSystemBrowser } from '../auth/open-browser.js'
import { createPiCredentialStore } from '../chat/pi-credential-store.js'
import { loadOfficialPiSdk } from '../chat/pi-session.js'

function providerLabel(provider) {
  return provider.name || provider.id
}

export async function createProviderRuntime({ config, sdk: suppliedSdk, secretStore }) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const credentials = createPiCredentialStore({ configDir: config.configDir, secretStore })
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  return { runtime, credentials }
}

export async function listProvidersCommand({ config, io = console, sdk, secretStore }) {
  const { runtime } = await createProviderRuntime({ config, sdk, secretStore })
  const providers = runtime.getProviders().map((provider) => ({
    id: provider.id,
    name: providerLabel(provider),
    configured: runtime.getProviderAuthStatus(provider.id).configured,
    oauth: Boolean(provider.auth?.oauth),
    apiKey: Boolean(provider.auth?.apiKey?.login),
  }))
  for (const provider of providers) {
    const methods = [provider.oauth && 'OAuth', provider.apiKey && 'API key'].filter(Boolean).join(' / ')
    io.log(`${provider.configured ? '\u2713' : '\u00b7'} ${provider.id}  ${methods || 'environment credentials'}`)
  }
  return providers
}

export async function listProviderModelsCommand({
  config, providerId, io = console, sdk, secretStore,
}) {
  const { runtime } = await createProviderRuntime({ config, sdk, secretStore })
  const models = await runtime.getAvailable(providerId)
  for (const model of models) io.log(`${model.provider}/${model.id}`)
  return models.map((model) => `${model.provider}/${model.id}`)
}

export async function providerLoginCommand({
  config,
  providerId,
  authType,
  io = console,
  input = process.stdin,
  output = process.stdout,
  sdk,
  secretStore,
  openBrowser = openSystemBrowser,
  interactionFactory,
}) {
  const { runtime } = await createProviderRuntime({ config, sdk, secretStore })
  const provider = runtime.getProvider(providerId)
  if (!provider) throw new Error(`Unknown Pi provider: ${providerId}`)
  const selectedType = authType || (provider.auth?.oauth ? 'oauth' : 'api_key')
  if (!provider.auth?.[selectedType === 'oauth' ? 'oauth' : 'apiKey']) {
    throw new Error(`${providerId} does not support ${selectedType === 'oauth' ? 'OAuth' : 'API-key'} login`)
  }

  const terminal = interactionFactory ? null : createInterface({ input, output })
  const interaction = interactionFactory
    ? interactionFactory({ providerId, authType: selectedType })
    : {
        async prompt(prompt) {
          if (prompt.type === 'select') {
            io.log(prompt.options.map((option) => `${option.id}: ${option.label}`).join('\n'))
          }
          if (prompt.type === 'secret') output.write('\u001b[8m')
          try {
            return await terminal.question(`${prompt.message}: `, { signal: prompt.signal })
          } finally {
            if (prompt.type === 'secret') output.write('\u001b[0m\n')
          }
        },
        notify(event) {
          if (event.type === 'auth_url') {
            io.log('Opening the provider sign-in page in your browser...')
            openBrowser(event.url)
          } else if (event.type === 'device_code') {
            io.log(`Enter code ${event.userCode} at ${event.verificationUri}`)
            openBrowser(event.verificationUri)
          } else if (event.message) {
            io.log(event.message)
          }
        },
      }
  try {
    await runtime.login(providerId, selectedType, interaction)
    io.log(`${providerLabel(provider)} connected. Credentials were saved by the operating system.`)
    return { providerId, authType: selectedType }
  } finally {
    terminal?.close()
  }
}

export async function providerLogoutCommand({ config, providerId, io = console, sdk, secretStore }) {
  const { runtime } = await createProviderRuntime({ config, sdk, secretStore })
  if (!runtime.getProvider(providerId)) throw new Error(`Unknown Pi provider: ${providerId}`)
  await runtime.logout(providerId)
  io.log(`${providerId} disconnected.`)
  return { providerId, disconnected: true }
}
