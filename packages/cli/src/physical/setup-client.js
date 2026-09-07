import { normalizePhysicalNodeUrl } from './node-client.js'
import { parseExecutionJson } from './execution-contracts.js'
import { normalizeSetupRequirements } from './setup-contracts.js'

const PATH = '/v2/physical/setup/requirements'
const MAX_BYTES = 256 * 1024
const MESSAGES = Object.freeze({
  unavailable: 'Implementation setup inspection is unavailable; no missing equipment or physical readiness is inferred.',
  invalid: 'Implementation setup evidence failed contract validation; no physical readiness is inferred.',
})
class SetupReadError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code }
}
export const setupReadFailure = (error) => error instanceof SetupReadError ? error.code : 'unavailable'

async function readJson(response) {
  if (response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new SetupReadError('invalid')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) throw new SetupReadError('invalid')
  const reader = response.body?.getReader?.()
  if (!reader) throw new SetupReadError('invalid')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new SetupReadError('invalid')
      chunks.push(value)
    }
    try { return parseExecutionJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new SetupReadError('invalid') }
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof SetupReadError) throw error
    throw new SetupReadError('unavailable')
  } finally { reader.releaseLock() }
}

/** Read-only Node setup inventory. The credential and endpoint remain host-owned. */
export function createSetupRequirementsClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const origin = normalizePhysicalNodeUrl(baseUrl)
  return Object.freeze({
    async requirements() {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new SetupReadError('unavailable')
      let response
      try {
        const url = new URL(PATH, origin)
        response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })
        if (response.redirected || response.type === 'opaqueredirect' || (response.url && response.url !== url.href)) throw new SetupReadError('invalid')
        if (!response.ok) {
          // Do not parse or reflect provider error bodies, including on old Nodes.
          await response.body?.cancel?.().catch(() => {})
          if ([404, 501].includes(response.status)) return Object.freeze({ status: 'unsupported', report: null })
          throw new SetupReadError('unavailable')
        }
        const value = await readJson(response)
        let report
        try { report = normalizeSetupRequirements(value) } catch { throw new SetupReadError('invalid') }
        return Object.freeze({ status: 'available', report })
      } catch (error) {
        if (error instanceof SetupReadError) throw error
        throw new SetupReadError('unavailable')
      } finally { await response?.body?.cancel?.().catch(() => {}) }
    },
  })
}
