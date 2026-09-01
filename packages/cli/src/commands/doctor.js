import { discoverOAuth } from '../auth/oauth.js'
import { createAuthenticatedMcp } from '../auth/session.js'
import { safeErrorMessage } from '../auth/redact.js'
import { VERSION } from '../version.js'

export function nodeVersionSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 19)
}

export function credentialStorageCheck(storage, { availability } = {}) {
  if (storage === 'windows-dpapi') {
    return Object.freeze({
      status: 'pass',
      detail: 'Windows DPAPI encryption scoped to the current user',
    })
  }
  if (storage === 'linux-secret-service') {
    if (availability === true) {
      return Object.freeze({
        status: 'pass',
        detail: 'Linux Secret Service keyring is available through secret-tool',
      })
    }
    if (availability === false) {
      return Object.freeze({
        status: 'fail',
        detail: 'Linux Secret Service keyring could not be read',
      })
    }
    return Object.freeze({
      status: 'warn',
      detail: 'Linux Secret Service adapter configured; keyring availability not verified',
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

  record('TinyEdge', 'pass', VERSION)
  record(
    'Node.js',
    nodeVersionSupported(nodeVersion) ? 'pass' : 'fail',
    nodeVersionSupported(nodeVersion) ? nodeVersion : `${nodeVersion}; requires >=22.19.0`,
  )

  let stored = null
  let storageError = null
  try {
    stored = await tokenStore.summary()
  } catch (error) {
    storageError = safeErrorMessage(error)
  }
  const credentialStorage = credentialStorageCheck(tokenStore.storage, {
    availability: storageError === null,
  })
  record('Credential storage', credentialStorage.status, credentialStorage.detail)

  try {
    const discovery = await discoverOAuth(config.mcpUrl, fetchImpl)
    record('OAuth discovery', 'pass', discovery.issuer)
  } catch (error) {
    record('OAuth discovery', 'fail', safeErrorMessage(error))
  }

  if (storageError !== null) {
    record('Saved connection', 'fail', `could not read credentials: ${storageError}`)
  } else if (!stored.connected) {
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
