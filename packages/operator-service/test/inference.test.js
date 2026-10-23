// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createSshNodeFetch } from '../src/ssh-node-fetch.js'
import { createOperatorService, createPublicClients } from '../src/index.js'
import { normalizeLocalEndpoint } from '../../desktop/src/connections.js'
import { createInferenceClient, normalizeInference } from '../../cli/src/physical/inference-client.js'

const stopped = { contractVersion: 'physicalsystems-inference-v1', phase: 'STOPPED', runtimeId: null,
  manifestSha256: 'b'.repeat(64), generation: 1, releaseId: 'fixture-release', image: 'sha256:' + 'c'.repeat(64),
  details: null, error: null, motorCommandsSent: 0 }
const ready = { ...stopped, runtimeId: 'd'.repeat(32), phase: 'READY', details: { ready: true, gpu: 'Fixture GPU', warmupMs: 1, chunkSize: 100 } }

test('SSH transport preserves the remote authority on the wire and refuses redirects and alternate origins', async t => {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    calls.push({ host: request.headers.host, auth: request.headers.authorization, body: Buffer.concat(chunks).toString() })
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'http://example.invalid' }); response.end(); return }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(stopped))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const client = createPublicClients({ endpoint, remotePort: 8876, credential: { executionToken: 'fixture-token' } }).inference
  assert.equal((await client.status()).phase, 'STOPPED')
  await client.start({ manifestSha256: stopped.manifestSha256, generation: 1 })
  assert.equal(calls[0].host, '127.0.0.1:8876')
  assert.equal(calls[0].auth, 'Bearer fixture-token')
  assert.equal(JSON.parse(calls[1].body).generation, 1)
  const transport = createSshNodeFetch(endpoint, 8876)
  await assert.rejects(transport(endpoint + '/redirect', { redirect: 'error' }), /redirects/)
  await assert.rejects(transport('http://example.invalid'), /endpoint/)
})

test('operator starts the exact model, authenticates requests, and fences a late response after Stop', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'inference-operator-'))
  const credentials = new Map(), calls = [], endpoint = 'http://127.0.0.1:8876'
  let delayed, release, started
  const startReceived = new Promise(resolve => { started = resolve })
  const service = await createOperatorService({ dataDir, allowDeviceConnections: true,
    secretStore: { read: async key => credentials.get(key), write: async (key, value) => credentials.set(key, value), delete: async key => credentials.delete(key) },
    clientFactory: options => ({ ...createPublicClients({ ...options, fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/start')) { started(); if (delayed) await new Promise(resolve => { release = resolve }); return Response.json(ready) }
      return Response.json(stopped)
    } }), node: { origin: endpoint, inspect: async () => ({ nodeName: 'fixture-node', discovery: { devices: [], observedAt: new Date().toISOString() } }) },
    camera: { status: async () => ({ phase: 'idle', captureSessionId: null, availableCameras: [] }) } }),
    connections: { normalizeLocalEndpoint, attachLocal: async (profile, options) => ({ endpoint, identity: await options.probeNode({ endpoint }), close: async () => {} }) },
  })
  t.after(async () => { release?.(); await service.close(); await rm(dataDir, { recursive: true, force: true }) })
  const projectId = (await service.command('project.create', { name: 'Inference fixture', connection: { type: 'local', nodeUrl: endpoint } })).activeProjectId
  await service.command('connection.saveCredential', { projectId, cameraToken: 'fixture-camera-token', executionToken: 'fixture-runtime-token' })
  const bound = await service.command('session.bind', { projectId, serverId: 'fixture-server', sessionId: 'fixture-session' })
  await service.command('connection.connect', { projectId })
  const scope = { ...bound.binding, connectionGeneration: service.snapshot().connectionGeneration }
  assert.equal(calls.length, 0, 'Connecting must not load or inspect a model')
  await service.command('inference.refresh', scope)
  assert.equal(service.snapshot().modelRuntime.phase, 'STOPPED')
  await assert.rejects(service.command('inference.start', { ...scope, manifestSha256: '../model', generation: 1 }), /selected model/i)
  await assert.rejects(service.agentCall({ agentToken: bound.agentToken, name: 'inference.start', arguments: {}, callId: 'forbidden' }))
  await service.command('inference.start', { ...scope, manifestSha256: stopped.manifestSha256, generation: 1 })
  assert.equal(service.snapshot().modelRuntime.phase, 'READY')
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { manifestSha256: stopped.manifestSha256, generation: 1 })
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer fixture-runtime-token')
  delayed = true
  const pending = service.command('inference.start', { ...scope, manifestSha256: stopped.manifestSha256, generation: 1 })
  // FetchImpl has entered synchronously up to its first await.
  await startReceived
  await service.command('inference.stop', { ...scope, runtimeId: ready.runtimeId })
  release(); await pending
  assert.equal(service.snapshot().modelRuntime.phase, 'STOPPED')
})

test('inference client rejects unavailable, oversized, and fabricated ready responses', async () => {
  assert.throws(() => normalizeInference({ ...ready, motorCommandsSent: 1 }))
  assert.throws(() => normalizeInference({ ...ready, details: null }))
  assert.throws(() => normalizeInference({ ...ready, runtimeId: null }))
  for (const response of [new Response('x'.repeat(17000)), Response.json({ secret: 'never reflect this' }, { status: 503 }), Response.json({ ...ready, details: null })]) {
    const client = createInferenceClient({ baseUrl: 'http://127.0.0.1:8876', token: 'fixture', fetchImpl: async () => response })
    await assert.rejects(client.status(), error => !error.message.includes('never reflect this'))
  }
})
