/** Shared, context-bound presentation of the read-only setup inspector. */
export function createSetupView({ inspector, getContext, onChange = () => {}, now = Date.now } = {}) {
  let disposed = false
  let active = null
  let expiry = null
  let report = null
  let historicalReport = null
  let error = null
  let acceptedAt = null
  function clear() { clearTimeout(expiry); expiry = null; report = null; historicalReport = null; error = null }
  function expire() {
    if (!report) return
    const remaining = Date.parse(report.inspection.expiresAt) - now()
    if (!Number.isFinite(remaining) || remaining <= 0 || now() < acceptedAt) {
      const previous = report
      clear()
      historicalReport = previous
      error = 'Setup report expired. Historical guidance is retained; inspect setup again for current evidence.'
      onChange()
    }
  }
  return Object.freeze({
    snapshot() {
      expire()
      return { pending: active !== null, report, historicalReport, error }
    },
    contextChanged() {
      clear()
      // The inspector retains its bounded read ownership and returns its
      // context_changed diagnosis. Do not relabel that result as user cancellation.
      if (!disposed) onChange()
    },
    async inspect(args = {}, { signal } = {}) {
      // The inspector owns duplicate handling and its underlying request lifetime.
      // A duplicate result must not replace the first caller's visible report.
      if (disposed || active) return inspector.inspect(args, { signal })
      const request = { context: getContext(), controller: new AbortController() }
      active = request
      clear()
      onChange()
      try {
        const result = await inspector.inspect(args, {
          signal: signal ? AbortSignal.any([signal, request.controller.signal]) : request.controller.signal,
        })
        if (!disposed && active === request && request.context === getContext()
          && !request.controller.signal.aborted && !signal?.aborted) {
          report = result
          acceptedAt = now()
          if (result.inspection.expiresAt) {
            expire()
            if (report) {
              expiry = setTimeout(expire, Math.max(0, Date.parse(result.inspection.expiresAt) - now()))
              expiry.unref?.()
            }
          }
        }
        return result
      } catch (cause) {
        if (!disposed && request.context === getContext() && !request.controller.signal.aborted) {
          error = 'Setup inspection could not be completed. Retry Inspect setup.'
        }
        throw cause
      } finally {
        if (active === request) active = null
        if (!disposed) onChange()
      }
    },
    dispose() {
      disposed = true
      inspector.dispose()
      active?.controller.abort()
      clear()
    },
  })
}
