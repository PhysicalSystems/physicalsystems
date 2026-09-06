// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSSH, attachLocal, buildSshArgs, normalizeLocalEndpoint, sshFailure } from '../src/connections.js';

const profile = { type: 'ssh', host: 'robot.example', username: 'operator', port: 22, remotePort: 5050, credentialRef: 'credential-1', expectedNodeId: 'node-1', knownHostsPath: '/example/known_hosts' };
const authorization = { credentialResolver: async () => ({ cameraToken: 'fixture-only-token' }), probeNode: async () => ({ authenticated: true, nodeId: 'node-1' }) };
function fakeChild({ exitOnKill = true } = {}) {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); if (exitOnKill) queueMicrotask(() => child.emit('exit', 0)); return true; };
  return child;
}
function fakeOptions(child, overrides = {}) { return { ...authorization, allocatePort: async () => 34567, spawnProcess: () => child, pollMs: 1, timeoutMs: 30, stopTimeoutMs: 20, ...overrides }; }

test('SSH uses strict pre-established trust, no command, local-only forwarding and no user SSH config', () => {
  const args = buildSshArgs(profile, 34567);
  for (const value of ['none', '-N', '-T', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'ExitOnForwardFailure=yes', '127.0.0.1:34567:127.0.0.1:5050', 'ForwardAgent=no']) assert.ok(args.includes(value), value);
  assert.equal(args.at(-1), profile.host);
  assert.ok(!args.some((value) => /accept-new|StrictHostKeyChecking=no/.test(value)));
  assert.throws(() => buildSshArgs({ ...profile, host: '-oProxyCommand=anything' }, 34567));
  assert.throws(() => buildSshArgs({ ...profile, username: 'operator; command' }, 34567));
});

test('local endpoints reject non-loopback, credentials and paths', () => {
  assert.equal(normalizeLocalEndpoint('http://127.0.0.1:5050/'), 'http://127.0.0.1:5050');
  for (const value of ['http://192.0.2.1:5050', 'http://127.0.0.1.evil', 'http://user:secret@localhost', 'http://localhost/api', 'file:///etc/passwd']) assert.throws(() => normalizeLocalEndpoint(value));
});

test('successful SSH attach requires separate authenticated Node identity and closes only its own tunnel', async () => {
  const child = fakeChild(); let argumentsSeen;
  const connection = await attachSSH(profile, fakeOptions(child, { spawnProcess: (command, args, options) => { argumentsSeen = { command, args, options }; return child; } }));
  assert.equal(connection.endpoint, 'http://127.0.0.1:34567');
  assert.equal(connection.identity.nodeId, 'node-1');
  assert.equal(argumentsSeen.command, 'ssh'); assert.equal(argumentsSeen.options.shell, false);
  assert.doesNotMatch(JSON.stringify(argumentsSeen), /fixture-only-token/);
  await connection.close(); assert.deepEqual(child.kills, ['SIGTERM']);
});

test('SSH cannot turn green on transport alone or changed Node identity', async () => {
  const absent = fakeChild(); let spawned = false;
  await assert.rejects(attachSSH({ ...profile, credentialRef: undefined }, fakeOptions(absent, { spawnProcess: () => { spawned = true; return absent; } })), { code: 'NODE_AUTH_REQUIRED' });
  assert.equal(spawned, false);
  for (const identity of [{ authenticated: false, nodeId: 'node-1' }, { authenticated: true, nodeId: 'another-node' }]) {
    const child = fakeChild();
    await assert.rejects(attachSSH(profile, fakeOptions(child, { probeNode: async () => identity })), /identity|unverified/);
    assert.deepEqual(child.kills, ['SIGTERM']);
  }
});

test('host key failure provides a manual trust path and never retries with weaker options', async () => {
  const child = fakeChild(); let spawns = 0;
  const pending = attachSSH(profile, fakeOptions(child, { spawnProcess: () => { spawns++; queueMicrotask(() => { child.stderr.emit('data', Buffer.from('Host key verification failed.')); child.emit('exit', 255); }); return child; }, probeNode: async () => { throw new Error('not reachable'); } }));
  await assert.rejects(pending, { code: 'SSH_HOST_TRUST_REQUIRED' });
  assert.equal(spawns, 1);
  assert.match(sshFailure('REMOTE HOST IDENTIFICATION HAS CHANGED').message, /trusted channel/);
});

test('bounded connection attempts clean up failed tunnels even if a probe ignores cancellation', async () => {
  const child = fakeChild();
  await assert.rejects(attachSSH(profile, fakeOptions(child, { probeNode: () => new Promise(() => {}) })), { code: 'CONNECTION_TIMEOUT' });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('unconfirmed tunnel cleanup retains a retryable owned handle', async () => {
  const child = fakeChild({ exitOnKill: false });
  const connection = await attachSSH(profile, fakeOptions(child));
  await assert.rejects(connection.close(), { code: 'SSH_STOP_UNCONFIRMED' });
  child.kill = (signal) => { child.kills.push(signal); queueMicrotask(() => child.emit('exit', 0)); return true; };
  await connection.close();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGTERM']);
});

test('tunnel loss reports unavailable without inventing a physical outcome', async () => {
  const child = fakeChild();
  const connection = await attachSSH(profile, fakeOptions(child));
  let failure; connection.onDisconnect((error) => { failure = error; });
  child.emit('exit', 255);
  assert.equal(failure.code, 'SSH_DISCONNECTED'); assert.match(failure.message, /remote Node was not stopped/);
  await connection.close(); assert.deepEqual(child.kills, []);
});

test('local attach verifies identity and bounds a nonresponsive probe', async () => {
  const local = { nodeUrl: 'http://127.0.0.1:5050', credentialRef: 'reference', expectedNodeId: 'node-1' };
  const connection = await attachLocal(local, authorization);
  assert.equal(connection.identity.nodeId, 'node-1'); await connection.close();
  await assert.rejects(attachLocal(local, { ...authorization, timeoutMs: 10, probeNode: () => new Promise(() => {}) }), { code: 'CONNECTION_TIMEOUT' });
});

test('already cancelled requests perform no SSH spawn or Node probe', async () => {
  const signal = AbortSignal.abort();
  const options = { ...authorization, signal, spawnProcess: () => { throw new Error('must not spawn'); }, probeNode: () => { throw new Error('must not probe'); } };
  await assert.rejects(attachSSH(profile, options), { code: 'CONNECTION_CANCELLED' });
  await assert.rejects(attachLocal({ nodeUrl: 'http://127.0.0.1:5050', credentialRef: 'reference' }, options), { code: 'CONNECTION_CANCELLED' });
});

test('cancellation during credential lookup prevents a later Node probe', async () => {
  let release;
  let probed = false;
  const controller = new AbortController();
  const pending = attachLocal({ nodeUrl: 'http://127.0.0.1:5050', credentialRef: 'reference' }, {
    signal: controller.signal,
    credentialResolver: () => new Promise((resolve) => { release = resolve; }),
    probeNode: () => { probed = true; return { authenticated: true, nodeId: 'node-1' }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'CONNECTION_TIMEOUT' });
  release('fixture');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probed, false);
});
