import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTinyEdgePiExtension } from '../src/pi-extension.js'

test('terminal command and assistant share conversation experiments, exact approval and persisted history without device access', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'experiment-extension-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const calls = [], notices = [], tools = new Map(), commands = new Map(), handlers = new Map()
  let experiments, workcell, sessionId = 'conversation-one'
  const pi = { registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, value) => commands.set(name, value),
    on: (name, handler) => handlers.set(name, handler), getActiveTools: () => [], setActiveTools() {} }
  createTinyEdgePiExtension({ standalone: true, env: {}, createConfigImpl: () => ({ configDir }),
    createPhysicalNodeClientImpl: () => ({ origin: 'http://127.0.0.1:8876', inspect() { calls.push('Node'); throw new Error('No Node access') } }),
    createCameraPreviewClientImpl: () => ({ status() { calls.push('camera'); throw new Error('No camera access') } }),
    createExecutionClientImpl: () => null,
    onExperiments: value => { experiments = value }, onWorkcell: value => { workcell = value },
  })(pi)
  const ctx = { mode: 'rpc', model: null, sessionManager: { getSessionId: () => sessionId },
    ui: { notify: message => notices.push(message), setWidget() {} } }
  t.after(() => handlers.get('session_shutdown')())
  await handlers.get('session_start')({}, ctx)
  assert.equal(workcell.snapshot().experiments.sessionId, sessionId)
  await commands.get('experiment').handler('plan align the synthetic fixture', ctx)
  const proposal = experiments.snapshot().current
  assert.equal(workcell.snapshot().experiments.current.id, proposal.id)
  await commands.get('experiment').handler('approve', ctx)
  assert.equal(experiments.snapshot().current.phase, 'PROPOSED')
  assert.match(notices.at(-1), /exact identifiers/)
  await commands.get('experiment').handler(`approve ${proposal.id} ${proposal.planDigest}`, ctx)
  const inspect = JSON.parse((await tools.get('inspect_local_experiment').execute('inspect', {})).content[0].text)
  assert.equal(inspect.current.phase, 'READY')
  assert.match(notices.at(-1), /ordinary message/)
  await commands.get('experiment').handler('stop', ctx)
  assert.equal(experiments.snapshot().current.phase, 'STOPPED')
  await handlers.get('session_shutdown')()
  assert.equal(experiments, null)
  sessionId = 'conversation-two'
  await handlers.get('session_start')({}, ctx)
  assert.equal(experiments.snapshot().current, null)
  await handlers.get('session_shutdown')()
  sessionId = 'conversation-one'
  await handlers.get('session_start')({}, ctx)
  assert.equal(experiments.snapshot().current.id, proposal.id)
  assert.equal(experiments.snapshot().current.phase, 'STOPPED')
  assert.deepEqual(calls, [])
})
