import { discoverOAuth } from '../auth/oauth.js'
import { createAuthenticatedMcp } from '../auth/session.js'
import { safeErrorMessage } from '../auth/redact.js'

export function nodeVersionSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 19)
}

export function credentialStorageCheck(storage) {
  if (storage === 'windows-dpapi') {
    return Object.freeze({
      status: 'pass',
      detail: 'Windows DPAPI encryption scoped to the current user',
    })
  }
  if (storage === 'memory') {
    return Object.freeze({
      status: 'warn',
      detail: 'in-memory test storage; credentials are not persisted',
    })
  }
  return Object.freeze({
    status: 'warn',
    detail: storage
      ? `unrecognized credential storage: ${storage}`
      : 'credential storage could not be identified',
  })
}

export async function doctorCommand({
  config,
  tokenStore,
  fetchImpl = fetch,
  io = console,
  nodeVersion = process.versions.node,
}) {
  const checks = []
  const record = (name, status, detail) => {
    checks.push({ name, status, detail })
    io.log(`${status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗'} ${name}: ${detail}`)
  }

  record(
    'Node.js',
    nodeVersionSupported(nodeVersion) ? 'pass' : 'fail',
    nodeVersionSupported(nodeVersion) ? nodeVersion : `${nodeVersion}; requires >=22.19.0`,
  )
  const credentialStorage = credentialStorageCheck(tokenStore.storage)
  record('Credential storage', credentialStorage.status, credentialStorage.detail)

  try {
    const discovery = await discoverOAuth(config.mcpUrl, fetchImpl)
    record('OAuth discovery', 'pass', discovery.issuer)
  } catch (error) {
    record('OAuth discovery', 'fail', safeErrorMessage(error))
  }

  const stored = await tokenStore.summary()
  if (!stored.connected) {
    record('Saved connection', 'warn', 'not logged in')
  } else {
    record('Saved connection', stored.expired && !stored.canRefresh ? 'fail' : 'pass', 'credentials present and redacted')
    try {
      const auth = await createAuthenticatedMcp({ config, tokenStore, fetchImpl })
      const tools = await auth.client.listTools()
      record('Remote MCP', 'pass', `${tools.length} tools available`)
    } catch (error) {
      record('Remote MCP', 'fail', safeErrorMessage(error))
    }
  }

  return Object.freeze({
    ok: checks.every((check) => check.status !== 'fail'),
    checks: Object.freeze(checks),
  })
}
