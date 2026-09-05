import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkcellController, WORKCELL_VIEW_VERSION } from '../src/harness/workcell-controller.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function setup(t, overrides = {}) {
  const calls = { intents: [], invalidations: 0, refreshes: 0, frames: 0, starts: [], stops: [] }
  let packet = { status: { phase: 'idle', captureSessionId: null }, frame: null }
  const cameraClient = {
    async frame() { calls.frames += 1; return packet },
    async start(body) {
      calls.starts.push(body)
      packet = { status: { phase: 'live', captureSessionId: 'capture-one' }, frame: null }
      return packet.status
    },
    async stop(body) {
      calls.stops.push(body)
      packet = { status: { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId }, frame: null }
      return packet.status
    },
  }
  const controller = createWorkcellController({
    workflow: { status: 'unchecked', generation: 0 },
    refreshWorkflow: async () => { calls.refreshes += 1 },
    invalidateWorkflow: () => { calls.invalidations += 1 },
    sendIntent: async (text) => { calls.intents.push(text) },
    modelLabel: () => 'provider/model',
    cameraClient,
    pollMs: 60_000,
    ...overrides,
  })
  t.after(() => controller.dispose())
  return { controller, calls, cameraClient, setPacket: (value) => { packet = value } }
}

test('workcell controller starts inert and presents no execution authority', async (t) => {
  const { controller, calls } = setup(t)
  const initial = controller.snapshot()
  assert.equal(initial.contractVersion, WORKCELL_VIEW_VERSION)
  assert.equal(initial.physicalExecutionAuthorized, false)
  assert.equal(initial.agent.model, 'provider/model')
  assert.equal(initial.agent.status, 'idle')
  assert.equal(initial.camera.availability, 'unchecked')
  assert.equal(controller.shouldAskInView(), false)
  assert.equal(await controller.ask({ kind: 'select', question: 'Continue?', options: ['Yes', 'No'] }), null)
  await tick()
  assert.deepEqual(calls, { intents: [], invalidations: 0, refreshes: 0, frames: 0, starts: [], stops: [] })
})

test('workflow and model notifications do not expand authority and one bad viewer cannot break the session', (t) => {
  let label = 'provider/first'
  const { controller } = setup(t, { modelLabel: () => label })
  let notices = 0
  controller.subscribe(() => { throw new Error('broken viewer') })
  const unsubscribe = controller.subscribe(() => { notices += 1 })
  controller.setWorkflow({ status: 'ready', generation: 2 })
  label = 'provider/second'
  controller.modelChanged()
  assert.equal(notices, 2)
  assert.equal(controller.snapshot().agent.model, label)
  assert.equal(controller.snapshot().workflow.generation, 2)
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
  unsubscribe()
  controller.modelChanged()
  assert.equal(notices, 2)
})

test('intent accepts once without awaiting the shared agent and rejects simultaneous browser requests', async (t) => {
  const pending = deferred()
  const sent = []
  const { controller, calls } = setup(t, { sendIntent: (text) => { sent.push(text); return pending.promise } })
  assert.deepEqual(await controller.submitIntent('  Inspect the workcell  '), {
    accepted: true, physicalExecutionAuthorized: false,
  })
  await assert.rejects(controller.submitIntent('Move another container'), /current agent request/)
  await assert.rejects(controller.refresh(), /current agent request/)
  await assert.rejects(controller.cameraAction('start', {}), /current request/)
  assert.equal(controller.snapshot().agent.status, 'working')
  assert.deepEqual(sent, ['Inspect the workcell'])
  assert.equal(calls.invalidations, 1)
  pending.resolve()
  await tick()
  assert.equal(controller.snapshot().agent.status, 'working', 'only the actual Pi settled event ends a run')
  controller.agentSettled()
  assert.equal(controller.snapshot().agent.status, 'idle')
})

test('intent rejects terminal commands, control characters and unavailable model before dispatch', async (t) => {
  const { controller, calls } = setup(t)
  for (const value of ['', ' ', '/physical transfer', '!whoami', 'first\nsecond', 'x'.repeat(501), {}, null]) {
    await assert.rejects(controller.submitIntent(value), /physical outcome|terminal command/)
  }
  assert.equal(calls.intents.length, 0)
  assert.equal(calls.invalidations, 0)
  const busy = setup(t, { canPrompt: () => false, modelLabel: () => null })
  await assert.rejects(busy.controller.submitIntent('Inspect the workcell'), /Select a model/)
  assert.equal(busy.calls.intents.length, 0)
})

test('a gated terminal preflight with a configured model reports busy rather than missing model', async (t) => {
  const { controller, calls } = setup(t, { canPrompt: () => false, modelLabel: () => 'provider/configured-model' })
  assert.equal(controller.snapshot().agent.status, 'idle')
  await assert.rejects(controller.submitIntent('Inspect the workcell'), (error) => {
    assert.equal(error.code, 'agent_busy')
    assert.match(error.message, /current agent request/)
    assert.doesNotMatch(error.message, /select a model/i)
    return true
  })
  assert.equal(calls.intents.length, 0)
})

test('shared-session prompt failures are bounded and redacted and release the browser busy latch', async (t) => {
  let fail = true
  const { controller } = setup(t, {
    sendIntent: async () => { if (fail) throw new Error(`Bearer private-token ${'x'.repeat(600)}`) },
  })
  await controller.submitIntent('Inspect the camera')
  await tick()
  const failed = controller.snapshot().agent
  assert.equal(failed.status, 'idle')
  assert.match(failed.error, /REDACTED/)
  assert.doesNotMatch(failed.error, /private-token/)
  assert.ok(failed.error.length <= 350)
  fail = false
  await controller.submitIntent('Try inspection again')
  assert.equal(controller.snapshot().agent.error, null)
})

test('late failure from an older accepted prompt cannot overwrite a new turn', async (t) => {
  const first = deferred()
  const second = deferred()
  let sent = 0
  const { controller } = setup(t, { sendIntent: () => (++sent === 1 ? first.promise : second.promise) })
  await controller.submitIntent('First inspection')
  controller.agentSettled()
  await controller.submitIntent('Second inspection')
  first.reject(new Error('obsolete first error'))
  await tick()
  assert.equal(controller.snapshot().agent.intent, 'Second inspection')
  assert.equal(controller.snapshot().agent.status, 'working')
  assert.equal(controller.snapshot().agent.error, null)
  second.resolve()
})

test('shutdown before the accepted dispatch microtask prevents the shared session from receiving input', async (t) => {
  const { controller, calls } = setup(t)
  const accepted = controller.submitIntent('Inspect the workcell')
  const disposed = controller.dispose()
  await Promise.all([accepted, disposed])
  await tick()
  assert.deepEqual(calls.intents, [])
  assert.equal(controller.snapshot().agent.canPrompt, false)
})

test('agent projection exposes ordinary text only and never reasoning, raw tool data or provider metadata', (t) => {
  const { controller } = setup(t)
  controller.agentStart('Inspect\u001b\u202ethe camera')
  controller.agentMessage({
    role: 'assistant', content: [
      { type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'text', text: 'Camera found.' },
      { type: 'toolCall', id: 'PRIVATE_CALL', name: 'PRIVATE_TOOL', arguments: { token: 'PRIVATE_ARGUMENT' } },
      { type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/jpeg' },
      { type: 'text', text: 'Choose a camera.' },
    ],
    providerMetadata: { secret: 'PRIVATE_METADATA' }, errorMessage: 'PRIVATE_ERROR',
  })
  assert.equal(controller.snapshot().agent.reply, 'Camera found.\nChoose a camera.')
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE_|\u001b|\u202e/)
  controller.agentMessage({ role: 'user', content: [{ type: 'text', text: 'not an assistant reply' }] })
  assert.equal(controller.snapshot().agent.reply, 'Camera found.\nChoose a camera.')
  controller.agentMessage({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(9000) }], stopReason: 'error', errorMessage: 'PRIVATE_FAILURE' })
  assert.equal(controller.snapshot().agent.reply.length, 8000)
  assert.match(controller.snapshot().agent.error, /check the terminal/)
  controller.agentTool('inspect_physical_system')
  assert.equal(controller.snapshot().agent.tool, 'inspect_physical_system')
  controller.agentSettled()
  assert.equal(controller.snapshot().agent.status, 'idle')
  assert.equal(controller.snapshot().agent.tool, null)
})

test('browser choices accept only the current offered answer and resolve once', async (t) => {
  const { controller } = setup(t)
  const close = controller.onViewerConnect()
  await controller.submitIntent('Inspect the workcell')
  assert.equal(controller.shouldAskInView(), true)
  const answer = controller.ask({ kind: 'select', question: 'Which camera?', options: ['Overhead', 'Wrist'] })
  const pending = controller.snapshot().agent.pendingChoice
  assert.equal(pending.kind, 'select')
  await assert.rejects(controller.answerChoice({ choiceId: 'obsolete', answer: 'Overhead' }), /no longer current/)
  await assert.rejects(controller.answerChoice({ choiceId: pending.choiceId, answer: 'Undiscovered camera' }), /displayed answers/)
  assert.equal(controller.snapshot().agent.pendingChoice.choiceId, pending.choiceId)
  assert.deepEqual(await controller.answerChoice({ choiceId: pending.choiceId, answer: 'Overhead' }), { accepted: true, physicalExecutionAuthorized: false })
  assert.equal(await answer, 'Overhead')
  await assert.rejects(controller.answerChoice({ choiceId: pending.choiceId, answer: 'Wrist' }), /no longer current/)
  assert.equal(controller.snapshot().agent.pendingChoice, null)
  close()
})

test('custom answers are bounded and an explicit cancellation is not a positive answer', async (t) => {
  const { controller } = setup(t)
  const close = controller.onViewerConnect()
  const typed = controller.ask({ kind: 'input', question: 'Describe the station' })
  const first = controller.snapshot().agent.pendingChoice.choiceId
  await assert.rejects(controller.answerChoice({ choiceId: first, answer: 'x'.repeat(2001) }), /bounded/)
  await controller.answerChoice({ choiceId: first, answer: '  The left rack  ' })
  assert.equal(await typed, 'The left rack')
  const cancelled = controller.ask({ kind: 'select', question: 'Continue?', options: ['Continue', 'Stop'] })
  await controller.answerChoice({ choiceId: controller.snapshot().agent.pendingChoice.choiceId, answer: null })
  assert.equal(await cancelled, null)
  close()
})

test('abort, last-viewer disconnect and shutdown cancel pending choices without selecting a default', async (t) => {
  const { controller } = setup(t)
  const firstClose = controller.onViewerConnect()
  const lastClose = controller.onViewerConnect()
  const abort = new AbortController()
  const aborted = controller.ask({ kind: 'select', question: 'Continue?', options: ['Continue', 'Stop'], signal: abort.signal })
  abort.abort()
  assert.equal(await aborted, null)
  assert.equal(await controller.ask({ kind: 'input', question: 'Answer', signal: abort.signal }), null)
  const disconnected = controller.ask({ kind: 'input', question: 'Answer' })
  firstClose()
  firstClose()
  assert.notEqual(controller.snapshot().agent.pendingChoice, null)
  lastClose()
  assert.equal(await disconnected, null)
  const close = controller.onViewerConnect()
  const stopped = controller.ask({ kind: 'input', question: 'Answer' })
  await controller.dispose()
  assert.equal(await stopped, null)
  assert.equal(controller.shouldAskInView(), false)
  await assert.rejects(controller.submitIntent('Inspect'), /session ended/)
  assert.throws(() => controller.onViewerConnect(), /session ended/)
  close()
})

test('choice timeout cancels and cannot be answered afterwards', async (t) => {
  const { controller } = setup(t, { choiceTimeoutMs: 5 })
  const close = controller.onViewerConnect()
  const answer = controller.ask({ kind: 'input', question: 'Answer' })
  const id = controller.snapshot().agent.pendingChoice.choiceId
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(await answer, null)
  await assert.rejects(controller.answerChoice({ choiceId: id, answer: 'Late answer' }), /no longer current/)
  close()
})

test('opening viewers and refreshing only read camera state; start requires explicit selected candidate', async (t) => {
  const { controller, calls } = setup(t)
  const close = controller.onViewerConnect()
  await tick()
  assert.equal(calls.frames, 1)
  assert.equal(calls.starts.length, 0)
  await controller.refresh()
  assert.equal(calls.refreshes, 1)
  assert.equal(calls.starts.length, 0)
  const selection = { candidateId: 'camera-overhead', expectedCandidateDigest: `sha256:${'a'.repeat(64)}` }
  await controller.cameraAction('start', selection)
  assert.deepEqual(calls.starts, [selection])
  assert.equal(controller.snapshot().camera.status.captureSessionId, 'capture-one')
  assert.equal(controller.snapshot().physicalExecutionAuthorized, false)
  await controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'capture-one' }])
  close()
  await controller.dispose()
  assert.equal(calls.stops.length, 1, 'an explicitly stopped session is not stopped twice')
})

test('camera inventory stays available across frame polling without automatically selecting or starting a camera', async (t) => {
  const candidates = [
    { candidateId: 'overhead-camera', candidateDigest: `sha256:${'a'.repeat(64)}`, displayName: 'Overhead' },
    { candidateId: 'wrist-camera', candidateDigest: `sha256:${'b'.repeat(64)}`, displayName: 'Wrist' },
  ]
  let inventories = 0
  let starts = 0
  const { controller } = setup(t, { cameraClient: {
    async status() { inventories += 1; return { phase: 'idle', captureSessionId: null, availableCameras: candidates } },
    async frame() { return { status: { phase: 'idle', captureSessionId: null }, frame: null } },
    async start() { starts += 1; throw new Error('Must not select a camera automatically') },
  } })
  const close = controller.onViewerConnect()
  await tick()
  assert.equal(inventories, 1)
  assert.deepEqual(controller.snapshot().camera.status.availableCameras, candidates)
  assert.equal(controller.snapshot().camera.status.captureSessionId, null)
  await controller.refresh()
  assert.equal(inventories, 2)
  assert.deepEqual(controller.snapshot().camera.status.availableCameras, candidates)
  assert.equal(starts, 0)
  close()
})

test('camera frame snapshot excludes JPEG bytes and only the exact currently retained preview is retrievable', async (t) => {
  const { controller, calls, setPacket } = setup(t)
  const bytes = Buffer.from('test-only-jpeg-payload')
  const frame = { captureSessionId: 'existing-capture', sequence: 1, previewDigest: `sha256:${'a'.repeat(64)}`, jpegBytes: bytes }
  setPacket({ status: { phase: 'live', captureSessionId: 'existing-capture' }, frame })
  const close = controller.onViewerConnect()
  await tick()
  const first = controller.snapshot().camera.previewFrameId
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(controller.snapshot().camera.frame.jpegBytes, undefined)
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /test-only-jpeg-payload/)
  assert.deepEqual(await controller.cameraFrame(first), { bytes, contentType: 'image/jpeg' })
  setPacket({ status: { phase: 'live', captureSessionId: 'existing-capture' }, frame: { ...frame, sequence: 2 } })
  await controller.refresh()
  assert.notEqual(controller.snapshot().camera.previewFrameId, first)
  await assert.rejects(controller.cameraFrame(first), /no longer retained/)
  close()
  await controller.dispose()
  assert.equal(calls.stops.length, 0, 'viewing an independently started session does not confer ownership')
})

test('camera disappearance removes its cached frame and invalidates prior workflow evidence', async (t) => {
  let fail = false
  const cameraClient = {
    async frame() {
      if (fail) throw new Error('Bearer camera-secret unplugged')
      return { status: { phase: 'live', captureSessionId: 'capture-one' }, frame: {
        captureSessionId: 'capture-one', sequence: 1, previewDigest: 'digest', jpegBytes: Buffer.from('jpeg'),
      } }
    },
  }
  const { controller, calls } = setup(t, { cameraClient })
  const close = controller.onViewerConnect()
  await tick()
  const first = controller.snapshot().camera.previewFrameId
  fail = true
  await controller.refresh()
  assert.equal(controller.snapshot().camera.availability, 'unavailable')
  assert.equal(controller.snapshot().camera.frame, null)
  assert.equal(controller.snapshot().camera.previewFrameId, null)
  assert.doesNotMatch(controller.snapshot().camera.error, /camera-secret/)
  assert.equal(calls.invalidations, 1)
  await assert.rejects(controller.cameraFrame(first), /no longer retained/)
  close()
})

test('controller cleanup stops only a camera capture it explicitly started', async (t) => {
  const { controller, calls } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  await controller.dispose()
  await controller.dispose()
  assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'capture-one' }])
})

test('shutdown while camera start is pending cannot leave the new capture running', async (t) => {
  const starting = deferred()
  const stopping = deferred()
  const stops = []
  const { controller } = setup(t, { cameraClient: {
    async frame() { return { status: { phase: 'idle', captureSessionId: null }, frame: null } },
    async start() { return starting.promise },
    async stop(body) { stops.push(body); await stopping.promise; return { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId } },
  } })
  const action = controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  const actionResult = Promise.allSettled([action])
  await tick()
  const disposing = controller.dispose()
  let disposed = false
  void disposing.then(() => { disposed = true })
  await tick()
  assert.equal(disposed, false, 'host must not exit while camera start is pending')
  starting.resolve({ phase: 'live', captureSessionId: 'late-capture' })
  await tick()
  assert.equal(disposed, false, 'host must wait for the exact late-session stop')
  assert.deepEqual(stops, [{ expectedCaptureSessionId: 'late-capture' }])
  stopping.resolve()
  await disposing
  await actionResult
  assert.equal(disposed, true)
})

test('shutdown while a previous frame read is pending does not begin a queued camera start', async (t) => {
  const reading = deferred()
  const starts = []
  const { controller } = setup(t, { cameraClient: {
    async frame() { return reading.promise },
    async start(body) { starts.push(body); return { phase: 'live', captureSessionId: 'too-late' } },
    async stop() { return { phase: 'stopped' } },
  } })
  const close = controller.onViewerConnect()
  const action = controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  const disposing = controller.dispose()
  reading.resolve({ status: { phase: 'idle', captureSessionId: null }, frame: null })
  await Promise.allSettled([action, disposing])
  assert.deepEqual(starts, [])
  close()
})

test('camera Stop bypasses a working assistant and clears the exact capture', async (t) => {
  const { controller, calls } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  controller.agentStart('Inspect the workcell')
  await controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'capture-one' }])
  assert.equal(controller.snapshot().camera.status.phase, 'stopped')
  assert.equal(controller.snapshot().camera.frame, null)
  assert.equal(controller.snapshot().agent.status, 'working')
})

test('camera Stop bypasses an in-flight frame read and its late response cannot restore pixels', async (t) => {
  const reading = deferred()
  const { controller, calls, cameraClient } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  cameraClient.frame = async () => reading.promise
  const refreshing = controller.refresh()
  await tick()
  const stopping = controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  await tick()
  const stopsBeforeReadCompleted = calls.stops.length
  reading.resolve({ status: { phase: 'live', captureSessionId: 'capture-one' }, frame: {
    captureSessionId: 'capture-one', sequence: 1, previewDigest: 'digest', jpegBytes: Buffer.from('synthetic-frame'),
  } })
  await Promise.all([refreshing, stopping])
  assert.equal(stopsBeforeReadCompleted, 1, 'Stop must reach the client before a prior read completes')
  assert.equal(controller.snapshot().camera.frame, null)
  assert.equal(controller.snapshot().camera.previewFrameId, null)
  assert.notEqual(controller.snapshot().camera.status.phase, 'live')
})

test('unconfirmed and failed stops retain exact ownership for cleanup and block another Start', async (t) => {
  for (const result of ['stop-unconfirmed', 'error']) {
    const { controller, calls, cameraClient } = setup(t)
    await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
    cameraClient.stop = async (body) => {
      calls.stops.push(body)
      if (calls.stops.length === 1) {
        if (result === 'error') throw new Error('private adapter diagnostics')
        return { phase: 'stop-unconfirmed', captureSessionId: body.expectedCaptureSessionId }
      }
      return { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId }
    }
    await controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' }).catch(() => {})
    const state = controller.snapshot().camera
    assert.equal(state.stopUnconfirmed, true)
    assert.equal(state.stopCaptureSessionId, 'capture-one')
    await assert.rejects(controller.cameraAction('start', { candidateId: 'camera-two', expectedCandidateDigest: 'other-digest' }))
    await controller.dispose()
    assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'capture-one' }, { expectedCaptureSessionId: 'capture-one' }])
    assert.equal(calls.starts.length, 1)
    assert.doesNotMatch(JSON.stringify(state), /private adapter/)
  }
})

test('Stop cancels only this controller pending Start and cleans up its exact late session', async (t) => {
  const starting = deferred(), stopping = deferred()
  const stops = []
  const { controller } = setup(t, { cameraClient: {
    async frame() { return { status: { phase: 'idle', captureSessionId: null }, frame: null } },
    async start() { return starting.promise },
    async stop(body) { stops.push(body); await stopping.promise; return { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId } },
  } })
  const action = controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  const actionResult = Promise.allSettled([action])
  await tick()
  const cancelled = await controller.cameraAction('stop', { expectedCaptureSessionId: null }).catch((error) => ({ error }))
  const pending = controller.snapshot().camera
  starting.resolve({ phase: 'live', captureSessionId: 'late-capture' })
  await tick()
  const latePhase = controller.snapshot().camera.status?.phase
  stopping.resolve()
  await actionResult
  assert.equal(cancelled.error, undefined)
  assert.equal(pending.stopPending, true)
  assert.deepEqual(stops, [{ expectedCaptureSessionId: 'late-capture' }])
  assert.notEqual(latePhase, 'live')
  assert.equal(controller.snapshot().camera.status.phase, 'stopped')
  assert.equal(controller.snapshot().camera.stopPending, false)
  await assert.rejects(controller.cameraAction('stop', { expectedCaptureSessionId: null }), /pending|current/)
})

test('Stop cancels a queued Start before its earlier frame read finishes without opening capture', async (t) => {
  const reading = deferred()
  const { controller, calls, cameraClient } = setup(t)
  cameraClient.frame = async () => reading.promise
  const close = controller.onViewerConnect()
  await tick()
  const starting = controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  const cancelled = await controller.cameraAction('stop', { expectedCaptureSessionId: null }).catch((error) => ({ error }))
  reading.resolve({ status: { phase: 'idle', captureSessionId: null }, frame: null })
  const result = await starting
  close()
  assert.equal(cancelled.error, undefined)
  assert.equal(calls.starts.length, 0)
  assert.equal(calls.stops.length, 0)
  assert.equal(controller.snapshot().camera.stopPending, false)
  assert.equal(result.camera.stopPending, false, 'the Start response cannot restore an already completed pending state')
  assert.equal(result.camera.pending, null)
})

test('repeated Stop requests share the pending exact operation and a new Start cannot overwrite its ownership', async (t) => {
  const stopping = deferred()
  const { controller, calls, cameraClient } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  cameraClient.stop = async (body) => { calls.stops.push(body); await stopping.promise; return { phase: 'stopped', captureSessionId: body.expectedCaptureSessionId } }
  const first = controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  const second = controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  await tick()
  const pending = controller.snapshot().camera
  const cannotStart = controller.cameraAction('start', { candidateId: 'camera-two', expectedCandidateDigest: 'another-digest' })
  await assert.rejects(cannotStart)
  stopping.resolve()
  await Promise.all([first, second])
  assert.equal(pending.stopPending, true)
  assert.equal(pending.stopCaptureSessionId, 'capture-one')
  assert.equal(calls.stops.length, 1)
  assert.equal(controller.snapshot().camera.stopCaptureSessionId, null)
  assert.equal(controller.snapshot().camera.stopUnconfirmed, false)
  assert.equal(calls.starts.length, 1)
})

test('an incorrect Stop response cannot release owned capture or authorize another Start', async (t) => {
  const { controller, calls, cameraClient } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  cameraClient.stop = async (body) => { calls.stops.push(body); return { phase: 'stopped', captureSessionId: calls.stops.length === 1 ? 'another-session' : body.expectedCaptureSessionId } }
  await assert.rejects(controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' }), /not confirmed/)
  assert.equal(controller.snapshot().camera.stopCaptureSessionId, 'capture-one')
  assert.equal(controller.snapshot().camera.stopUnconfirmed, true)
  await assert.rejects(controller.cameraAction('start', { candidateId: 'camera-two', expectedCandidateDigest: 'another-digest' }))
  await controller.dispose()
  assert.deepEqual(calls.stops, [{ expectedCaptureSessionId: 'capture-one' }, { expectedCaptureSessionId: 'capture-one' }])
})

test('a fresh read after an unconfirmed Stop cannot revive that stopped preview or release ownership', async (t) => {
  const { controller, calls, cameraClient, setPacket } = setup(t)
  await controller.cameraAction('start', { candidateId: 'camera-one', expectedCandidateDigest: 'digest' })
  cameraClient.stop = async (body) => { calls.stops.push(body); return { phase: calls.stops.length === 1 ? 'stop-unconfirmed' : 'stopped', captureSessionId: body.expectedCaptureSessionId } }
  await controller.cameraAction('stop', { expectedCaptureSessionId: 'capture-one' })
  setPacket({ status: { phase: 'live', captureSessionId: 'capture-one' }, frame: {
    captureSessionId: 'capture-one', sequence: 3, previewDigest: 'digest', jpegBytes: Buffer.from('synthetic-frame'),
  } })
  await controller.refresh()
  assert.equal(controller.snapshot().camera.frame, null)
  assert.equal(controller.snapshot().camera.status.phase, 'stop-unconfirmed')
  assert.equal(controller.snapshot().camera.stopUnconfirmed, true)
  await controller.dispose()
  assert.equal(calls.stops.length, 2)
})
