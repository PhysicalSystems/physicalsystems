import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { advanceCoordinator, createDispatchStages, parsePublishArguments, readPublishedComponent, validateCoordinatorState, validateWorkflowJobs, readComponentCandidate, validateEvidenceBinding } from '../scripts/publish-coordinator.mjs'

const id = '01234567-89ab-4cde-8123-456789abcdef'
const pin = { distribution: 'tinyedge-runtime', version: '0.2.0', wheelSha256: 'a'.repeat(64) }
const release = { product: { version: '0.2.3' }, components: { runtime: pin, node: { ...pin, distribution: 'physicalsystems-node' } } }
const values = { '--node-candidate': '123', '--node-metadata-sha256': 'b'.repeat(64) }
async function fixture(action = 'verify-publishers', published = async () => true, options = values) {
  return { contractVersion: 'physicalsystems-release-coordinator-v1', repository: 'PhysicalSystems/physicalsystems',
    id, headSha: 'c'.repeat(40), planDigest: 'd'.repeat(64), action,
    stages: await createDispatchStages(action, release, options, published) }
}
function run(state, stage, overrides = {}) {
  return { id: stage.component === 'runtime' ? 1 : 2, head_sha: state.headSha, head_branch: 'main', event: 'workflow_dispatch',
    path: `.github/workflows/${stage.workflow}`, repository: { full_name: state.repository }, display_title: `verify / ${id}`,
    run_attempt: 1, status: 'completed', conclusion: 'success', ...overrides }
}

test('coordinator option parsing rejects shell/ref overrides and ambiguous candidates', () => {
  const output = process.cwd()
  assert.deepEqual(parsePublishArguments(['--output', output]), { '--output': output })
  for (const args of [[], ['--output', 'relative'], ['--output', output, '--ref', 'branch'],
    ['--output', output, '--node-candidate', '12'], ['--output', output, '--output', output],
    ['--output', output, '--node-candidate', 'x;evil', '--node-metadata-sha256', 'b'.repeat(64)]]) {
    assert.throws(() => parsePublishArguments(args))
  }
})

test('unchanged components are reused; only changed components get publishers in dependency order', async () => {
  const reused = await createDispatchStages('publish', release, {}, async () => true)
  assert.deepEqual(reused.map((stage) => stage.status), ['reused', 'reused', 'reused'])
  const stages = await createDispatchStages('publish', release, values, async (component) => component === 'runtime')
  assert.deepEqual(stages.map((stage) => [stage.component, stage.status]), [['runtime', 'reused'], ['node', 'pending'], ['npm', 'pending']])
  await assert.rejects(createDispatchStages('publish', release, values, async () => true), /must not supply/)
  await assert.rejects(createDispatchStages('publish', release, {}, async () => false), /Missing reviewed runtime/)
  await assert.rejects(createDispatchStages('verify-publishers', release, values, async () => false), /already published/)
})

test('registry reuse requires exact wheel hash, singleton wheel and non-yanked status', async () => {
  const data = { urls: [{ packagetype: 'bdist_wheel', digests: { sha256: pin.wheelSha256 }, yanked: false }] }
  assert.equal(await readPublishedComponent('runtime', release, async () => data), true)
  assert.equal(await readPublishedComponent('runtime', release, async () => null), false)
  for (const mutate of [(d) => { d.urls[0].digests.sha256 = 'bad' }, (d) => { d.urls[0].yanked = true }, (d) => { d.urls.push(d.urls[0]) }]) {
    const bad = structuredClone(data); mutate(bad)
    await assert.rejects(readPublishedComponent('runtime', release, async () => bad))
  }
})

test('dispatch intent is saved before network and resume does not resend an uncertain request', async () => {
  const state = await fixture()
  let saves = 0, dispatches = 0
  const save = async () => { saves++ }
  await assert.rejects(advanceCoordinator(state, { release, published: async () => true, save,
    api(endpoint, body) {
      if (endpoint.endsWith('branches/main')) return { commit: { sha: state.headSha } }
      if (body) { assert.equal(saves, 1); dispatches++; throw new Error('lost response') }
      throw new Error('unexpected')
    },
  }), /lost response/)
  assert.equal(state.stages[0].status, 'dispatch-requested')
  state.stages[1].status = 'dispatch-requested'
  await advanceCoordinator(state, { release, published: async () => true, save,
    api(endpoint, body) { assert.equal(body, undefined); return { workflow_runs: [] } },
  })
  assert.equal(dispatches, 1)
  assert.equal(state.workflowVerificationComplete, false)
})

test('verification dispatches independent component jobs but does not approve them', async () => {
  const state = await fixture()
  let dispatches = 0
  await advanceCoordinator(state, { release, published: async () => true, save: async () => {},
    api(endpoint, body) {
      if (endpoint.endsWith('branches/main')) return { commit: { sha: state.headSha } }
      if (body) { dispatches++; assert.equal(body.inputs.coordinator_id, id); return null }
      const stage = state.stages.find((entry) => endpoint.includes(entry.workflow))
      return { workflow_runs: [run(state, stage, { status: 'waiting', conclusion: null })] }
    },
  })
  assert.equal(dispatches, 2)
  assert.equal(state.workflowVerificationComplete, false)
  assert.deepEqual(state.stages.map((stage) => stage.runStatus), ['waiting', 'waiting'])
})

test('failed job stops publication before its dependent npm stage, with no retry', async () => {
  const state = await fixture('publish', async (component) => component === 'runtime')
  let dispatches = 0
  await assert.rejects(advanceCoordinator(state, { release, published: async () => true, save: async () => {},
    api(endpoint, body) {
      if (endpoint.endsWith('branches/main')) return { commit: { sha: state.headSha } }
      if (body) { dispatches++; return null }
      return { workflow_runs: [run(state, state.stages[1], { conclusion: 'failure' })] }
    },
  }), /Release job failed/)
  assert.equal(dispatches, 1)
  assert.equal(state.stages[2].status, 'pending')
})

test('correlation rejects foreign identity, changed main, reruns and duplicate matches', async () => {
  for (const override of [{ head_sha: 'e'.repeat(40) }, { event: 'push' }, { head_branch: 'other' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'someone/fork' } }, { run_attempt: 2 }]) {
    const state = await fixture(); state.stages[0].status = 'dispatch-requested'
    await assert.rejects(advanceCoordinator(state, { release, published: async () => true, save: async () => {},
      api: () => ({ workflow_runs: [run(state, state.stages[0], override)] }),
    }))
  }
  const state = await fixture(); state.stages[0].status = 'dispatch-requested'
  await assert.rejects(advanceCoordinator(state, { release, published: async () => true, save: async () => {},
    api: () => ({ workflow_runs: [run(state, state.stages[0]), run(state, state.stages[0])] }),
  }), /Ambiguous/)
})

test('successful workflow needs exact public readback, not just a green job', async () => {
  const state = await fixture(); state.stages[0].status = 'dispatch-requested'
  await assert.rejects(advanceCoordinator(state, { release, published: async () => false, save: async () => {},
    evidence: async () => ({}),
    api: () => ({ workflow_runs: [run(state, state.stages[0])] }),
  }), /public registry readback/)
})

test('green top-level run with skipped or absent qualification jobs is not publisher proof', async () => {
  const state = await fixture(), stage = state.stages[0]
  stage.runId = '1'
  const names = ['verify', 'finish', ...['linux-x64', 'win32-x64'].flatMap((os) => ['3.10', '3.11', '3.12'].map((python) => `install-${os}-py${python}`))]
  const jobs = names.map((name) => ({ name, run_id: 1, run_attempt: 1, head_sha: state.headSha, status: 'completed', conclusion: 'success', steps: [{ conclusion: 'success' }] }))
  validateWorkflowJobs(jobs, state, stage)
  for (const mutate of [(j) => j.pop(), (j) => { j[0].conclusion = 'skipped' }, (j) => { j[0].run_attempt = 2 }, (j) => { j[0].steps = [] }]) {
    const bad = structuredClone(jobs); mutate(bad)
    assert.throws(() => validateWorkflowJobs(bad, state, stage))
  }
})

test('saved receipt cannot introduce different targets or upload inputs', async () => {
  const original = await fixture()
  for (const mutate of [(s) => { s.repository = 'someone/fork' }, (s) => { s.stages.reverse() },
    (s) => { s.stages[0].inputs.operation = 'publish' }, (s) => { s.stages[0].inputs.extra = 'unreviewed' },
    (s) => { s.stages[0].workflow = 'other.yml' }, (s) => { s.stages[0].status = 'reused' }]) {
    const bad = structuredClone(original); mutate(bad)
    assert.throws(() => validateCoordinatorState(bad))
  }
})

test('changed component phase binds its own reviewed capsule independently of old npm pins', async () => {
  const raw = Buffer.from(JSON.stringify({ contractVersion: 'physicalsystems-node-release-capsule-v1',
    distribution: 'physicalsystems-node', version: '0.2.2', wheel: { sha256: 'f'.repeat(64) } }))
  const hash = createHash('sha256').update(raw).digest('hex')
  const candidate = { id: 123, draft: false, prerelease: true, target_commitish: 'main',
    tag_name: 'physicalsystems-node-v0.2.2-candidate', assets: [{ id: 321, name: 'release.json',
      digest: `sha256:${hash}`, size: raw.length,
      browser_download_url: 'https://github.com/PhysicalSystems/physicalsystems/releases/download/physicalsystems-node-v0.2.2-candidate/release.json' }] }
  const options = { '--node-candidate': '123', '--node-metadata-sha256': hash }
  const pin = await readComponentCandidate('node', options, { api: () => candidate, readAsset: async () => raw })
  assert.equal(pin.version, '0.2.2')
  assert.equal(pin.wheelSha256, 'f'.repeat(64))
  for (const mutate of [(c) => { c.draft = true }, (c) => { c.assets[0].digest = 'bad' },
    (c) => { c.assets[0].browser_download_url = 'https://untrusted.example/file' }, (c) => { c.tag_name = 'runtime-v0.2.2-candidate' }]) {
    const bad = structuredClone(candidate); mutate(bad)
    await assert.rejects(readComponentCandidate('node', options, { api: () => bad, readAsset: async () => raw }))
  }
  await assert.rejects(readComponentCandidate('node', options, { api: () => candidate, readAsset: async () => Buffer.alloc(raw.length) }))
})

test('evidence digest and saved receipt binding reject modified or relabeled caches', async () => {
  const state = await fixture(), stage = state.stages[0]
  stage.runId = '123'
  const archive = Buffer.from('synthetic archive boundary; ZIP parsing has separate stdlib tests')
  const artifact = { id: 88, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` }
  const parsed = Buffer.from(JSON.stringify({ schema: 'physicalsystems.publisher-verification.v1', component: 'runtime',
    repository: state.repository, workflow: stage.workflow, distribution: 'tinyedge-runtime', environment: 'runtime-pypi',
    runId: '123', runAttempt: '1', headSha: state.headSha, tokenExchangeVerified: true, publicationPerformed: false,
    distributionAuthorizationVerified: false, pypiEnvironmentBindingVerified: false }))
  stage.evidence = validateEvidenceBinding(archive, parsed, artifact, state, stage)
  validateEvidenceBinding(archive, parsed, artifact, state, stage)
  assert.throws(() => validateEvidenceBinding(Buffer.from('different'), parsed, artifact, state, stage), /archive digest mismatch/)
  assert.throws(() => validateEvidenceBinding(archive, parsed, { ...artifact, id: 89 }, state, stage), /Saved evidence differs/)
  stage.evidence.receiptSha256 = 'a'.repeat(64)
  assert.throws(() => validateEvidenceBinding(archive, parsed, artifact, state, stage), /Saved evidence differs/)
})
