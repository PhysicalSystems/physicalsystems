import { createNativeSecretStore } from './secret-store.js'

const SECRET_NAME = 'tinyedge-oauth'
const TOKEN_FIELDS = new Set([
  'accessToken',
  'refreshToken',
  'expiresAt',
  'scope',
  'clientId',
  'tokenEndpoint',
  'revocationEndpoint',
  'resource',
  'issuer',
])

function normalizeTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Stored TinyEdge credentials are invalid')
  }
  const normalized = {}
  for (const [key, entry] of Object.entries(value)) {
    if (TOKEN_FIELDS.has(key) && (typeof entry === 'string' || entry === null)) {
      normalized[key] = entry
    }
  }
  if (typeof normalized.accessToken !== 'string' || !normalized.accessToken) {
    throw new TypeError('Stored TinyEdge credentials do not contain an access token')
  }
  return normalized
}

export function summarizeTokens(tokens, now = Date.now()) {
  if (!tokens) return Object.freeze({ connected: false })
  const expiresAt = tokens.expiresAt || null
  return Object.freeze({
    connected: true,
    resource: tokens.resource || null,
    issuer: tokens.issuer || null,
    scope: String(tokens.scope || '').split(/\s+/).filter(Boolean),
    expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) <= now : false,
    canRefresh: Boolean(tokens.refreshToken),
  })
}

export function createTokenStore({ configDir, secretStore } = {}) {
  const secrets = secretStore || createNativeSecretStore({ configDir })

  return Object.freeze({
    storage: secrets.kind,
    async load() {
      const value = await secrets.read(SECRET_NAME)
      return value === null ? null : normalizeTokens(JSON.parse(value))
    },
    async save(tokens) {
      const normalized = normalizeTokens(tokens)
      await secrets.write(SECRET_NAME, JSON.stringify(normalized))
    },
    async clear() {
      await secrets.delete(SECRET_NAME)
    },
    async summary(now) {
      return summarizeTokens(await this.load(), now)
    },
  })
}
