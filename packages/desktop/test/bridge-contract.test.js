// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_URL, assetName, validateCommand, validateSender, unavailableSnapshot, validateAuthDestination } from '../src/bridge-contract.js';

test('IPC accepts only the main local frame of the owned window', () => {
  const frame = { url: APP_URL };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  validateSender({ sender: contents, senderFrame: frame }, contents);
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: APP_URL } }]) assert.throws(() => validateSender(event, contents));
  frame.url = 'https://untrusted.invalid';
  assert.throws(() => validateSender({ sender: contents, senderFrame: frame }, contents));
});

test('IPC rejects arbitrary authority, prototype keys and excessive request size', () => {
  assert.throws(() => validateCommand('shell.exec', { command: 'anything' }));
  assert.throws(() => validateCommand('project.create', null));
  assert.throws(() => validateCommand('project.create', JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.throws(() => validateCommand('conversation.send', { text: 'x'.repeat(1024 * 1024) }));
  assert.deepEqual(validateCommand('workcell.camera.stop', { projectId: 'project-1' }), { projectId: 'project-1' });
  for (const name of ['workcell.commissioning.recoveryInspect', 'workcell.commissioning.recoveryConfirm']) assert.deepEqual(validateCommand(name, { projectId: 'project-1' }), { projectId: 'project-1' });
});

test('asset protocol exposes only the packaged renderer allowlist', () => {
  assert.equal(assetName(APP_URL), 'index.html');
  for (const url of ['file:///etc/passwd', 'physicalsystems://desktop/../host.js', 'physicalsystems://desktop/%2e%2e/catalog.json', 'physicalsystems://desktop/index.html?file=x', 'physicalsystems://desktop.attacker/index.html']) assert.equal(assetName(url), null);
});

test('sandboxed preload exposes no raw IPC, Node or shell API', async () => {
  const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  const exposed = source.slice(source.indexOf('Object.freeze({'));
  assert.doesNotMatch(exposed, /(?:ipcRenderer|process|require|shell)\s*[,}]/);
  assert.match(source, /const receive = \(_event, snapshot\) => listener\(snapshot\)/);
});

test('host death retires camera/status claims but preserves last-observed runs and saved conversation', () => {
  const original = { revision: 12, projects: [{ id: 'p1', connection: { status: 'connected', deviceCount: 2, inUseCount: 1 } }], conversation: { messages: [{ role: 'user', text: 'Saved history' }], busy: true }, workcell: { camera: { frame: 'must-clear' } }, activeRuns: [{ run: { phase: 'RUNNING' }, canStop: true }] };
  const result = unavailableSnapshot(original);
  assert.equal(result.hostUnavailable, true);
  assert.equal(result.workcell, null);
  assert.equal(result.projects[0].connection.status, 'offline');
  assert.equal(result.projects[0].connection.deviceCount, null);
  assert.equal(result.activeRuns[0].run.phase, 'RUNNING');
  assert.equal(result.activeRuns[0].statusUnavailable, true);
  assert.equal(result.activeRuns[0].canStop, false);
  assert.deepEqual(result.conversation.messages, original.conversation.messages);
  assert.equal(original.workcell.camera.frame, 'must-clear');
  const retained = unavailableSnapshot({ activeCommissioning: [{ trialId: 'retained-unknown', recoveryView: { recoveryAvailable: true, recoveryFresh: true, recoveryReceivedAt: 123, unresolved: true } }] });
  assert.equal(retained.activeCommissioning[0].trialId, 'retained-unknown');
  assert.equal(retained.activeCommissioning[0].recoveryView.recoveryFresh, false);
  assert.equal(retained.activeCommissioning[0].recoveryView.recoveryAvailable, false);
  assert.equal(retained.activeCommissioning[0].recoveryView.unresolved, true);
});

test('native provider browser destination rejects executable schemes and embedded credentials', () => {
  assert.equal(validateAuthDestination('https://provider.example/authorize?state=fixture'), 'https://provider.example/authorize?state=fixture');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://provider.example', 'https://user:password@provider.example', 'ssh://host']) assert.throws(() => validateAuthDestination(url));
});
