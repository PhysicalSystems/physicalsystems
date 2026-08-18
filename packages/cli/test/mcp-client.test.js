import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_PROTOCOL_VERSION, RemoteMcpClient } from '../src/mcp/client.js'

test('remote MCP initializes, retains its session, and lists tools', async () => {
  const calls = []
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body)
    calls.push({ payload, headers: options.headers })
    if (payload.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'TinyEdge', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      }, { headers: { 'mcp-session-id': 'session-one' } })
    }
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return Response.json({
      jsonrpc: '2.0',
      id: payload.id,
      result: { tools: [{ name: 'list_devices', inputSchema: { type: 'object' } }] },
    })
  }
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => 'test-access-token',
    fetchImpl,
  })
  const tools = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['list_devices'])
  assert.equal(calls[0].payload.params.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.equal(calls[0].headers['mcp-protocol-version'], undefined)
  assert.equal(calls[1].headers['mcp-session-id'], 'session-one')
  assert.equal(calls[1].headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION)
  assert.equal(calls[2].headers['mcp-session-id'], 'session-one')
  assert.equal(calls[2].headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION)
})

test('remote MCP rejects unsupported protocol negotiation', async () => {
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => 'test-access-token',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body)
      return Response.json({
        jsonrpc: '2.0',
        id: payload.id,
        result: { protocolVersion: '2024-01-01', serverInfo: { name: 'old-server' } },
      })
    },
  })
  await assert.rejects(client.initialize(), /unsupported protocol version/)
})

test('remote MCP hard allowlist filters discovery and blocks calls before transport', async () => {
  let requests = 0
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => 'test-access-token',
    allowedTools: ['list_devices'],
    fetchImpl: async (_url, options) => {
      requests += 1
      const payload = JSON.parse(options.body)
      if (payload.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
        })
      }
      if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: '2.0',
        id: payload.id,
        result: { tools: [{ name: 'list_devices' }, { name: 'run_benchmark' }] },
      })
    },
  })
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ['list_devices'])
  const beforeBlockedCall = requests
  await assert.rejects(client.callTool('run_benchmark'), /not allowed/)
  assert.equal(requests, beforeBlockedCall)
})

test('remote MCP requests have a bounded timeout', async () => {
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => 'test-access-token',
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }),
  })
  await assert.rejects(client.initialize(), /timed out after 5ms/)
})

test('remote MCP refreshes once after a 401 and parses an SSE response', async () => {
  let token = 'expired-token'
  let attempts = 0
  let refreshes = 0
  const fetchImpl = async (_url, options) => {
    attempts += 1
    const payload = JSON.parse(options.body)
    if (options.headers.authorization === 'Bearer expired-token') {
      return Response.json({ error: 'invalid_token' }, { status: 401 })
    }
    const message = {
      jsonrpc: '2.0',
      id: payload.id,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'TinyEdge' } },
    }
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => token,
    onUnauthorized: async () => {
      refreshes += 1
      token = 'fresh-token'
    },
    fetchImpl,
  })
  const result = await client.request('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  assert.equal(result.serverInfo.name, 'TinyEdge')
  assert.equal(refreshes, 1)
  assert.equal(attempts, 2)
})

test('MCP errors redact token-shaped values', async () => {
  const client = new RemoteMcpClient({
    url: 'https://tinyedge.ai/api/mcp',
    getAccessToken: () => 'client-secret',
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body)
      return Response.json({
        jsonrpc: '2.0',
        id: payload.id,
        error: { message: 'Rejected Bearer server-secret' },
      })
    },
  })
  await assert.rejects(client.request('tools/list'), (error) => {
    assert.doesNotMatch(error.message, /server-secret/)
    assert.match(error.message, /\[REDACTED\]/)
    return true
  })
})

test('MCP client refuses remote plaintext HTTP', () => {
  assert.throws(() => new RemoteMcpClient({
    url: 'http://tinyedge.ai/api/mcp',
    getAccessToken: () => 'unused',
  }), /requires HTTPS/)
})
