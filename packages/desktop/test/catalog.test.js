// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCatalog, emptyCatalog, validateCatalog } from '../src/catalog.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'physical-desktop-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function seed(draft) {
  draft.connections.push({ id: 'local-1', type: 'local', label: 'This computer', nodeUrl: 'http://127.0.0.1:5050', credentialRef: 'opaque-reference' });
  draft.projects.push({ id: 'project-1', name: 'Bench', connectionId: 'local-1' });
  draft.conversations.push({ id: 'chat-1', projectId: 'project-1', title: 'Inspect camera', sessionFile: 'harness/harness-sessions/2026-01-02_03.04-chat-1.jsonl', draft: '' });
  draft.selection = { projectId: 'project-1', conversationId: 'chat-1' };
}

test('catalog persists isolated metadata and reloads selection/drafts without duplicating transcripts', async (t) => {
  const directory = await fixture(t);
  const store = await openCatalog(directory);
  await store.transaction(seed);
  await store.transaction((draft) => { draft.conversations[0].draft = 'Continue the plan'; });
  const copy = store.snapshot(); copy.projects[0].name = 'External mutation';
  assert.equal(store.snapshot().projects[0].name, 'Bench');
  await store.close();
  const reopened = await openCatalog(directory);
  assert.equal(reopened.snapshot().conversations[0].draft, 'Continue the plan');
  assert.equal(reopened.snapshot().selection.conversationId, 'chat-1');
  assert.equal(reopened.snapshot().revision, 2);
  const backup = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json.bak')));
  assert.equal(backup.revision, 1);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, 'catalog.json'))).mode & 0o777, 0o600);
  await reopened.close();
});

test('catalog serializes concurrent changes and rolls back invalid mutations', async (t) => {
  const store = await openCatalog(await fixture(t));
  await store.transaction(seed);
  await Promise.all([store.transaction(async (draft) => { await new Promise((resolve) => setTimeout(resolve, 5)); draft.projects[0].name = 'Changed'; }), store.transaction((draft) => { draft.conversations[0].draft = 'Saved'; })]);
  await assert.rejects(store.transaction((draft) => { draft.connections[0].bearerToken = 'forbidden'; }), /credentials/);
  assert.equal(store.snapshot().projects[0].name, 'Changed');
  assert.equal(store.snapshot().conversations[0].draft, 'Saved');
  assert.equal(store.snapshot().revision, 3);
  await store.close();
  await assert.rejects(store.transaction(() => {}), /closed/);
});

test('catalog locks concurrent writers and preserves crash locks for explicit recovery', async (t) => {
  const directory = await fixture(t);
  const store = await openCatalog(directory);
  await assert.rejects(openCatalog(directory), { code: 'CATALOG_LOCKED' });
  await store.close();
  await fs.writeFile(path.join(directory, 'catalog.lock'), JSON.stringify({ pid: 999999999, token: 'crashed-process' }));
  await assert.rejects(openCatalog(directory), /confirm that its process has ended/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'catalog.lock'))).token, 'crashed-process');
});

test('corrupt catalog preserves primary and backup and releases its owned lock', async (t) => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'catalog.json'), '{interrupted');
  await fs.writeFile(path.join(directory, 'catalog.json.bak'), JSON.stringify(emptyCatalog()));
  await assert.rejects(openCatalog(directory), { code: 'CATALOG_INVALID' });
  assert.equal(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'), '{interrupted');
  await assert.rejects(fs.stat(path.join(directory, 'catalog.lock')), { code: 'ENOENT' });
});

test('metadata rejects credential URLs, unknown fields, cross-project selection and session traversal', () => {
  const catalog = emptyCatalog(); seed(catalog);
  for (const mutate of [
    (draft) => { draft.connections[0].nodeUrl = 'http://user:password@127.0.0.1'; },
    (draft) => { draft.connections[0].privateKey = 'not allowed'; },
    (draft) => { draft.conversations[0].sessionFile = 'sessions/../../configuration.json'; },
    (draft) => { draft.projects.push({ id: 'second', name: 'Other', connectionId: 'local-1' }); draft.selection.projectId = 'second'; },
    (draft) => { draft.schemaVersion = 2; },
    (draft) => { draft.projects[0].lastConversationId = 'missing-chat'; },
  ]) { const draft = structuredClone(catalog); mutate(draft); assert.throws(() => validateCatalog(draft)); }
});

test('catalog refuses symbolic links without overwriting their targets', async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, 'untouched.json');
  await fs.writeFile(target, 'existing configuration');
  await fs.symlink(target, path.join(directory, 'catalog.json'));
  await assert.rejects(openCatalog(directory), /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing configuration');
});
