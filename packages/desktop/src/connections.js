// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw failure('INVALID_PROFILE', `Enter a valid ${label} port.`);
  return value;
}
function absoluteFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f"\\]/.test(value)) throw failure('INVALID_PROFILE', `${label} must be an absolute file path without control characters.`);
  return value;
}

export function normalizeLocalEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_PROFILE', 'Enter the Node loopback HTTP address.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw failure('INVALID_PROFILE', 'The Node address must be a loopback HTTP origin without credentials, query data, or a path.');
  }
  return url.origin;
}

export function buildSshArgs(profile, localPort) {
  if (typeof profile.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(profile.host) || profile.host.includes('..')) throw failure('INVALID_PROFILE', 'Enter a host name or IP address, without SSH options.');
  if (typeof profile.username !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(profile.username)) throw failure('INVALID_PROFILE', 'Enter a valid SSH user name.');
  const args = [
    '-F', 'none', '-N', '-T', '-n', '-a', '-x',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-o', 'ConnectionAttempts=1', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'RequestTTY=no',
    '-o', `UserKnownHostsFile="${absoluteFile(profile.knownHostsPath ?? path.join(os.homedir(), '.ssh', 'known_hosts'), 'Known hosts file')}"`,
  ];
  if (profile.keyPath) args.push('-i', absoluteFile(profile.keyPath, 'SSH key'), '-o', 'IdentitiesOnly=yes');
  args.push('-p', String(port(profile.port ?? 22, 'SSH')), '-l', profile.username,
    '-L', `127.0.0.1:${port(localPort, 'local')}:127.0.0.1:${port(profile.remotePort, 'remote Node')}`, profile.host);
  return args;
}

export function sshFailure(stderr = '') {
  if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(stderr)) return failure('SSH_HOST_TRUST_REQUIRED', 'SSH host identity is not trusted or has changed. Ask the host operator for its fingerprint through a trusted channel. Verify and record the matching key in your selected known_hosts file using your normal SSH client, then retry. The desktop will not accept a key automatically.');
  if (/permission denied|authentication failed|no supported authentication/i.test(stderr)) return failure('SSH_AUTH_REQUIRED', 'SSH authentication failed. Unlock the selected key in your SSH agent or select an authorized key, then retry. Password prompts are not supported by this attach flow.');
  if (/address already in use|cannot listen|forwarding failed/i.test(stderr)) return failure('SSH_FORWARD_FAILED', 'The local SSH forwarding port could not be opened. Retry to allocate another port.');
  return failure('SSH_DISCONNECTED', 'The SSH tunnel could not stay connected. Check the computer address, SSH service, network, and key access, then retry. The remote Node was not stopped.');
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selected;
}

async function authorize(profile, { credentialResolver, probeNode }, endpoint, signal) {
  if (typeof credentialResolver !== 'function' || typeof probeNode !== 'function' || !profile.credentialRef) throw failure('NODE_AUTH_REQUIRED', 'SSH connectivity is separate from Node authorization. Configure a Node credential reference and supported identity verification before connecting.');
  const credential = await credentialResolver(profile.credentialRef);
  if (signal.aborted) throw failure('CONNECTION_CANCELLED', 'The connection request was cancelled before Node verification.');
  if (!credential) throw failure('NODE_AUTH_REQUIRED', 'The referenced Node credential is unavailable. Unlock the credential store or configure the intended Node credential, then retry.');
  const identity = await probeNode({ endpoint, credential, expectedNodeId: profile.expectedNodeId, signal });
  if (signal.aborted) throw failure('CONNECTION_CANCELLED', 'The connection request ended before Node verification completed.');
  if (!identity || identity.authenticated !== true || typeof identity.nodeId !== 'string' || !identity.nodeId) throw failure('NODE_IDENTITY_UNVERIFIED', 'The Node did not provide a supported authenticated identity. The connection remains unverified.');
  if (profile.expectedNodeId && identity.nodeId !== profile.expectedNodeId) throw failure('NODE_IDENTITY_CHANGED', 'The responding Node identity differs from this project. Recheck the selected host and Node configuration before reconnecting.');
  return identity;
}

export async function attachLocal(profile, options = {}) {
  if (options.signal?.aborted) throw failure('CONNECTION_CANCELLED', 'The connection request was cancelled.');
  const endpoint = normalizeLocalEndpoint(profile.nodeUrl);
  const deadline = connectionDeadline(options.timeoutMs ?? 10000, options.signal);
  try {
    const identity = await bounded(() => authorize(profile, options, endpoint, deadline.signal), deadline.signal);
    return { endpoint, identity, close: async () => {}, onDisconnect: () => () => {} };
  } finally { deadline.clear(); }
}

function connectionDeadline(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal, clear: () => clearTimeout(timer) };
}

function bounded(operation, signal) {
  if (signal.aborted) return Promise.reject(failure('CONNECTION_TIMEOUT', 'The connection request ended before verification. Retry after checking the target.'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(failure('CONNECTION_TIMEOUT', 'The connection request ended before verification. Retry after checking the target.'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export async function attachSSH(profile, options = {}) {
  if (options.signal?.aborted) throw failure('CONNECTION_CANCELLED', 'The connection request was cancelled.');
  // Validate before allocating resources or attempting any network activity.
  buildSshArgs(profile, 12345);
  if (!profile.credentialRef || typeof options.credentialResolver !== 'function' || typeof options.probeNode !== 'function') throw failure('NODE_AUTH_REQUIRED', 'Configure separate Node authorization and identity verification before attaching over SSH.');
  const localPort = await (options.allocatePort ?? availablePort)();
  if (options.signal?.aborted) throw failure('CONNECTION_CANCELLED', 'The connection request was cancelled.');
  const endpoint = `http://127.0.0.1:${localPort}`;
  const child = (options.spawnProcess ?? spawn)('ssh', buildSshArgs(profile, localPort), { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let ended = false;
  let processError;
  let closing = false;
  const listeners = new Set();
  const exit = new Promise((resolve) => {
    const finish = (error) => { if (ended) return; ended = true; processError = error ?? sshFailure(stderr); resolve(); if (!closing) for (const listener of listeners) listener(processError); };
    child.once('error', () => finish(failure('SSH_UNAVAILABLE', 'The system SSH client could not be started. Install or repair it through your normal system administration process.')));
    child.once('exit', () => finish());
  });
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-8192); });
  const close = async () => {
    if (ended) return;
    closing = true;
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([exit, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure('SSH_STOP_UNCONFIRMED', 'SSH tunnel shutdown is not confirmed. Keep this connection owned and retry cleanup before replacing it.')), options.stopTimeoutMs ?? 3000); })]);
    } finally { clearTimeout(timer); }
  };
  const handle = { endpoint, identity: null, close, onDisconnect(listener) { listeners.add(listener); if (ended && !closing) queueMicrotask(() => { if (listeners.has(listener)) listener(processError); }); return () => listeners.delete(listener); } };
  const deadline = connectionDeadline(options.timeoutMs ?? 12000, options.signal);
  const signal = deadline.signal;
  try {
    let lastError;
    while (!signal.aborted) {
      if (ended) throw processError;
      try {
        handle.identity = await bounded(() => authorize(profile, options, endpoint, signal), signal);
        if (ended) throw processError;
        return handle;
      } catch (error) {
        if (['NODE_AUTH_REQUIRED', 'NODE_IDENTITY_CHANGED', 'NODE_IDENTITY_UNVERIFIED'].includes(error.code)) throw error;
        lastError = error;
      }
      await delay(options.pollMs ?? 200, undefined, { signal }).catch(() => {});
    }
    throw ended ? processError : failure('CONNECTION_TIMEOUT', `The SSH/Node connection could not be verified before the deadline.${lastError?.code === 'NODE_AUTH_REQUIRED' ? ' Check Node authorization.' : ''} Retry after checking the target.`);
  } catch (error) {
    try { await close(); } catch (cleanupError) { cleanupError.connection = handle; throw cleanupError; }
    throw error;
  } finally { deadline.clear(); }
}
