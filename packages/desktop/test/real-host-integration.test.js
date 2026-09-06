// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)

test('actual application, catalog and pinned Pi SDK work offline without Node or provider network access', async () => {
  // A clean child environment prevents ambient provider credentials from
  // participating. This exercises the actual SDK and provider listing APIs.
  const script = `
    import assert from 'node:assert/strict'
    import { mkdtemp, readFile, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    import { createApplication } from ${JSON.stringify(new URL('../src/application.js', import.meta.url).href)}
    import { openCatalog } from ${JSON.stringify(new URL('../src/catalog.js', import.meta.url).href)}
    const directory = await mkdtemp(path.join(tmpdir(), 'physicalsystems-real-desktop-integration-'))
    let networkReads = 0, nodeAttachments = 0
    globalThis.fetch = async () => { networkReads += 1; throw new Error('No network access is allowed in this integration test') }
    const values = new Map()
    const secretStore = { kind: 'memory', async read(key) { return values.get(key) ?? null }, async write(key, value) { values.set(key, value) }, async delete(key) { values.delete(key) } }
    const noAttach = () => { nodeAttachments += 1; throw new Error('No Node connection is allowed') }
    let catalog, application
    try {
      catalog = await openCatalog(directory)
      application = await createApplication({ dataDir: directory, catalog, secretStore, env: {}, connections: { attachLocal: noAttach, attachSSH: noAttach } })
      assert.equal(application.snapshot().projects.length, 0)
      await application.command('project.create', { name: 'Offline SDK project', connection: { type: 'local', label: 'Disconnected fixture', nodeUrl: 'http://127.0.0.1:19997' } })
      const first = application.snapshot()
      assert.equal(first.projects[0].connection.status, 'offline')
      assert.equal(first.projects[0].connection.deviceCount, null)
      assert.equal(first.conversation.model, null)
      assert.deepEqual(first.conversation.messages, [])
      const scope = { projectId: first.activeProjectId, conversationId: first.activeConversationId, connectionGeneration: first.connectionGeneration }
      await assert.rejects(application.command('conversation.send', { ...scope, text: 'Inspect my setup', requestId: 'offline-request-one' }), /Select a model and connect its provider in Settings/)
      assert.equal(application.snapshot().conversation.busy, false)
      await application.command('settings.get')
      const providers = application.snapshot().settings.providers
      assert.ok(providers.length > 0)
      assert.ok(providers.every((provider) => provider.configured === false))
      assert.deepEqual(application.snapshot().models, [])
      await application.command('conversation.rename', { ...scope, title: 'Saved offline conversation' })
      const stored = catalog.snapshot().conversations[0]
      assert.match(stored.sessionFile, /^harness\\/harness-sessions\\/[^/]+\\.jsonl$/)
      const bytes = await readFile(path.join(directory, stored.sessionFile), 'utf8')
      assert.equal(JSON.parse(bytes.split('\\n')[0]).type, 'session')
      await application.command('conversation.create', { projectId: scope.projectId, title: 'Second offline conversation' })
      assert.notEqual(application.snapshot().activeConversationId, scope.conversationId)
      await application.command('conversation.select', scope)
      assert.equal(application.snapshot().activeConversationId, scope.conversationId)
      assert.deepEqual(application.snapshot().conversation.messages, [])
      await application.close(); await catalog.close()
      catalog = await openCatalog(directory)
      application = await createApplication({ dataDir: directory, catalog, secretStore, env: {}, connections: { attachLocal: noAttach, attachSSH: noAttach } })
      assert.equal(application.snapshot().activeConversationId, scope.conversationId)
      assert.equal(application.snapshot().conversation.title, 'Saved offline conversation')
      assert.equal(application.snapshot().projects[0].connection.status, 'offline')
      assert.ok((await readFile(path.join(directory, stored.sessionFile), 'utf8')).startsWith(bytes), 'Existing transcript bytes remain an unchanged prefix; Pi may append its session settings metadata')
      assert.equal(nodeAttachments, 0)
      assert.equal(networkReads, 0)
      assert.equal(values.size, 0)
      console.log(JSON.stringify({ passed: true, providerCount: providers.length, nodeAttachments, networkReads, secretWrites: values.size }))
    } finally {
      await application?.close(); await catalog?.close(); await rm(directory, { recursive: true, force: true })
    }
  `
  const result = await run(process.execPath, ['--input-type=module', '--eval', script], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 30_000, maxBuffer: 128 * 1024,
  })
  assert.equal(result.stderr, '')
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.passed, true)
  assert.equal(evidence.nodeAttachments, 0)
  assert.equal(evidence.networkReads, 0)
  assert.equal(evidence.secretWrites, 0)
})
