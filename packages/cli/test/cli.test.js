import assert from 'node:assert/strict'
import test from 'node:test'

import { runCli } from '../src/cli.js'
import { credentialStorageCheck, doctorCommand, nodeVersionSupported } from '../src/commands/doctor.js'
import { VERSION } from '../src/version.js'

function captureIo() {
  const out = []
  const err = []
  return { out, err, io: { log: (value) => out.push(String(value)), error: (value) => err.push(String(value)) } }
}

test('CLI reports its version without loading credentials', async () => {
  const capture = captureIo()
  assert.equal(await runCli(['--version'], { io: capture.io }), 0)
  assert.deepEqual(capture.out, [VERSION])
})

test('bare tinyedge opens the native Harness while explicit help stays one-shot', async () => {
  const calls = []
  const dependencies = {
    config: { configDir: 'C:\\TinyEdge' },
    tokenStore: { summary: async () => ({ connected: false }) },
    harnessCommand: async (options) => calls.push(options.config.configDir),
    io: captureIo().io,
  }
  assert.equal(await runCli([], dependencies), 0)
  assert.deepEqual(calls, ['C:\\TinyEdge'])

  const capture = captureIo()
  assert.equal(await runCli(['help'], { io: capture.io }), 0)
  assert.match(capture.out[0], /harness\s+Open the native TinyEdge Harness/)
  assert.deepEqual(calls, ['C:\\TinyEdge'])
})

test('CLI login requests read-only scope unless elevation is explicit', async () => {
  let authorizationScopes = ''
  const fetchImpl = async (url) => {
    const value = String(url)
    if (value.includes('oauth-protected-resource')) {
      return Response.json({
        resource: 'http://127.0.0.1:3456/api/mcp',
        authorization_servers: ['http://127.0.0.1:3456'],
      })
    }
    if (value.includes('oauth-authorization-server')) {
      return Response.json({
        issuer: 'http://127.0.0.1:3456',
        authorization_endpoint: 'http://127.0.0.1:3456/oauth/authorize',
        token_endpoint: 'http://127.0.0.1:3456/oauth/token',
        registration_endpoint: 'http://127.0.0.1:3456/oauth/register',
        scopes_supported: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
      })
    }
    if (value.endsWith('/oauth/register')) return Response.json({ client_id: 'public-client' })
    return Response.json({ access_token: 'secret', expires_in: 60, scope: authorizationScopes })
  }
  const dependencies = {
    config: {
      baseUrl: 'http://127.0.0.1:3456',
      mcpUrl: 'http://127.0.0.1:3456/api/mcp',
      configDir: 'C:\\tinyedge-test',
      scopes: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
    },
    tokenStore: { save: async () => {}, summary: async () => ({ connected: true }) },
    fetchImpl,
    openBrowser: (url) => { authorizationScopes = new URL(url).searchParams.get('scope') },
    callbackFactory: async ({ expectedState }) => ({
      redirectUri: 'http://127.0.0.1:49876/callback',
      result: Promise.resolve({ code: 'one-time-code', state: expectedState }),
      close() {},
    }),
    io: captureIo().io,
  }

  await runCli(['login'], dependencies)
  assert.equal(authorizationScopes, 'tinyedge:read')
  await runCli(['login', '--allow-run'], dependencies)
  assert.equal(authorizationScopes, 'tinyedge:read tinyedge:run')
  await assert.rejects(runCli(['login', '--admin'], dependencies), /Unexpected login argument/)
})

test('Node support enforces the Pi-compatible 22.19 floor', () => {
  assert.equal(nodeVersionSupported('22.18.0'), false)
  assert.equal(nodeVersionSupported('22.19.0'), true)
  assert.equal(nodeVersionSupported('23.0.0'), true)
})

test('doctor reports Windows DPAPI as native encrypted credential storage', () => {
  assert.deepEqual(credentialStorageCheck('windows-dpapi'), {
    status: 'pass',
    detail: 'Windows DPAPI encryption scoped to the current user',
  })
})

test('doctor does not claim unknown or test credential storage is plaintext', () => {
  assert.deepEqual(credentialStorageCheck('memory'), {
    status: 'warn',
    detail: 'in-memory test storage; credentials are not persisted',
  })
  assert.deepEqual(credentialStorageCheck(undefined), {
    status: 'warn',
    detail: 'credential storage could not be identified',
  })
})

test('doctor treats absent login as a warning while validating discovery', async () => {
  const capture = captureIo()
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth-protected-resource')) {
      return Response.json({
        resource: 'http://127.0.0.1:3456/api/mcp',
        authorization_servers: ['http://127.0.0.1:3456'],
      })
    }
    return Response.json({
      issuer: 'http://127.0.0.1:3456',
      authorization_endpoint: 'http://127.0.0.1:3456/oauth/authorize',
      token_endpoint: 'http://127.0.0.1:3456/oauth/token',
      registration_endpoint: 'http://127.0.0.1:3456/oauth/register',
      scopes_supported: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
    })
  }
  const result = await doctorCommand({
    config: { mcpUrl: 'http://127.0.0.1:3456/api/mcp' },
    tokenStore: { storage: 'windows-dpapi', summary: async () => ({ connected: false }) },
    fetchImpl,
    io: capture.io,
    nodeVersion: '22.19.0',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks.find((check) => check.name === 'TinyEdge'), {
    name: 'TinyEdge',
    status: 'pass',
    detail: VERSION,
  })
  assert.equal(result.checks.find((check) => check.name === 'Credential storage').status, 'pass')
  assert.equal(result.checks.find((check) => check.name === 'Saved connection').status, 'warn')
})

test('malicious base URL cannot receive credentials saved for another MCP resource', async () => {
  let networkCalls = 0
  const tokenStore = {
    summary: async () => ({ connected: true, scope: ['tinyedge:read'] }),
    load: async () => ({
      accessToken: 'tinyedge-access-secret',
      refreshToken: 'tinyedge-refresh-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: 'tinyedge:read',
      clientId: 'public-client',
      tokenEndpoint: 'https://tinyedge.ai/oauth/token',
      resource: 'https://tinyedge.ai/api/mcp',
      issuer: 'https://tinyedge.ai/',
    }),
  }
  const fetchImpl = async () => {
    networkCalls += 1
    throw new Error('A mismatched resource must be rejected before transport')
  }

  await assert.rejects(
    runCli(
      ['--base-url', 'https://attacker.example', 'chat', 'list my devices'],
      { tokenStore, fetchImpl, io: captureIo().io },
    ),
    /credentials belong to a different service/,
  )
  assert.equal(networkCalls, 0)
})
