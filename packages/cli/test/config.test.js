import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createConfig,
  loginScopes,
  normalizeBaseUrl,
  protectedResourceMetadataUrl,
} from '../src/config.js'

test('config defaults to the production HTTPS MCP resource', () => {
  const config = createConfig({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, 'win32')
  assert.equal(config.baseUrl, 'https://tinyedge.ai')
  assert.equal(config.mcpUrl, 'https://tinyedge.ai/api/mcp')
  assert.match(config.configDir, /TinyEdge[\\/]cli$/)
  assert.deepEqual(config.scopes, ['tinyedge:read'])
})

test('login scope elevation is explicit and additive', () => {
  assert.deepEqual(loginScopes(), ['tinyedge:read'])
  assert.deepEqual(loginScopes({ allowWrite: true }), ['tinyedge:read', 'tinyedge:write'])
  assert.deepEqual(loginScopes({ allowRun: true }), ['tinyedge:read', 'tinyedge:run'])
})

test('base URL rejects credentials, paths, and remote plaintext HTTP', () => {
  assert.throws(() => normalizeBaseUrl('http://tinyedge.ai'), /requires HTTPS/)
  assert.throws(() => normalizeBaseUrl('https://user:secret@tinyedge.ai'), /credentials/)
  assert.throws(() => normalizeBaseUrl('https://tinyedge.ai/api'), /without a path/)
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3456'), 'http://127.0.0.1:3456')
})

test('protected resource metadata preserves the MCP resource path', () => {
  assert.equal(
    protectedResourceMetadataUrl('https://tinyedge.ai/api/mcp'),
    'https://tinyedge.ai/.well-known/oauth-protected-resource/api/mcp',
  )
})
