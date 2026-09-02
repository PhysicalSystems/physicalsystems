import { createInterface } from 'node:readline/promises'

import { createAuthenticatedMcp } from '../auth/session.js'
import { READ_SCOPE } from '../config.js'
import {
  createTinyEdgePiSession,
  toolsForScopes,
} from '../chat/pi-session.js'

function hasReadScope(summary) {
  return summary.scope?.includes(READ_SCOPE)
}

function terminalHelp(write) {
  write([
    'Commands:',
    '  /help   Show this help',
    '  /tools  Show the TinyEdge operations available in this session',
    '  /model  Show the active model',
    '  /exit   End the session',
    '',
  ].join('\n'))
}

function dim(value) {
  return process.stdout.isTTY ? `\u001b[2m${value}\u001b[0m` : value
}

export async function chatCommand({
  config,
  tokenStore,
  fetchImpl = fetch,
  io = console,
  prompt,
  requestedModel,
  input = process.stdin,
  output = process.stdout,
  createSession = createTinyEdgePiSession,
  secretStore,
}) {
  const summary = await tokenStore.summary()
  if (!summary.connected) throw new Error('Run `physicalsystems login` first')
  if (!hasReadScope(summary)) throw new Error('Reconnect with `physicalsystems login` to grant read access')

  const allowedTools = toolsForScopes(summary.scope)
  const auth = await createAuthenticatedMcp({
    config,
    tokenStore,
    fetchImpl,
    allowedTools,
  })
  const created = await createSession({
    config,
    mcpClient: auth.client,
    requestedModel,
    grantedScopes: summary.scope,
    secretStore,
  })
  const { session } = created
  const activeTools = new Map()
  const write = typeof io.write === 'function'
    ? (value) => io.write(value)
    : (value) => output.write(value)
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      write(event.assistantMessageEvent.delta)
    } else if (event.type === 'tool_execution_start') {
      activeTools.set(event.toolCallId, event.toolName)
      write(`\n${dim(`  ↳ ${event.toolName}`)}\n`)
    } else if (event.type === 'tool_execution_end') {
      const toolName = activeTools.get(event.toolCallId) || event.toolName
      activeTools.delete(event.toolCallId)
      write(`${dim(`  ${event.isError ? '✗' : '✓'} ${toolName}`)}\n`)
    }
  })

  async function runPrompt(value) {
    await session.prompt(value, {
      expandPromptTemplates: false,
      source: 'interactive',
    })
    write('\n')
  }

  const mode = summary.scope.includes('tinyedge:run') ? 'approved execution'
    : summary.scope.includes('tinyedge:write') ? 'planning'
      : 'read-only'
  io.log(`TinyEdge · ${mode} · ${created.model}`)
  try {
    if (prompt) {
      await runPrompt(prompt)
      return Object.freeze({ model: created.model, tools: created.tools })
    }

    const terminal = createInterface({ input, output })
    try {
      while (true) {
        const value = (await terminal.question('physicalsystems> ')).trim()
        if (!value) continue
        if (value === '/exit' || value === '/quit') break
        if (value === '/help') {
          terminalHelp(write)
          continue
        }
        if (value === '/tools') {
          write(`${created.tools.join('\n')}\n`)
          continue
        }
        if (value === '/model') {
          write(`${created.model}\n`)
          continue
        }
        if (value.startsWith('/')) {
          write(`Unknown command: ${value}. Use /help.\n`)
          continue
        }
        await runPrompt(value)
      }
    } finally {
      terminal.close()
    }
    return Object.freeze({ model: created.model, tools: created.tools })
  } finally {
    unsubscribe()
    session.dispose()
  }
}
