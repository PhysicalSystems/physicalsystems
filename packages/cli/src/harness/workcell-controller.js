import { createHash, randomUUID } from 'node:crypto'
import { safeErrorMessage } from '../auth/redact.js'
import { createExecutionController } from './execution-controller.js'

export const WORKCELL_VIEW_VERSION = 'physicalsystems-workcell-view-v1'

const REQUEST_ERRORS = Object.freeze({
  agent_busy: [409, 'Wait for the current agent request to finish before starting another request'],
  model_unavailable: [503, 'Select a model in the Harness terminal before sending a request'],
  question_expired: [409, 'This operator question is no longer current; use the current question in the terminal or browser'],
  camera_busy: [409, 'Finish the current request before starting another camera preview; Stop remains available'],
  camera_changed: [409, 'No matching current capture or pending Start is available; refresh camera state before retrying'],
  camera_unavailable: [503, 'Camera preview is unavailable; refresh camera state and check the terminal'],
  camera_start_unconfirmed: [503, 'Camera Start was not confirmed; refresh camera state and request Stop before starting another preview'],
  camera_stop_unconfirmed: [503, 'Camera stop is not confirmed; retry Stop for this capture and check the terminal'],
})
class WorkcellRequestError extends Error {
  constructor(code) { super(REQUEST_ERRORS[code][1]); this.code = code }
}
/** Only errors constructed here may select a fixed public explanation. */
export function workcellRequestFailure(error) {
  const entry = error instanceof WorkcellRequestError && REQUEST_ERRORS[error.code]
  return entry ? { status: entry[0], code: error.code, message: entry[1] } : null
}

function displayText(value, maximum = 8000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, maximum)
}

function inputText(value, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new TypeError('Enter a bounded, single-line physical outcome')
  return value.trim()
}

/** Shared operator surface, never a second agent, router or execution owner. */
export function createWorkcellController({
  workflow, refreshWorkflow, invalidateWorkflow = () => {},
  sendIntent, canPrompt = () => true, modelLabel = () => null,
  cameraClient, executionClient, now = () => new Date().toISOString(), pollMs = 200,
  choiceTimeoutMs = 180_000,
} = {}) {
  const sessionId = randomUUID()
  const listeners = new Set()
  let revision = 0
  let disposed = false
  let viewers = 0
  let pollTimer = null
  let cameraPending = null
  let inventoryPending = null
  let cameraActionPending = false
  let cameraActionDone = null
  let cameraStart = null
  let cameraEpoch = 0
  let startUnconfirmed = false
  let stopCaptureSessionId = null
  const ownedCaptureSessions = new Set()
  const stopRequestedSessions = new Set()
  const unconfirmedStops = new Set()
  const pendingStops = new Map()
  let disposePromise = null
  let choice = null
  let browserTurn = false
  let pendingPrompt = null
  let agent = { status: 'idle', intent: null, reply: '', error: null, tool: null }
  let camera = { availability: 'unchecked', status: null, frame: null, previewFrameId: null, error: null, receivedAt: null }
  let cachedFrame = null

  const snapshot = () => ({
    contractVersion: WORKCELL_VIEW_VERSION, sessionId, revision,
    physicalExecutionAuthorized: false,
    workflow,
    agent: { ...agent, model: displayText(modelLabel(), 160) || null, canPrompt: !disposed && agent.status !== 'working' && canPrompt(),
      pendingChoice: choice ? { choiceId: choice.id, kind: choice.kind, question: choice.question, options: choice.options } : null },
    camera: { ...camera, pending: cameraActionPending ? 'start' : null,
      stopPending: pendingStops.size > 0 || Boolean(cameraStart?.cancelled),
      stopUnconfirmed: unconfirmedStops.size > 0,
      stopCaptureSessionId: stopCaptureSessionId || ownedCaptureSessions.values().next().value || null },
    execution: execution.snapshot(),
  })
  const emit = () => {
    if (disposed) return
    revision += 1
    for (const listener of listeners) { try { listener() } catch { /* A viewer cannot break the agent. */ } }
  }
  const execution = createExecutionController({ client: executionClient, currentRoute: () => workflow?.routeReceipt,
    canPrepare: () => !disposed && agent.status !== 'working' && !choice && !cameraActionPending && !pendingStops.size && !unconfirmedStops.size,
    onChange: emit, now: () => Date.parse(now()) })
  const setWorkflow = (value) => { workflow = value; execution.contextChanged() }
  const resolveChoice = (answer) => {
    if (!choice) return
    const pending = choice
    choice = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    pending.resolve(answer)
    emit()
  }

  const clearCameraFrame = () => { cachedFrame = null; camera = { ...camera, frame: null, previewFrameId: null } }
  function acceptStopped(status) {
    if (status.phase !== 'stopped' || !status.captureSessionId) return
    ownedCaptureSessions.delete(status.captureSessionId)
    unconfirmedStops.delete(status.captureSessionId)
    if (stopCaptureSessionId === status.captureSessionId) stopCaptureSessionId = null
  }
  function stopCapture(sessionId) {
    if (pendingStops.has(sessionId)) return pendingStops.get(sessionId)
    const epoch = ++cameraEpoch
    stopCaptureSessionId = sessionId
    stopRequestedSessions.add(sessionId)
    clearCameraFrame()
    // The camera client already bounds each authenticated request to five seconds.
    // Reads and the assistant never hold this independent exact-session channel.
    const request = Promise.resolve().then(() => cameraClient.stop({ expectedCaptureSessionId: sessionId })).then((status) => {
      if (status.captureSessionId !== sessionId || !['stopped', 'stop-unconfirmed'].includes(status.phase)) throw new Error('Invalid camera stop response')
      if (status.phase === 'stopped') acceptStopped(status)
      else unconfirmedStops.add(sessionId)
      if (cameraEpoch === epoch) camera = { ...camera, availability: 'available',
        status: { ...status, availableCameras: camera.status?.availableCameras || [] },
        error: status.phase === 'stopped' ? null : REQUEST_ERRORS.camera_stop_unconfirmed[1] }
      return status
    }).catch(() => {
      unconfirmedStops.add(sessionId)
      if (cameraEpoch === epoch) camera = { ...camera, availability: 'unavailable',
        status: { ...camera.status, phase: 'stop-unconfirmed', captureSessionId: sessionId },
        error: REQUEST_ERRORS.camera_stop_unconfirmed[1] }
      throw new WorkcellRequestError('camera_stop_unconfirmed')
    }).finally(() => { pendingStops.delete(sessionId); emit() })
    pendingStops.set(sessionId, request)
    emit()
    return request
  }

  async function pollCamera() {
    if (disposed || cameraPending || cameraActionPending || pendingStops.size) return cameraPending
    if (!cameraClient) {
      camera = { ...camera, availability: 'unavailable', error: 'Camera preview integration is unavailable', frame: null, previewFrameId: null }
      emit()
      return
    }
    const epoch = cameraEpoch
    cameraPending = (async () => {
      try {
        const packet = await cameraClient.frame()
        if (disposed || epoch !== cameraEpoch) return
        const previousSession = camera.status?.captureSessionId
        const previousPhase = camera.status?.phase
        acceptStopped(packet.status)
        if (['idle', 'stopped'].includes(packet.status.phase)) startUnconfirmed = false
        const stopUnconfirmed = stopRequestedSessions.has(packet.status.captureSessionId) && packet.status.phase !== 'stopped'
        if (stopUnconfirmed) { unconfirmedStops.add(packet.status.captureSessionId); stopCaptureSessionId ||= packet.status.captureSessionId }
        let frame = stopUnconfirmed ? null : packet.frame
        let previewFrameId = null
        if (frame) {
          const { jpegBytes, ...metadata } = frame
          previewFrameId = createHash('sha256').update(`${frame.captureSessionId}:${frame.sequence}:${frame.previewDigest}`).digest('hex')
          cachedFrame = { id: previewFrameId, bytes: jpegBytes, contentType: 'image/jpeg' }
          frame = metadata
        } else cachedFrame = null
        camera = { availability: 'available', status: { ...packet.status, ...(stopUnconfirmed ? { phase: 'stop-unconfirmed' } : {}),
          availableCameras: packet.status.availableCameras ?? camera.status?.availableCameras ?? [] },
          frame, previewFrameId, error: stopUnconfirmed ? REQUEST_ERRORS.camera_stop_unconfirmed[1] : null, receivedAt: now() }
        if ((previousSession && previousSession !== packet.status.captureSessionId)
          || (previousPhase === 'live' && packet.status.phase !== 'live')) invalidateWorkflow()
        emit()
      } catch (error) {
        if (disposed || epoch !== cameraEpoch) return
        cachedFrame = null
        if (camera.status?.phase === 'live') invalidateWorkflow()
        camera = { ...camera, availability: 'unavailable', frame: null, previewFrameId: null,
          error: displayText(safeErrorMessage(error), 350), receivedAt: now() }
        emit()
      }
    })().finally(() => { cameraPending = null })
    return cameraPending
  }
  async function refreshCameras() {
    if (disposed || !cameraClient?.status || inventoryPending) return inventoryPending
    inventoryPending = (async () => {
      try {
        const status = await cameraClient.status()
        if (!disposed) {
          camera = { ...camera, status: { ...(camera.status || status), availableCameras: status.availableCameras || [] } }
          emit()
        }
      } catch (error) {
        if (!disposed) {
          camera = { ...camera, error: displayText(safeErrorMessage(error), 350) }
          emit()
        }
      }
    })().finally(() => { inventoryPending = null })
    return inventoryPending
  }
  const schedule = () => {
    clearTimeout(pollTimer)
    if (disposed || !viewers) return
    pollTimer = setTimeout(async () => { await pollCamera(); schedule() }, pollMs)
    pollTimer.unref?.()
  }

  return {
    snapshot, setWorkflow,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    onViewerConnect() {
      if (disposed) throw new Error('Harness session ended')
      viewers += 1
      const leaveExecution = execution.connect()
      void refreshCameras().then(pollCamera).then(schedule)
      let closed = false
      return () => {
        if (closed) return
        closed = true
        leaveExecution()
        viewers = Math.max(0, viewers - 1)
        if (!viewers) { clearTimeout(pollTimer); resolveChoice(null) }
      }
    },
    async refresh() {
      if (disposed) throw new Error('Harness session ended')
      if (agent.status === 'working') throw new WorkcellRequestError('agent_busy')
      await refreshWorkflow()
      await refreshCameras()
      await pollCamera()
      await execution.refresh()
      return snapshot()
    },
    async submitIntent(value) {
      const text = inputText(value)
      if (/^[!/]/.test(text)) throw new TypeError('Enter a physical outcome, not a terminal command')
      if (disposed) throw new Error('Harness session ended')
      if (agent.status === 'working' || choice) throw new WorkcellRequestError('agent_busy')
      if (!canPrompt()) throw new WorkcellRequestError(displayText(modelLabel(), 160) ? 'agent_busy' : 'model_unavailable')
      browserTurn = true
      agent = { status: 'working', intent: text, reply: '', error: null, tool: null }
      invalidateWorkflow()
      emit()
      // Accept once under the synchronous busy latch. The same Pi session may
      // ask a question before it completes; do not keep this HTTP POST pending.
      const request = {}
      pendingPrompt = request
      void Promise.resolve().then(() => {
        if (disposed || pendingPrompt !== request) return
        return sendIntent(text)
      }).catch((error) => {
        if (disposed || pendingPrompt !== request) return
        agent = { ...agent, status: 'idle', error: displayText(safeErrorMessage(error), 350) }
        browserTurn = false
        resolveChoice(null)
        emit()
      }).finally(() => { if (pendingPrompt === request) pendingPrompt = null })
      return { accepted: true, physicalExecutionAuthorized: false }
    },
    agentStart(prompt) {
      agent = { status: 'working', intent: displayText(prompt, 500), reply: '', error: null, tool: null }
      emit()
    },
    agentMessage(message) {
      if (message?.role !== 'assistant') return
      // Never expose hidden reasoning, raw tools, media or provider metadata.
      const text = Array.isArray(message.content) ? message.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n') : ''
      agent = { ...agent, reply: displayText(text), error: message.stopReason === 'error' ? 'The agent request failed; check the terminal for provider diagnostics.' : null }
      emit()
    },
    agentTool(name) { agent = { ...agent, tool: displayText(name, 128) }; emit() },
    agentSettled() { agent = { ...agent, status: 'idle', tool: null }; browserTurn = false; resolveChoice(null); emit() },
    modelChanged() { emit() },
    shouldAskInView() { return !disposed && browserTurn && viewers > 0 },
    ask({ kind, question, options = [], signal } = {}) {
      if (!['select', 'input'].includes(kind)) throw new TypeError('Unsupported operator question')
      if (disposed || !viewers || signal?.aborted) return Promise.resolve(null)
      if (choice) throw new Error('An operator question is already pending')
      return new Promise((resolve) => {
        const onAbort = () => resolveChoice(null)
        const timer = setTimeout(onAbort, choiceTimeoutMs)
        timer.unref?.()
        choice = { id: randomUUID(), kind, question: displayText(question, 240),
          options: options.map((option) => displayText(option, 80)).slice(0, 7), resolve, timer, signal, onAbort }
        signal?.addEventListener('abort', onAbort, { once: true })
        emit()
      })
    },
    async answerChoice({ choiceId, answer }) {
      if (!choice || choice.id !== choiceId) throw new WorkcellRequestError('question_expired')
      if (answer !== null) {
        answer = inputText(answer, 2000)
        if (choice.kind === 'select' && !choice.options.includes(answer)) throw new TypeError('Choose one of the displayed answers')
      }
      resolveChoice(answer)
      return { accepted: true, physicalExecutionAuthorized: false }
    },
    async cameraAction(action, body) {
      if (disposed || !cameraClient) throw new WorkcellRequestError('camera_unavailable')
      if (action === 'stop') {
        const id = body?.expectedCaptureSessionId
        if (id === null) {
          if (!cameraStart) throw new WorkcellRequestError('camera_changed')
          cameraStart.cancelled = true
          cameraEpoch += 1
          clearCameraFrame(); invalidateWorkflow(); emit()
          // No session is guessed: the pending Start owns its eventual exact cleanup.
          return snapshot()
        }
        if (typeof id !== 'string' || !id || (!ownedCaptureSessions.has(id) && id !== camera.status?.captureSessionId
          && id !== stopCaptureSessionId)) throw new WorkcellRequestError('camera_changed')
        if (cameraStart) cameraStart.cancelled = true
        invalidateWorkflow()
        await stopCapture(id)
        return snapshot()
      }
      if (action !== 'start') throw new TypeError('Unsupported camera action')
      if (cameraActionPending || pendingStops.size || agent.status === 'working') throw new WorkcellRequestError('camera_busy')
      if (unconfirmedStops.size || startUnconfirmed) throw new WorkcellRequestError('camera_stop_unconfirmed')
      if (ownedCaptureSessions.size || (camera.status?.captureSessionId && !['idle', 'stopped'].includes(camera.status.phase))) throw new WorkcellRequestError('camera_busy')
      cameraActionPending = true
      const start = { cancelled: false }
      cameraStart = start
      cameraEpoch += 1
      stopRequestedSessions.clear()
      let finishAction
      const actionDone = new Promise((resolve) => { finishAction = resolve })
      cameraActionDone = actionDone
      emit()
      try {
        // Finish the previous read before mutating the selected capture session.
        await cameraPending
        if (!disposed && !start.cancelled) {
          invalidateWorkflow()
          clearCameraFrame()
          emit()
          let status
          try { status = await cameraClient.start(body) }
          catch { startUnconfirmed = true; throw new WorkcellRequestError('camera_start_unconfirmed') }
          if (!status.captureSessionId) { startUnconfirmed = true; throw new WorkcellRequestError('camera_start_unconfirmed') }
          ownedCaptureSessions.add(status.captureSessionId)
          if (disposed || start.cancelled) {
            await stopCapture(status.captureSessionId)
          } else {
            camera = { ...camera, availability: 'available', status: { ...status, availableCameras: camera.status?.availableCameras || [] }, error: null }
          }
        }
      } catch (error) {
        camera = { ...camera, error: workcellRequestFailure(error)?.message || REQUEST_ERRORS.camera_unavailable[1] }
        throw error
      } finally {
        if (cameraStart === start) cameraStart = null
        cameraActionPending = false
        finishAction()
        if (cameraActionDone === actionDone) cameraActionDone = null
        emit()
      }
      if (!disposed && !start.cancelled) void pollCamera()
      return snapshot()
    },
    async cameraFrame(id) {
      if (!cachedFrame || id !== cachedFrame.id) throw new Error('This exact preview frame is no longer retained; refresh the view')
      return { bytes: cachedFrame.bytes, contentType: cachedFrame.contentType }
    },
    async executionAction(action, body) {
      await execution.action(action, body)
      return snapshot()
    },
    async dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      pendingPrompt = null
      execution.dispose()
      clearTimeout(pollTimer)
      resolveChoice(null)
      listeners.clear()
      cachedFrame = null
      disposePromise = (async () => {
        // Pi may exit immediately after teardown. Await a pending start's exact
        // cleanup here; a fire-and-forget continuation could die with the host.
        await cameraActionDone
        // Only stop capture started by this Harness, never an unrelated session.
        await Promise.allSettled([...pendingStops.values()])
        for (const id of ownedCaptureSessions) {
          try { await stopCapture(id) } catch { /* Retain ownership when exact stop remains unconfirmed. */ }
        }
      })()
      return disposePromise
    },
  }
}
