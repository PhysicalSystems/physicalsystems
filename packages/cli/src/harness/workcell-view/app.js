/* Local operator view. No storage, third-party scripts, model client or direct robot I/O. */
import { cameraIsFresh, executionReadIsFresh, executionApprovalAvailable } from './view-state.js'

(() => {
  'use strict'
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  history.replaceState(null, '', location.pathname)
  const byId = (id) => document.getElementById(id)
  const text = (id, value) => { byId(id).textContent = value }
  const make = (tag, content, className) => {
    const element = document.createElement(tag)
    if (content !== undefined) element.textContent = content
    if (className) element.className = className
    return element
  }
  let state = null
  let connected = false
  let mutating = false
  let selectedCandidate = ''
  let choicesKey = ''
  let candidatesKey = ''
  let conversationKey = ''
  let workflowKey = ''
  let currentFrame = null
  let frameUrl = null
  let frameRequest = null
  let pendingFrameId = null
  let stopped = false
  let eventAbort = null
  let executionPending = false
  let stopPending = false
  let selectedConfiguration = ''
  let confirmationDigest = ''
  let configurationOptionsKey = ''
  let runHistoryKey = ''
  let runDetailsKey = ''
  function notice(message = '') { text('notice', message); byId('notice').hidden = !message }
  function connection(isConnected, label) {
    connected = isConnected
    text('connection-state', label)
    byId('connection-dot').classList.toggle('connected', isConnected)
    controls()
  }
  async function api(path, body, signal) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit', redirect: 'error', signal })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('This view is no longer authorized. Run /workcell in the Harness terminal to reopen it.')
      let detail
      try { detail = await response.json() } catch { /* Status message below. */ }
      throw new Error(detail?.error || `Workcell request failed (${response.status}). Refresh before trying again.`)
    }
    return response
  }
  async function action(path, body) {
    if (mutating || !connected) return
    mutating = true; controls(); notice()
    try {
      const result = await (await api(path, body)).json()
      if (result.contractVersion === 'physicalsystems-workcell-view-v1') render(result)
      return true
    } catch (error) { notice(error.message); return false }
    finally { mutating = false; controls() }
  }
  async function executionAction(kind, body) {
    // A stop request must not wait for approval, refresh, camera I/O or SSE recovery.
    const stopping = kind === 'stop'
    if (stopping ? stopPending : executionPending || !connected) return
    if (stopping) stopPending = true
    else executionPending = true
    controls(); notice()
    try {
      const result = await (await api(`/api/execution/${kind}`, body, AbortSignal.timeout(6500))).json()
      render(result)
    } catch (error) {
      notice(stopping ? `Stop is not confirmed. Use the physical stop procedure. ${error.message}` : error.message)
      byId('run-confirm').checked = false
    } finally { if (stopping) stopPending = false; else executionPending = false; controls() }
  }
  function controls() {
    const busy = mutating || !connected
    const working = state?.agent?.status === 'working'
    const camera = state?.camera?.status
    byId('refresh').disabled = busy || working
    byId('camera-select').disabled = busy || working
    byId('camera-start').disabled = busy || working || !selectedCandidate || ['live', 'starting', 'stale', 'stop-unconfirmed'].includes(camera?.phase)
    byId('camera-stop').disabled = busy || working || !camera?.captureSessionId || ['idle', 'stopped'].includes(camera.phase)
    byId('intent-submit').disabled = busy || !state?.agent?.canPrompt
    byId('intent-input').disabled = busy || working
    for (const button of byId('choice').querySelectorAll('button,input')) button.disabled = busy
    const execution = state?.execution
    const executionBusy = busy || executionPending || Boolean(execution?.pending)
    const fresh = executionReadIsFresh(execution)
    byId('configuration-select').disabled = executionBusy || !fresh
    byId('run-prepare').disabled = executionBusy || !fresh || !execution?.canPrepare || !selectedConfiguration
    byId('execution-refresh').disabled = executionBusy
    byId('run-select').disabled = executionBusy || !execution?.runs?.length
    byId('run-confirm').disabled = executionBusy || !executionApprovalAvailable(execution)
    byId('run-approve').disabled = executionBusy || !executionApprovalAvailable(execution) || !byId('run-confirm').checked
    byId('run-stop').disabled = stopPending || execution?.stopPending || !execution?.canStop
    byId('run-reconcile').disabled = executionBusy || !fresh || !execution?.canReconcile
    byId('run-receipt').disabled = executionBusy || !execution?.run
  }
  function hideFrame() {
    currentFrame = null
    frameRequest?.abort(); frameRequest = null
    pendingFrameId = null
    byId('preview').hidden = true
    byId('preview').removeAttribute('src')
    if (frameUrl) URL.revokeObjectURL(frameUrl)
    frameUrl = null
    byId('frame-kind').hidden = true
    byId('camera-empty').hidden = false
  }
  async function showFrame(camera) {
    if (!cameraIsFresh(camera)) { hideFrame(); return }
    if (currentFrame === camera.previewFrameId) return
    if (pendingFrameId === camera.previewFrameId) return
    // Never leave the previous image visible under the new frame's metadata.
    hideFrame()
    const request = new AbortController()
    frameRequest = request
    const id = camera.previewFrameId
    pendingFrameId = id
    try {
      const response = await api(`/api/camera/frame/${id}`, undefined, request.signal)
      const blob = await response.blob()
      if (request.signal.aborted || state?.camera?.previewFrameId !== id || !connected) return
      if (!cameraIsFresh(state.camera)) { hideFrame(); return }
      if (blob.type !== 'image/jpeg') throw new Error('Unsupported preview image')
      const nextUrl = URL.createObjectURL(blob)
      const oldUrl = frameUrl
      frameUrl = nextUrl; currentFrame = id
      pendingFrameId = null
      byId('preview').src = nextUrl; byId('preview').hidden = false
      byId('camera-empty').hidden = true
      const synthetic = camera.frame?.sourceKind === 'synthetic' || camera.frame?.source?.kind === 'synthetic'
      text('frame-kind', synthetic ? 'SYNTHETIC TEST FRAME · NOT HARDWARE' : 'LIVE PREVIEW · NOT VERIFIED STATE')
      byId('frame-kind').hidden = false
      if (oldUrl) URL.revokeObjectURL(oldUrl)
    } catch (error) {
      if (!request.signal.aborted && state?.camera?.previewFrameId === id) {
        hideFrame()
        text('frame-details', 'Exact frame unavailable · awaiting next frame')
      }
    }
  }
  function renderCamera(camera) {
    const status = camera?.status
    const candidates = status?.availableCameras || []
    const key = JSON.stringify(candidates)
    if (key !== candidatesKey) {
      candidatesKey = key
      if (!candidates.some((candidate) => candidate.candidateId === selectedCandidate)) selectedCandidate = ''
      const select = byId('camera-select')
      select.replaceChildren(new Option(candidates.length ? 'Choose an observed camera' : 'No camera candidates observed', ''))
      for (const candidate of candidates) select.add(new Option(candidate.displayName || candidate.candidateId, candidate.candidateId))
      select.value = selectedCandidate
    }
    const phase = camera?.availability === 'unavailable' ? 'unavailable'
      : status?.phase === 'live' && !cameraIsFresh(camera) ? 'stale' : status?.phase || 'idle'
    text('camera-state', phase === 'live' ? 'LIVE PREVIEW' : phase.replaceAll('-', ' ').toUpperCase())
    byId('camera-state').className = `badge ${phase === 'live' ? 'live' : ['stale', 'error', 'unavailable', 'stop-unconfirmed'].includes(phase) ? 'warning' : ''}`
    const frame = camera?.frame
    text('frame-details', phase === 'stale' ? 'No fresh camera frame is available' : frame ? `Frame ${frame.sequence} · age at receipt ${status.frameAgeMs ?? '?'} ms · ${frame.captureSessionId}` : 'No current frame received')
    text('observation', phase === 'stale' ? 'Unknown · stale preview' : frame?.observation ? `${status.observationStatus || 'Provisional'} · exact-frame observation, not execution permission` : 'Unknown · preview is not a detector')
    const selected = candidates.find((candidate) => candidate.candidateId === status?.selectedCandidateId)
    text('camera-detail', camera?.error || (selected ? `${selected.displayName} · ${selected.identityStability} identity · host read timing, not a bounded sensor-exposure age.` : 'Refresh discovery to find cameras. Select one explicitly; no automatic camera switching.'))
    const empty = byId('camera-empty')
    empty.querySelector('h3').textContent = { idle: 'No camera capture started', starting: 'Waiting for the first frame', stopped: 'Preview stopped', stale: 'Camera frame is stale', error: 'Camera preview failed', unavailable: 'Camera preview unavailable', 'stop-unconfirmed': 'Capture stop is not confirmed' }[phase] || 'Waiting for the exact frame'
    empty.querySelector('p').textContent = camera?.error || (phase === 'idle' ? 'Choose a camera observed by the local node, then start preview. Opening this view does not open a camera.' : 'No current image is being claimed. Physical state remains unknown.')
    void showFrame(camera || {})
  }
  function renderAgent(agent) {
    text('agent-state', agent.tool ? 'CHECKING' : agent.status === 'working' ? 'WORKING' : 'IDLE')
    text('model-line', agent.model ? `${agent.model} · shared Harness session` : 'Select a model in the Harness terminal to continue.')
    const key = JSON.stringify([agent.intent, agent.reply, agent.error, agent.tool])
    if (key !== conversationKey) {
      conversationKey = key
      const view = byId('conversation'); view.replaceChildren()
      if (agent.intent) view.append(make('p', agent.intent, 'operator'))
      if (agent.reply) view.append(make('p', agent.reply, 'assistant'))
      if (agent.tool) view.append(make('p', `Checking: ${agent.tool.replaceAll('_', ' ')}`, 'quiet'))
      if (agent.error) view.append(make('p', agent.error, 'error'))
      if (!view.childElementCount) view.append(make('p', 'Your request, the assistant’s questions, and its response will appear here.', 'quiet'))
    }
    const choice = agent.pendingChoice
    const choiceKey = choice?.choiceId || ''
    if (choiceKey !== choicesKey) {
      choicesKey = choiceKey
      const panel = byId('choice'); panel.replaceChildren(); panel.hidden = !choice
      if (choice) {
        panel.append(make('p', choice.question))
        const answer = (value) => action('/api/choice', { choiceId: choice.choiceId, answer: value })
        if (choice.kind === 'select') for (const option of choice.options) {
          const button = make('button', option); button.onclick = () => answer(option); panel.append(button)
        } else {
          const input = make('input'); input.maxLength = 2000; input.setAttribute('aria-label', choice.question); panel.append(input)
          const submit = make('button', 'Send answer'); submit.onclick = () => { if (input.value.trim()) void answer(input.value.trim()) }; panel.append(submit)
        }
        const cancel = make('button', 'Cancel', 'secondary'); cancel.onclick = () => answer(null); panel.append(cancel)
      }
    }
  }
  function renderWorkflow(workflow = {}) {
    const key = JSON.stringify(workflow)
    if (key === workflowKey) return
    workflowKey = key
    const snapshot = workflow.snapshot
    const devices = (snapshot?.discovery?.devices || []).filter((device) => device.detected === true)
    text('device-count', String(devices.length))
    const list = byId('devices'); list.replaceChildren()
    for (const device of devices) {
      const row = make('div', undefined, 'device-row'); row.append(make('span', undefined, 'device-indicator'))
      const details = make('div'); details.append(make('strong', device.displayName || device.deviceId))
      details.append(make('p', `${device.kind} · ${device.readiness || (device.driverReady ? 'adapter available' : 'adapter unavailable')}`)); row.append(details); list.append(row)
    }
    if (!devices.length) list.append(make('p', workflow.error || 'No devices observed. Connect hardware and refresh discovery.', 'quiet'))
    text('discovery-note', snapshot?.discovery?.observedAt ? `Observed ${snapshot.discovery.observedAt} · detection alone is not readiness.` : 'Only devices reported as detected are listed; no fixed demo inventory.')
    text('node-detail', snapshot ? `${snapshot.nodeName} · ${workflow.nodeOrigin}` : `Local node · ${workflow.nodeOrigin || 'not connected'}`)
    const receipt = workflow.routeReceipt
    const panel = byId('proposal'); panel.replaceChildren()
    text('proposal-state', receipt ? receipt.decision.decision_status === 'selected' ? 'SELECTED · NOT APPROVED' : 'NEEDS COMMISSIONING' : workflow.routeError ? 'UNAVAILABLE' : 'WAITING')
    if (workflow.agentSkillId) panel.append(make('p', `Agent Skill: ${workflow.agentSkillId} · instructions only`, 'receipt-meta'))
    if (receipt) {
      panel.append(make('p', receipt.capabilityId, 'proposal-summary'))
      panel.append(make('p', receipt.request.arguments.map((argument) => `${argument.name} = ${argument.value}`).join(' · '), 'panel-note'))
      for (const candidate of receipt.decision.candidates) {
        const item = make('div', undefined, 'implementation'); item.append(make('strong', candidate.implementation_id))
        item.append(make('p', `${candidate.mechanism} · ${candidate.provider} · ${candidate.status}`))
        const reasons = make('ul')
        for (const code of candidate.rejection_codes) reasons.append(make('li', code.replaceAll('_', ' ')))
        if (reasons.childElementCount) item.append(reasons)
        panel.append(item)
      }
      for (const code of receipt.decision.request_rejection_codes) panel.append(make('p', code.replaceAll('_', ' '), 'error'))
      panel.append(make('p', `Evaluated ${receipt.evaluatedAt}. This is a recorded decision, not a live authorization.`, 'receipt-meta'))
      panel.append(make('p', `Receipt ${receipt.receiptDigest}`, 'receipt-meta'))
    } else if (workflow.routeError) panel.append(make('p', workflow.routeError, 'error'))
    else if (workflow.response?.interpretation) {
      const interpretation = workflow.response.interpretation
      panel.append(make('p', `Workflow: ${interpretation.status}`, 'proposal-summary'))
      for (const gap of interpretation.gaps || []) panel.append(make('p', gap.detail, 'quiet'))
      for (const question of interpretation.questions || []) panel.append(make('p', question, 'quiet'))
    } else panel.append(make('p', 'A proposal appears after the assistant checks a physical capability against the node’s registered implementations.', 'quiet'))
    if (workflow.capabilityCatalog) panel.append(make('p', `${workflow.capabilityCatalog.capabilities.length} registered physical capabilities.`, 'receipt-meta'))
  }
  function render(next) {
    if (next.contractVersion !== 'physicalsystems-workcell-view-v1' || next.physicalExecutionAuthorized !== false) throw new Error('Unsupported workcell contract; no physical state is trusted.')
    state = next
    connection(true, 'Connected to Harness')
    renderCamera(next.camera); renderAgent(next.agent); renderWorkflow(next.workflow); renderExecution(next.execution); controls()
  }
  function renderExecution(execution = {}) {
    const run = execution.run
    const phase = run?.phase || execution.availability || 'unavailable'
    text('execution-state', `${run?.mode === 'simulation' ? 'SIMULATION · ' : ''}${phase.replaceAll('_', ' ')}`.toUpperCase())
    byId('execution-state').className = `badge ${run?.phase === 'VERIFIED_SUCCESS' ? 'live' : ['OUTCOME_UNKNOWN', 'FAILED', 'BLOCKED'].includes(run?.phase) ? 'warning' : ''}`
    text('execution-detail', execution.error || (execution.status?.availability === 'available'
      ? `${execution.status.mode === 'simulation' ? 'Simulation only: no hardware movement or physical success is demonstrated.' : 'Physical execution backend available; exact approval and fresh commissioned checks are still required.'} Geometry, image quality and detector evidence are evaluated by the Node; camera preview or matching calibration hashes alone are not readiness.`
      : 'No available execution backend. A local configuration, trusted observations and a commissioned controller are required.'))
    text('configuration-detail', execution.configurationReason || 'An installed configuration is not proof of current readiness.')
    const choices = execution.configurations || []
    const nextConfigurations = JSON.stringify(choices)
    if (configurationOptionsKey !== nextConfigurations) {
      configurationOptionsKey = nextConfigurations
      if (!choices.some((item) => item.configurationId === selectedConfiguration)) selectedConfiguration = ''
      const select = byId('configuration-select')
      select.replaceChildren(new Option(choices.length ? 'Choose the exact local configuration' : 'No configuration matches the current successful route', ''))
      for (const item of choices) select.add(new Option(`${item.displayName} · ${item.mode}`, item.configurationId))
      select.value = selectedConfiguration
    }
    const nextHistory = JSON.stringify([execution.runs, run?.runId])
    if (runHistoryKey !== nextHistory) {
      runHistoryKey = nextHistory
      const history = byId('run-select')
      history.replaceChildren(new Option('Select a persistent run', ''))
      for (const item of execution.runs || []) history.add(new Option(`${item.runId} · ${item.mode} · ${item.phase}`, item.runId))
      history.value = run?.runId || ''
    }
    const nextConfirmation = `${run?.runDigest || ''}:${execution.canApprove === true}`
    if (confirmationDigest !== nextConfirmation) { confirmationDigest = nextConfirmation; byId('run-confirm').checked = false }
    byId('run-confirmation').hidden = !run || run.phase !== 'WAITING_FOR_APPROVAL'
    text('run-confirmation-text', run ? `${run.mode === 'simulation' ? 'Approve one SIMULATED invocation. This will not move hardware.' : 'Approve one PHYSICAL invocation. The selected controller may move hardware.'} Approval expires ${run.approval.expiresAt}. Confirm the full run and configuration digests below.` : '')
    text('run-approve', run?.mode === 'physical' ? 'Approve this physical invocation' : 'Approve this simulation')
    const nextDetails = JSON.stringify([run, execution.receipt])
    if (runDetailsKey === nextDetails) return
    runDetailsKey = nextDetails
    const details = byId('run-details'); details.replaceChildren()
    if (!run) { details.append(make('p', 'A run is one capability invocation, not a controller instance. Preparing does not dispatch it.', 'quiet')); return }
    details.append(make('p', `${run.capabilityId} · ${run.implementationId}`, 'proposal-summary'))
    details.append(make('p', `Run ${run.runId} · revision ${run.revision} · ${run.mode}`, 'receipt-meta'))
    details.append(make('p', Object.entries(run.inputs).map(([key, value]) => `${key} = ${value}`).join(' · '), 'quiet'))
    for (const [label, value] of [['Run', run.runDigest], ['Configuration', run.configurationDigest], ['Implementation', run.implementationDigest], ['Snapshot', run.snapshotDigest], ['Route receipt', run.routeReceiptDigest]]) details.append(make('p', `${label}: ${value}`, 'receipt-meta'))
    details.append(make('p', `Stop status: ${run.stopStatus.replaceAll('_', ' ')}`, 'quiet'))
    if (run.outcome) details.append(make('p', `${run.mode === 'simulation' ? 'SIMULATED OUTCOME · ' : ''}${run.outcome.status}: ${run.outcome.reason}`, run.outcome.status === 'VERIFIED_SUCCESS' ? 'quiet' : 'error'))
    if (run.phase === 'OUTCOME_UNKNOWN') details.append(make('p', 'The physical outcome is unknown. Do not repeat the invocation. Request stop if needed, then check independent evidence.', 'error'))
    const events = make('ol', undefined, 'run-events')
    for (const event of run.events) events.append(make('li', `${event.sequence}. ${event.type.replaceAll('_', ' ')} · ${event.at}`))
    details.append(events)
    if (execution.receipt) {
      details.append(make('p', `Verified stored receipt integrity: ${execution.receipt.receiptDigest}. Integrity does not create new execution authority.`, 'receipt-meta'))
      details.append(make('p', execution.receipt.configurationSnapshotDigest
        ? `Shared configuration bytes verified: ${execution.receipt.configurationSnapshotDigest}`
        : 'Shared configuration reference is not available in this receipt.', 'receipt-meta'))
      details.append(make('p', execution.receipt.evidenceDigest
        ? `Stored outcome evidence bytes verified: ${execution.receipt.evidenceDigest}`
        : 'No independent outcome evidence has been recorded for this run.', 'receipt-meta'))
      details.append(make('p', 'Stored checks describe this invocation at the recorded time. They are not live readiness, renewed permission, or proof that camera/robot geometry has not changed.', 'panel-note'))
      for (const observation of [execution.receipt.preparation, execution.receipt.verification]) {
        if (!observation) continue
        const section = make('details', undefined, 'observation-details')
        section.append(make('summary', `${observation.mode === 'simulation' ? 'SIMULATED · ' : ''}${observation.stage} checks · historical`))
        section.append(make('p', `Recorded ${observation.at || 'time unavailable'} · preconditions ${observation.preconditions} · outcome ${observation.verified} · stopped ${observation.stopped}`, 'quiet'))
        const checks = make('ul', undefined, 'run-events')
        for (const check of observation.checks) {
          const row = make('li', `${check.name}: ${check.status.toUpperCase()}`)
          for (const metric of check.metrics) row.append(make('p', `${metric.label}: ${metric.value} ${metric.unit}`, 'receipt-meta'))
          checks.append(row)
        }
        section.append(checks)
        section.append(make('p', 'Pixel deviation is not millimetres; HSV brightness is not lux; detector scores are not calibrated probabilities.', 'panel-note'))
        details.append(section)
      }
    }
  }
  byId('configuration-select').onchange = (event) => { selectedConfiguration = event.target.value; controls() }
  byId('run-confirm').onchange = controls
  byId('execution-refresh').onclick = () => executionAction('refresh', {})
  byId('run-select').onchange = (event) => { if (event.target.value) void executionAction('select', { runId: event.target.value }) }
  byId('run-prepare').onclick = () => {
    const configuration = state?.execution?.configurations?.find((item) => item.configurationId === selectedConfiguration)
    const route = state?.workflow?.routeReceipt
    if (configuration && route) void executionAction('prepare', { configurationId: configuration.configurationId, expectedConfigurationDigest: configuration.configurationDigest, routeReceiptDigest: route.receiptDigest })
  }
  byId('run-approve').onclick = () => {
    const run = state?.execution?.run
    if (run && byId('run-confirm').checked && executionApprovalAvailable(state.execution)) void executionAction('approve', { runId: run.runId, expectedRunDigest: run.runDigest, approvalDigest: run.approval.digest, approved: true })
  }
  byId('run-stop').onclick = () => { if (state?.execution?.run) void executionAction('stop', { runId: state.execution.run.runId, reason: 'operator-requested-stop' }) }
  byId('run-reconcile').onclick = () => { if (state?.execution?.run) void executionAction('reconcile', { runId: state.execution.run.runId, expectedRunDigest: state.execution.run.runDigest }) }
  byId('run-receipt').onclick = () => { if (state?.execution?.run) void executionAction('receipt', { runId: state.execution.run.runId }) }
  byId('refresh').onclick = () => action('/api/refresh', {})
  byId('camera-select').onchange = (event) => { selectedCandidate = event.target.value; controls() }
  byId('camera-start').onclick = () => {
    const candidate = state?.camera?.status?.availableCameras?.find((item) => item.candidateId === selectedCandidate)
    if (candidate) void action('/api/camera/start', { candidateId: candidate.candidateId, expectedCandidateDigest: candidate.candidateDigest })
  }
  byId('camera-stop').onclick = () => action('/api/camera/stop', { expectedCaptureSessionId: state.camera.status.captureSessionId })
  byId('intent-form').onsubmit = async (event) => {
    event.preventDefault()
    const input = byId('intent-input')
    if (input.value.trim() && await action('/api/intent', { text: input.value.trim() })) input.value = ''
  }
  async function stream() {
    let failures = 0
    while (!stopped && failures < 4) {
      eventAbort = new AbortController()
      try {
        render(await (await api('/api/state', undefined, eventAbort.signal)).json())
        const response = await api('/api/events', undefined, eventAbort.signal)
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          if (buffer.length > 1024 * 1024) throw new Error('Workcell stream exceeded its limit')
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (data) render(JSON.parse(data))
          }
        }
        throw new Error('Harness connection ended')
      } catch (error) {
        if (stopped) return
        eventAbort.abort(); failures += 1
        connection(false, 'Harness disconnected'); hideFrame(); notice(error.message)
        if (failures < 4) await new Promise((resolve) => setTimeout(resolve, failures * 1000))
      }
    }
  }
  setInterval(() => {
    if (!executionApprovalAvailable(state?.execution)) byId('run-confirm').checked = false
    controls()
    const camera = state?.camera
    if (connected && camera?.status?.phase === 'live' && !cameraIsFresh(camera)) {
      hideFrame(); text('camera-state', 'STALE'); text('frame-details', 'No fresh update from the Harness'); text('observation', 'Unknown · stale preview')
    }
  }, 500)
  addEventListener('pagehide', () => { stopped = true; eventAbort?.abort(); hideFrame() })
  // A browser may reuse this tab when /workcell opens its session link again.
  // Reload to consume a new fragment in memory; history.replaceState itself
  // does not fire hashchange and never persists the bearer.
  addEventListener('hashchange', () => { if (location.hash.startsWith('#token=')) location.reload() })
  if (!token) {
    connection(false, 'Session link required')
    notice('Run /workcell in the Harness terminal to open an authorized view. The session link is not stored in your browser.')
  } else void stream()
})()
