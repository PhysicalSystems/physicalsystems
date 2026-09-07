import { mountWorkcellView } from './workcell.js'
import { mountExperiments, mountExperimentChat } from './experiments.js'
import { renderMarkdown } from './markdown.js'

// The renderer owns presentation only. All persistence, sessions, provider
// credentials and Node calls cross the constrained main-process bridge.
const bridge = window.physicalSystems
const byId = (id) => document.getElementById(id)
const make = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = String(text)
  if (className) node.className = className
  return node
}
const button = (text, action, className = '') => {
  const node = make('button', text, className); node.type = 'button'; node.onclick = action; return node
}
const cleanStatus = (value) => String(value || 'disconnected').replaceAll('_', ' ')
let state = null, disposed = false, unsubscribe = null, sidebarKey = '', transcriptKey = '', questionKey = '', bannerKey = '', setupKey = ''
let inspectorTab = 'devices', panelOpen = innerWidth > 950, navOpen = false, expanded = new Set(), popoverProject = null
let pendingSend = false, dialogBusy = false, noticeMessage = '', currentContext = '', loginQuestionKey = '', draftTimer = null
let dialogGeneration = 0, refreshDialog = null
let slash = null
let draftSave = Promise.resolve()
const drafts = new Map(), pendingOwnedStops = new Set(), projectNavigationErrors = new Map()
const activeProject = () => state?.projects?.find((project) => project.id === state.activeProjectId)
const activeConversation = () => state?.conversation
const scope = () => ({ projectId: state?.activeProjectId, conversationId: state?.activeConversationId, connectionGeneration: state?.connectionGeneration })
function notice(message = '') { noticeMessage = message; byId('app-notice').textContent = message; byId('app-notice').hidden = !message }
async function command(name, payload = {}, options = {}) {
  const context = scope()
  if (payload.projectId && payload.projectId !== context.projectId) delete context.conversationId
  try {
    const result = await bridge.command(name, { ...context, ...payload })
    // Mutations may also emit the same snapshot; revisions keep order stable.
    if (result?.projects && Number.isInteger(result.revision)) update(result)
    return result
  } catch (error) {
    if (!options.quiet) notice(error?.message || 'The request could not be completed. Check the current state before retrying.')
    throw error
  }
}
function run(name, payload = {}) { void command(name, payload).catch(() => {}) }
let workcellNotice = ''
const workcell = mountWorkcellView(byId('workcell'), { command: (name, payload) => command(name, payload, { quiet: true }), onControls: renderControls, onNotice: (message) => { if (message || noticeMessage === workcellNotice) notice(message); workcellNotice = message } })
const experiments = mountExperiments(byId('experiments'), { command: (name, payload) => command(name, payload, { quiet: true }) })
const experimentChatRoot = make('section')
const experimentChat = mountExperimentChat(experimentChatRoot, {
  command: (name, payload) => command(name, payload, { quiet: true }),
  openDetails: () => { panelOpen = true; navOpen = false; setTab('experiments'); layout() },
})
function folderIcon(remote) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.classList.add('project-icon'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18')
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path)
  if (remote) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', '18'); circle.setAttribute('cy', '18'); circle.setAttribute('r', '4'); circle.setAttribute('fill', 'var(--bg)'); circle.setAttribute('stroke', '#69b7cd'); svg.append(circle)
    const globe = document.createElementNS(svg.namespaceURI, 'path'); globe.setAttribute('d', 'M14 18h8m-4-4c2 2 2 6 0 8m0-8c-2 2-2 6 0 8'); globe.setAttribute('stroke', '#69b7cd'); globe.setAttribute('fill', 'none'); globe.setAttribute('stroke-width', '.7'); svg.append(globe)
  }
  return svg
}
function composeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.classList.add('project-compose-icon'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z')
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path)
  return svg
}
function statusDot(status) { const dot = make('span', undefined, `dot ${['connected', 'connecting', 'reconnecting'].includes(status) ? status : ''}`); dot.setAttribute('aria-hidden', 'true'); return dot }
function showProject(project, anchor, pinned = false) {
  if (!project) return
  popoverProject = project.id
  const popover = byId('project-popover'); popover.replaceChildren()
  const title = make('div', undefined, 'project-popover-title'); title.append(folderIcon(project.connection?.kind === 'ssh'), make('h3', project.name)); popover.append(title)
  const connection = project.connection || {}
  popover.append(make('p', `${connection.label || 'No connection profile'} · ${connection.kind || 'local'}`, 'muted'))
  const line = make('div', undefined, 'connection-line'); line.append(statusDot(connection.status), make('span', cleanStatus(connection.status))); popover.append(line)
  const current = connection.status === 'connected'
  const count = Number.isInteger(connection.deviceCount) ? connection.deviceCount : null
  const deviceLabel = !current ? 'Device state unavailable' : `${count === null ? 'Device count unavailable' : `${count} ${count === 1 ? 'device' : 'devices'} detected`}${Number.isInteger(connection.inUseCount) ? ` · ${connection.inUseCount} camera ${connection.inUseCount === 1 ? 'preview' : 'previews'} active` : ' · preview status unavailable'}`
  popover.append(button(deviceLabel, async () => {
    await saveDraft()
    try {
      await command('project.select', { projectId: project.id })
      if (state?.activeProjectId !== project.id) return
      if (noticeMessage && noticeMessage === projectNavigationErrors.get(project.id)) notice()
      projectNavigationErrors.delete(project.id)
      panelOpen = true; navOpen = false; setTab('devices'); closePopover(); layout()
    } catch (error) { projectNavigationErrors.set(project.id, error.message) }
  }, 'plain device-count'))
  if (connection.observedAt) popover.append(make('p', `Last observed ${new Date(connection.observedAt).toLocaleString()}`, 'small muted'))
  if (connection.error) popover.append(make('p', connection.error, 'error'))
  const actions = make('div', undefined, 'actions')
  actions.append(button(current ? 'Disconnect' : 'Connect', () => { run(current ? 'connection.disconnect' : 'connection.connect', { projectId: project.id }); closePopover() }), button('Settings', () => projectSettings(project), 'plain'))
  popover.append(actions); popover.hidden = false; popover.dataset.pinned = String(pinned)
  const bounds = anchor.getBoundingClientRect()
  popover.style.left = `${Math.max(10, Math.min(bounds.right + 8, innerWidth - popover.offsetWidth - 10))}px`
  popover.style.top = `${Math.max(10, Math.min(bounds.top, innerHeight - popover.offsetHeight - 10))}px`
}
function closePopover() { byId('project-popover').hidden = true; popoverProject = null }
function renderSidebar() {
  const key = JSON.stringify([state?.projects, state?.activeConversationId, [...expanded]])
  if (key === sidebarKey) return
  sidebarKey = key
  const list = byId('projects'); list.replaceChildren()
  for (const project of state?.projects || []) {
    if (project.archived) continue
    const group = make('div', undefined, 'project-group'), row = make('div', undefined, 'project-row'); row.dataset.projectId = project.id
    const toggle = button('', () => { expanded.has(project.id) ? expanded.delete(project.id) : expanded.add(project.id); closePopover(); renderSidebar() }, 'project-toggle')
    toggle.setAttribute('aria-expanded', String(expanded.has(project.id))); toggle.setAttribute('aria-label', `${project.name}: ${expanded.has(project.id) ? 'collapse' : 'expand'} conversations; connection ${cleanStatus(project.connection?.status)}`)
    toggle.append(folderIcon(project.connection?.kind === 'ssh'))
    const copy = make('span', undefined, 'project-copy'); copy.append(make('span', project.name, 'project-name'), make('span', project.connection?.label || 'Not connected', 'project-host')); toggle.append(copy)
    toggle.append(statusDot(project.connection?.status))
    row.onmouseenter = () => showProject(project, row); row.addEventListener('focusin', () => showProject(project, row))
    const compose = button('', async () => { await saveDraft(); try { await command('conversation.create', { projectId: project.id }); navOpen = false; closePopover(); layout() } catch {} }, 'plain new-conversation')
    compose.append(composeIcon()); compose.setAttribute('aria-label', `New conversation in ${project.name}`); compose.title = 'New conversation'
    row.append(toggle, compose); group.append(row)
    if (expanded.has(project.id)) {
      const chats = make('div', undefined, 'project-conversations')
      for (const conversation of project.conversations || []) {
        if (conversation.archived) continue
        const item = make('div', undefined, `conversation-entry${conversation.id === state.activeConversationId && project.id === state.activeProjectId ? ' selected' : ''}`)
        const open = button(conversation.title || 'New conversation', async () => { await saveDraft(); run('conversation.select', { projectId: project.id, conversationId: conversation.id }); navOpen = false; closePopover(); layout() }, 'conversation-link')
        open.setAttribute('aria-current', String(conversation.id === state.activeConversationId && project.id === state.activeProjectId))
        item.append(open, button('•••', () => conversationSettings(project, conversation), 'icon')); item.lastChild.setAttribute('aria-label', `Actions for ${conversation.title || 'conversation'}`); chats.append(item)
      }
      group.append(chats)
    }
    list.append(group)
  }
  if (!list.childElementCount) list.append(make('p', 'Your projects will appear here.', 'small muted'))
}
function saveDraft() {
  clearTimeout(draftTimer); draftTimer = null
  if (!state?.activeConversationId || state.hostUnavailable) return Promise.resolve()
  const text = slash?.context === currentContext ? slash.draft : byId('message').value, context = scope()
  drafts.set(`${state.activeProjectId}:${state.activeConversationId}`, text)
  draftSave = draftSave.catch(() => {}).then(() => command('conversation.saveDraft', { ...context, draft: text }, { quiet: true })).catch(() => { notice('This draft is not saved yet. Keep the conversation open and try again before leaving.') })
  return draftSave
}

function renderTranscript() {
  const conversation = activeConversation(), project = activeProject()
  const workflow = state?.workcell?.workflow
  const key = JSON.stringify([project?.id, conversation?.id, conversation?.messages, conversation?.busy, conversation?.error,
    workflow?.routeReceipt, workflow?.routeError, workflow?.response?.interpretation, workflow?.capabilityCatalog, state?.experiments])
  if (key === transcriptKey) return
  transcriptKey = key
  const transcript = byId('transcript'), keepBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90
  transcript.replaceChildren()
  const messages = conversation?.messages || []
  if (!project) {
    const empty = make('div', undefined, 'empty'); empty.append(make('h2', 'Your physical workspace.'), make('p', 'Bring your conversations and equipment together. Start with a project, then choose how to connect.'))
    const actions = make('div', undefined, 'actions'); actions.append(button('Create a project', () => createProject(), 'primary')); empty.append(actions); transcript.append(empty)
  } else if (!conversation) {
    const empty = make('div', undefined, 'empty'); empty.append(make('h2', project.name), make('p', 'Start a conversation to inspect capabilities, discuss setup, and plan a task.'))
    empty.append(button('New conversation', () => run('conversation.create', { projectId: project.id }), 'primary')); transcript.append(empty)
  } else if (!messages.length) {
    const empty = make('div', undefined, 'empty'); empty.append(make('h2', 'What would you like to do?'), make('p', 'Describe the outcome, inspect the available capabilities, or ask what setup is still needed.'))
    if (!state?.models?.length) empty.append(make('p', 'Choose a model and sign in through Model & app settings to talk to the assistant. Device controls remain available independently.', 'small'))
    transcript.append(empty)
  }
  for (const message of messages) {
    const role = ['user', 'assistant', 'tool'].includes(message.role) ? message.role : 'tool'
    if (role === 'assistant' && !message.text?.trim()) continue
    const item = make('article', undefined, `message ${role}`); item.dataset.messageId = message.id || ''
    if (role === 'tool') {
      const labels = { ask_choice: 'Ask a question', inspect_local_experiment: 'Inspect experiment', propose_local_experiment: 'Propose experiment', run_simulated_trial: 'Measure simulated trial', finish_local_experiment: 'Finish experiment' }
      const label = labels[message.toolName] || (message.toolName || 'Tool result').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
      const detail = make('details'); detail.append(make('summary', label + (message.isError ? ' · Failed' : '')), make('pre', message.text || 'No text result')); item.append(detail)
    } else {
      item.append(make('div', role === 'user' ? 'You' : 'Physical Systems', 'who'))
      const body = make('div', undefined, `body${role === 'assistant' ? ' message-markdown' : ''}${message.streaming ? ' streaming' : ''}`)
      if (role === 'assistant') renderMarkdown(body, message.text || '')
      else body.textContent = message.text || ''
      item.append(body)
    }
    transcript.append(item)
  }
  if (conversation?.busy) transcript.append(make('p', 'Assistant is working…', 'small muted'))
  if (conversation?.error) transcript.append(make('p', conversation.error, 'error'))
  if (conversation && workflow) renderProposal(transcript, workflow)
  if (conversation) transcript.append(experimentChatRoot)
  if (keepBottom) transcript.scrollTop = transcript.scrollHeight
}
function blockerAction(code) {
  if (/argument|input/.test(code)) return 'Ask for the missing or corrected input, using the capability’s declared schema.'
  if (/calibration/.test(code)) return 'Review the required calibration and its validation evidence with the setup owner.'
  if (/artifact/.test(code)) return 'Review the required taught positions or artifacts and their exact bindings with the setup owner.'
  if (/dependency/.test(code)) return 'Inspect the required driver or dependency and its reported version and health.'
  if (/qualification/.test(code)) return 'Review this setup’s qualification record and underlying evidence.'
  if (/precondition/.test(code)) return 'Obtain fresh, trusted observations through the supported procedure. Unknown or stale state remains blocked.'
  if (/execution_target/.test(code)) return 'Check the exact configured execution target through the supported setup procedure.'
  if (/manifest|configuration|mismatch|policy/.test(code)) return 'Ask the setup owner to inspect the reported configuration or policy mismatch before preparing another invocation.'
  if (/unknown_skill|unsupported/.test(code)) return 'Inspect the registered capabilities and choose a supported outcome.'
  return 'Inspect this reported reason in Setup. Ask the Node or implementation provider to explain any unclassified condition.'
}
function renderProposal(transcript, workflow) {
  const receipt = workflow.routeReceipt, interpretation = workflow.response?.interpretation
  if (!receipt && !workflow.routeError && !interpretation) return
  const card = make('section', undefined, 'proposal-card'); card.setAttribute('aria-label', 'Capability proposal')
  const heading = make('div', undefined, 'proposal-heading'); heading.append(make('span', 'Proposed capability', 'small muted'))
  const selected = receipt?.decision?.decision_status === 'selected'
  heading.append(make('span', receipt ? selected ? 'Implementation selected' : 'Blocked' : workflow.routeError ? 'Unavailable' : cleanStatus(interpretation.status), 'proposal-status'))
  card.append(heading)
  if (receipt) {
    const capability = workflow.capabilityCatalog?.capabilities?.find((item) => item.capabilityId === receipt.capabilityId)
    card.append(make('h3', capability?.displayName || receipt.capabilityId))
    if (receipt.request?.arguments?.length) card.append(make('p', receipt.request.arguments.map((argument) => `${argument.name}: ${argument.value}`).join(' · '), 'small'))
    const reasons = make('ul', undefined, 'proposal-reasons')
    for (const code of receipt.decision?.request_rejection_codes || []) {
      const row = make('li'); row.append(make('strong', code.replaceAll('_', ' ')), make('p', blockerAction(code))); reasons.append(row)
    }
    if (reasons.childElementCount) card.append(reasons)
    for (const candidate of receipt.decision?.candidates || []) {
      if (!candidate.rejection_codes?.length) continue
      const assessment = make('details', undefined, 'implementation-assessment'); assessment.open = !selected
      assessment.append(make('summary', `${candidate.implementation_id} · ${candidate.status}`))
      const blockers = make('ul', undefined, 'proposal-reasons')
      for (const code of candidate.rejection_codes) {
        const row = make('li'); row.append(make('strong', code.replaceAll('_', ' ')), make('p', blockerAction(code))); blockers.append(row)
      }
      assessment.append(blockers); card.append(assessment)
    }
    card.append(make('p', `Recorded decision${receipt.evaluatedAt ? ` · ${new Date(receipt.evaluatedAt).toLocaleString()}` : ''}. Preparation rechecks the exact configuration; this card is not a live authorization.`, 'proposal-footnote'))
  } else {
    if (workflow.routeError) card.append(make('p', workflow.routeError, 'error'))
    for (const gap of interpretation?.gaps || []) card.append(make('p', gap.detail || gap.message || String(gap), 'small'))
    for (const question of interpretation?.questions || []) card.append(make('p', question, 'small'))
  }
  const actions = make('div', undefined, 'actions')
  actions.append(button('Review setup', () => { panelOpen = true; setTab('setup'); layout() }))
  if (selected) actions.append(button('Review run', () => { panelOpen = true; setTab('run'); layout() }, 'primary'))
  card.append(actions); transcript.append(card)
}
function renderQuestion() {
  const question = activeConversation()?.question || state?.workcell?.agent?.pendingChoice
  const key = JSON.stringify([state?.activeConversationId, question])
  if (key === questionKey) return
  questionKey = key
  const panel = byId('question'); panel.replaceChildren(); panel.hidden = !question
  if (!question) return
  panel.append(make('p', question.question || question.text || 'The assistant needs your input.'))
  const actions = make('div', undefined, 'actions'), answer = (value) => run('conversation.answer', { choiceId: question.choiceId || question.id, answer: value })
  if (question.options?.length) for (const option of question.options) actions.append(button(typeof option === 'string' ? option : option.label, () => answer(typeof option === 'string' ? option : option.value || option.label)))
  else {
    const input = make('input'); input.type = 'text'; input.maxLength = 2000; input.setAttribute('aria-label', 'Answer'); panel.append(input)
    actions.append(button('Send answer', () => { if (input.value.trim()) answer(input.value.trim()) }))
  }
  actions.append(button('Cancel question', () => answer(null), 'plain')); panel.append(actions)
}
function renderControls() {
  const project = activeProject(), conversation = activeConversation()
  byId('conversation-title').textContent = conversation?.title || project?.name || 'Your physical workspace'
  const connection = project?.connection
  byId('connection-summary').textContent = connection ? `${connection.label || connection.kind} · ${cleanStatus(connection.status)}${connection.kind === 'simulation' ? ' · Simulation' : ''}` : 'Create a project to get started'
  byId('conversation-menu').hidden = !conversation
  byId('composer').hidden = !conversation
  const busy = pendingSend || conversation?.busy
  byId('send-message').disabled = state?.hostUnavailable || !conversation || busy || (slash ? slash.pending || !slash.options?.length : !byId('message').value.trim())
  const submitLabel = slash ? 'Select option' : 'Send message'
  byId('send-message').setAttribute('aria-label', submitLabel)
  byId('send-message').title = submitLabel
  byId('message').disabled = state?.hostUnavailable || !conversation || busy
  byId('cancel-message').hidden = !conversation?.busy
  byId('model-settings').textContent = state?.conversation?.model?.name || state?.conversation?.model?.id || state?.workcell?.agent?.model || 'Select a model'
  byId('workcell').hidden = !state?.workcell || inspectorTab === 'experiments'
  byId('experiments').hidden = inspectorTab !== 'experiments'
  byId('inspector-empty').hidden = Boolean(state?.workcell) || inspectorTab === 'experiments'
  byId('inspector-empty').querySelector('h3').textContent = connection?.status === 'connected' ? 'Waiting for device state' : 'Connect a project'
  const execution = state?.workcell?.execution, runState = execution?.run
  const camera = state?.workcell?.camera
  const cameraOwned = camera?.stopUnconfirmed || camera?.stopPending || camera?.pending === 'start' || (camera?.status?.captureSessionId && !['idle', 'stopped'].includes(camera.status.phase))
  const runOwned = execution?.canStop || ['PREPARING', 'DISPATCHING', 'RUNNING', 'STOPPING', 'OUTCOME_UNKNOWN'].includes(runState?.phase)
  const banner = byId('active-operation')
  const globalRuns = state?.activeRuns || []
  const globalCaptures = state?.activeCaptures || []
  const activeExperiments = state?.activeExperiments || []
  const runs = globalRuns.length ? globalRuns : runOwned ? [{ projectId: project.id, projectName: project.name, connectionGeneration: state.connectionGeneration, run: runState, canStop: execution.canStop }] : []
  const captures = globalCaptures.length ? globalCaptures : cameraOwned ? [{ projectId: project.id, projectName: project.name, connectionGeneration: state.connectionGeneration, captureSessionId: camera.stopCaptureSessionId || camera.status?.captureSessionId, stopUnconfirmed: camera.stopUnconfirmed, stopPending: camera.stopPending, canStop: !byId('camera-stop').disabled }] : []
  const nextBanner = JSON.stringify([runs, captures, activeExperiments, [...pendingOwnedStops], state?.hostUnavailable, byId('camera-state').textContent, byId('camera-stop').disabled, byId('run-stop').disabled])
  if (nextBanner === bannerKey) return
  bannerKey = nextBanner; banner.replaceChildren()
  banner.hidden = !runs.length && !captures.length && !activeExperiments.length
  for (const owner of activeExperiments) {
    const row = make('div', undefined, 'operation-row'), key = `experiment:${owner.projectId}:${owner.experiment.id}`
    row.append(make('span', `${owner.projectName || 'Project'} · Synthetic experiment · ${owner.statusUnavailable || state.hostUnavailable ? 'last observed ' : ''}${cleanStatus(owner.experiment.phase)}${owner.statusUnavailable || state.hostUnavailable ? ' · current state unavailable' : ''}`))
    const stop = button(pendingOwnedStops.has(key) ? 'Stopping experiment…' : 'Stop experiment', async () => {
      if (pendingOwnedStops.has(key)) return
      pendingOwnedStops.add(key); renderControls()
      let timer
      try { await Promise.race([command('experiment.stop', { projectId: owner.projectId, conversationId: owner.conversationId, experimentId: owner.experiment.id }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Experiment Stop timed out. Inspect its recorded status and retry Stop.')), 6500) })]) }
      catch (error) { notice(error.message) }
      finally { clearTimeout(timer); pendingOwnedStops.delete(key); renderControls() }
    }, 'stop'); stop.disabled = !owner.canStop || state.hostUnavailable || pendingOwnedStops.has(key); row.append(stop); banner.append(row)
  }
  for (const owner of runs) {
    const row = make('div', undefined, 'operation-row')
    const phase = owner.run?.stopStatus === 'STOP_UNCONFIRMED' ? `Stop unconfirmed · last observed ${cleanStatus(owner.run?.phase)}` : cleanStatus(owner.run?.phase)
    row.append(make('span', `${owner.projectName || 'Project'} · ${owner.run?.mode === 'simulation' ? 'Simulation' : 'Physical run'} · ${owner.statusUnavailable || state.hostUnavailable ? 'last observed ' : ''}${phase}${owner.statusUnavailable || state.hostUnavailable ? ' · current state unavailable' : ''}`))
    const selected = owner.projectId === state.activeProjectId && owner.run?.runId === state.workcell?.execution?.run?.runId
    const key = `run:${owner.projectId}:${owner.run?.runId}`
    const stop = button(pendingOwnedStops.has(key) ? 'Requesting stop…' : 'Request run stop', () => { if (selected) byId('run-stop').click(); else void stopOwned(owner, 'run') }, 'stop'); stop.disabled = !owner.canStop || state.hostUnavailable || pendingOwnedStops.has(key) || (selected && byId('run-stop').disabled)
    row.append(stop); banner.append(row)
  }
  for (const owner of captures) {
    const row = make('div', undefined, 'operation-row'); row.append(make('span', `${owner.projectName || 'Project'} · Camera · ${state.hostUnavailable || owner.statusUnavailable ? 'current state unavailable' : owner.projectId === state.activeProjectId ? cleanStatus(byId('camera-state').textContent).toLowerCase() : owner.stopUnconfirmed ? 'Stop unconfirmed' : owner.stopPending ? 'Stopping' : 'capture owned by this project'}`))
    const stop = button('Stop preview', () => {
      if (owner.projectId === state.activeProjectId) byId('camera-stop').click()
      else void stopOwned(owner, 'camera')
    }, 'stop'); stop.disabled = !owner.canStop || state.hostUnavailable || pendingOwnedStops.has(`camera:${owner.projectId}`) || (owner.projectId === state.activeProjectId && byId('camera-stop').disabled)
    row.append(stop); banner.append(row)
  }
}
async function stopOwned(owner, kind) {
  const key = `${kind}:${owner.projectId}${kind === 'run' ? `:${owner.run?.runId}` : ''}`
  if (pendingOwnedStops.has(key) || state?.hostUnavailable) return
  pendingOwnedStops.add(key); renderControls()
  let timer
  try {
    await Promise.race([
      command(kind === 'run' ? 'workcell.execution.stop' : 'workcell.camera.stop', {
        projectId: owner.projectId, connectionGeneration: owner.connectionGeneration,
        ...(kind === 'run' ? { runId: owner.run.runId, reason: 'operator-requested-stop' } : { expectedCaptureSessionId: owner.captureSessionId || null }),
      }, { quiet: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The Stop request timed out.')), 6500) }),
    ])
  } catch (error) { notice(`Stop is not confirmed for ${owner.projectName || 'this project'}. Check that Node and use the independent stop procedure if needed. ${error.message || ''}`) }
  finally { clearTimeout(timer); pendingOwnedStops.delete(key); renderControls() }
}
function renderSetup() {
  const panel = byId('setup-inspection'), inspection = state?.setupReport || state?.setup || state?.workcell?.setup
  const next = JSON.stringify(inspection || null)
  if (setupKey === next) return
  setupKey = next; panel.replaceChildren()
  const intro = make('p', 'Setup inspection describes available records. Unverified evidence does not mean missing equipment.', 'panel-note'); panel.append(intro)
  panel.append(button('Inspect setup', () => run('workcell.setup.inspect')))
  if (inspection?.inspection?.message) panel.append(make('p', inspection.inspection.message, 'panel-note'))
  const findings = [...(inspection?.checks || []), ...(inspection?.requestBlockers || []), ...(inspection?.implementations || []).flatMap((implementation) => (implementation.checks || []).map((finding) => ({ ...finding, implementation: implementation.implementationId })))]
  for (const finding of findings) {
    const row = make('div', undefined, 'setup-finding'); row.append(make('strong', [finding.implementation, finding.id || finding.code].filter(Boolean).join(' · ')), make('span', finding.status || 'blocked', 'status'), make('p', finding.message || finding.detail || ''))
    if (finding.action) row.append(make('p', finding.action)); if (finding.reasonCodes?.length) row.append(make('p', finding.reasonCodes.join(' · '))); panel.append(row)
  }
}
function setTab(tab) {
  inspectorTab = tab
  byId('inspector').querySelector('.inspector-heading h2').textContent = { devices: 'Devices', setup: 'Setup', run: 'Runs', experiments: 'Experiments' }[tab] || 'Devices'
  for (const item of document.querySelectorAll('[data-tab]')) item.setAttribute('aria-selected', String(item.dataset.tab === tab))
  for (const item of document.querySelectorAll('[data-workcell-tab]')) item.hidden = item.dataset.workcellTab !== tab
  renderControls()
}
function layout() {
  byId('desktop').classList.toggle('devices-hidden', !panelOpen)
  byId('inspector').hidden = !panelOpen
  byId('devices-toggle').setAttribute('aria-expanded', String(panelOpen))
  byId('sidebar').classList.toggle('open', navOpen)
  byId('sidebar-toggle').setAttribute('aria-expanded', String(navOpen))
  byId('panel-backdrop').hidden = !(navOpen && innerWidth <= 680 || panelOpen && innerWidth <= 950)
}
function update(next) {
  if (disposed || !next || !Array.isArray(next.projects) || !Number.isInteger(next.revision)) return
  if (state && next.revision < state.revision) return
  const context = `${next.activeProjectId}:${next.activeConversationId}:${next.connectionGeneration}`
  const changed = currentContext !== context
  if (slash && (changed || next.hostUnavailable)) closeSlash({ focus: false, save: false })
  if (changed && state?.activeConversationId) drafts.set(`${state.activeProjectId}:${state.activeConversationId}`, byId('message').value)
  state = next
  if (changed) {
    currentContext = context; pendingSend = false; questionKey = ''; transcriptKey = ''; closePopover()
    if (state.activeProjectId) expanded.add(state.activeProjectId)
    byId('message').value = drafts.get(`${state.activeProjectId}:${state.activeConversationId}`) ?? state.conversation?.draft ?? ''
  }
  workcell.update(next.workcell, activeProject()?.connection?.status === 'connected', context)
  experiments.update(next, scope())
  experimentChat.update(next, scope())
  renderSidebar(); renderTranscript(); renderQuestion(); renderSetup(); renderControls(); renderProviderQuestion(); layout()
  if (byId('dialog').open) refreshDialog?.()
  if (slash) renderSlash()
  if (popoverProject) { const current = state.projects.find((item) => item.id === popoverProject), anchor = [...document.querySelectorAll('.project-row')].find((row) => row.dataset.projectId === popoverProject); if (current && anchor) showProject(current, anchor, byId('project-popover').dataset.pinned === 'true'); else closePopover() }
  if (next.notice && next.notice !== noticeMessage) notice(next.notice)
}
function dialog(title) {
  if (slash) closeSlash({ focus: false })
  dialogGeneration++; refreshDialog = null; byId('dialog').dataset.providerQuestion = ''
  closePopover(); const content = byId('dialog-content'); content.replaceChildren(make('h2', title)); if (!byId('dialog').open) byId('dialog').showModal(); return content
}
function field(form, label, name, value = '', type = 'text') {
  const caption = make('label', label); const input = make('input'); input.type = type; input.name = name; input.value = value; input.id = `field-${name}`; caption.htmlFor = input.id; form.append(caption, input); return input
}
function selectField(form, label, name, options, selected) {
  const caption = make('label', label), select = make('select'); select.name = name; select.id = `field-${name}`; caption.htmlFor = select.id
  for (const [value, text] of options) select.add(new Option(text, value)); if (selected) select.value = selected
  form.append(caption, select); return select
}
function footer(form, submitText, submit) {
  const actions = make('div', undefined, 'actions'); const cancel = button('Cancel', () => byId('dialog').close(), 'plain'), save = button(submitText, async () => {
    if (dialogBusy || ![...form.querySelectorAll('input,select')].every((input) => input.reportValidity())) return
    dialogBusy = true; save.disabled = true
    try { await submit(); byId('dialog').close() } catch (error) {
      let message = form.querySelector('.error'); if (!message) { message = make('p', undefined, 'error'); form.append(message) }; message.textContent = error.message || 'Request failed'
    } finally { dialogBusy = false; save.disabled = false }
  }, 'primary'); actions.append(cancel, save); form.append(actions)
}
function createProject() {
  const form = dialog('New project'); const name = field(form, 'Project name', 'name'); name.required = true; name.maxLength = 100
  const type = selectField(form, 'Connection', 'type', [['local', 'Local Node'], ['ssh', 'Remote Node over SSH'], ['simulation', 'Simulation only']], 'local')
  const label = field(form, 'Computer or connection name', 'label'); label.placeholder = 'Robot laptop'
  const details = make('div'); form.append(details)
  const fields = {}
  const redraw = () => {
    details.replaceChildren()
    if (type.value === 'simulation') details.append(make('p', 'Uses the explicit simulation backend. It does not demonstrate hardware movement or physical readiness.', 'help'))
    else if (type.value === 'local') { fields.nodeUrl = field(details, 'Node address', 'nodeUrl', 'http://127.0.0.1:8876'); details.append(make('p', 'Attach to an existing Node. Creating the project does not start or replace an installation.', 'help')) }
    else {
      fields.host = field(details, 'SSH host', 'host'); fields.host.required = true
      fields.username = field(details, 'SSH user', 'username'); fields.username.required = true
      fields.port = field(details, 'SSH port', 'port', '22', 'number'); fields.port.min = '1'; fields.port.max = '65535'
      fields.remotePort = field(details, 'Remote Node port', 'remotePort', '8876', 'number'); fields.remotePort.min = '1'; fields.remotePort.max = '65535'
      fields.keyPath = field(details, 'SSH identity file (optional)', 'keyPath'); details.append(make('p', 'Uses your existing SSH configuration and known host trust. Connect reports missing trust or credentials; the app never accepts an unknown host automatically.', 'help'))
    }
  }
  type.onchange = redraw; redraw()
  footer(form, 'Create project', () => {
    const connection = { type: type.value, label: label.value.trim() || name.value.trim() }
    for (const key of type.value === 'local' ? ['nodeUrl'] : type.value === 'ssh' ? ['host', 'username', 'port', 'remotePort', 'keyPath'] : []) if (fields[key]?.value) connection[key] = ['port', 'remotePort'].includes(key) ? Number(fields[key].value) : fields[key].value.trim()
    return command('project.create', { name: name.value.trim(), connection })
  }); name.focus()
}
function projectSettings(project) {
  const form = dialog('Project settings'), name = field(form, 'Project name', 'name', project.name); name.required = true
  form.append(make('p', `${project.connection?.label || ''} · ${project.connection?.kind || 'local'} · ${cleanStatus(project.connection?.status)}`, 'help'))
  const reconnectLabel = make('label', undefined, 'checkbox-label'), reconnect = make('input')
  reconnect.type = 'checkbox'; reconnect.checked = project.connection?.autoConnect === true
  reconnectLabel.append(reconnect, make('span', 'Reconnect when the app opens')); form.append(reconnectLabel)
  form.append(make('p', 'Reconnection checks this Node’s identity and authorization. Cameras and runs still require explicit actions.', 'help'))
  reconnect.onchange = async () => { reconnect.disabled = true; try { await command('connection.setAutoConnect', { projectId: project.id, enabled: reconnect.checked }) } catch { reconnect.checked = !reconnect.checked } finally { reconnect.disabled = false } }
  if (project.connection?.kind !== 'simulation') {
    const token = field(form, 'Camera authorization token', 'camera-credential', '', 'password'); token.autocomplete = 'off'
    const executionToken = field(form, 'Execution authorization token (optional)', 'execution-credential', '', 'password'); executionToken.autocomplete = 'off'
    form.append(make('p', 'The main process stores credentials in the operating system credential store. Tokens are never included in conversation history or project files.', 'help'))
    form.append(button('Save Node credential', async () => { if (!token.value) return; try { await command('connection.saveCredential', { projectId: project.id, cameraToken: token.value, executionToken: executionToken.value }); token.value = ''; executionToken.value = ''; notice('Node credential saved.') } catch {} }))
  }
  form.append(button('Archive project', () => confirmArchive('project', project), 'plain stop'))
  footer(form, 'Save name', () => command('project.rename', { projectId: project.id, name: name.value.trim() }))
}
function conversationSettings(project, conversation) {
  const form = dialog('Conversation'), title = field(form, 'Title', 'title', conversation.title || 'New conversation'); title.required = true
  form.append(button('Archive conversation', () => confirmArchive('conversation', project, conversation), 'plain stop'))
  footer(form, 'Save title', () => command('conversation.rename', { projectId: project.id, conversationId: conversation.id, title: title.value.trim() }))
}
function confirmArchive(kind, project, conversation) {
  byId('dialog').close(); const form = dialog(`Archive ${kind}?`); form.append(make('p', 'The saved history is preserved. Archiving does not stop equipment or terminate a run.'))
  footer(form, 'Archive', () => command(`${kind}.archive`, { projectId: project.id, ...(conversation ? { conversationId: conversation.id } : {}) }))
}
function dialogError(form, message, id = 'settings-error') {
  let error = form.querySelector('#' + id)
  if (!error) { error = make('p', undefined, 'error'); error.id = id; error.setAttribute('role', 'alert'); form.append(error) }
  error.textContent = message
}
const providerId = (provider) => typeof provider === 'string' ? provider : provider.id
const providerName = (id) => (state?.settings?.providers || []).find((item) => providerId(item) === id)?.name || id
const availableModels = () => (state?.models || []).filter((model) => typeof model.provider === 'string' && typeof model.id === 'string')
const simulationSelected = () => state?.settings?.simulation || activeProject()?.connection?.kind === 'simulation'
function modelEmptyMessage() {
  if (simulationSelected()) return 'Simulation uses a scripted guide. No AI model or provider sign-in is needed for this project.'
  if (!activeConversation()) return 'Choose a project and conversation to select its assistant model.'
  return 'No models available. Connect a provider below, then refresh the list. If credentials are already configured, check that provider’s setup.'
}
function showModels() {
  const form = dialog('Choose a model'), generation = dialogGeneration, context = currentContext
  const search = field(form, 'Search models', 'model-search', '', 'search')
  search.placeholder = 'Search by model or provider'; search.autocomplete = 'off'
  const count = make('p', undefined, 'help'); count.id = 'model-result-count'; count.setAttribute('role', 'status')
  const list = make('div', undefined, 'choice-list'); list.id = 'model-list'; list.setAttribute('aria-label', 'Available models')
  form.append(count, list)
  const actions = make('div', undefined, 'actions settings-actions')
  const manage = button('Manage providers', showSettings, 'plain'); manage.id = 'model-manage'
  const refresh = button('Refresh models', async () => {
    refresh.disabled = true
    try { await command('settings.models', {}, { quiet: true }); if (generation === dialogGeneration) redraw(true) }
    catch (error) { if (generation === dialogGeneration) dialogError(form, error.message) }
    finally { refresh.disabled = false }
  }, 'plain')
  actions.append(manage, refresh, button('Done', () => byId('dialog').close(), 'plain')); form.append(actions)
  let signature = '', selecting = false
  const redraw = (force = false) => {
    const models = availableModels(), current = state?.conversation?.model
    const next = JSON.stringify([models, state?.settings?.providers, current, search.value, state?.hostUnavailable, state?.conversation?.busy, currentContext, simulationSelected()])
    if (!force && next === signature) return
    signature = next; list.replaceChildren()
    if (currentContext !== context) {
      count.textContent = 'The conversation changed. Close this picker and reopen it for the current conversation.'
      search.disabled = true; return
    }
    search.disabled = !models.length
    search.hidden = !models.length; form.querySelector('label[for="field-model-search"]').hidden = !models.length
    if (!models.length) {
      count.textContent = modelEmptyMessage()
      manage.textContent = simulationSelected() ? 'Provider settings' : 'Manage providers'
      return
    }
    const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const filtered = models.filter((model) => words.every((word) => [model.name, model.id, model.provider, providerName(model.provider)].join(' ').toLocaleLowerCase().includes(word)))
    count.textContent = filtered.length ? filtered.length + ' available ' + (filtered.length === 1 ? 'model' : 'models') : 'No models match your search.'
    if (state?.hostUnavailable) count.textContent += ' The workspace host is unavailable. Reopen the app to recover.'
    else if (state?.conversation?.busy) count.textContent += ' Wait for the response or cancel it before changing models.'
    const groups = new Map()
    for (const model of filtered) {
      if (!groups.has(model.provider)) groups.set(model.provider, [])
      groups.get(model.provider).push(model)
    }
    for (const [id, entries] of [...groups].sort(([a], [b]) => providerName(a).localeCompare(providerName(b)))) {
      const group = make('section', undefined, 'model-group'); group.append(make('h3', providerName(id)))
      for (const model of entries.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))) {
        const selected = current?.provider === model.provider && current?.id === model.id
        const option = button('', async () => {
          if (selecting || generation !== dialogGeneration || context !== currentContext) return
          selecting = true
          for (const item of list.querySelectorAll('button')) item.disabled = true
          try {
            await command('settings.selectModel', { provider: model.provider, modelId: model.id }, { quiet: true })
            if (generation === dialogGeneration) byId('dialog').close()
          } catch (error) { if (generation === dialogGeneration) dialogError(form, error.message) }
          finally { selecting = false; if (generation === dialogGeneration) redraw(true) }
        }, 'model-option')
        option.dataset.provider = model.provider; option.dataset.modelId = model.id
        option.setAttribute('aria-pressed', String(selected))
        option.disabled = selecting || state?.hostUnavailable || state?.conversation?.busy
        const label = make('span', undefined, 'model-label'); label.append(make('strong', model.name || model.id), make('small', model.id, 'muted'))
        option.append(label, make('span', selected ? 'Selected' : '', 'model-selected')); group.append(option)
      }
      list.append(group)
    }
  }
  search.oninput = () => redraw()
  search.onkeydown = (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button:not(:disabled)')?.focus() } }
  list.onkeydown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...list.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement)
    if (!items.length) return
    event.preventDefault()
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    items[target].focus()
  }
  refreshDialog = redraw; redraw(); if (!search.hidden) search.focus()
}
function showSettings() {
  if (state?.settings?.loginQuestion) { loginQuestionKey = ''; renderProviderQuestion(); return }
  const form = dialog('Model & app settings'), generation = dialogGeneration
  const summary = make('div', undefined, 'model-summary'); form.append(summary)
  const heading = make('h3', 'Providers'); form.append(heading)
  const search = field(form, 'Search providers', 'provider-search', '', 'search')
  search.placeholder = 'Find your provider'; search.autocomplete = 'off'
  const list = make('div', undefined, 'choice-list'); list.id = 'provider-list'; list.setAttribute('aria-label', 'Providers'); form.append(list)
  const refresh = button('Refresh providers', async () => {
    refresh.disabled = true
    try { await command('settings.get', {}, { quiet: true }); if (generation === dialogGeneration) redraw(true) }
    catch (error) { if (generation === dialogGeneration) dialogError(form, error.message) }
    finally { refresh.disabled = false }
  }, 'plain')
  const actions = make('div', undefined, 'actions settings-actions'); actions.append(refresh, button('Done', () => byId('dialog').close(), 'plain')); form.append(actions)
  let signature = ''
  const redraw = (force = false) => {
    const providers = state?.settings?.providers || [], current = state?.conversation?.model
    const next = JSON.stringify([providers, availableModels(), current, search.value, state?.settings?.loginPending, state?.hostUnavailable, simulationSelected(), currentContext])
    if (!force && signature === next) return
    signature = next
    const expandedProviders = new Set([...list.querySelectorAll('details[open]')].map((item) => item.dataset.providerId))
    summary.replaceChildren()
    summary.append(make('p', simulationSelected() ? modelEmptyMessage() : current ? 'Current model: ' + (current.name || current.id) : availableModels().length ? 'Choose a model for this conversation.' : modelEmptyMessage(), 'help'))
    if (availableModels().length && !simulationSelected()) summary.append(button('Choose model', showModels))
    list.replaceChildren()
    const query = search.value.trim().toLocaleLowerCase()
    const matches = providers.filter((item) => [providerId(item), item.name].join(' ').toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(Boolean(b.configured)) - Number(Boolean(a.configured)) || (a.name || providerId(a)).localeCompare(b.name || providerId(b)))
    if (state?.settings?.loginPending) {
      const pending = make('p', 'Waiting for provider sign-in to finish or cancel. Provider actions will become available when it settles.', 'help'); pending.setAttribute('role', 'status'); summary.append(pending)
      const cancel = button('Cancel sign in', async () => {
        cancel.disabled = true
        try { await command('settings.providerCancel', {}, { quiet: true }); if (generation === dialogGeneration) pending.textContent = 'Cancellation requested. Waiting for the provider to finish cleanup.' }
        catch (error) { if (generation === dialogGeneration) { dialogError(form, error.message); cancel.disabled = Boolean(state?.hostUnavailable) } }
      }, 'plain')
      cancel.id = 'provider-pending-cancel'; cancel.disabled = Boolean(state?.hostUnavailable); summary.append(cancel)
    }
    if (!matches.length) list.append(make('p', providers.length ? 'No providers match your search.' : 'No providers have been reported. Refresh providers to try again.', 'help'))
    for (const provider of matches) {
      const id = providerId(provider), row = make('details', undefined, 'provider-row'); row.dataset.providerId = id; row.open = expandedProviders.has(id)
      const title = make('summary'), label = make('span', undefined, 'provider-label')
      label.append(make('strong', provider.name || id))
      if (provider.name && provider.name !== id) label.append(make('small', id, 'muted'))
      title.append(label, make('span', provider.configured ? 'Configured' : 'Connect', 'provider-status')); row.append(title)
      const actions = make('div', undefined, 'actions')
      const act = (text, name, payload, style = '') => {
        const control = button(text, async () => {
          control.disabled = true
          try { await command(name, payload, { quiet: true }) }
          catch (error) { if (generation === dialogGeneration) dialogError(form, error.message) }
          finally { if (generation === dialogGeneration) control.disabled = Boolean(state?.settings?.loginPending || state?.hostUnavailable) }
        }, style)
        control.disabled = Boolean(state?.settings?.loginPending) || state?.hostUnavailable; actions.append(control)
      }
      if (provider.oauth) act('Browser sign in', 'settings.providerLogin', { providerId: id, authType: 'oauth' })
      if (provider.apiKey) act('Use API key', 'settings.providerLogin', { providerId: id, authType: 'api_key' })
      if (provider.configured) act('Sign out', 'settings.providerLogout', { providerId: id }, 'plain')
      if (!actions.childElementCount) row.append(make('p', 'This provider uses environment credentials. Configure it through its supported setup, then refresh.', 'help'))
      row.append(actions); list.append(row)
    }
  }
  search.oninput = () => redraw(); refreshDialog = redraw; redraw()
}
function renderProviderQuestion() {
  const question = state?.settings?.loginQuestion
  const key = question ? JSON.stringify(question) : ''
  if (key === loginQuestionKey) return
  const prior = loginQuestionKey; loginQuestionKey = key
  if (!question) {
    if (prior && byId('dialog').dataset.providerQuestion === 'true') {
      byId('dialog').dataset.providerQuestion = ''; byId('dialog').close(); showSettings()
      if (state?.notice) { const status = make('p', state.notice, 'help'); status.setAttribute('role', 'status'); byId('dialog-content').append(status) }
    }
    return
  }
  // A later auth URL can update the same manual prompt. Preserve its input;
  // unrelated state notifications must not erase a code while it is being typed.
  const previous = byId('field-provider-answer')
  const preserve = byId('dialog').dataset.providerQuestionId === question.id
  const answerValue = preserve ? previous?.value || '' : ''
  const answerFocused = preserve && document.activeElement === previous
  const selection = answerFocused && previous?.type === 'text' ? [previous.selectionStart, previous.selectionEnd] : null
  const form = dialog('Provider sign in'), generation = dialogGeneration
  byId('dialog').dataset.providerQuestion = 'true'; byId('dialog').dataset.providerQuestionId = question.id
  const status = make('p', undefined, 'help'); status.id = 'provider-login-status'; status.setAttribute('role', 'status')
  if (question.url) {
    form.append(make('p', 'Open the sign-in page and complete authorization in your browser.', 'help'))
    const open = button('Open sign-in page', async () => {
      open.disabled = true
      try {
        await command('settings.openAuthUrl', { questionId: question.id }, { quiet: true })
        if (generation === dialogGeneration) {
          form.querySelector('#provider-login-error')?.remove()
          status.textContent = 'Sign-in page opened. Complete authorization in your browser.'
        }
      } catch (error) {
        if (generation === dialogGeneration) {
          status.textContent = ''
          dialogError(form, 'Could not open the sign-in page. Copy the address below into your browser. ' + error.message, 'provider-login-error')
        }
      } finally { if (generation === dialogGeneration) open.disabled = false }
    }, 'auth-open')
    open.id = 'provider-open-auth'; form.append(open)
    const label = make('label', 'Sign-in address — copy if the browser does not open')
    label.htmlFor = 'provider-auth-url'
    const address = make('input'); address.id = 'provider-auth-url'; address.type = 'text'; address.readOnly = true; address.value = question.url; address.className = 'credential'; address.onclick = () => address.select()
    form.append(label, address)
  }
  if (question.userCode) form.append(make('p', 'Code: ' + question.userCode, 'credential'))
  if (question.instructions) form.append(make('p', question.instructions, 'help'))
  form.append(status)
  const cancel = button('Cancel sign in', async () => {
    try { await command('settings.providerCancel', {}, { quiet: true }) }
    catch (error) { if (generation === dialogGeneration) dialogError(form, error.message, 'provider-login-error') }
  }, 'plain')
  if (question.kind === 'oauth') {
    status.textContent = 'Waiting for provider authorization. You can reopen the sign-in page if needed.'
    const actions = make('div', undefined, 'actions'); actions.append(cancel); form.append(actions); return
  }
  form.append(make('p', question.question || 'Provider information is required.'))
  let input
  if (question.options?.length) input = selectField(form, 'Answer', 'provider-answer', question.options.map((option) => typeof option === 'string' ? [option, option] : [option.id, option.label]), answerValue)
  else {
    input = field(form, question.kind === 'manual_code' ? 'Authorization code or redirect URL' : question.kind === 'secret' ? 'API key' : 'Answer', 'provider-answer', answerValue, question.kind === 'secret' ? 'password' : 'text')
    input.autocomplete = 'off'; input.spellcheck = false; input.required = true; input.maxLength = 16000
  }
  const actions = make('div', undefined, 'actions')
  const submit = button('Continue', async () => {
    if (submit.disabled || !input.reportValidity()) return
    const answer = input.value; input.value = ''; submit.disabled = true
    try { await command('settings.providerAnswer', { questionId: question.id, answer }, { quiet: true }) }
    catch (error) { if (generation === dialogGeneration) dialogError(form, error.message, 'provider-login-error') }
    finally { if (generation === dialogGeneration) submit.disabled = false }
  }, 'primary')
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); submit.click() } }
  actions.append(cancel, submit); form.append(actions)
  if (answerFocused || !question.url) { input.focus(); if (selection) input.setSelectionRange(...selection) }
}
async function openSettingsView(show) {
  if (state?.settings?.loginQuestion) { loginQuestionKey = ''; renderProviderQuestion(); return }
  show()
  const generation = dialogGeneration
  try { await command('settings.get', {}, { quiet: true }) }
  catch (error) { if (generation === dialogGeneration) dialogError(byId('dialog-content'), error.message) }
}
// Slash commands are local presentation state. The textarea is temporarily a
// filter; only the separately retained prose draft may cross the session bridge.
const slashMenu = make('section', undefined, 'slash-menu')
slashMenu.id = 'slash-menu'; slashMenu.hidden = true; slashMenu.setAttribute('aria-label', 'Composer commands')
byId('composer').prepend(slashMenu)
const messagePlaceholder = byId('message').placeholder
const draftKey = () => state?.activeProjectId + ':' + state?.activeConversationId
const isModelCommand = (value) => /^\/model$/i.test(value.trim())
const isCommandPrefix = (value) => !value.includes('\n') && value.startsWith('/') && '/model'.startsWith(value.trim().toLowerCase())
function scheduleDraft() {
  clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveDraft() }, 600)
}
function closeSlash({ restore = true, focus = true, save = true } = {}) {
  if (!slash) return
  const previous = slash; slash = null
  slashMenu.hidden = true; slashMenu.replaceChildren()
  const input = byId('message')
  input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-autocomplete'); input.removeAttribute('aria-expanded')
  input.placeholder = messagePlaceholder
  if (previous.context === currentContext && restore) {
    input.value = previous.draft; drafts.set(draftKey(), previous.draft)
    if (save) scheduleDraft()
  }
  renderControls(); if (focus && !input.disabled) input.focus()
}
function openSlash(stage = 'commands') {
  if (!state?.activeConversationId || state.hostUnavailable || activeConversation()?.busy || pendingSend) return
  clearTimeout(draftTimer); draftTimer = null
  slash = { stage, context: currentContext, scope: scope(), draft: drafts.get(draftKey()) ?? state.conversation?.draft ?? '',
    query: '', provider: null, active: 0, options: [], pending: false, error: '' }
  if (stage !== 'commands') byId('message').value = ''
  renderSlash(); byId('message').focus()
}
function slashBack() {
  if (!slash || slash.pending) return
  if (slash.stage !== 'models') { closeSlash(); return }
  slash.stage = 'providers'; slash.provider = null; slash.query = ''; slash.active = 0; slash.error = ''
  byId('message').value = ''; renderSlash(); byId('message').focus()
}
function activateSlash(option) {
  const owner = slash
  if (!owner || owner.pending || owner.context !== currentContext || state.hostUnavailable || activeConversation()?.busy || pendingSend || !option) return
  if (owner.stage === 'commands') {
    owner.stage = 'providers'; owner.query = ''; owner.active = 0
    byId('message').value = ''; renderSlash(); byId('message').focus(); return
  }
  if (owner.stage === 'providers') {
    owner.stage = 'models'; owner.provider = option.provider; owner.query = ''; owner.active = 0; owner.error = ''
    byId('message').value = ''; renderSlash(); byId('message').focus(); return
  }
  owner.pending = true; owner.error = ''; renderSlash()
  void command('settings.selectModel', { ...owner.scope, provider: option.provider, modelId: option.modelId }, { quiet: true })
    .then(() => { if (slash === owner && owner.context === currentContext) closeSlash() })
    .catch((error) => { if (slash === owner) owner.error = error.message || 'Could not select that model. Refresh the list and try again.' })
    .finally(() => { if (slash === owner) { owner.pending = false; renderSlash(); byId('message').focus() } })
}
function renderSlash() {
  const owner = slash
  if (!owner) return
  const input = byId('message'), models = availableModels(), current = state?.conversation?.model
  const query = owner.query.trim().toLocaleLowerCase()
  const matches = (parts) => query.split(/\s+/).filter(Boolean).every((word) => parts.join(' ').toLocaleLowerCase().includes(word))
  if (owner.stage === 'commands') owner.options = [{ label: '/model', detail: 'Choose provider and model', command: 'model' }]
  else if (owner.stage === 'providers') {
    const providers = [...new Set(models.map((model) => model.provider))]
    owner.options = providers.filter((id) => matches([id, providerName(id)]))
      .sort((a, b) => Number(b === current?.provider) - Number(a === current?.provider) || providerName(a).localeCompare(providerName(b)))
      .map((id) => { const count = models.filter((model) => model.provider === id).length; return { provider: id, label: providerName(id), detail: count + (count === 1 ? ' model' : ' models') } })
  } else {
    owner.options = models.filter((model) => model.provider === owner.provider && matches([model.name, model.id]))
      .sort((a, b) => Number(b.id === current?.id && b.provider === current?.provider) - Number(a.id === current?.id && a.provider === current?.provider) || (a.name || a.id).localeCompare(b.name || b.id))
      .map((model) => ({ provider: model.provider, modelId: model.id, label: model.name || model.id, detail: model.id,
        selected: model.provider === current?.provider && model.id === current?.id }))
  }
  owner.active = Math.max(0, Math.min(owner.active, owner.options.length - 1))
  slashMenu.hidden = false; slashMenu.dataset.stage = owner.stage; slashMenu.replaceChildren()
  const header = make('div', undefined, 'slash-heading')
  header.append(make('strong', owner.stage === 'commands' ? 'Commands' : owner.stage === 'providers' ? 'Choose provider' : providerName(owner.provider) + ' · Choose model'))
  if (owner.stage === 'models') {
    const back = button('← Providers', slashBack, 'plain'); back.id = 'slash-back'; back.disabled = owner.pending; header.append(back)
  }
  slashMenu.append(header)
  const list = make('div', undefined, 'slash-options'); list.id = 'slash-options'; list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', owner.stage === 'providers' ? 'Available providers' : owner.stage === 'models' ? 'Available models' : 'Commands')
  const disabled = owner.pending || state?.hostUnavailable || state?.conversation?.busy || pendingSend
  owner.options.forEach((item, index) => {
    const row = button('', () => { if (slash === owner && owner.options[index] === item) activateSlash(item) }, owner.stage === 'providers' ? 'slash-provider' : owner.stage === 'models' ? 'slash-model' : 'slash-command')
    row.id = 'slash-option-' + index; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === owner.active)); row.tabIndex = -1; row.disabled = disabled
    if (item.provider) row.dataset.provider = item.provider
    if (item.modelId) row.dataset.modelId = item.modelId
    const label = make('span', undefined, 'slash-label'); label.append(make('strong', item.label), make('small', item.detail, 'muted'))
    row.append(label, make('span', item.selected ? 'Current' : '↵', 'slash-choice-hint'))
    row.onpointerdown = (event) => event.preventDefault()
    row.onpointermove = () => {
      if (slash !== owner || owner.options[index] !== item || owner.pending) return
      owner.active = index
      for (const option of list.children) option.setAttribute('aria-selected', String(option === row))
      input.setAttribute('aria-activedescendant', row.id)
    }
    list.append(row)
  })
  slashMenu.append(list)
  if (!owner.options.length) slashMenu.append(make('p', !models.length ? modelEmptyMessage() : owner.stage === 'providers' ? 'No providers match your search.' : 'No models match your search.', 'slash-empty'))
  if (owner.error) { const error = make('p', owner.error, 'error'); error.id = 'slash-error'; error.setAttribute('role', 'alert'); slashMenu.append(error) }
  const footer = make('div', undefined, 'slash-footer')
  const hint = owner.pending ? 'Selecting model…' : state?.conversation?.busy ? 'Wait for the response or cancel it before changing models.' : '↑ ↓ Navigate · Enter Select · Esc Back'
  footer.append(make('span', hint))
  if (owner.stage !== 'commands') {
    const manage = button('Manage providers', () => { closeSlash({ focus: false }); void openSettingsView(showSettings) }, 'plain'); manage.id = 'slash-manage'; manage.disabled = owner.pending
    const refresh = button('Refresh', async () => {
      if (slash !== owner || owner.pending) return
      owner.pending = true; renderSlash()
      try { await command('settings.models', {}, { quiet: true }) }
      catch (error) { if (slash === owner) owner.error = error.message }
      finally { if (slash === owner) { owner.pending = false; renderSlash(); input.focus() } }
    }, 'plain'); refresh.disabled = owner.pending
    footer.append(manage, refresh)
  }
  slashMenu.append(footer)
  input.placeholder = owner.stage === 'providers' ? 'Filter providers…' : owner.stage === 'models' ? 'Filter models…' : messagePlaceholder
  input.setAttribute('aria-controls', 'slash-options'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-autocomplete', 'list')
  if (owner.options.length && !disabled) input.setAttribute('aria-activedescendant', 'slash-option-' + owner.active)
  else input.removeAttribute('aria-activedescendant')
  renderControls()
}
function slashKey(event) {
  if (!slash || event.isComposing || event.keyCode === 229) return false
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); slashBack(); return true }
  if (event.key === 'Enter' && event.shiftKey) return false
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    if (slash.options.length && !slash.pending) {
      slash.active = event.key === 'Home' ? 0 : event.key === 'End' ? slash.options.length - 1 : (slash.active + (event.key === 'ArrowDown' ? 1 : -1) + slash.options.length) % slash.options.length
      for (const [index, item] of [...byId('slash-options').children].entries()) item.setAttribute('aria-selected', String(index === slash.active))
      const active = byId('slash-option-' + slash.active); inputActive(active)
    }
    return true
  }
  if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey && slash.stage === 'commands') {
    event.preventDefault(); activateSlash(slash.options[slash.active]); return true
  }
  return false
}
function inputActive(active) {
  if (!active) return
  byId('message').setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' })
}
function handleComposerInput() {
  if (slash && slash.stage !== 'commands') {
    slash.query = byId('message').value; slash.active = 0; slash.error = ''; renderSlash(); return
  }
  if (isCommandPrefix(byId('message').value)) {
    if (!slash) openSlash()
    else renderSlash()
    return
  }
  if (slash) closeSlash({ restore: false, focus: false, save: false })
  drafts.set(draftKey(), byId('message').value); renderControls(); scheduleDraft()
}
byId('new-project').onclick = createProject
byId('settings-open').onclick = () => { void openSettingsView(showSettings) }
byId('model-settings').onclick = () => { void openSettingsView(showModels) }
byId('conversation-menu').onclick = () => { if (activeProject() && activeConversation()) conversationSettings(activeProject(), activeConversation()) }
byId('message').oninput = handleComposerInput
byId('message').onkeydown = (event) => { if (slashKey(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); byId('composer').requestSubmit() } }
byId('composer').onsubmit = async (event) => {
  event.preventDefault(); const text = byId('message').value.trim()
  if (slash) { activateSlash(slash.options[slash.active]); return }
  if (isModelCommand(text)) { openSlash('providers'); return }
  if (!text || pendingSend || activeConversation()?.busy || !state?.activeConversationId || state.hostUnavailable) return
  const context = currentContext, requestScope = scope(), key = `${state.activeProjectId}:${state.activeConversationId}`
  clearTimeout(draftTimer); draftTimer = null; pendingSend = true; renderControls(); notice()
  try { await draftSave; if (context !== currentContext) return; await command('conversation.send', { ...requestScope, text, requestId: crypto.randomUUID() }); drafts.set(key, ''); if (context === currentContext) byId('message').value = '' }
  catch {} finally { if (context === currentContext) { pendingSend = false; renderControls() } }
}
byId('cancel-message').onclick = () => run('conversation.cancel')
byId('devices-toggle').onclick = () => { panelOpen = !panelOpen; layout() }
byId('inspector-close').onclick = () => { panelOpen = false; layout() }
byId('sidebar-toggle').onclick = () => { navOpen = !navOpen; layout() }
byId('close-sidebar').onclick = () => { navOpen = false; layout() }
byId('panel-backdrop').onclick = () => { navOpen = false; if (innerWidth <= 950) panelOpen = false; layout() }
for (const tab of document.querySelectorAll('[data-tab]')) tab.onclick = () => setTab(tab.dataset.tab)
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.project-popover,.project-row')) closePopover(); if (slash && !event.target.closest('#composer')) closeSlash({ focus: false }) })
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closePopover(); navOpen = false; if (innerWidth <= 950) panelOpen = false; layout() } })
byId('dialog').addEventListener('cancel', () => { if (state?.settings?.loginPending && byId('dialog').dataset.providerQuestion === 'true') run('settings.providerCancel') })
addEventListener('resize', () => { closePopover(); layout() })
addEventListener('pagehide', () => { clearTimeout(draftTimer); disposed = true; unsubscribe?.(); workcell.dispose(); experiments.dispose(); experimentChat.dispose() })
async function start() {
  layout()
  if (!bridge || typeof bridge.snapshot !== 'function' || typeof bridge.command !== 'function' || typeof bridge.subscribe !== 'function') {
    notice('The desktop bridge is unavailable. Open this view through the Physical Systems desktop application.'); renderTranscript(); renderControls(); return
  }
  unsubscribe = bridge.subscribe(update)
  try { update(await bridge.snapshot()) } catch (error) {
    notice(`Could not load the workspace. ${error.message || ''}`)
    const retry = button('Reload workspace', () => { retry.remove(); void bridge.snapshot().then(update).catch((failure) => notice(failure.message)) }); byId('app-notice').append(' ', retry)
  }
}
void start()
