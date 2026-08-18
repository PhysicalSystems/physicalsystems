import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_BASE_URL = 'https://tinyedge.ai'
export const READ_SCOPE = 'tinyedge:read'
export const WRITE_SCOPE = 'tinyedge:write'
export const RUN_SCOPE = 'tinyedge:run'
export const DEFAULT_SCOPES = Object.freeze([READ_SCOPE])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function isLoopbackUrl(url) {
  return LOOPBACK_HOSTS.has(url.hostname)
}

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw new TypeError('TinyEdge base URL must be an absolute URL')
  }

  if (parsed.username || parsed.password) {
    throw new TypeError('TinyEdge base URL cannot contain credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError('TinyEdge base URL cannot contain a query or fragment')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError('TinyEdge base URL must be an origin without a path')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackUrl(parsed))) {
    throw new TypeError('TinyEdge requires HTTPS except for loopback development')
  }

  return parsed.origin
}

export function resolveConfigDir(env = process.env, platform = process.platform) {
  if (env.TINYEDGE_CONFIG_DIR) return path.resolve(env.TINYEDGE_CONFIG_DIR)
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'TinyEdge', 'cli')
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'tinyedge', 'cli')
  return path.join(homedir(), '.config', 'tinyedge', 'cli')
}

export function createConfig(env = process.env, platform = process.platform) {
  const baseUrl = normalizeBaseUrl(env.TINYEDGE_BASE_URL || DEFAULT_BASE_URL)
  return Object.freeze({
    baseUrl,
    mcpUrl: new URL('/api/mcp', baseUrl).toString(),
    configDir: resolveConfigDir(env, platform),
    scopes: DEFAULT_SCOPES,
  })
}

export function loginScopes({ allowWrite = false, allowRun = false } = {}) {
  return Object.freeze([
    READ_SCOPE,
    ...(allowWrite ? [WRITE_SCOPE] : []),
    ...(allowRun ? [RUN_SCOPE] : []),
  ])
}

export function withScopes(config, scopes) {
  return Object.freeze({ ...config, scopes: Object.freeze([...scopes]) })
}

export function protectedResourceMetadataUrl(resourceUrl) {
  const resource = new URL(resourceUrl)
  const suffix = resource.pathname === '/' ? '' : resource.pathname
  return new URL(`/.well-known/oauth-protected-resource${suffix}`, resource.origin).toString()
}
