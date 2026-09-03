import assert from 'node:assert/strict'
import test from 'node:test'
import { projectExecutionObservation } from '../src/harness/execution-evidence.js'

test('historical evidence projects known checks and actual units, never raw paths or new permission', () => {
  const result = projectExecutionObservation({ preconditionsMet: true, stopped: true, verified: null, evidence: { mode: 'physical',
    privatePath: '/private/observation.json', physicalExecutionAuthorized: true,
    readinessChecks: { markerGeometry: true, imageQuality: false, detectorQuality: null, unknownFlag: true },
    readinessCheckDetails: {
      markerGeometry: { status: 'met', observed: [{ anchorId: 'marker-a', centerErrorPx: 1.5, matchedPixels: 450 }], thresholds: [{ anchorId: 'marker-a', maximumCenterErrorPx: 2, minimumPixels: 200 }] },
      imageQuality: { status: 'violated', observed: { meanValue: 23, sharpness: 1.25 }, thresholds: { minimumMeanValue: 30, maximumMeanValue: 220, minimumSharpness: 2 } },
      detectorQuality: { status: 'unknown', observed: [{ detectionScore: 0.24, matchedPixels: 13 }], thresholds: { minimumDetectionScore: 0.6, minimumWinnerRatio: 1.5 } },
    },
  } }, { stage: 'preparation', at: '2026-09-02T20:00:00.000Z', mode: 'physical' })
  assert.equal(result.historical, true)
  assert.equal(result.verified, 'unknown')
  assert.deepEqual(result.checks.map((item) => item.status), ['met', 'violated', 'unknown'])
  assert.ok(result.checks[0].metrics.some((item) => item.value === 1.5 && item.unit === 'pixel'))
  assert.ok(result.checks[1].metrics.some((item) => item.value === 23 && item.unit === 'HSV-value-0-255'))
  assert.ok(result.checks[2].metrics.some((item) => item.value === 0.24 && item.unit === 'color-coverage-score-not-probability'))
  assert.equal(JSON.stringify(result).includes('/private'), false)
  assert.equal(JSON.stringify(result).includes('physicalExecutionAuthorized'), false)
  assert.equal(JSON.stringify(result).includes('unknownFlag'), false)
})

test('missing, mismatched and contradictory evidence stays unknown, without fabricated thresholds', () => {
  assert.equal(projectExecutionObservation(null, { mode: 'physical' }), null)
  assert.equal(projectExecutionObservation({ evidence: { mode: 'simulation' } }, { mode: 'physical' }), null)
  const result = projectExecutionObservation({ evidence: { mode: 'simulation', readinessChecks: { markerGeometry: true }, readinessCheckDetails: { markerGeometry: { status: 'violated' } } } }, { mode: 'simulation' })
  assert.equal(result.checks[0].status, 'unknown')
  assert.deepEqual(result.checks[0].metrics, [])
})
