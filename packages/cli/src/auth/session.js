import { refreshAccessToken } from './oauth.js'
import { RemoteMcpClient } from '../mcp/client.js'

const EXPIRY_SKEW_MS = 30_000

function canonicalResource(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    return new URL(value).toString()
  } catch {
    return null
  }
}

function requireMatchingResource(tokens, configuredResource) {
  const stored = canonicalResource(tokens?.resource)
  const configured = canonicalResource(configuredResource)
  if (!stored || !configured || stored !== configured) {
    throw new Error(
      'Saved TinyEdge credentials belong to a different service; run `physicalsystems login` for this service',
    )
  }
}

function needsRefresh(tokens, now = Date.now()) {
  if (!tokens?.expiresAt) return false
  return Date.parse(tokens.expiresAt) <= now + EXPIRY_SKEW_MS
}

export async function createAuthenticatedMcp({
  config,
  tokenStore,
  fetchImpl = fetch,
  now = Date.now,
  allowedTools,
}) {
  let tokens = await tokenStore.load()
  if (!tokens) throw new Error('Run `physicalsystems login` first')
  requireMatchingResource(tokens, config.mcpUrl)

  async function refresh() {
    tokens = await refreshAccessToken(tokens, fetchImpl, now())
    await tokenStore.save(tokens)
  }

  if (needsRefresh(tokens, now())) await refresh()

  return Object.freeze({
    client: new RemoteMcpClient({
      url: config.mcpUrl,
      fetchImpl,
      getAccessToken: () => tokens.accessToken,
      onUnauthorized: refresh,
      allowedTools,
    }),
    tokens: () => tokens,
  })
}
