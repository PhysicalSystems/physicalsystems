#!/usr/bin/env node

import { createConfig, loginScopes, withScopes } from './config.js'
import { createTokenStore } from './auth/token-store.js'
import { safeErrorMessage } from './auth/redact.js'
import { pathToFileURL } from 'node:url'
import { doctorCommand } from './commands/doctor.js'
import { chatCommand } from './commands/chat.js'
import { harnessCommand } from './commands/harness.js'
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { whoamiCommand } from './commands/whoami.js'
import {
  listProviderModelsCommand,
  listProvidersCommand,
  providerLoginCommand,
  providerLogoutCommand,
} from './commands/provider.js'
import { VERSION } from './version.js'

function help() {
  return `Physical Systems Harness ${VERSION}

Usage: physicalsystems [--base-url URL] [command]

Commands:
  harness  Open the local Physical Systems Harness (default)
  login    Connect optional TinyEdge cloud tools with read-only access
  chat     Inspect, plan, or run work allowed by the saved OAuth scopes
  provider Configure the model provider used by the terminal assistant
  models   List authenticated Pi models
  whoami   Verify the saved account-scoped connection
  doctor   Diagnose OAuth and MCP connectivity
  logout   Revoke and remove the saved connection
  help     Show this help

Options:
  --base-url URL  Override the TinyEdge origin (HTTPS or loopback HTTP only)
  login --allow-write  Explicitly request write scope
  login --allow-run    Explicitly request workload-run scope
  chat --model PROVIDER/MODEL [PROMPT]
  provider list
  provider login PROVIDER [--oauth|--api-key]
  provider logout PROVIDER
  models [--provider PROVIDER]
  --version       Print the CLI version
`
}

function parseProviderArgs(args) {
  const [action = 'list', providerId, ...flags] = args
  if (!['list', 'login', 'logout'].includes(action)) throw new Error(`Unknown provider action: ${action}`)
  if (action === 'list') {
    if (providerId || flags.length) throw new Error('provider list does not accept arguments')
    return { action }
  }
  if (!providerId || providerId.startsWith('--')) throw new Error(`provider ${action} requires a provider ID`)
  if (action === 'logout') {
    if (flags.length) throw new Error('provider logout does not accept options')
    return { action, providerId }
  }
  const allowed = new Set(['--oauth', '--api-key'])
  const unknown = flags.find((value) => !allowed.has(value))
  if (unknown) throw new Error(`Unexpected provider login argument: ${unknown}`)
  if (flags.includes('--oauth') && flags.includes('--api-key')) {
    throw new Error('Choose either --oauth or --api-key')
  }
  return {
    action,
    providerId,
    authType: flags.includes('--api-key') ? 'api_key' : flags.includes('--oauth') ? 'oauth' : undefined,
  }
}

function parseModelsArgs(args) {
  if (!args.length) return {}
  if (args.length !== 2 || args[0] !== '--provider' || !args[1]) {
    throw new Error('Usage: physicalsystems models [--provider PROVIDER]')
  }
  return { providerId: args[1] }
}

export function parseArgs(argv) {
  const args = [...argv]
  let baseUrl
  const commandArgs = []
  while (args.length) {
    const value = args.shift()
    if (value === '--base-url') {
      baseUrl = args.shift()
      if (!baseUrl) throw new Error('--base-url requires a URL')
    } else {
      commandArgs.push(value)
    }
  }
  return { baseUrl, command: commandArgs[0] || 'harness', extra: commandArgs.slice(1) }
}

function parseLoginArgs(args) {
  const allowed = new Set(['--allow-write', '--allow-run'])
  const unknown = args.find((value) => !allowed.has(value))
  if (unknown) throw new Error(`Unexpected login argument: ${unknown}`)
  return {
    allowWrite: args.includes('--allow-write'),
    allowRun: args.includes('--allow-run'),
  }
}

function parseChatArgs(args) {
  const values = [...args]
  let requestedModel
  const prompt = []
  while (values.length) {
    const value = values.shift()
    if (value === '--model') {
      requestedModel = values.shift()
      if (!requestedModel) throw new Error('--model requires PROVIDER/MODEL')
    } else if (value.startsWith('--')) {
      throw new Error(`Unexpected chat argument: ${value}`)
    } else {
      prompt.push(value)
    }
  }
  return { requestedModel, prompt: prompt.join(' ') || undefined }
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const io = dependencies.io || console
  const { baseUrl, command, extra } = parseArgs(argv)
  if (command === '--version' || command === 'version') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    io.log(VERSION)
    return 0
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    io.log(help())
    return 0
  }

  const env = baseUrl ? { ...process.env, TINYEDGE_BASE_URL: baseUrl } : process.env
  const config = dependencies.config || createConfig(env)
  const needsAccountStore = ['login', 'chat', 'logout', 'whoami', 'doctor'].includes(command)
  const tokenStore = dependencies.tokenStore || (needsAccountStore ? createTokenStore({
    ...config,
    secretStore: dependencies.secretStore,
  }) : null)
  const shared = { config, tokenStore, io, fetchImpl: dependencies.fetchImpl || fetch }

  if (command === 'harness') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    await (dependencies.harnessCommand || harnessCommand)({
      ...shared,
      sdk: dependencies.piSdk,
      secretStore: dependencies.secretStore,
      createMode: dependencies.createHarnessMode,
      createExtension: dependencies.createHarnessExtension,
      cwd: dependencies.cwd,
    })
  } else if (command === 'login') {
    const requested = parseLoginArgs(extra)
    await loginCommand({
      ...shared,
      config: withScopes(config, loginScopes(requested)),
      openBrowser: dependencies.openBrowser,
      callbackFactory: dependencies.callbackFactory,
    })
  } else if (command === 'chat') {
    const chat = parseChatArgs(extra)
    await chatCommand({
      ...shared,
      ...chat,
      input: dependencies.input,
      output: dependencies.output,
      createSession: dependencies.createChatSession,
      secretStore: dependencies.secretStore,
    })
  } else if (command === 'provider') {
    const provider = parseProviderArgs(extra)
    const providerShared = {
      config, io, sdk: dependencies.piSdk, secretStore: dependencies.secretStore,
    }
    if (provider.action === 'list') await listProvidersCommand(providerShared)
    else if (provider.action === 'login') {
      await providerLoginCommand({
        ...providerShared,
        ...provider,
        input: dependencies.input,
        output: dependencies.output,
        openBrowser: dependencies.openBrowser,
        interactionFactory: dependencies.providerInteractionFactory,
      })
    } else await providerLogoutCommand({ ...providerShared, providerId: provider.providerId })
  } else if (command === 'models') {
    await listProviderModelsCommand({
      config,
      io,
      sdk: dependencies.piSdk,
      secretStore: dependencies.secretStore,
      ...parseModelsArgs(extra),
    })
  } else if (command === 'logout') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    await logoutCommand(shared)
  } else if (command === 'whoami') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    await whoamiCommand(shared)
  }
  else if (command === 'doctor') {
    if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`)
    const result = await doctorCommand(shared)
    return result.ok ? 0 : 1
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(`Physical Systems: ${safeErrorMessage(error)}`)
    process.exitCode = 1
  })
}
