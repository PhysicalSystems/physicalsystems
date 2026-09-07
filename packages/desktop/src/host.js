// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { openCatalog } from './catalog.js';
import * as connections from './connections.js';
import { validateCommand } from './bridge-contract.js';
import { createApplication } from './application.js';

const parent = process.parentPort;
if (!parent) throw new Error('The desktop host requires its owned application process channel.');
const dataDir = process.argv[2];
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('An absolute desktop data directory is required.');
let catalog;
let application;
let unsubscribe;
let closed = false;
let closing;

const ready = (async () => {
  catalog = await openCatalog(dataDir);
  try {
    application = await createApplication({ dataDir, catalog, connections });
    unsubscribe = application.subscribe((snapshot) => parent.postMessage({ event: 'snapshot', snapshot }));
    parent.postMessage({ event: 'snapshot', snapshot: await application.snapshot() });
  } catch (error) { await catalog.close(); throw error; }
})();
ready.catch(() => {});

async function close() {
  if (closed) return;
  if (closing) return closing;
  closing = (async () => {
    try { await ready; } catch (error) { if (application) throw error; }
    await application?.close(); // May reject; retain process and ownership in that case.
    unsubscribe?.();
    await catalog?.close();
    closed = true;
  })();
  try { await closing; } finally { closing = undefined; }
}

parent.on('message', async ({ data }) => {
  const { id, method, name, payload } = data ?? {};
  if (typeof id !== 'string' || id.length > 128) return;
  try {
    if (method === 'exit') {
      if (!closed) throw new Error('The desktop host cannot exit before cleanup is confirmed.');
      process.exit(0);
      return;
    }
    if (method !== 'close') await ready;
    if (closed && method !== 'close') throw new Error('The desktop application host is closed.');
    let result;
    if (method === 'snapshot') result = await application.snapshot();
    else if (method === 'command') result = await application.command(name, validateCommand(name, payload));
    else if (method === 'close') { await close(); result = { closed: true }; }
    else throw new Error('Unsupported desktop host request.');
    parent.postMessage({ id, result });
  } catch (error) {
    parent.postMessage({ id, error: { code: typeof error.code === 'string' ? error.code : 'DESKTOP_REQUEST_FAILED', message: error.message || 'The desktop request could not be completed.' } });
  }
});

// No parent means no new authority. Attempt ordinary cleanup, never force-kill a Node.
parent.on('close', () => { close().then(() => process.exit(0)).catch(() => {}); });
