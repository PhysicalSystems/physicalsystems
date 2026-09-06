// SPDX-License-Identifier: Apache-2.0
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 5 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const FILE = 'catalog.json';
const LOCK = 'catalog.lock';

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Unsupported ${label} field; credentials and execution authority do not belong in the catalog.`);
}
function text(value, label, max = 256, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error(`Invalid ${label}.`);
}
function id(value, optional = false) {
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid catalog identifier.');
}
function bool(value, label) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`Invalid ${label}.`);
}
function uniqueIds(items) {
  if (!Array.isArray(items) || items.length > 10000) throw new Error('Invalid catalog collection.');
  const seen = new Set();
  for (const item of items) { id(item?.id); if (seen.has(item.id)) throw new Error('Duplicate catalog identifier.'); seen.add(item.id); }
  return seen;
}

export function emptyCatalog() {
  return { schemaVersion: 1, revision: 0, projects: [], connections: [], conversations: [], selection: { projectId: null, conversationId: null }, preferences: { devicesOpen: true, theme: 'system' } };
}

export function validateCatalog(value) {
  record(value, ['schemaVersion', 'revision', 'projects', 'connections', 'conversations', 'selection', 'preferences'], 'catalog');
  if (value.schemaVersion !== 1) throw new Error('This catalog version is not supported. Preserve the file and use a compatible desktop build.');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid catalog revision.');
  const projectIds = uniqueIds(value.projects);
  const connectionIds = uniqueIds(value.connections);
  const conversationIds = uniqueIds(value.conversations);
  for (const project of value.projects) {
    record(project, ['id', 'name', 'connectionId', 'collapsed', 'archived', 'cwd', 'createdAt', 'lastConversationId'], 'project');
    text(project.name, 'project name'); id(project.connectionId, true);
    if (project.connectionId && !connectionIds.has(project.connectionId)) throw new Error('Project connection reference is missing.');
    bool(project.collapsed, 'project collapsed state'); bool(project.archived, 'project archive state');
    if (project.cwd !== undefined && (typeof project.cwd !== 'string' || !path.isAbsolute(project.cwd) || project.cwd.includes('\0'))) throw new Error('Project folder must be an absolute path.');
    text(project.createdAt, 'project creation date', 64, true);
    id(project.lastConversationId, true);
    if (project.lastConversationId && !value.conversations.some((conversation) => conversation.id === project.lastConversationId && conversation.projectId === project.id)) throw new Error('The project’s last conversation reference belongs to another project or is missing.');
  }
  for (const connection of value.connections) {
    record(connection, ['id', 'type', 'label', 'nodeUrl', 'host', 'username', 'port', 'remotePort', 'keyPath', 'knownHostsPath', 'credentialRef', 'expectedNodeId', 'autoConnect'], 'connection');
    if (!['local', 'ssh', 'simulation'].includes(connection.type)) throw new Error('Unsupported connection type.');
    text(connection.label, 'connection label', 256, true); bool(connection.autoConnect, 'automatic connection');
    for (const key of ['nodeUrl', 'host', 'username', 'keyPath', 'knownHostsPath', 'credentialRef', 'expectedNodeId']) text(connection[key], key, 4096, true);
    for (const key of ['port', 'remotePort']) if (connection[key] !== undefined && (!Number.isInteger(connection[key]) || connection[key] < 1 || connection[key] > 65535)) throw new Error(`Invalid ${key}.`);
    if (connection.nodeUrl !== undefined) {
      const url = new URL(connection.nodeUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error('Node URLs cannot contain credentials or request data.');
    }
  }
  for (const conversation of value.conversations) {
    record(conversation, ['id', 'projectId', 'title', 'sessionId', 'sessionFile', 'archived', 'draft', 'createdAt', 'updatedAt'], 'conversation');
    id(conversation.projectId); if (!projectIds.has(conversation.projectId)) throw new Error('Conversation project reference is missing.');
    text(conversation.title, 'conversation title'); id(conversation.sessionId, true); bool(conversation.archived, 'conversation archive state');
    text(conversation.draft, 'draft', 128 * 1024, true);
    for (const key of ['createdAt', 'updatedAt']) text(conversation[key], key, 64, true);
    if (conversation.sessionFile !== undefined && (typeof conversation.sessionFile !== 'string' || !/^harness\/harness-sessions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.jsonl$/.test(conversation.sessionFile))) throw new Error('Session reference must remain within the desktop Harness session directory.');
  }
  record(value.selection, ['projectId', 'conversationId'], 'selection');
  id(value.selection.projectId, true); id(value.selection.conversationId, true);
  if (value.selection.projectId && !projectIds.has(value.selection.projectId)) throw new Error('Selected project is missing.');
  if (value.selection.conversationId) {
    if (!conversationIds.has(value.selection.conversationId)) throw new Error('Selected conversation is missing.');
    if (value.conversations.find((item) => item.id === value.selection.conversationId).projectId !== value.selection.projectId) throw new Error('Selected conversation belongs to another project.');
  }
  record(value.preferences, ['devicesOpen', 'theme'], 'preferences');
  bool(value.preferences.devicesOpen, 'device panel preference');
  if (value.preferences.theme !== undefined && !['system', 'light', 'dark'].includes(value.preferences.theme)) throw new Error('Invalid theme.');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('The desktop catalog is too large. Archive or export conversations before adding more metadata.');
  return value;
}

async function readFileSafe(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Desktop catalog must be a regular file of a supported size.');
  return fs.readFile(filename, 'utf8');
}

async function atomicWrite(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close();
    await fs.rename(temporary, filename);
    // fsync directories is available on the qualified Linux development route.
    if (process.platform !== 'win32') { const directory = await fs.open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}

export async function openCatalog(dataDir) {
  if (!path.isAbsolute(dataDir)) throw new Error('The desktop data directory must be absolute.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(dataDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('The desktop data directory must not be a symbolic link.');
  const lockPath = path.join(dataDir, LOCK);
  const token = randomUUID();
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('This desktop data directory is locked. Close its other desktop instance. After a crash, inspect catalog.lock and confirm that its process has ended before moving that lock aside; preserve catalog.json and its backup.'), { code: 'CATALOG_LOCKED' });
    throw error;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); await lock.sync(); await lock.close();
  const unlock = async () => {
    try { const current = JSON.parse(await readFileSafe(lockPath)); if (current.token === token) await fs.unlink(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  let state;
  try {
    try { state = validateCatalog(JSON.parse(await readFileSafe(path.join(dataDir, FILE)))); }
    catch (error) {
      if (error.code === 'ENOENT') state = emptyCatalog();
      else throw Object.assign(new Error(`The desktop catalog could not be opened: ${error.message} The original was preserved. Inspect catalog.json.bak for recovery; do not reset the existing configuration.`), { code: 'CATALOG_INVALID' });
    }
  } catch (error) { await unlock(); throw error; }
  let queue = Promise.resolve();
  let closed = false;
  return {
    dataDir,
    snapshot: () => structuredClone(state),
    transaction(mutator) {
      if (closed) return Promise.reject(new Error('Desktop catalog is closed.'));
      const pending = queue.then(async () => {
        const draft = structuredClone(state);
        const result = await mutator(draft);
        draft.revision = state.revision + 1;
        validateCatalog(draft);
        const target = path.join(dataDir, FILE);
        try { await atomicWrite(`${target}.bak`, await readFileSafe(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await atomicWrite(target, `${JSON.stringify(draft, null, 2)}\n`);
        state = draft;
        return result === undefined ? structuredClone(state) : result;
      });
      queue = pending.catch(() => {});
      return pending;
    },
    async close() { if (closed) return; closed = true; await queue; await unlock(); },
  };
}
