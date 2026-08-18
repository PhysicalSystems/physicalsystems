export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

export async function fetchWithTimeout(
  fetchImpl,
  url,
  options = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Request timeout must be a positive number')
  }
  const timeoutController = new AbortController()
  const timeoutError = new Error(`TinyEdge request timed out after ${timeoutMs}ms`)
  const timer = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal
  try {
    return await fetchImpl(url, { ...options, signal })
  } catch (error) {
    if (timeoutController.signal.aborted) throw timeoutError
    throw error
  } finally {
    clearTimeout(timer)
  }
}
