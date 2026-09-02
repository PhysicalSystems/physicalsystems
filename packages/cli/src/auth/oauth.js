import { createHash, randomBytes } from 'node:crypto'

import { isLoopbackUrl, protectedResourceMetadataUrl } from '../config.js'
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../net/fetch.js'
import { redactSecrets, safeErrorMessage } from './redact.js'

function requireSecureEndpoint(value, label) {
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError(`${label} is not a valid URL`)
  }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopbackUrl(endpoint))) {
    throw new TypeError(`${label} must use HTTPS except on loopback`)
  }
  if (endpoint.username || endpoint.password) throw new TypeError(`${label} cannot contain credentials`)
  return endpoint.toString()
}

async function fetchJson(url, options, fetchImpl, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const response = await fetchWithTimeout(fetchImpl, url, options, requestTimeoutMs)
  const text = await response.text()
  let body = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`OAuth endpoint returned non-JSON data (${response.status})`)
    }
  }
  if (!response.ok) {
    const safe = redactSecrets(body)
    throw new Error(safe.error_description || safe.error || `OAuth request failed (${response.status})`)
  }
  return body
}

function authorizationMetadataUrl(issuer) {
  const parsed = new URL(issuer)
  const issuerPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  return new URL(`/.well-known/oauth-authorization-server${issuerPath}`, parsed.origin).toString()
}

export async function discoverOAuth(resourceUrl, fetchImpl = fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const resource = requireSecureEndpoint(resourceUrl, 'MCP resource URL')
  const resourceMetadataUrl = protectedResourceMetadataUrl(resource)
  const protectedResource = await fetchJson(resourceMetadataUrl, {
    headers: { accept: 'application/json' },
  }, fetchImpl, requestTimeoutMs)
  const advertisedResource = requireSecureEndpoint(
    protectedResource.resource,
    'OAuth protected resource',
  )
  if (advertisedResource !== resource) {
    throw new Error('TinyEdge OAuth discovery returned metadata for a different resource')
  }
  const issuer = protectedResource.authorization_servers?.[0]
  if (!issuer) throw new Error('TinyEdge OAuth discovery did not advertise an authorization server')
  const advertisedIssuer = requireSecureEndpoint(issuer, 'OAuth authorization server')

  const authorizationServer = await fetchJson(authorizationMetadataUrl(advertisedIssuer), {
    headers: { accept: 'application/json' },
  }, fetchImpl, requestTimeoutMs)
  const metadataIssuer = requireSecureEndpoint(authorizationServer.issuer, 'OAuth issuer')
  if (metadataIssuer !== advertisedIssuer) {
    throw new Error('TinyEdge OAuth discovery returned metadata for a different issuer')
  }
  const endpoints = {
    issuer: metadataIssuer,
    authorizationEndpoint: requireSecureEndpoint(
      authorizationServer.authorization_endpoint,
      'OAuth authorization endpoint',
    ),
    tokenEndpoint: requireSecureEndpoint(authorizationServer.token_endpoint, 'OAuth token endpoint'),
    registrationEndpoint: requireSecureEndpoint(
      authorizationServer.registration_endpoint,
      'OAuth registration endpoint',
    ),
    revocationEndpoint: authorizationServer.revocation_endpoint
      ? requireSecureEndpoint(authorizationServer.revocation_endpoint, 'OAuth revocation endpoint')
      : null,
  }

  return Object.freeze({
    resource,
    resourceMetadataUrl,
    scopesSupported: Object.freeze([...(authorizationServer.scopes_supported || [])]),
    ...endpoints,
  })
}

export function generateCodeVerifier(size = 64) {
  if (!Number.isInteger(size) || size < 32 || size > 96) {
    throw new RangeError('PKCE verifier entropy must be between 32 and 96 bytes')
  }
  return randomBytes(size).toString('base64url')
}

export function pkceChallenge(verifier) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    throw new TypeError('PKCE verifier must contain 43 to 128 characters')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function generateState() {
  return randomBytes(32).toString('base64url')
}

export async function registerOAuthClient(
  discovery,
  redirectUri,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const redirect = requireSecureEndpoint(redirectUri, 'OAuth redirect URI')
  if (!isLoopbackUrl(new URL(redirect))) throw new TypeError('OAuth redirect URI must use loopback')

  const client = await fetchJson(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Physical Systems Harness',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }, fetchImpl, requestTimeoutMs)
  if (!client.client_id || client.client_secret) {
    throw new Error('TinyEdge OAuth registration did not return a public client')
  }
  return Object.freeze({ clientId: String(client.client_id), redirectUri: redirect })
}

export function buildAuthorizationUrl({ discovery, clientId, redirectUri, verifier, state, scopes }) {
  const url = new URL(discovery.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('resource', discovery.resource)
  return url.toString()
}

function normalizeTokenResponse(body, context, now = Date.now()) {
  if (!body.access_token || typeof body.access_token !== 'string') {
    throw new Error('OAuth token response did not contain an access token')
  }
  const expiresIn = Number(body.expires_in)
  return Object.freeze({
    accessToken: body.access_token,
    refreshToken: body.refresh_token || context.refreshToken || null,
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(now + Math.max(0, expiresIn) * 1_000).toISOString()
      : null,
    scope: body.scope || context.scope || '',
    clientId: context.clientId,
    tokenEndpoint: context.tokenEndpoint,
    revocationEndpoint: context.revocationEndpoint || null,
    resource: context.resource,
    issuer: context.issuer,
  })
}

export async function exchangeAuthorizationCode({
  discovery,
  clientId,
  redirectUri,
  code,
  verifier,
  scope,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now,
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: discovery.resource,
  })
  const result = await fetchJson(discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  }, fetchImpl, requestTimeoutMs)
  return normalizeTokenResponse(result, {
    clientId,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    resource: discovery.resource,
    issuer: discovery.issuer,
    scope: scope.join(' '),
  }, now)
}

export async function refreshAccessToken(
  tokens,
  fetchImpl = fetch,
  now,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  if (!tokens?.refreshToken) throw new Error('TinyEdge connection cannot be refreshed; run `physicalsystems login`')
  const result = await fetchJson(tokens.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: tokens.resource,
    }),
  }, fetchImpl, requestTimeoutMs)
  const refreshed = normalizeTokenResponse(result, tokens, now)
  const previousScopes = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean))
  const refreshedScopes = new Set(String(refreshed.scope || '').split(/\s+/).filter(Boolean))
  if (
    previousScopes.size !== refreshedScopes.size
    || [...refreshedScopes].some((scope) => !previousScopes.has(scope))
  ) {
    throw new Error('OAuth refresh changed the granted scopes; run `physicalsystems login` again')
  }
  return refreshed
}

export async function revokeToken(
  tokens,
  token,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  if (!tokens?.revocationEndpoint || !token) return false
  const response = await fetchWithTimeout(fetchImpl, tokens.revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ token, client_id: tokens.clientId }),
  }, requestTimeoutMs)
  if (!response.ok) throw new Error(`OAuth revocation failed (${response.status}): ${safeErrorMessage(await response.text())}`)
  return true
}
