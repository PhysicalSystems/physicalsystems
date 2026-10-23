// SPDX-License-Identifier: Apache-2.0
import { normalizePhysicalNodeUrl } from './node-client.js'

export function normalizeInference(value) {
  const hex = (text, size) => typeof text === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(text)
  if (!value || value.contractVersion !== 'physicalsystems-inference-v1' ||
      !['STOPPED', 'STARTING', 'READY', 'STOPPING', 'FAILED', 'UNKNOWN'].includes(value.phase) ||
      (value.runtimeId !== null && !hex(value.runtimeId, 32)) ||
      (value.manifestSha256 !== null && !hex(value.manifestSha256, 64)) ||
      (value.generation !== null && (!Number.isSafeInteger(value.generation) || value.generation < 0)) ||
      typeof value.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.image) ||
      (value.releaseId !== null && (typeof value.releaseId !== 'string' || value.releaseId.length > 128)) ||
      (value.error !== null && (typeof value.error !== 'string' || value.error.length > 256)) ||
      value.motorCommandsSent !== 0 ||
      (['STARTING', 'READY', 'STOPPING', 'UNKNOWN'].includes(value.phase) && !value.runtimeId)) {
    throw new Error('Invalid inference status')
  }
  if (value.details !== null && (!value.details || value.details.ready !== true ||
      typeof value.details.gpu !== 'string' || value.details.gpu.length > 256 ||
      !Number.isFinite(value.details.warmupMs) || value.details.warmupMs < 0 ||
      !Number.isInteger(value.details.chunkSize) || value.details.chunkSize < 1 || value.details.chunkSize > 100)) {
    throw new Error('Invalid inference readiness')
  }
  if (value.phase === 'READY' && !value.details) throw new Error('Missing inference readiness')
  return value
}

export function createInferenceClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  async function request(operation, body) {
    if (!token) throw new Error('Configure the Node operator credential before loading a model.')
    const response = await fetchImpl(`${origin}/v2/physical/inference${operation ? '/' + operation : ''}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    // Bound even chunked responses before parsing untrusted device output.
    const reader = response.body.getReader()
    const chunks = []; let size = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 16384) throw new Error('Inference response is too large')
        chunks.push(result.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (!response.ok) throw new Error(response.status === 503 ? 'Model inference is not configured on this Node.' : 'The model runtime request was rejected. Refresh its status before retrying.')
    return normalizeInference(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  }
  return Object.freeze({ status: () => request(''), start: body => request('start', body), stop: body => request('stop', body) })
}
