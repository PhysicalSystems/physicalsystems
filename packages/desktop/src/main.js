// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow, dialog, ipcMain, protocol, session, utilityProcess, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { APP_URL, assetName, validateCommand, validateSender, unavailableSnapshot, validateAuthDestination } from './bridge-contract.js';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const dataArgument = process.argv.find((arg) => arg.startsWith('--data-dir='));
const argumentIndex = process.argv.indexOf('--data-dir');
const selectedDataDir = dataArgument?.slice('--data-dir='.length) ?? (argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined);
if (selectedDataDir !== undefined && (!path.isAbsolute(selectedDataDir) || selectedDataDir.includes('\0'))) throw new Error('--data-dir requires an absolute directory path.');
const dataDir = selectedDataDir ?? path.join(app.getPath('appData'), 'PhysicalSystems', 'desktop-development');
app.setPath('userData', path.join(dataDir, 'shell'));
app.setName('Physical Systems Development');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'physicalsystems', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

let window;
let host;
let hostExited = false;
let quitAllowed = false;
let closing = false;
let nextId = 0;
let lastSnapshot = {};
const requests = new Map();
const runId = randomUUID();

function request(method, name, payload, timeoutMs = 30000) {
  if (!host || hostExited) return Promise.reject(new Error('The application host is unavailable. Close and reopen the desktop to recover; pending operations are not replayed.'));
  if (requests.size >= 128 && method !== 'close' && !name?.endsWith('.stop') && name !== 'conversation.cancel') return Promise.reject(new Error('The desktop has too many pending requests. Wait for the current request, then retry.'));
  const id = `${runId}:${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('The desktop request timed out. Inspect current state before retrying an operation.')); }, timeoutMs);
    requests.set(id, { resolve, reject, timer });
    host.postMessage({ id, method, name, payload });
  });
}

async function tryClose() {
  if (closing || quitAllowed) return;
  closing = true;
  try {
    if (!hostExited) {
      await request('close', undefined, undefined, 15000);
      // The host exits only after main has received its confirmed cleanup result.
      if (!hostExited) host.postMessage({ id: `${runId}:exit`, method: 'exit' });
    }
    quitAllowed = true;
    app.quit();
  } catch (error) {
    await dialog.showMessageBox(window, { type: 'warning', title: 'Desktop cleanup is not confirmed', message: 'Keep the workspace open to resolve its active resources.', detail: error.message, buttons: ['Return to workspace'], defaultId: 0, cancelId: 0 });
  } finally { closing = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', (event) => { if (!quitAllowed) { event.preventDefault(); void tryClose(); } });
  app.on('window-all-closed', () => { if (quitAllowed) app.quit(); });
  // Finish ESM entry evaluation before waiting for Electron's ready event.
  void app.whenReady().then(async () => {
  const rendererSession = session.fromPartition('physical-systems-desktop');
  rendererSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.on('will-download', (event) => event.preventDefault());
  rendererSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('physicalsystems://desktop/') && !details.url.startsWith('data:') && !details.url.startsWith('blob:') }));
  await rendererSession.protocol.handle('physicalsystems', async (requestInfo) => {
    const name = assetName(requestInfo.url);
    if (!name || requestInfo.method !== 'GET') return new Response('Not found', { status: 404 });
    const mime = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name === 'styles.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    const filename = name === 'view-state.js' ? path.join(sourceDir, '../../cli/src/harness/workcell-view/view-state.js') : path.join(sourceDir, 'renderer', name);
    try {
      return new Response(await readFile(filename), { headers: {
        'Content-Type': mime,
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      } });
    } catch { return new Response('Desktop asset unavailable', { status: 404 }); }
  });
  host = utilityProcess.fork(path.join(sourceDir, 'host.js'), [dataDir], { serviceName: 'Physical Systems Harness', stdio: 'ignore', execArgv: [] });
  host.on('message', (message) => {
    if (message?.event === 'snapshot') { lastSnapshot = message.snapshot; if (window && !window.isDestroyed()) window.webContents.send('physical-systems:snapshot', message.snapshot); return; }
    const pending = requests.get(message?.id);
    if (!pending) return;
    requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result);
  });
  host.on('exit', () => {
    hostExited = true;
    lastSnapshot = unavailableSnapshot(lastSnapshot);
    if (window && !window.isDestroyed()) window.webContents.send('physical-systems:snapshot', lastSnapshot);
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('The application host stopped. Pending operations were not replayed. Reopen the desktop to restore saved conversations and inspect the target before retrying.')); }
    requests.clear();
    if (!quitAllowed && !closing && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: 'Application host stopped', message: 'The workspace connection is unavailable.', detail: 'Saved conversations remain on disk. Close and reopen the desktop, then inspect the target state before retrying any operation. Remote hardware may still be active.', buttons: ['Keep window open'] });
  });
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 720, minHeight: 560, title: 'Physical Systems', show: false, backgroundColor: '#202020', webPreferences: {
    preload: path.join(sourceDir, 'preload.cjs'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    session: rendererSession,
  } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => { if (!quitAllowed) { event.preventDefault(); void tryClose(); } });
  ipcMain.handle('physical-systems:snapshot', async (event) => { validateSender(event, window.webContents); return hostExited ? lastSnapshot : request('snapshot'); });
  ipcMain.handle('physical-systems:command', async (event, name, payload) => {
    validateSender(event, window.webContents);
    const result = await request('command', name, validateCommand(name, payload));
    if (name === 'settings.openAuthUrl') {
      // The host resolves the current question ID; renderer-supplied URLs are never opened.
      await shell.openExternal(validateAuthDestination(result?.url), { activate: true });
      return { opened: true };
    }
    return result;
  });
  await window.loadURL(APP_URL);
  window.show();
  }).catch(async (error) => {
    await dialog.showMessageBox({ type: 'error', title: 'Desktop startup failed', message: 'The desktop workspace could not open.', detail: error.message, buttons: ['Close'] });
    if (host && !hostExited) await tryClose();
    else { quitAllowed = true; app.quit(); }
  });
}
