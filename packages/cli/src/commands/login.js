import {
  buildAuthorizationUrl,
  discoverOAuth,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateState,
  registerOAuthClient,
} from '../auth/oauth.js'
import { startOAuthCallback } from '../auth/callback-server.js'
import { openBrowser as openSystemBrowser } from '../auth/open-browser.js'

export function validateGrantedScopes(grantedScope, requestedScopes) {
  const requested = new Set(requestedScopes)
  const granted = new Set(String(grantedScope || '').split(/\s+/).filter(Boolean))
  const missing = [...requested].filter((scope) => !granted.has(scope))
  if (missing.length) throw new Error(`TinyEdge OAuth grant is missing requested scope: ${missing.join(', ')}`)
  const unexpected = [...granted].filter((scope) => !requested.has(scope))
  if (unexpected.length) {
    throw new Error(`TinyEdge OAuth grant included an unrequested scope: ${unexpected.join(', ')}`)
  }
  return granted
}

export async function loginCommand({
  config,
  tokenStore,
  fetchImpl = fetch,
  openBrowser = openSystemBrowser,
  callbackFactory = startOAuthCallback,
  io = console,
}) {
  const discovery = await discoverOAuth(config.mcpUrl, fetchImpl)
  const missingScopes = config.scopes.filter((scope) => !discovery.scopesSupported.includes(scope))
  if (missingScopes.length) {
    throw new Error(`TinyEdge OAuth server does not support required scope: ${missingScopes.join(', ')}`)
  }

  const verifier = generateCodeVerifier()
  const state = generateState()
  const callback = await callbackFactory({ expectedState: state })
  try {
    const registration = await registerOAuthClient(discovery, callback.redirectUri, fetchImpl)
    const authorizationUrl = buildAuthorizationUrl({
      discovery,
      clientId: registration.clientId,
      redirectUri: callback.redirectUri,
      verifier,
      state,
      scopes: config.scopes,
    })
    io.log('Opening TinyEdge in your browser to authorize this terminal...')
    openBrowser(authorizationUrl)
    const { code } = await callback.result
    const tokens = await exchangeAuthorizationCode({
      discovery,
      clientId: registration.clientId,
      redirectUri: callback.redirectUri,
      code,
      verifier,
      scope: config.scopes,
      fetchImpl,
    })
    validateGrantedScopes(tokens.scope, config.scopes)
    await tokenStore.save(tokens)
    io.log('TinyEdge connection saved. Credentials were not printed.')
    return tokenStore.summary()
  } catch (error) {
    callback.close()
    throw error
  }
}
