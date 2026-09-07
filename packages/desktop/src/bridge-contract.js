// SPDX-License-Identifier: Apache-2.0
export const APP_ORIGIN = 'physicalsystems://desktop';
export const APP_URL = `${APP_ORIGIN}/index.html`;
export const COMMANDS = new Set([
  'project.create', 'project.rename', 'project.archive', 'project.select',
  'conversation.create', 'conversation.rename', 'conversation.archive', 'conversation.select',
  'conversation.send', 'conversation.cancel', 'conversation.answer', 'conversation.saveDraft',
  'connection.connect', 'connection.disconnect', 'connection.saveCredential', 'connection.setAutoConnect',
  'workcell.refresh', 'workcell.setup.inspect', 'workcell.camera.start', 'workcell.camera.stop', 'workcell.camera.frame',
  'workcell.execution.refresh', 'workcell.execution.prepare', 'workcell.execution.approve',
  'workcell.execution.stop', 'workcell.execution.reconcile', 'workcell.execution.select',
  'workcell.execution.receipt', 'settings.get', 'settings.models', 'settings.selectModel',
  'settings.providerLogin', 'settings.providerLogout', 'settings.providerAnswer', 'settings.providerCancel', 'settings.openAuthUrl',
  'experiment.propose', 'experiment.approve', 'experiment.approveAndContinue', 'experiment.continue', 'experiment.trial', 'experiment.finish', 'experiment.stop',
]);

export function validateCommand(name, payload = {}) {
  if (!COMMANDS.has(name)) throw new Error('This desktop command is not supported.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid command data.');
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > 1024 * 1024) throw new Error('This request is too large.');
  const clean = JSON.parse(json);
  const visit = (value, depth = 0) => {
    if (depth > 20) throw new Error('Invalid nested command data.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid command field.');
      visit(child, depth + 1);
    }
  };
  visit(clean);
  if (name.startsWith('experiment.')) {
    const operations = { propose: ['goal', 'trialLimit', 'requestId', 'mode'], approve: ['experimentId', 'expectedDigest', 'approved'],
      approveAndContinue: ['experimentId', 'expectedDigest', 'requestId', 'approved'], continue: ['experimentId', 'expectedDigest', 'requestId'],
      trial: ['experimentId', 'requestId', 'offsetMm'], finish: ['experimentId'], stop: ['experimentId'] };
    const allowed = new Set(['projectId', 'conversationId', 'connectionGeneration', ...operations[name.slice('experiment.'.length)]]);
    if (Object.keys(clean).some((key) => !allowed.has(key))) throw new Error('This experiment request contains unsupported fields.');
    if (!clean.projectId || !clean.conversationId) throw new Error('An explicit project and conversation are required for experiments.');
    if (['experiment.approveAndContinue', 'experiment.continue'].includes(name)) {
      if (!Number.isSafeInteger(clean.connectionGeneration) || clean.connectionGeneration < 0) throw new Error('An exact connection generation is required for experiment continuation.');
      for (const key of ['projectId', 'conversationId', 'experimentId', 'expectedDigest']) {
        if (typeof clean[key] !== 'string' || !clean[key].trim() || clean[key].length > 160 || /[\u0000-\u001f\u007f]/u.test(clean[key])) throw new Error(`The experiment ${key} is invalid.`);
      }
      if (typeof clean.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clean.requestId)) throw new Error('A bounded unique request ID is required.');
      if (name === 'experiment.approveAndContinue' && clean.approved !== true) throw new Error('Review this exact simulation experiment and explicitly approve its trial budget.');
    }
  }
  return clean;
}

export function validateSender(event, webContents) {
  if (!webContents || webContents.isDestroyed() || event.sender !== webContents ||
      event.senderFrame !== webContents.mainFrame || event.senderFrame?.url !== APP_URL) {
    throw new Error('The request did not come from the desktop workspace.');
  }
}

export function assetName(requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== 'physicalsystems:' || url.host !== 'desktop' || url.search || url.hash) return null;
  // An explicit allowlist prevents access to application code, metadata, or local files.
  const allowed = new Set(['/index.html', '/styles.css', '/app.js', '/workcell.js', '/experiments.js', '/view-state.js', '/markdown.js']);
  return allowed.has(url.pathname) ? url.pathname.slice(1) : null;
}

export function unavailableSnapshot(previous = {}) {
  const message = 'Desktop host disconnected. Close and reopen the app, then inspect device and operation state before retrying.';
  return {
    ...previous,
    hostUnavailable: true,
    revision: (previous.revision ?? 0) + 1,
    notice: message,
    workcell: null,
    setupReport: null,
    experiments: previous.experiments ? { ...previous.experiments, availability: 'unavailable', historical: true } : null,
    settings: previous.settings ? { ...previous.settings, loginPending: false, loginQuestion: null } : undefined,
    projects: (previous.projects ?? []).map((project) => ({ ...project, connection: { ...project.connection, status: 'offline', error: message, deviceCount: null, inUseCount: null } })),
    conversation: previous.conversation ? { ...previous.conversation, busy: false, error: message } : null,
    activeRuns: (previous.activeRuns ?? []).map((run) => ({ ...run, statusUnavailable: true, canStop: false })),
    activeCaptures: (previous.activeCaptures ?? []).map((capture) => ({ ...capture, statusUnavailable: true, canStop: false })),
    activeExperiments: (previous.activeExperiments ?? []).map((experiment) => ({ ...experiment, statusUnavailable: true, canStop: false })),
  };
}

export function validateAuthDestination(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('The provider authorization address is invalid.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Provider authorization requires a secure HTTPS address.');
  return url.href;
}
