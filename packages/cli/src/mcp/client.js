import { redactSecrets, safeErrorMessage } from '../auth/redact.js'
import { isLoopbackUrl } from '../config.js'
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../net/fetch.js'
import { VERSION } from '../version.js'

export const MCP_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION])

export class McpUnauthorizedError extends Error {
  constructor(message = 'TinyEdge MCP authorization is required') {
    super(message)
    this.name = 'McpUnauthorizedError'
  }
}

function parseSse(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    messages.push(JSON.parse(data))
  }
  return messages.at(-1) || null
}

async function parseResponse(response) {
  if (response.status === 202 || response.status === 204) return null
  const text = await response.text()
  if (!text) return null
  try {
    return response.headers.get('content-type')?.includes('text/event-stream')
      ? parseSse(text)
      : JSON.parse(text)
  } catch {
    throw new Error(`TinyEdge MCP returned an invalid response (${response.status})`)
  }
}

export class RemoteMcpClient {
  #nextId = 1
  #sessionId = null
  #initialized = false
  #negotiatedProtocolVersion = null
  #allowedTools = null

  constructor({
    url,
    getAccessToken,
    onUnauthorized,
    fetchImpl = fetch,
    clientInfo = { name: 'tinyedge', version: VERSION },
    allowedTools,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }) {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLoopbackUrl(parsedUrl))) {
      throw new TypeError('TinyEdge MCP requires HTTPS except on loopback')
    }
    this.url = parsedUrl.toString()
    this.getAccessToken = getAccessToken
    this.onUnauthorized = onUnauthorized
    this.fetchImpl = fetchImpl
    this.clientInfo = Object.freeze({ ...clientInfo })
    this.requestTimeoutMs = requestTimeoutMs
    if (allowedTools) this.#allowedTools = new Set(allowedTools)
  }

  async #post(payload, canRefresh = true) {
    const accessToken = await this.getAccessToken()
    if (!accessToken) throw new McpUnauthorizedError('Run `tinyedge login` first')

    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId
    if (this.#negotiatedProtocolVersion) {
      headers['mcp-protocol-version'] = this.#negotiatedProtocolVersion
    }

    const response = await fetchWithTimeout(this.fetchImpl, this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, this.requestTimeoutMs)
    if (response.status === 401) {
      if (canRefresh && this.onUnauthorized) {
        await this.onUnauthorized()
        return this.#post(payload, false)
      }
      throw new McpUnauthorizedError()
    }

    const body = await parseResponse(response)
    if (!response.ok) {
      const safe = redactSecrets(body || {})
      throw new Error(safe.error?.message || safe.error || `TinyEdge MCP request failed (${response.status})`)
    }
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) this.#sessionId = sessionId
    return body
  }

  async request(method, params = {}) {
    const id = this.#nextId++
    const body = await this.#post({ jsonrpc: '2.0', id, method, params })
    if (!body || body.id !== id) throw new Error(`TinyEdge MCP did not answer ${method}`)
    if (body.error) {
      const safe = redactSecrets(body.error)
      throw new Error(safe.message || `TinyEdge MCP ${method} failed`)
    }
    return body.result
  }

  async notify(method, params = {}) {
    await this.#post({ jsonrpc: '2.0', method, params })
  }

  async initialize() {
    if (this.#initialized) return this.serverInfo
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    })
    if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new Error(`TinyEdge MCP negotiated unsupported protocol version: ${result.protocolVersion || 'missing'}`)
    }
    this.#negotiatedProtocolVersion = result.protocolVersion
    await this.notify('notifications/initialized')
    this.#initialized = true
    this.serverInfo = Object.freeze({
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo || null,
      capabilities: result.capabilities || {},
    })
    return this.serverInfo
  }

  async listTools() {
    await this.initialize()
    const result = await this.request('tools/list')
    const tools = [...(result.tools || [])]
    return Object.freeze(this.#allowedTools
      ? tools.filter((tool) => this.#allowedTools.has(tool.name))
      : tools)
  }

  async callTool(name, args = {}) {
    if (this.#allowedTools && !this.#allowedTools.has(name)) {
      throw new Error(`TinyEdge MCP tool is not allowed in this client: ${name}`)
    }
    await this.initialize()
    return this.request('tools/call', { name, arguments: args })
  }
}

export function formatMcpError(error) {
  return safeErrorMessage(error)
}
