// A bounded historical evidence projection, not a new readiness evaluator.
// Raw observations/configuration, paths, provider messages and image bytes stay
// server-side. Only known booleans and numerical measurements enter the view.
const CHECKS = ['configuredThresholds', 'producerContract', 'configuration', 'frameGeometry', 'markerGeometry',
  'imageQuality', 'freshFrame', 'captureProvenance', 'sensorExposureAge', 'detectorQuality', 'distinctObjectSlots',
  'receiptStatus', 'targetIdentified', 'sourcePresent', 'destinationClear']
const state = (value) => value === true ? 'met' : value === false ? 'violated' : 'unknown'
const scalar = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null
const array = (value) => Array.isArray(value) ? value.slice(0, 8) : []

export function projectExecutionObservation(observation, { stage, at = null, mode } = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null
  const evidence = observation.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.mode !== mode) return null
  const checks = evidence.readinessChecks || {}, details = evidence.readinessCheckDetails || {}
  const projected = CHECKS.filter((name) => Object.hasOwn(checks, name)).map((name) => {
    const detail = details[name] || {}, metrics = []
    const metric = (label, value, unit) => { if (scalar(value) !== null) metrics.push({ label, value, unit }) }
    if (name === 'markerGeometry') {
      array(detail.observed).forEach((item, index) => {
        metric(`Anchor ${index + 1} deviation`, item?.centerErrorPx, 'pixel')
        metric(`Anchor ${index + 1} matched area`, item?.matchedPixels, 'pixel-count')
        const threshold = array(detail.thresholds).find((limit) => limit?.anchorId === item?.anchorId)
        metric(`Anchor ${index + 1} maximum deviation`, threshold?.maximumCenterErrorPx, 'pixel')
        metric(`Anchor ${index + 1} minimum area`, threshold?.minimumPixels, 'pixel-count')
      })
    } else if (name === 'imageQuality') {
      metric('Sharpness', detail.observed?.sharpness, 'detector-sharpness-score')
      metric('Minimum sharpness', detail.thresholds?.minimumSharpness, 'detector-sharpness-score')
      metric('Brightness', detail.observed?.meanValue, 'HSV-value-0-255')
      metric('Minimum brightness', detail.thresholds?.minimumMeanValue, 'HSV-value-0-255')
      metric('Maximum brightness', detail.thresholds?.maximumMeanValue, 'HSV-value-0-255')
    } else if (name === 'detectorQuality') {
      array(detail.observed).forEach((item, index) => {
        metric(`Marker ${index + 1} detection score`, item?.detectionScore, 'color-coverage-score-not-probability')
        metric(`Marker ${index + 1} matched area`, item?.matchedPixels, 'pixel-count')
      })
      metric('Minimum detection score', detail.thresholds?.minimumDetectionScore, 'color-coverage-score-not-probability')
      metric('Minimum winner ratio', detail.thresholds?.minimumWinnerRatio, 'ratio')
    } else if (name === 'freshFrame') {
      metric('Age at observation check', detail.observed, 'second')
      metric('Maximum age', detail.maximum, 'second')
    } else if (name === 'sensorExposureAge') {
      metric('Exposure age upper bound', detail.observedUpperBound, 'nanosecond')
      metric('Configured maximum age', detail.configuredMaximum, 'nanosecond')
    }
    // A disagreement between the boolean and detail is unknown, never positive.
    const reported = state(checks[name])
    return { name, status: detail.status && detail.status !== reported ? 'unknown' : reported, metrics }
  })
  return { stage, at, mode, historical: true, preconditions: state(observation.preconditionsMet),
    verified: state(observation.verified), stopped: state(observation.stopped), checks: projected }
}
