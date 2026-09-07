// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createApplication } from '../src/application.js'
import { openCatalog } from '../src/catalog.js'

test('viewing completed history retains every unresolved simulation run and exact independent Stop', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'desktop-run-ownership-'))
  const catalog = await openCatalog(dataDir)
  const forbidden = async () => assert.fail('This regression must never access hardware, SSH or provider credentials')
  const app = await createApplication({ dataDir, catalog, env: {},
    secretStore: { read: forbidden, write: forbidden, delete: forbidden }, hostFactory: forbidden,
    connections: { attachLocal: forbidden, attachSSH: forbidden }, probeNode: forbidden })
  const scope = () => { const s = app.snapshot(); return { projectId: s.activeProjectId, conversationId: s.activeConversationId, connectionGeneration: s.connectionGeneration } }
  let waitingId
  t.after(async () => {
    // Explicitly recover the synthetic owner even when this regression fails.
    if (waitingId) {
      await app.command('conversation.cancel', scope()).catch(() => {})
      await app.command('workcell.execution.select', { ...scope(), runId: waitingId }).catch(() => {})
      await app.command('workcell.execution.stop', { ...scope(), runId: waitingId, reason: 'operator-requested-stop' }).catch(() => {})
    }
    await app.close(); await catalog.close(); await rm(dataDir, { recursive: true, force: true })
  })
  await app.command('project.create', { name: 'Synthetic ownership review', connection: { type: 'simulation' } })
  await app.command('conversation.send', { ...scope(), text: 'Plan a tray transfer', requestId: 'ownership_plan_one' })
  const question = app.snapshot().conversation.question
  await app.command('conversation.answer', { ...scope(), choiceId: question.choiceId, answer: 'Tray B' })
  await new Promise((resolve) => setImmediate(resolve))
  await app.command('workcell.execution.refresh', scope())
  const prepare = async () => {
    const wc = app.snapshot().workcell, configuration = wc.execution.configurations[0]
    await app.command('workcell.execution.prepare', { ...scope(), configurationId: configuration.configurationId,
      expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: wc.workflow.routeReceipt.receiptDigest })
    return app.snapshot().workcell.execution.run
  }
  const historical = await prepare()
  await app.command('workcell.execution.stop', { ...scope(), runId: historical.runId, reason: 'operator-requested-stop' })
  const waiting = await prepare(); waitingId = waiting.runId
  await app.command('workcell.execution.select', { ...scope(), runId: historical.runId })
  await app.command('workcell.execution.receipt', { ...scope(), runId: historical.runId })
  const selected = app.snapshot().workcell.execution
  assert.equal(selected.run.phase, 'CANCELLED')
  assert.deepEqual(app.snapshot().activeRuns.map((owner) => owner.run.runId), [waiting.runId])
  assert.equal(app.snapshot().activeRuns[0].canStop, true)
  await assert.rejects(app.close(), /Stop or resolve/)
  await assert.rejects(app.command('connection.disconnect', scope()), /Stop or resolve/)
  await assert.rejects(app.command('project.archive', scope()), /Stop or resolve/)
  await assert.rejects(app.command('conversation.archive', scope()), /Stop or resolve/)
  await assert.rejects(app.command('conversation.create', scope()), /resolve the current camera, run or experiment/)
  await app.command('conversation.send', { ...scope(), text: 'Plan another tray transfer', requestId: 'ownership_plan_busy' })
  assert.equal(app.snapshot().conversation.busy, true)
  await assert.rejects(app.command('workcell.execution.stop', { ...scope(), runId: 'run-ffffffffffffffffffffffffffffffff', reason: 'operator-requested-stop' }))
  await app.command('workcell.execution.stop', { ...scope(), runId: waiting.runId, reason: 'operator-requested-stop' })
  const stopped = app.snapshot().workcell.execution
  assert.equal(stopped.run.runId, historical.runId, 'Stop must not replace the reviewed history selection')
  assert.equal(stopped.run.runDigest, selected.run.runDigest)
  assert.deepEqual(stopped.receipt, selected.receipt, 'Stop must preserve the exact selected receipt')
  assert.equal(stopped.runs.find((run) => run.runId === waiting.runId).stopStatus, 'STOP_CONFIRMED')
  assert.deepEqual(app.snapshot().activeRuns, [])
  await app.command('conversation.cancel', scope())
  await app.close(); waitingId = null
})
