const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secretaccesskey',
  'authorization',
  'apikey',
  'token',
  'secret',
  'password',
])

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key).replace(/[-_]/g, '').toLowerCase())
}

const TEXT_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+\/=\-]+/gi, '$1[REDACTED]'],
  [/\btinyedge_(?:sk|dk|mcp|mcp_refresh|mcp_code)_[A-Za-z0-9._~-]+\b/gi, '[REDACTED]'],
  [/([?&](?:access_?token|refresh_?token|token|api_?key|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]'],
  [/("(?:access_?token|refresh_?token|id_?token|client_?secret|secret_?access_?key|api_?key|token|secret|password)"\s*:\s*")[^"]+("?)/gi, '$1[REDACTED]$2'],
]

export function redactText(value) {
  let result = String(value ?? '')
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen))

  const safe = {}
  for (const [key, entry] of Object.entries(value)) {
    safe[key] = isSecretKey(key) ? '[REDACTED]' : redactSecrets(entry, seen)
  }
  return safe
}

export function safeErrorMessage(error) {
  if (error instanceof Error) return redactText(error.message)
  return redactText(error)
}
