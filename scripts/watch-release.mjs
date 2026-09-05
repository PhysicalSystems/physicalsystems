import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

// Each iteration uses the existing receipt lock, identity checks and evidence
// verification. Errors stop the watch; there is no retry of a failed mutation.
export async function watchRelease(resume, { print = console.log, sleep = setTimeout, interval = 30_000, maxPolls = 240, signal } = {}) {
  assert.ok(Number.isInteger(maxPolls) && maxPolls > 0)
  let previous
  for (let poll = 0; poll < maxPolls; poll++) {
    if (signal?.aborted) { print('Stopped watching. Continue with the same receipt directory.'); return }
    const state = await resume()
    const summary = state.stages.map((stage) => `${stage.component}: ${stage.status}${stage.runStatus && stage.status === 'running' ? ` (${stage.runStatus})` : ''}${stage.url ? ` ${stage.url}` : ''}`).join('\n')
    if (summary !== previous) { print(summary); previous = summary }
    if (state.workflowVerificationComplete) { print('Release verification complete.'); return state }
    if (poll === 0) print('Watching the saved release. If GitHub requests approval, open the run link and review the deployment. Ctrl+C stops watching; resume with the same receipt directory.')
    if (poll + 1 < maxPolls) {
      try { await sleep(interval, undefined, { signal }) }
      catch (error) { if (!signal?.aborted) throw error }
    }
  }
  throw new Error('Watch time limit reached. Continue with watch --output and the same receipt directory.')
}
