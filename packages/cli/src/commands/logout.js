import { revokeToken } from '../auth/oauth.js'
import { safeErrorMessage } from '../auth/redact.js'

export async function logoutCommand({ tokenStore, fetchImpl = fetch, io = console }) {
  const tokens = await tokenStore.load()
  if (!tokens) {
    io.log('TinyEdge is already disconnected.')
    return { disconnected: true, revoked: false }
  }

  const failures = []
  for (const token of [tokens.refreshToken, tokens.accessToken].filter(Boolean)) {
    try {
      await revokeToken(tokens, token, fetchImpl)
    } catch (error) {
      failures.push(safeErrorMessage(error))
    }
  }
  await tokenStore.clear()
  if (failures.length) io.error('Local credentials removed; remote revocation could not be confirmed.')
  else io.log('TinyEdge connection revoked and local credentials removed.')
  return { disconnected: true, revoked: failures.length === 0 }
}
