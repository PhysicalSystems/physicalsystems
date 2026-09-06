import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createSimulationHost } from '../src/simulation.js'

async function setup(t, extra = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'physicalsystems-desktop-simulation-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const options = { config: { configDir: path.join(cwd, 'harness') }, cwd, projectId: 'simulation-project', stepMs: 5, ...extra }
  let leave
  const host = await createSimulationHost({ ...options, onWorkcell(controller) { leave?.(); leave = controller?.onViewerConnect() } })
  t.after(async () => { await host.dispose(); leave?.() })
  await host.getWorkcell().refresh()
  return { host, options, cwd }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(fn) {
  for (let i = 0; i < 100; i += 1) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
  assert.fail('Expected simulation state was not reached')
}
async function plan(host, id = 'request_plan_one') {
  host.prompt('Plan a tray transfer', id)
  const question = host.getWorkcell().snapshot().agent.pendingChoice
  assert.ok(question)
  await host.getWorkcell().answerChoice({ choiceId: question.choiceId, answer: 'Tray B' })
  await tick()
  await host.getWorkcell().executionAction('refresh', {})
}
async function prepare(host) {
  const state = host.getWorkcell().snapshot(), config = state.execution.configurations[0]
  assert.ok(config)
  await host.getWorkcell().executionAction('prepare', { configurationId: config.configurationId,
    expectedConfigurationDigest: config.configurationDigest, routeReceiptDigest: state.workflow.routeReceipt.receiptDigest })
  return host.getWorkcell().snapshot().execution.run
}
const approveBody = (run) => ({ runId: run.runId, expectedRunDigest: run.runDigest, approvalDigest: run.approval.digest, approved: true })

test('scripted simulation discovers only synthetic devices and asks before creating an unapproved proposal', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => assert.fail('The scripted simulator must never make a network request')
  t.after(() => { globalThis.fetch = originalFetch })
  const { host } = await setup(t)
  assert.equal(host.snapshot().model.name, 'Simulation guide (scripted)')
  assert.equal(host.snapshot().scripted, true)
  assert.equal(host.getWorkcell().snapshot().workflow.snapshot.discovery.devices.length, 3)
  assert.equal(host.getWorkcell().snapshot().camera.status.captureSessionId, null)
  assert.equal(host.getWorkcell().snapshot().execution.run, null)
  host.prompt('Plan a tray transfer', 'request_question')
  assert.equal(host.snapshot().busy, true)
  const view = host.getWorkcell().snapshot()
  assert.equal(view.workflow.routeReceipt, null)
  assert.deepEqual(view.agent.pendingChoice.options, ['Tray B', 'Tray C'])
  assert.equal(host.prompt('Plan a tray transfer', 'request_question').duplicate, true)
  assert.throws(() => host.prompt('Other question', 'request_another'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  await host.getWorkcell().answerChoice({ choiceId: view.agent.pendingChoice.choiceId, answer: 'Tray C' })
  await tick()
  const planned = host.getWorkcell().snapshot()
  assert.equal(planned.workflow.routeReceipt.request.arguments.find((item) => item.name === 'destination').value, 'tray-c')
  assert.equal(planned.workflow.routeReceipt.physicalExecutionAuthorized, false)
  assert.equal(planned.execution.run, null)
  assert.equal(host.snapshot().busy, false)
  const report = await host.inspectSetup()
  assert.equal(report.service.mode, 'simulation')
  assert.equal(report.sources.discovery.status, 'cached')
  assert.equal(report.sources.catalog.status, 'cached')
  assert.equal(report.sources.route.status, 'cached')
  assert.equal(report.physicalExecutionAuthorized, false)
})

test('expired simulation approval cannot start any scripted step', async (t) => {
  let currentTime = Date.now()
  const { host } = await setup(t, { now: () => currentTime })
  await plan(host)
  const run = await prepare(host)
  currentTime += 61_000
  await host.getWorkcell().executionAction('refresh', {})
  assert.equal(host.getWorkcell().snapshot().execution.canApprove, false)
  await assert.rejects(host.getWorkcell().executionAction('approve', approveBody(run)))
  assert.equal(host.getWorkcell().snapshot().execution.run.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(host.getWorkcell().snapshot().execution.run.events.length, 1)
  await host.getWorkcell().executionAction('stop', { runId: run.runId, reason: 'operator-requested-stop' })
  assert.equal(host.getWorkcell().snapshot().execution.run.phase, 'CANCELLED')
})

test('simulation runs require exact approval and create a verified synthetic receipt after three steps', async (t) => {
  const { host, options } = await setup(t)
  await plan(host)
  const run = await prepare(host)
  assert.equal(run.phase, 'WAITING_FOR_APPROVAL')
  await assert.rejects(host.getWorkcell().executionAction('approve', { ...approveBody(run), approved: false }))
  await assert.rejects(host.getWorkcell().executionAction('approve', { ...approveBody(run), approvalDigest: `sha256:${'f'.repeat(64)}` }))
  assert.equal(host.getWorkcell().snapshot().execution.run.phase, 'WAITING_FOR_APPROVAL')
  await host.getWorkcell().executionAction('approve', approveBody(run))
  await assert.rejects(host.getWorkcell().executionAction('approve', approveBody(run)))
  await until(() => host.getWorkcell().snapshot().execution.run.phase === 'VERIFIED_SUCCESS')
  const complete = host.getWorkcell().snapshot().execution.run
  assert.equal(complete.mode, 'simulation')
  assert.equal(complete.physicalExecutionAuthorized, false)
  assert.equal(complete.events.filter((event) => event.type.endsWith('_simulated')).length, 3)
  await host.getWorkcell().executionAction('receipt', { runId: run.runId })
  const receipt = host.getWorkcell().snapshot().execution.receipt
  assert.equal(receipt.verification.mode, 'simulation')
  assert.equal(receipt.verification.verified, 'met')
  assert.equal(receipt.verification.historical, true)
  const saved = host.snapshot().sessionFile
  await host.dispose()
  const reopened = await createSimulationHost({ ...options, sessionFile: saved })
  t.after(() => reopened.dispose())
  await reopened.getWorkcell().executionAction('refresh', {})
  await reopened.getWorkcell().executionAction('select', { runId: run.runId })
  await reopened.getWorkcell().executionAction('receipt', { runId: run.runId })
  assert.equal(reopened.getWorkcell().snapshot().execution.receipt.verification.verified, 'met')
})

test('run Stop works while a separate guide question is busy and prevents remaining scripted steps', async (t) => {
  const { host } = await setup(t, { stepMs: 20 })
  await plan(host)
  const run = await prepare(host)
  await host.getWorkcell().executionAction('approve', approveBody(run))
  host.prompt('Plan another tray transfer', 'request_while_running')
  assert.equal(host.snapshot().busy, true)
  await host.getWorkcell().executionAction('stop', { runId: run.runId, reason: 'operator-requested-stop' })
  assert.equal(host.getWorkcell().snapshot().execution.run.phase, 'CANCELLED')
  assert.equal(host.getWorkcell().snapshot().execution.run.stopStatus, 'STOP_CONFIRMED')
  await host.cancel()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await host.getWorkcell().executionAction('refresh', {})
  assert.equal(host.getWorkcell().snapshot().execution.run.phase, 'CANCELLED')
  await host.getWorkcell().executionAction('receipt', { runId: run.runId })
  assert.equal(host.getWorkcell().snapshot().execution.receipt.verification, null)
})

test('synthetic camera starts only on exact selection; Stop clears image and retains truthful identity', async (t) => {
  const { host } = await setup(t)
  const wc = host.getWorkcell(), candidate = wc.snapshot().camera.status.availableCameras[0]
  await assert.rejects(wc.cameraAction('start', { candidateId: 'another-camera', expectedCandidateDigest: candidate.candidateDigest }))
  // A rejected Start is deliberately unconfirmed in the shared controller.
  await wc.refresh()
  await wc.cameraAction('start', { candidateId: candidate.candidateId, expectedCandidateDigest: candidate.candidateDigest })
  await until(() => wc.snapshot().camera.frame)
  const camera = wc.snapshot().camera, frame = await wc.cameraFrame(camera.previewFrameId)
  assert.equal(frame.contentType, 'image/jpeg')
  assert.equal(camera.frame.source.kind, 'synthetic')
  assert.equal(camera.frame.preview.width, 1)
  assert.equal(camera.frame.preview.height, 1)
  assert.equal(camera.frame.captureSessionId, camera.status.captureSessionId)
  await assert.rejects(host.createSession(), { code: 'ERR_HARNESS_OPERATION_ACTIVE' })
  host.prompt('Plan a tray transfer', 'request_camera_busy')
  await wc.cameraAction('stop', { expectedCaptureSessionId: camera.status.captureSessionId })
  assert.equal(wc.snapshot().camera.status.phase, 'stopped')
  assert.equal(wc.snapshot().camera.frame, null)
  assert.equal(wc.snapshot().camera.stopCaptureSessionId, null)
  await assert.rejects(wc.cameraFrame(camera.previewFrameId))
  await host.cancel()
  const stored = await readFile(host.snapshot().sessionFile, 'utf8')
  assert.doesNotMatch(stored, /jpegBytes|\/9j\/|previewDigest/)
})

test('cancellation expires the guide question and saved conversation resumes without inventing a proposal', async (t) => {
  const { host, cwd } = await setup(t)
  const first = host.snapshot()
  host.prompt('Plan a tray transfer', 'request_cancelled')
  const question = host.getWorkcell().snapshot().agent.pendingChoice
  await host.cancel()
  await assert.rejects(host.getWorkcell().answerChoice({ choiceId: question.choiceId, answer: 'Tray B' }))
  assert.equal(host.getWorkcell().snapshot().workflow.routeReceipt, null)
  await host.renameSession(first.sessionFile, 'Cancelled transfer')
  await host.createSession()
  await host.openSession(first.sessionFile)
  assert.equal(host.snapshot().name, 'Cancelled transfer')
  assert.match(host.snapshot().messages.at(-1).text, /cancelled/)
  const outside = path.join(cwd, 'outside.jsonl')
  await writeFile(outside, 'unrelated')
  await assert.rejects(host.openSession(outside))
  const link = path.join(path.dirname(first.sessionFile), 'symlink.jsonl')
  await symlink(outside, link)
  await assert.rejects(host.openSession(link))
  assert.equal(await readFile(outside, 'utf8'), 'unrelated')
})

test('a stopped simulation process restores an unfinished run as unknown without replaying it', async (t) => {
  const { host, options } = await setup(t, { stepMs: 1000 })
  await plan(host)
  const run = await prepare(host)
  await host.getWorkcell().executionAction('approve', approveBody(run))
  const file = host.snapshot().sessionFile
  await host.dispose()
  const restored = await createSimulationHost({ ...options, sessionFile: file })
  t.after(() => restored.dispose())
  await restored.getWorkcell().executionAction('refresh', {})
  assert.equal(restored.getWorkcell().snapshot().execution.run.phase, 'OUTCOME_UNKNOWN')
  assert.equal(restored.getWorkcell().snapshot().execution.canPrepare, false)
  await restored.getWorkcell().executionAction('stop', { runId: run.runId, reason: 'operator-requested-stop' })
  assert.equal(restored.getWorkcell().snapshot().execution.run.phase, 'CANCELLED')
})
