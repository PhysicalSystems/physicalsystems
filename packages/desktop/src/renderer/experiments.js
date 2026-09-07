// SPDX-License-Identifier: Apache-2.0
const ACTIVE = new Set(['PROPOSED', 'READY', 'RUNNING', 'OUTCOME_UNKNOWN'])
const node = (tag, text, className) => {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = String(text)
  if (className) el.className = className
  return el
}
const labelPhase = (phase) => String(phase || 'No experiment').toLowerCase().replaceAll('_', ' ')

/** A presentation-only, conversation-scoped view of the synthetic controller. */
export function mountExperiments(root, { command }) {
  let state, scope, context = '', key = '', disposed = false, pending = false, stopPending = false, failure = ''
  let goal = 'Find an alignment approach', budget = '4', offset = '0', approvedDigest = null, selectedHistory = ''
  const requestIds = new Map()
  const requestId = (key) => { if (!requestIds.has(key)) requestIds.set(key, crypto.randomUUID()); return requestIds.get(key) }
  function actionButton(text, action, disabled = false, className = '') {
    const ownerContext = context, button = node('button', text, className); button.type = 'button'; button.disabled = disabled
    button.onclick = () => { if (ownerContext === context && root.contains(button) && !button.disabled) action() }; return button
  }
  async function send(operation, payload, independent = false) {
    if (disposed || state?.hostUnavailable || (independent ? stopPending : pending)) return
    const ownerContext = context, ownerScope = { ...scope }
    if (independent) stopPending = true; else pending = true
    failure = ''; key = ''; render()
    let timer
    try {
      await Promise.race([command(`experiment.${operation}`, { ...ownerScope, ...payload }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The experiment request timed out. Inspect its recorded status before retrying; no trial is replayed automatically.')), 6500)
      })])
    } catch (error) {
      if (ownerContext === context && !disposed) failure = error.message || 'The experiment request could not be confirmed. Inspect its status before retrying.'
    } finally {
      clearTimeout(timer)
      if (ownerContext === context && !disposed) { if (independent) stopPending = false; else pending = false; key = ''; render() }
    }
  }
  function details(record, historical = false) {
    const section = node('section', undefined, 'experiment-result')
    const title = node('div', undefined, 'experiment-title'); title.append(node('h3', record.goal), node('span', historical ? `Historical · ${labelPhase(record.phase)}` : labelPhase(record.phase), 'badge')); section.append(title)
    section.append(node('p', `${record.trials?.length || 0} / ${record.trialLimit} trials · synthetic alignment fixture · millimetres`, 'panel-note'))
    const table = node('table', undefined, 'experiment-trials'); table.id = historical ? 'experiment-history-trials' : 'experiment-trials'
    table.append(node('caption', 'Trial measurements — synthetic fixture'))
    const head = node('thead'), heading = node('tr'); for (const label of ['Trial', 'Offset', 'Error', 'Status']) heading.append(node('th', label)); head.append(heading); table.append(head)
    const body = node('tbody')
    for (const [index, trial] of (record.trials || []).entries()) {
      const row = node('tr'); row.dataset.trialId = trial.id || trial.trialId || String(index)
      const measured = trial.result || trial.measurement || trial
      const value = trial.offsetMm ?? trial.parameters?.offsetMm ?? trial.inputs?.offsetMm
      for (const cell of [index + 1, Number.isFinite(value) ? `${value} mm` : '—', Number.isFinite(measured.alignmentErrorMm) ? `${measured.alignmentErrorMm} mm` : 'Unverified', labelPhase(trial.phase || trial.status || 'recorded')]) row.append(node('td', cell))
      body.append(row)
      if (trial.error) { const diagnostic = node('tr'), cell = node('td', trial.error, 'error'); cell.colSpan = 4; diagnostic.append(cell); body.append(diagnostic) }
    }
    table.append(body); section.append(table)
    if (!record.trials?.length) section.append(node('p', 'No trial has run. A proposal alone grants no trial authority.', 'panel-note'))
    const measured = (record.trials || []).filter((trial) => trial.status === 'COMPLETED' && Number.isFinite((trial.result || trial.measurement || trial).alignmentErrorMm))
    const best = measured.reduce((chosen, trial) => !chosen || (trial.result || trial.measurement || trial).alignmentErrorMm < (chosen.result || chosen.measurement || chosen).alignmentErrorMm ? trial : chosen, null)
    if (best) {
      const result = best.result || best.measurement || best, value = best.offsetMm ?? best.parameters?.offsetMm ?? best.inputs?.offsetMm
      const summary = node('p', `Best measured: ${result.alignmentErrorMm} mm error${Number.isFinite(value) ? ` at ${value} mm offset` : ''}. Synthetic evidence only.`, 'experiment-best'); summary.id = historical ? 'experiment-history-best' : 'experiment-best'; section.append(summary)
    }
    if (record.summary?.interpretation) section.append(node('p', record.summary.interpretation, 'panel-note'))
    if (record.reason || record.error?.message) section.append(node('p', record.reason || record.error.message, 'error'))
    if (record.recoveryReason) section.append(node('p', record.recoveryReason, 'notice'))
    const evidence = node('details', undefined, 'technical-evidence'); evidence.append(node('summary', 'Experiment evidence'), node('p', `Experiment ${record.id}`), node('p', `Plan ${record.planDigest}`)); section.append(evidence)
    return section
  }
  function render() {
    if (disposed) return
    const experimentState = state?.experiments, current = experimentState?.current
    const unavailable = state?.hostUnavailable || !experimentState || experimentState.availability !== 'simulation-only'
    const expiry = typeof current?.expiresAt === 'number' ? current.expiresAt : Date.parse(current?.expiresAt || '')
    const expired = Number.isFinite(expiry) && Date.now() >= expiry
    const next = JSON.stringify([context, experimentState, state?.hostUnavailable, pending, stopPending, failure, expired, selectedHistory])
    if (next === key) return
    key = next; root.replaceChildren()
    const intro = node('div', undefined, 'experiment-intro'); intro.append(node('span', 'SIMULATION ONLY', 'badge'), node('h2', 'Experiments'), node('p', state?.settings?.simulation ? 'Scripted guide · numeric synthetic fixture. No AI model, physics or hardware.' : 'Compare measured trials in a numeric synthetic fixture. These results do not qualify physical equipment.', 'panel-note')); root.append(intro)
    if (unavailable) root.append(node('p', state?.hostUnavailable ? 'Experiment host unavailable. Displayed records are historical. Reopen the app to inspect recovery; trials are never replayed automatically.' : 'Choose a conversation to open its experiment controller. A Node connection is not required for synthetic trials.', 'notice'))
    if (experimentState?.error) root.append(node('p', experimentState.error, 'error'))
    if (failure) { const error = node('p', failure, 'error'); error.id = 'experiment-error'; error.setAttribute('role', 'status'); root.append(error) }
    if (current) root.append(details(current, Boolean(state?.hostUnavailable)))
    if (current?.phase === 'PROPOSED' && !unavailable) {
      const review = node('div', undefined, 'experiment-approval')
      review.append(node('p', `Review this goal and maximum of ${current.trialLimit} synthetic trials. Approval expires ${new Date(current.expiresAt).toLocaleTimeString()}.`, 'panel-note'))
      const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'experiment-confirm'; checkbox.checked = approvedDigest === current.planDigest; checkbox.disabled = pending || expired
      label.append(checkbox, document.createTextNode(' I approve this exact simulation plan and trial budget.')); review.append(label)
      const approve = actionButton(state?.settings?.simulation ? 'Approve & run scripted trials' : 'Approve simulation plan', () => void send('approve', { experimentId: current.id, expectedDigest: current.planDigest, approved: true }), pending || expired || !checkbox.checked, 'primary'); approve.id = 'experiment-approve'
      checkbox.onchange = () => { approvedDigest = checkbox.checked ? current.planDigest : null; approve.disabled = pending || expired || !checkbox.checked }
      review.append(approve); if (expired) review.append(node('p', 'This proposal expired. Stop it, then propose a new experiment and review it again.', 'error')); root.append(review)
    }
    if (current?.phase === 'READY' && !unavailable) {
      const controls = node('form', undefined, 'experiment-trial-form'), caption = node('label', 'Next synthetic offset (mm)'), input = node('input')
      input.id = 'experiment-offset'; input.type = 'number'; input.min = '-10'; input.max = '10'; input.step = '0.001'; input.value = offset; input.required = true; caption.htmlFor = input.id; input.oninput = () => { offset = input.value }
      const trial = actionButton('Measure trial', () => { if (input.reportValidity()) void send('trial', { experimentId: current.id, offsetMm: Number(input.value), requestId: requestId(`trial:${current.id}:${current.trials.length}:${input.value}`) }) }, pending || expired || current.trials.length >= current.trialLimit); trial.id = 'experiment-trial'
      controls.onsubmit = (event) => { event.preventDefault(); trial.click() }; controls.append(caption, input, trial, actionButton('Finish experiment', () => void send('finish', { experimentId: current.id }), pending || !current.trials.some((trial) => trial.status === 'COMPLETED')))
      if (current.trials.length >= current.trialLimit) controls.append(node('p', 'The approved trial budget is used. Finish this experiment to retain its result.', 'panel-note'))
      root.append(controls)
    }
    if (current && ['PROPOSED', ...ACTIVE].includes(current.phase)) {
      const stop = actionButton(stopPending ? 'Stopping experiment…' : 'Stop experiment', () => void send('stop', { experimentId: current.id }, true), unavailable || stopPending, 'stop'); stop.id = 'experiment-stop'; root.append(stop)
      if (current.phase === 'OUTCOME_UNKNOWN') root.append(node('p', 'The trial outcome is unknown. Stop requests cancellation but cannot by itself confirm a previous process outcome. Retain this record until the runner confirms settlement. An uncertain trial is never repeated automatically.', 'notice'))
    }
    if (!current || !ACTIVE.has(current.phase)) {
      const form = node('form', undefined, 'experiment-proposal-form'), goalLabel = node('label', 'Experiment goal'), goalInput = node('textarea'), budgetLabel = node('label', 'Maximum trials'), budgetInput = node('input')
      goalInput.id = 'experiment-goal'; goalInput.value = goal; goalInput.rows = 2; goalInput.maxLength = 1000; goalInput.required = true; goalLabel.htmlFor = goalInput.id; goalInput.oninput = () => { goal = goalInput.value }
      budgetInput.id = 'experiment-budget'; budgetInput.type = 'number'; budgetInput.min = '1'; budgetInput.max = '10'; budgetInput.step = '1'; budgetInput.value = budget; budgetInput.required = true; budgetLabel.htmlFor = budgetInput.id; budgetInput.oninput = () => { budget = budgetInput.value }
      const propose = actionButton('Propose experiment', () => { if (goalInput.reportValidity() && budgetInput.reportValidity()) void send('propose', { goal: goalInput.value, trialLimit: Number(budgetInput.value), mode: 'simulation', requestId: requestId(`proposal:${current?.id || ''}:${goalInput.value}:${budgetInput.value}`) }) }, unavailable || pending); propose.id = 'experiment-propose'
      form.onsubmit = (event) => { event.preventDefault(); propose.click() }; form.append(goalLabel, goalInput, budgetLabel, budgetInput, propose); root.append(form)
    }
    const history = (experimentState?.history || []).filter((record) => record.id !== current?.id)
    if (history.length) {
      const historyLabel = node('label', 'Previous experiments'), select = node('select'); select.id = 'experiment-history'; historyLabel.htmlFor = select.id; select.add(new Option('Choose recorded experiment', ''))
      for (const item of history) select.add(new Option(`${item.goal} · ${labelPhase(item.phase)}`, item.id))
      select.value = selectedHistory; select.onchange = () => { selectedHistory = select.value; key = ''; render() }; root.append(historyLabel, select)
      const selected = history.find((record) => record.id === selectedHistory); if (selected) root.append(details(selected, true))
    }
  }
  const timer = setInterval(render, 500)
  return {
    update(next, nextScope) {
      const nextContext = `${nextScope.projectId}:${nextScope.conversationId}`
      if (nextContext !== context) { context = nextContext; pending = false; stopPending = false; failure = ''; approvedDigest = null; selectedHistory = ''; requestIds.clear(); goal = 'Find an alignment approach'; budget = '4'; offset = '0' }
      state = next; scope = nextScope; render()
    },
    dispose() { disposed = true; clearInterval(timer) },
  }
}

/** Approval is a real operator action bound to the controller's exact plan.
 * Assistant prose cannot create this card or authorize a continuation. */
export function mountExperimentChat(root, { command, openDetails }) {
  let state, scope, context = '', key = '', disposed = false, attempt = null, stopping = null, finishing = null, failure = ''
  const current = () => state?.experiments?.current
  const identity = () => JSON.stringify([scope?.projectId, scope?.conversationId, scope?.connectionGeneration, current()?.id, current()?.planDigest])
  const progress = () => JSON.stringify([state?.conversation?.messages?.length, state?.conversation?.messages?.at(-1)?.id,
    state?.conversation?.error, current()?.trials?.length])
  const active = () => !disposed && state?.activeProjectId === scope?.projectId && state?.activeConversationId === scope?.conversationId
  const offline = () => state?.hostUnavailable || state?.experiments?.historical || state?.experiments?.availability !== 'simulation-only'
  const unavailable = () => offline() || Boolean(state?.experiments?.error) || current()?.mode !== 'simulation'
  const settled = () => attempt?.status === 'accepted' && !state?.conversation?.busy && (attempt.sawBusy || progress() !== attempt.before)
  const unconfirmed = () => attempt?.status === 'unknown' || attempt?.status === 'accepted' && !settled()
  const invalidate = () => { key = ''; render() }
  function actionButton(id, text, action, disabled = false, className = '') {
    const owner = context, button = node('button', text, className)
    button.type = 'button'; button.id = id; button.disabled = disabled
    button.onclick = () => { if (active() && context === owner && root.contains(button) && !button.disabled) action() }
    return button
  }
  function continueExperiment(approve) {
    if (!active() || unavailable() || attempt?.pending || finishing?.pending || stopping?.pending || state?.conversation?.busy) return
    const record = current()
    if (!record || Date.now() >= record.expiresAt || record.phase !== (approve ? 'PROPOSED' : 'READY')) return
    const reuse = attempt && (unconfirmed() || attempt.status === 'rejected')
    const token = { context, requestId: reuse ? attempt.requestId : crypto.randomUUID(), pending: true,
      status: 'pending', before: reuse ? attempt.before : progress(), sawBusy: reuse ? attempt.sawBusy : false, timer: null }
    if (attempt) clearTimeout(attempt.timer)
    attempt = token; failure = ''
    const operation = approve ? 'approveAndContinue' : 'continue'
    const payload = { ...scope, experimentId: record.id, expectedDigest: record.planDigest,
      requestId: token.requestId, ...(approve ? { approved: true } : {}) }
    const owned = () => active() && context === token.context && attempt === token
    token.timer = setTimeout(() => {
      if (!owned()) return
      token.pending = false; token.status = 'unknown'
      failure = 'The request is not confirmed yet. Check its status here before trying another continuation.'; invalidate()
    }, 6500)
    invalidate()
    void Promise.resolve().then(() => command(`experiment.${operation}`, payload)).then((result) => {
      if (!owned()) return
      const receipt = result?.continuation
      token.pending = false
      if (receipt?.requestId === token.requestId && receipt.accepted === true) {
        token.status = 'accepted'; failure = ''
      } else if (receipt?.requestId === token.requestId && receipt.accepted === false) {
        token.status = 'rejected'; failure = receipt.error || 'The assistant did not start. Your recorded approval is preserved; retry Continue when the assistant is available.'
      } else {
        token.status = 'unknown'; failure = 'The continuation was not confirmed. Check its recorded status before trying another request.'
      }
    }, (error) => {
      if (!owned()) return
      token.pending = false; token.status = 'unknown'
      failure = error.message || 'The request could not be confirmed. Inspect this experiment before retrying.'
    }).finally(() => { clearTimeout(token.timer); if (owned()) invalidate() })
  }
  function controlExperiment(operation) {
    const stop = operation === 'stop'
    if (!active() || offline() || !current()) return
    if (stop ? stopping?.pending : unavailable() || finishing?.pending || stopping?.pending || attempt?.pending || state?.conversation?.busy || current().phase !== 'READY') return
    const token = { context, pending: true, timer: null }, payload = { ...scope, experimentId: current().id }
    if (stop) stopping = token; else finishing = token
    failure = ''
    const label = stop ? 'Stop' : 'Finish'
    const owned = () => active() && context === token.context && (stop ? stopping : finishing) === token
    token.timer = setTimeout(() => {
      if (!owned()) return
      token.pending = false; failure = `${label} is not confirmed yet. Inspect the recorded status and retry ${label}.`; invalidate()
    }, 6500)
    invalidate()
    void Promise.resolve().then(() => command(`experiment.${operation}`, payload)).then(() => {
      if (owned()) { token.pending = false; failure = '' }
    }, (error) => {
      if (owned()) { token.pending = false; failure = error.message || `${label} could not be confirmed. Retain this experiment and retry ${label}.` }
    }).finally(() => { clearTimeout(token.timer); if (owned()) invalidate() })
  }
  function render() {
    if (disposed) return
    const experiment = state?.experiments, record = current(), expired = record && (!Number.isFinite(record.expiresAt) || Date.now() >= record.expiresAt)
    const busy = Boolean(state?.conversation?.busy), pending = Boolean(attempt?.pending || finishing?.pending)
    const next = JSON.stringify([context, experiment, busy, state?.conversation?.error, progress(),
      unavailable(), expired, pending, attempt?.status, settled(), stopping?.pending, failure])
    if (next === key) return
    key = next; root.replaceChildren(); root.hidden = !record && !experiment?.error
    if (root.hidden) return
    root.id = 'chat-experiment-card'; root.className = 'experiment-chat-card'; root.setAttribute('aria-label', 'Experiment in this conversation')
    const title = node('div', undefined, 'experiment-chat-heading')
    title.append(node('span', 'SIMULATION ONLY', 'eyebrow'), node('span', unavailable() ? 'Status unavailable' : labelPhase(record?.phase), 'badge'))
    root.append(title)
    if (record) {
      const heading = record.phase === 'PROPOSED' ? 'Review experiment' : record.phase === 'COMPLETED' ? 'Experiment completed' : 'Experiment'
      root.append(node('h3', heading), node('p', record.goal, 'experiment-chat-goal'))
      const input = experiment.fixture?.input
      root.append(node('p', `${record.trials?.length || 0} / ${record.trialLimit} trials · Synthetic alignment · Offset ${input?.minimum ?? -10} to ${input?.maximum ?? 10} mm`, 'panel-note'))
      if (record.phase === 'PROPOSED') {
        root.append(node('p', `Approve up to ${record.trialLimit} synthetic trials and let the assistant continue. This numeric fixture does not operate equipment.`, 'experiment-chat-review'))
        root.append(node('p', expired ? 'This proposal has expired. Stop it and ask for a new proposal.' : `Approval expires ${new Date(record.expiresAt).toLocaleTimeString()}.`, expired ? 'error' : 'panel-note'))
      }
      if (record.trials?.length) {
        const table = node('table', undefined, 'experiment-trials'), head = node('thead'), row = node('tr'), body = node('tbody')
        table.append(node('caption', 'Recorded synthetic results'))
        for (const text of ['Trial', 'Offset', 'Error', 'Status']) row.append(node('th', text))
        head.append(row); table.append(head)
        for (const [index, trial] of record.trials.entries()) {
          const row = node('tr'), measured = trial.status === 'COMPLETED' && Number.isFinite(trial.result?.alignmentErrorMm)
          for (const value of [index + 1, `${trial.offsetMm} mm`, measured ? `${trial.result.alignmentErrorMm} mm` : 'Not confirmed', labelPhase(trial.status)]) row.append(node('td', value))
          body.append(row)
        }
        table.append(body); root.append(table)
        const measured = record.trials.filter((trial) => trial.status === 'COMPLETED' && Number.isFinite(trial.result?.alignmentErrorMm))
        if (record.phase === 'COMPLETED' && measured.length) {
          const best = measured.reduce((best, trial) => trial.result.alignmentErrorMm < best.result.alignmentErrorMm ? trial : best)
          root.append(node('p', `Best recorded: ${best.result.alignmentErrorMm} mm error at ${best.offsetMm} mm offset.`, 'experiment-best'))
        }
      }
      if (record.recoveryReason) root.append(node('p', record.recoveryReason, 'error'))
      if (record.phase === 'OUTCOME_UNKNOWN') root.append(node('p', 'The outcome is unconfirmed. Stop and retain the evidence; an uncertain trial is never replayed automatically.', 'error'))
      if (busy && ['PROPOSED', 'READY'].includes(record.phase)) root.append(node('p', 'The assistant is working. Answer its question or wait for the response before continuing.', 'panel-note'))
      if (record.phase === 'READY' && expired) root.append(node('p', 'The approval has expired. Stop this experiment and review a new proposal.', 'error'))
      if (attempt?.status === 'accepted' && !settled() && !busy && record.phase === 'READY') root.append(node('p', 'Continuation requested. Waiting for the assistant’s status.', 'panel-note'))
      const actions = node('div', undefined, 'actions')
      if (record.phase === 'PROPOSED') actions.append(actionButton('chat-experiment-approve', pending ? 'Requesting approval…' : 'Approve & continue', () => continueExperiment(true), unavailable() || busy || pending || stopping?.pending || expired, 'primary'))
      if (record.phase === 'READY') {
        if (record.trials.length < record.trialLimit) actions.append(actionButton('chat-experiment-continue', pending ? 'Requesting continuation…' : unconfirmed() ? 'Check continuation' : 'Continue experiment', () => continueExperiment(false), unavailable() || busy || pending || stopping?.pending || expired, 'primary'))
        else actions.append(actionButton('chat-experiment-finish', finishing?.pending ? 'Finishing experiment…' : 'Finish experiment', () => controlExperiment('finish'), unavailable() || busy || pending || stopping?.pending || !record.trials.some((trial) => trial.status === 'COMPLETED'), 'primary'))
      }
      if (ACTIVE.has(record.phase)) actions.append(actionButton('chat-experiment-stop', stopping?.pending ? 'Stopping experiment…' : 'Stop experiment', () => controlExperiment('stop'), offline() || stopping?.pending, 'plain stop'))
      actions.append(actionButton('chat-experiment-details', 'View details', openDetails, false, 'plain'))
      root.append(actions)
    }
    if (experiment?.error) root.append(node('p', experiment.error, 'error'))
    if (failure) { const error = node('p', failure, 'error'); error.setAttribute('role', 'status'); root.append(error) }
  }
  const timer = setInterval(render, 500)
  return {
    update(next, nextScope) {
      state = next; scope = nextScope
      const nextContext = identity()
      if (nextContext !== context) {
        clearTimeout(attempt?.timer); clearTimeout(stopping?.timer); clearTimeout(finishing?.timer)
        context = nextContext; attempt = null; stopping = null; finishing = null; failure = ''; key = ''
      }
      if (attempt && state?.conversation?.busy) attempt.sawBusy = true
      render()
    },
    dispose() { disposed = true; clearInterval(timer); clearTimeout(attempt?.timer); clearTimeout(stopping?.timer); clearTimeout(finishing?.timer) },
  }
}
