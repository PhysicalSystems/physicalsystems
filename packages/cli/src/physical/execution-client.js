import { normalizePhysicalNodeUrl } from './node-client.js'
import { executionFields, executionHash, executionId, executionRunId, executionText, parseExecutionJson,
  normalizeExecutionStatus, normalizePhysicalRun, normalizePhysicalRunList, normalizePhysicalRunReceipt, normalizeExecutionSnapshot, assertRunMatches } from './execution-contracts.js'

const ROOT = '/v2/physical/execution'
const MAX_BYTES = 2 * 1024 * 1024
class ExecutionHttpError extends Error {}
export const executionFailureMessage = (error, fallback) => error instanceof ExecutionHttpError ? error.message : fallback

async function readJson(response, maximum = MAX_BYTES) {
  if (response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('Invalid content type')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) throw new Error('Response too large')
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('Missing response')
  let size = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('Response too large')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return parseExecutionJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

/** Operator server closure only. No execution credential or method is a model tool. */
export function createExecutionClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  async function request(path, body, decode) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new ExecutionHttpError('Execution requires a configured server-side credential')
    try {
      const url = new URL(`${ROOT}${path}`, origin)
      const response = await fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.redirected || response.type === 'opaqueredirect' || (response.url && response.url !== url.href)) throw new Error('Redirect forbidden')
      if (!response.ok) {
        let code
        try { code = (await readJson(response, 8192)).code } catch { await response.body?.cancel?.().catch(() => {}) /* Never reflect an unvalidated provider error. */ }
        const explanation = response.status === 422 && ({
          preconditions_unknown: 'Fresh observed preconditions and confirmed idle state are required. Check the commissioned observation source; no invocation was dispatched.',
          configuration_unavailable: 'The selected local configuration is not installed on this node.',
        })[code]
        const error = new ExecutionHttpError(explanation || ({ 401: 'Execution credentials were rejected', 403: 'Execution request was not permitted', 409: 'Run or configuration changed; refresh before acting', 404: 'Execution service or run is unavailable', 503: 'Execution is unavailable on this node' })[response.status] || 'Execution request failed')
        error.status = [400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 503
        throw error
      }
      return decode(await readJson(response, path === '/runs' ? 1024 * 1024 : MAX_BYTES))
    } catch (error) {
      if (error instanceof ExecutionHttpError) throw error
      throw new Error('Execution transport or response is unavailable; no outcome is assumed')
    }
  }
  return Object.freeze({
    status: () => request('/status', undefined, normalizeExecutionStatus),
    runs: () => request('/runs', undefined, normalizePhysicalRunList),
    run(runId, expected = {}) { executionRunId(runId); return request(`/runs/${runId}`, undefined, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId })) },
    receipt(runId, expected = {}) { executionRunId(runId); return request(`/runs/${runId}/receipt`, undefined, (value) => normalizePhysicalRunReceipt(value, { ...expected, runId })) },
    snapshot(digest) { executionHash(digest); return request(`/snapshots/${digest}`, undefined, (value) => normalizeExecutionSnapshot(value, digest)) },
    prepare(body, expected = {}) {
      executionFields(body, ['contractVersion', 'routeReceiptDigest', 'configurationId', 'expectedConfigurationDigest', 'idempotencyKey'])
      if (body.contractVersion !== 'physicalsystems-run-prepare-v1') throw new TypeError('Unsupported run preparation')
      executionHash(body.routeReceiptDigest); executionId(body.configurationId); executionHash(body.expectedConfigurationDigest); executionId(body.idempotencyKey)
      return request('/runs:prepare', body, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected,
        routeReceiptDigest: body.routeReceiptDigest, configurationId: body.configurationId, configurationDigest: body.expectedConfigurationDigest }))
    },
    approve(runId, body, expected = {}) {
      executionRunId(runId); executionFields(body, ['expectedRunDigest', 'approvalDigest', 'approved'])
      executionHash(body.expectedRunDigest); executionHash(body.approvalDigest)
      if (body.approved !== true) throw new TypeError('Explicit approval is required')
      return request(`/runs/${runId}:approve`, body, (value) => {
        const run = assertRunMatches(normalizePhysicalRun(value), { ...expected, runId })
        if (run.approval.digest !== body.approvalDigest) throw new TypeError('Approval response does not match')
        return run
      })
    },
    stop(runId, body, expected = {}) {
      executionRunId(runId); executionFields(body, ['reason']); executionText(body.reason, 256)
      return request(`/runs/${runId}:stop`, body, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId }))
    },
    reconcile(runId, body, expected = {}) {
      executionRunId(runId); executionFields(body, ['expectedRunDigest']); executionHash(body.expectedRunDigest)
      return request(`/runs/${runId}:reconcile`, body, (value) => assertRunMatches(normalizePhysicalRun(value), { ...expected, runId }))
    },
  })
}
