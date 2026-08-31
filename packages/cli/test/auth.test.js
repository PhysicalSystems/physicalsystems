import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS,
  startOAuthCallback,
} from '../src/auth/callback-server.js'
import {
  buildAuthorizationUrl,
  discoverOAuth,
  pkceChallenge,
  refreshAccessToken,
  registerOAuthClient,
} from '../src/auth/oauth.js'
import { redactSecrets, redactText } from '../src/auth/redact.js'
import { createTokenStore } from '../src/auth/token-store.js'
import {
  createLinuxSecretServiceSecretStore,
  createMemorySecretStore,
  createNativeSecretStore,
  createWindowsDpapiSecretStore,
} from '../src/auth/secret-store.js'
import { loginCommand, validateGrantedScopes } from '../src/commands/login.js'
import { logoutCommand } from '../src/commands/logout.js'

test('PKCE challenge matches the RFC 7636 S256 example', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('OAuth discovery and public-client registration use loopback PKCE metadata', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (String(url).includes('oauth-protected-resource')) {
      return Response.json({
        resource: 'http://127.0.0.1:3456/api/mcp',
        authorization_servers: ['http://127.0.0.1:3456'],
      })
    }
    if (String(url).includes('oauth-authorization-server')) {
      return Response.json({
        issuer: 'http://127.0.0.1:3456',
        authorization_endpoint: 'http://127.0.0.1:3456/oauth/authorize',
        token_endpoint: 'http://127.0.0.1:3456/oauth/token',
        registration_endpoint: 'http://127.0.0.1:3456/oauth/register',
        revocation_endpoint: 'http://127.0.0.1:3456/oauth/revoke',
        scopes_supported: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
      })
    }
    return Response.json({ client_id: 'public-client' }, { status: 201 })
  }

  const discovery = await discoverOAuth('http://127.0.0.1:3456/api/mcp', fetchImpl)
  const registration = await registerOAuthClient(
    discovery,
    'http://127.0.0.1:49876/callback',
    fetchImpl,
  )
  assert.equal(registration.clientId, 'public-client')
  const body = JSON.parse(requests.at(-1).options.body)
  assert.equal(body.token_endpoint_auth_method, 'none')
  assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:49876/callback'])

  const authorization = new URL(buildAuthorizationUrl({
    discovery,
    clientId: registration.clientId,
    redirectUri: registration.redirectUri,
    verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    state: 'state-value',
    scopes: ['tinyedge:read'],
  }))
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorization.searchParams.get('resource'), discovery.resource)
  assert.equal(authorization.searchParams.get('state'), 'state-value')
})

test('OAuth discovery binds protected-resource and issuer metadata to the requested URLs', async () => {
  await assert.rejects(
    discoverOAuth('https://tinyedge.ai/api/mcp', async () => Response.json({
      resource: 'https://attacker.example/api/mcp',
      authorization_servers: ['https://tinyedge.ai'],
    })),
    /different resource/,
  )

  await assert.rejects(
    discoverOAuth('https://tinyedge.ai/api/mcp', async (url) => {
      if (String(url).includes('oauth-protected-resource')) {
        return Response.json({
          resource: 'https://tinyedge.ai/api/mcp',
          authorization_servers: ['https://tinyedge.ai'],
        })
      }
      return Response.json({
        issuer: 'https://attacker.example',
        authorization_endpoint: 'https://tinyedge.ai/oauth/authorize',
        token_endpoint: 'https://tinyedge.ai/oauth/token',
        registration_endpoint: 'https://tinyedge.ai/oauth/register',
      })
    }),
    /different issuer/,
  )
})

test('loopback callback validates state and returns only the authorization code', async () => {
  const callback = await startOAuthCallback({ expectedState: 'expected', timeoutMs: 5_000 })
  const response = await fetch(`${callback.redirectUri}?code=one-time-code&state=expected`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /Authentication successful/)
  assert.match(html, /TinyEdge authentication completed\. You can close this window\./)
  assert.match(html, /aria-label="TinyEdge logo"/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/)
  assert.deepEqual(await callback.result, { code: 'one-time-code', state: 'expected' })
})

test('loopback callback allows five minutes for interactive sign-in then closes deterministically', async (t) => {
  assert.equal(DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS, 5 * 60_000)
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const callback = await startOAuthCallback({ expectedState: 'expected' })
  let outcome
  callback.result.then(
    (value) => { outcome = { value } },
    (error) => { outcome = { error } },
  )

  t.mock.timers.tick(DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS - 1)
  await Promise.resolve()
  assert.equal(outcome, undefined)

  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.match(outcome.error.message, /authorization timed out/i)
})

test('redaction removes credentials recursively and from error text', () => {
  const safe = redactSecrets({
    access_token: 'oauth-secret',
    refreshToken: 'camel-case-secret',
    nested: { authorization: 'Bearer nested-secret', token: 'opaque-secret', label: 'safe' },
  })
  assert.deepEqual(safe, {
    access_token: '[REDACTED]',
    refreshToken: '[REDACTED]',
    nested: { authorization: '[REDACTED]', token: '[REDACTED]', label: 'safe' },
  })
  const text = redactText(
    'Authorization: Bearer abc.def== and tinyedge_mcp_example at https://example.test/?token=query-secret',
  )
  assert.equal(
    text,
    'Authorization: Bearer [REDACTED] and [REDACTED] at https://example.test/?token=[REDACTED]',
  )
})

test('token store keeps credentials in a secret store and summaries never contain tokens', async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'tinyedge-cli-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const store = createTokenStore({ configDir, secretStore: createMemorySecretStore() })
  await store.save({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope: 'tinyedge:read',
    clientId: 'public-client',
    tokenEndpoint: 'https://tinyedge.ai/oauth/token',
    revocationEndpoint: 'https://tinyedge.ai/oauth/revoke',
    resource: 'https://tinyedge.ai/api/mcp',
    issuer: 'https://tinyedge.ai/',
  })
  const loaded = await store.load()
  assert.equal(loaded.accessToken, 'access-secret')
  const serializedSummary = JSON.stringify(await store.summary())
  assert.doesNotMatch(serializedSummary, /access-secret|refresh-secret/)
  assert.equal(store.storage, 'memory')
  await store.clear()
  assert.equal(await store.load(), null)
})

test('Windows DPAPI adapter never passes plaintext secrets on the process command line', async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'tinyedge-dpapi-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const calls = []
  const run = async (_executable, args, options) => {
    calls.push({ args, input: options.input, timeout: options.timeout })
    return { stdout: options.input }
  }
  const secrets = createWindowsDpapiSecretStore({ configDir, run })
  await secrets.write('oauth', 'access-secret')
  assert.equal(await secrets.read('oauth'), 'access-secret')
  assert.equal(calls.some(({ args }) => args.join(' ').includes('access-secret')), false)
  assert.equal(calls.every(({ input }) => !String(input).includes('access-secret')), true)
  assert.deepEqual(calls.map(({ timeout }) => timeout), [30_000, 30_000])
})

test('Windows DPAPI integration closes child stdin and round-trips an encrypted secret', {
  skip: process.platform !== 'win32',
  // The round trip starts two independently bounded 30-second PowerShell
  // processes. Keep the aggregate test budget above both production bounds so
  // a cold runner can still prove the complete write/read path.
  timeout: 70_000,
}, async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'tinyedge-dpapi-integration-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const secrets = createWindowsDpapiSecretStore({ configDir })
  const value = 'access-secret-δ-🔒'

  // Both DPAPI scripts call Console.In.ReadToEnd(), so this test can only
  // complete when the Node parent writes the payload and closes child stdin.
  await secrets.write('oauth', value)
  const ciphertext = (await readFile(path.join(configDir, 'secrets', 'oauth.dpapi'), 'utf8')).trim()
  assert.doesNotMatch(ciphertext, /access-secret/)
  assert.notEqual(ciphertext, Buffer.from(value, 'utf8').toString('base64'))
  assert.match(ciphertext, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(await secrets.read('oauth'), value)

  await secrets.delete('oauth')
  assert.equal(await secrets.read('oauth'), null)
})

test('Linux Secret Service adapter uses stable attributes and keeps secrets off argv', async () => {
  const values = new Map()
  const calls = []
  const run = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options: { ...options } })
    const name = args.at(-1)
    if (args[0] === 'store') {
      values.set(name, options.input)
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'lookup' && values.has(name)) {
      return { stdout: values.get(name), stderr: '' }
    }
    if (args[0] === 'clear') {
      values.delete(name)
      return { stdout: '', stderr: '' }
    }
    const error = new Error('not found')
    error.code = 1
    error.tinyedgeStderrPresent = false
    throw error
  }
  const secrets = createLinuxSecretServiceSecretStore({ run })
  const value = 'access-secret-δ-🔒\n'

  await secrets.write('oauth', value)
  assert.equal(await secrets.read('oauth'), value)
  await secrets.delete('oauth')
  assert.equal(await secrets.read('oauth'), null)

  assert.equal(secrets.kind, 'linux-secret-service')
  assert.deepEqual(calls.map(({ executable }) => executable), [
    'secret-tool',
    'secret-tool',
    'secret-tool',
    'secret-tool',
  ])
  assert.deepEqual(calls[0].args, [
    'store',
    '--label=TinyEdge CLI credential',
    'application',
    'ai.tinyedge.cli',
    'credential',
    'oauth',
  ])
  assert.deepEqual(calls[1].args, [
    'lookup',
    'application',
    'ai.tinyedge.cli',
    'credential',
    'oauth',
  ])
  assert.deepEqual(calls[2].args, [
    'clear',
    'application',
    'ai.tinyedge.cli',
    'credential',
    'oauth',
  ])
  assert.equal(calls.some(({ args }) => args.includes(value)), false)
  assert.equal(calls[0].options.input, value)
  assert.equal(calls.slice(1).every(({ options }) => options.input === ''), true)
  assert.equal(calls.every(({ options }) => options.shell === false), true)
  assert.equal(calls.every(({ options }) => options.timeout === 15_000), true)
  assert.equal(calls.every(({ options }) => options.maxBuffer === 1024 * 1024), true)
})

test('Linux Secret Service adapter fails closed without leaking rejected input', async () => {
  const value = 'provider-secret-must-not-leak'
  const secrets = createLinuxSecretServiceSecretStore({
    run: async (_executable, _args, options) => {
      throw new Error(`helper failed while handling ${options.input}`)
    },
  })

  await assert.rejects(
    secrets.write('pi-provider-credentials', value),
    (error) => {
      assert.equal(error.code, 'TINYEDGE_SECRET_SERVICE_UNAVAILABLE')
      assert.match(error.message, /install secret-tool/i)
      assert.match(error.message, /unlock a Secret Service keyring/i)
      assert.doesNotMatch(error.message, new RegExp(value))
      return true
    },
  )
})

test('native secret store selects Linux Secret Service and rejects unsafe item names', async () => {
  let calls = 0
  const secrets = createNativeSecretStore({
    platform: 'linux',
    run: async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    },
  })

  assert.equal(secrets.kind, 'linux-secret-service')
  await assert.rejects(secrets.read('../oauth'), /secret name is invalid/)
  await assert.rejects(secrets.write('oauth', 'a'.repeat(8 * 1024)), /too large/)
  assert.equal(calls, 0)
  assert.throws(
    () => createNativeSecretStore({ platform: 'darwin' }),
    /not configured for darwin/,
  )
})

test('login persists OAuth results while keeping secrets out of terminal output', async () => {
  let saved
  let opened
  const logs = []
  const tokenStore = {
    save: async (value) => { saved = value },
    summary: async () => ({ connected: true }),
  }
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
        revocation_endpoint: 'http://127.0.0.1:3456/oauth/revoke',
        scopes_supported: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
      })
    }
    if (value.endsWith('/oauth/register')) return Response.json({ client_id: 'public-client' })
    return Response.json({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_in: 3600,
      scope: 'tinyedge:read tinyedge:write tinyedge:run',
    })
  }
  await loginCommand({
    config: {
      mcpUrl: 'http://127.0.0.1:3456/api/mcp',
      scopes: ['tinyedge:read', 'tinyedge:write', 'tinyedge:run'],
    },
    tokenStore,
    fetchImpl,
    openBrowser: (url) => { opened = url },
    callbackFactory: async ({ expectedState }) => ({
      redirectUri: 'http://127.0.0.1:49876/callback',
      result: Promise.resolve({ code: 'one-time-code', state: expectedState }),
      close() {},
    }),
    io: { log: (value) => logs.push(String(value)), error() {} },
  })
  assert.equal(saved.accessToken, 'access-secret')
  assert.match(opened, /\/oauth\/authorize/)
  assert.doesNotMatch(logs.join('\n'), /access-secret|refresh-secret|one-time-code/)
})

test('OAuth grant cannot silently elevate beyond explicitly requested scopes', () => {
  assert.doesNotThrow(() => validateGrantedScopes('tinyedge:read', ['tinyedge:read']))
  assert.throws(
    () => validateGrantedScopes('tinyedge:read tinyedge:run', ['tinyedge:read']),
    /unrequested scope: tinyedge:run/,
  )
  assert.throws(
    () => validateGrantedScopes('tinyedge:read', ['tinyedge:read', 'tinyedge:write']),
    /missing requested scope: tinyedge:write/,
  )
})

test('OAuth refresh cannot silently change the granted scope set', async () => {
  const tokens = {
    accessToken: 'old-access',
    refreshToken: 'refresh-secret',
    clientId: 'public-client',
    tokenEndpoint: 'https://tinyedge.ai/oauth/token',
    resource: 'https://tinyedge.ai/api/mcp',
    issuer: 'https://tinyedge.ai/',
    scope: 'tinyedge:read',
  }
  await assert.rejects(
    refreshAccessToken(tokens, async () => Response.json({
      access_token: 'new-access',
      scope: 'tinyedge:read tinyedge:run',
    })),
    /refresh changed the granted scopes/,
  )
})

test('logout removes local credentials even when revocation cannot be confirmed', async () => {
  let cleared = false
  const errors = []
  const result = await logoutCommand({
    tokenStore: {
      load: async () => ({
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        clientId: 'public-client',
        revocationEndpoint: 'https://tinyedge.ai/oauth/revoke',
      }),
      clear: async () => { cleared = true },
    },
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
    io: { log() {}, error: (value) => errors.push(String(value)) },
  })
  assert.equal(cleared, true)
  assert.equal(result.revoked, false)
  assert.doesNotMatch(errors.join('\n'), /access-secret|refresh-secret/)
})
