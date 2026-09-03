import { createHash, randomUUID } from 'node:crypto'
import { safeErrorMessage } from '../auth/redact.js'
import { createExecutionController } from './execution-controller.js'

export const WORKCELL_VIEW_VERSION = 'physicalsystems-workcell-view-v1'

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
  let disposePromise = null
  let ownedCaptureSessionId = null
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
    camera, execution: execution.snapshot(),
  })
  const emit = () => {
    if (disposed) return
    revision += 1
    for (const listener of listeners) { try { listener() } catch { /* A viewer cannot break the agent. */ } }
  }
  const execution = createExecutionController({ client: executionClient, currentRoute: () => workflow?.routeReceipt,
    canPrepare: () => !disposed && agent.status !== 'working' && !choice && !cameraActionPending,
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

  async function pollCamera() {
    if (disposed || cameraPending || cameraActionPending) return cameraPending
    if (!cameraClient) {
      camera = { ...camera, availability: 'unavailable', error: 'Camera preview integration is unavailable', frame: null, previewFrameId: null }
      emit()
      return
    }
    cameraPending = (async () => {
      try {
        const packet = await cameraClient.frame()
        if (disposed) return
        const previousSession = camera.status?.captureSessionId
        const previousPhase = camera.status?.phase
        let frame = packet.frame
        let previewFrameId = null
        if (frame) {
          const { jpegBytes, ...metadata } = frame
          previewFrameId = createHash('sha256').update(`${frame.captureSessionId}:${frame.sequence}:${frame.previewDigest}`).digest('hex')
          cachedFrame = { id: previewFrameId, bytes: jpegBytes, contentType: 'image/jpeg' }
          frame = metadata
        } else cachedFrame = null
        camera = { availability: 'available', status: { ...packet.status,
          availableCameras: packet.status.availableCameras ?? camera.status?.availableCameras ?? [] },
          frame, previewFrameId, error: null, receivedAt: now() }
        if ((previousSession && previousSession !== packet.status.captureSessionId)
          || (previousPhase === 'live' && packet.status.phase !== 'live')) invalidateWorkflow()
        emit()
      } catch (error) {
        if (disposed) return
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
      if (agent.status === 'working') throw new Error('Wait for the current agent request before refreshing the workcell')
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
      if (agent.status === 'working' || choice || !canPrompt()) throw new Error('The Harness is busy or has no model configured; finish the current request or select a model in the terminal')
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
      if (!choice || choice.id !== choiceId) throw new Error('This operator question is no longer current')
      if (answer !== null) {
        answer = inputText(answer, 2000)
        if (choice.kind === 'select' && !choice.options.includes(answer)) throw new TypeError('Choose one of the displayed answers')
      }
      resolveChoice(answer)
      return { accepted: true, physicalExecutionAuthorized: false }
    },
    async cameraAction(action, body) {
      if (disposed || !cameraClient) throw new Error('Camera preview is unavailable')
      if (cameraActionPending || agent.status === 'working') throw new Error('Finish the current request before changing camera capture')
      cameraActionPending = true
      let finishAction
      const actionDone = new Promise((resolve) => { finishAction = resolve })
      cameraActionDone = actionDone
      try {
        // Finish the previous read before mutating the selected capture session.
        await cameraPending
        if (disposed) throw new Error('Harness session ended')
        invalidateWorkflow()
        cachedFrame = null
        camera = { ...camera, frame: null, previewFrameId: null }
        emit()
        if (action === 'start') {
          const status = await cameraClient.start(body)
          if (disposed) {
            if (status.captureSessionId) {
              try { await cameraClient.stop({ expectedCaptureSessionId: status.captureSessionId }) } catch { /* Exact session only. */ }
            }
            throw new Error('Harness session ended')
          }
          ownedCaptureSessionId = status.captureSessionId
          camera = { ...camera, availability: 'available', status: { ...status, availableCameras: camera.status?.availableCameras || [] }, error: null }
        } else if (action === 'stop') {
          const status = await cameraClient.stop(body)
          ownedCaptureSessionId = null
          camera = { ...camera, availability: 'available', status: { ...status, availableCameras: camera.status?.availableCameras || [] }, error: null }
        } else throw new TypeError('Unsupported camera action')
      } catch (error) {
        camera = { ...camera, error: displayText(safeErrorMessage(error), 350) }
        throw new Error(camera.error)
      } finally {
        cameraActionPending = false
        finishAction()
        if (cameraActionDone === actionDone) cameraActionDone = null
        emit()
      }
      await pollCamera()
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
        if (ownedCaptureSessionId && cameraClient) {
          try { await cameraClient.stop({ expectedCaptureSessionId: ownedCaptureSessionId }) } catch { /* Node still owns its capture status. */ }
        }
      })()
      return disposePromise
    },
  }
}
