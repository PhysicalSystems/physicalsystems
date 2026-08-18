import { createAuthenticatedMcp } from '../auth/session.js'
import { summarizeTokens } from '../auth/token-store.js'

export async function whoamiCommand({
  config,
  tokenStore,
  fetchImpl = fetch,
  io = console,
  now = Date.now,
}) {
  const auth = await createAuthenticatedMcp({ config, tokenStore, fetchImpl, now })
  const tools = await auth.client.listTools()
  const summary = summarizeTokens(auth.tokens(), now())
  io.log('Connected to TinyEdge through account-scoped OAuth.')
  io.log(`Resource: ${summary.resource || config.mcpUrl}`)
  io.log(`Scopes: ${summary.scope.join(', ') || 'not reported'}`)
  io.log(`Available TinyEdge tools: ${tools.length}`)
  return Object.freeze({ ...summary, toolCount: tools.length })
}
