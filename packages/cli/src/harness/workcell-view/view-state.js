/** A session/agent update must never refresh an older camera observation. */
export function cameraIsFresh(camera, now = Date.now()) {
  const status = camera?.status
  const receivedAt = Date.parse(camera?.receivedAt || '')
  const elapsed = now - receivedAt
  return Boolean(camera?.availability === 'available' && camera.frame && camera.previewFrameId
    && status?.phase === 'live' && status.frameFresh === true
    && Number.isFinite(elapsed) && elapsed >= 0
    && Number.isFinite(status.frameAgeMs) && status.frameAgeMs >= 0
    && Number.isFinite(status.staleAfterMs) && status.staleAfterMs > 0
    && elapsed + status.frameAgeMs < status.staleAfterMs)
}

/** An unrelated SSE event cannot extend the execution read or approval lifetime. */
export function executionReadIsFresh(execution, now = Date.now()) {
  const at = Date.parse(execution?.receivedAt || '')
  return Boolean(execution?.availability === 'available' && Number.isFinite(at) && now >= at && now - at < 5000)
}

export function executionApprovalAvailable(execution, now = Date.now()) {
  return Boolean(executionReadIsFresh(execution, now) && execution.canApprove === true
    && execution.run?.phase === 'WAITING_FOR_APPROVAL' && execution.run.approval?.approvedAt === null
    && Date.parse(execution.run.approval.expiresAt) > now)
}
