/** An arithmetic fixture, not a robot simulator, perception model or policy. */
export const experimentFixture = Object.freeze({
  id: 'synthetic-alignment-v1',
  name: 'Synthetic alignment',
  description: 'Try a horizontal offset and compare its absolute distance from a fixed synthetic target at 3 mm.',
  input: { name: 'offsetMm', unit: 'mm', minimum: -10, maximum: 10 },
  metric: { name: 'alignmentErrorMm', unit: 'mm', lowerIsBetter: true,
    signedMeasurement: { name: 'signedErrorMm', meaning: 'Synthetic target minus the submitted offset, in millimetres' } },
  limitations: [
    'Arithmetic simulation only: no devices, cameras, physics, learned policy or hardware execution.',
    'The target is deliberately disclosed at 3 mm. This fixture checks the experiment workflow, not autonomous discovery quality.',
    'Results do not establish physical readiness or authorize hardware access.',
  ],
})

export function runSyntheticTrial({ offsetMm, signal, stepMs }) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Synthetic trial cancelled')) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve({ alignmentErrorMm: Math.abs(offsetMm - 3), signedErrorMm: 3 - offsetMm, source: experimentFixture.id })
    }, stepMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
