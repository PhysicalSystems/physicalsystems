import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchWithTimeout } from '../src/net/fetch.js'

function pendingFetch(_url, options) {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
}

test('fetch timeout keeps a pending request alive until its deterministic error', async () => {
  await assert.rejects(
    fetchWithTimeout(pendingFetch, 'https://tinyedge.ai/api/mcp', {}, 10),
    (error) => {
      assert.equal(error.message, 'TinyEdge request timed out after 10ms')
      return true
    },
  )
})

test('fetch timeout preserves an earlier caller abort', async () => {
  const controller = new AbortController()
  const callerError = new Error('caller stopped the request')
  const request = fetchWithTimeout(
    pendingFetch,
    'https://tinyedge.ai/api/mcp',
    { signal: controller.signal },
    1_000,
  )

  controller.abort(callerError)
  await assert.rejects(request, (error) => error === callerError)
})

test('fetch timeout is cleared after a completed request', async () => {
  let requestSignal
  const response = await fetchWithTimeout(async (_url, options) => {
    requestSignal = options.signal
    return Response.json({ ok: true })
  }, 'https://tinyedge.ai/api/mcp', {}, 20)

  assert.equal(response.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(requestSignal.aborted, false)
})
