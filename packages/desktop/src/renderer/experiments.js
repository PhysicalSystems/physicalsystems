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
