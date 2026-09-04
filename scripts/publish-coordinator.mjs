// One resumable dispatch route; no registry credential, upload or approval bypass.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProductRelease, createReleasePlan } from './release-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const repository = 'PhysicalSystems/physicalsystems'
const sha256 = /^[a-f0-9]{64}$/
const decimal = /^[1-9][0-9]*$/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const workflows = { runtime: 'runtime-release.yml', node: 'node-release.yml', npm: 'npm-release.yml' }

export function parsePublishArguments(args) {
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    assert.ok(['--output', '--component', '--runtime-candidate', '--runtime-metadata-sha256', '--node-candidate', '--node-metadata-sha256'].includes(key), 'Unknown coordinator option')
    assert.ok(args[i + 1] && !Object.hasOwn(values, key), 'Missing or repeated coordinator option')
    values[key] = args[i + 1]
  }
  assert.ok(values['--output'] && path.isAbsolute(values['--output']), 'Coordinator output must be an absolute new directory (or existing receipt for resume)')
  if (values['--component']) assert.ok(['runtime', 'node'].includes(values['--component']), 'Unknown component')
  for (const component of ['runtime', 'node']) {
    const id = values[`--${component}-candidate`], hash = values[`--${component}-metadata-sha256`]
    assert.equal(Boolean(id), Boolean(hash), 'A candidate release ID and metadata SHA256 are required together')
    if (id) assert.ok(decimal.test(id) && sha256.test(hash), 'Invalid candidate ID or metadata SHA256')
  }
  return values
}

export function githubApi(endpoint, body) {
  const args = ['api', '--hostname', 'github.com', endpoint]
  if (body) args.push('--method', 'POST', '--input', '-')
  try {
    const raw = execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000,
      input: body ? JSON.stringify(body) : undefined, stdio: ['pipe', 'pipe', 'pipe'] })
    return raw.trim() ? JSON.parse(raw) : null
  } catch { throw new Error('GitHub request failed. Inspect the saved receipt; never repeat an uncertain dispatch automatically.') }
}

async function publicJson(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (response.status === 404) return null
  assert.equal(response.status, 200, 'Public registry lookup failed; absence must be an explicit 404')
  return response.json()
}

export async function readPublishedComponent(component, release, readJson = publicJson) {
  if (component === 'npm') {
    const data = await readJson(`https://registry.npmjs.org/physicalsystems/${release.product.version}`)
    if (!data) return false
    assert.equal(data.name, 'physicalsystems')
    assert.equal(data.version, release.product.version)
    // Existing npm versions are immutable. Reuse never claims byte identity to
    // an unpacked local source tree; the workflow owns exact candidate readback.
    assert.match(data.dist?.integrity || '', /^sha512-[A-Za-z0-9+/]+=*$/)
    return true
  }
  const pin = release.components[component]
  const data = await readJson(`https://pypi.org/pypi/${pin.distribution}/${pin.version}/json`)
  if (!data) return false
  const wheels = data.urls?.filter((entry) => entry.packagetype === 'bdist_wheel')
  assert.equal(wheels?.length, 1, 'Expected exactly one published component wheel')
  assert.equal(wheels[0].digests?.sha256, pin.wheelSha256, 'Published component differs from reviewed product pin')
  assert.equal(wheels[0].yanked, false, 'Cannot reuse a yanked component')
  return true
}

export async function createDispatchStages(action, release, values, published) {
  const stages = []
  for (const component of ['runtime', 'node', 'npm']) {
    if (action === 'verify-publishers' && component === 'npm') continue
    const exists = await published(component, release)
    if (action === 'verify-publishers') assert.ok(exists, 'Verification requires an already published exact component')
    if (action === 'publish' && exists) {
      assert.ok(!values[`--${component}-candidate`], 'Unchanged published components must not supply a new candidate')
      stages.push({ component, status: 'reused', workflow: workflows[component] })
      continue
    }
    const inputs = component === 'npm' ? {} : { operation: action === 'verify-publishers' ? 'verify-published' : 'publish' }
    if (component === 'node' || (component === 'runtime' && action === 'publish')) {
      assert.ok(values[`--${component}-candidate`], `Missing reviewed ${component} candidate release ID and metadata SHA256`)
      inputs.candidate_release_id = values[`--${component}-candidate`]
      inputs.release_metadata_sha256 = values[`--${component}-metadata-sha256`]
    } else assert.ok(!values[`--${component}-candidate`], 'Runtime verification uses the reviewed published pin, not a candidate')
    stages.push({ component, workflow: workflows[component], inputs, status: 'pending' })
  }
  return stages
}

// Backend publication precedes the review which adopts its real registry URLs
// into the npm manifests. Do not require imaginary future URLs to publish it.
export async function readComponentCandidate(component, values, { api = githubApi, readAsset } = {}) {
  const candidateId = values[`--${component}-candidate`], hash = values[`--${component}-metadata-sha256`]
  assert.ok(decimal.test(candidateId || '') && sha256.test(hash || ''), 'Missing reviewed component candidate')
  const candidate = api(`repos/${repository}/releases/${candidateId}`)
  assert.equal(candidate.id, Number(candidateId))
  assert.equal(candidate.draft, false)
  assert.equal(candidate.prerelease, true)
  assert.equal(candidate.target_commitish, 'main')
  const assets = candidate.assets.filter((entry) => entry.name === 'release.json')
  assert.equal(assets.length, 1)
  assert.equal(assets[0].digest, `sha256:${hash}`)
  assert.ok(assets[0].size > 0 && assets[0].size < 64 * 1024)
  const url = `https://github.com/${repository}/releases/download/${candidate.tag_name}/release.json`
  assert.match(candidate.tag_name, /^(?:runtime|physicalsystems-node)-v\d+\.\d+\.\d+-candidate$/)
  assert.equal(assets[0].browser_download_url, url)
  const raw = readAsset ? await readAsset(url) : Buffer.from(execFileSync('gh',
    ['api', '--hostname', 'github.com', `repos/${repository}/releases/assets/${assets[0].id}`, '-H', 'Accept: application/octet-stream'],
    { timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(raw.length, assets[0].size)
  assert.equal(createHash('sha256').update(raw).digest('hex'), hash)
  const metadata = JSON.parse(raw)
  const distribution = component === 'runtime' ? 'tinyedge-runtime' : 'physicalsystems-node'
  assert.equal(metadata.distribution, distribution)
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/)
  assert.equal(candidate.tag_name, `${component === 'runtime' ? 'runtime' : 'physicalsystems-node'}-v${metadata.version}-candidate`)
  assert.equal(metadata.contractVersion, component === 'runtime' ? 'physicalsystems-runtime-candidate-v1' : 'physicalsystems-node-release-capsule-v1')
  const wheels = component === 'node' ? [metadata.wheel] : metadata.files.filter((entry) => entry.filename.endsWith('.whl'))
  assert.equal(wheels.length, 1)
  assert.ok(sha256.test(wheels[0].sha256))
  // Full capsule/content/source/dependency validation belongs to the protected
  // component workflow; this only binds the coordinator's future readback.
  return { distribution, version: metadata.version, wheelSha256: wheels[0].sha256 }
}

export function validateCoordinatorState(state) {
  assert.equal(state.contractVersion, 'physicalsystems-release-coordinator-v1')
  assert.equal(state.repository, repository)
  assert.ok(uuid.test(state.id) && /^[a-f0-9]{40}$/.test(state.headSha) && sha256.test(state.planDigest), 'Invalid coordinator identity')
  assert.ok(['verify-publishers', 'publish', 'publish-component'].includes(state.action))
  if (state.action === 'publish-component') {
    assert.ok(['runtime', 'node'].includes(state.component))
    assert.deepEqual(state.stages.map((stage) => stage.component), [state.component])
    const pin = state.componentPin
    assert.equal(pin.distribution, state.component === 'runtime' ? 'tinyedge-runtime' : 'physicalsystems-node')
    assert.match(pin.version, /^\d+\.\d+\.\d+$/)
    assert.ok(sha256.test(pin.wheelSha256))
  } else assert.deepEqual(state.stages.map((stage) => stage.component), state.action === 'publish' ? ['runtime', 'node', 'npm'] : ['runtime', 'node'])
  for (const stage of state.stages) {
    assert.equal(stage.workflow, workflows[stage.component])
    assert.ok(['pending', 'dispatch-requested', 'running', 'success', 'reused'].includes(stage.status))
    if (stage.status === 'reused') { assert.equal(state.action, 'publish'); continue }
    const expectedKeys = stage.component === 'npm' ? [] : ['operation']
    if (stage.component === 'node' || (stage.component === 'runtime' && state.action !== 'verify-publishers')) {
      expectedKeys.push('candidate_release_id', 'release_metadata_sha256')
      assert.ok(decimal.test(stage.inputs.candidate_release_id) && sha256.test(stage.inputs.release_metadata_sha256))
    }
    if (stage.component !== 'npm') assert.equal(stage.inputs.operation, state.action === 'verify-publishers' ? 'verify-published' : 'publish')
    assert.deepEqual(Object.keys(stage.inputs).sort(), expectedKeys.sort(), 'Unexpected dispatch input')
    if (stage.runId) assert.ok(decimal.test(String(stage.runId)))
  }
  return state
}

function validateRun(run, state, stage) {
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0, 'Invalid workflow run ID')
  if (stage.runId) assert.equal(String(run.id), stage.runId, 'Saved run identity changed')
  assert.equal(run.head_sha, state.headSha, 'Workflow ran a different main revision; stop and inspect')
  assert.equal(run.head_branch, 'main')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.path, `.github/workflows/${stage.workflow}`)
  assert.equal(run.repository.full_name, repository)
  assert.ok(run.display_title?.split(/\s+/).includes(state.id), 'Uncorrelated workflow run')
  assert.equal(run.run_attempt, 1, 'Reruns require inspection; a new attempt is not the approved original run')
}

export function validateWorkflowJobs(jobs, state, stage) {
  assert.ok(Array.isArray(jobs) && jobs.length > 0, 'Workflow did not report actual jobs')
  if (stage.component !== 'npm') {
    const expected = ['verify', stage.component === 'node' ? 'publish' : 'finish',
      ...['linux-x64', 'win32-x64'].flatMap((os) => ['3.10', '3.11', '3.12'].map((python) => `install-${os}-py${python}`))]
    assert.deepEqual(jobs.map((job) => job.name).sort(), expected.sort(), 'Missing component qualification jobs')
  }
  for (const job of jobs) {
    assert.equal(job.run_id, Number(stage.runId))
    assert.equal(job.run_attempt, 1)
    assert.equal(job.head_sha, state.headSha)
    assert.equal(job.status, 'completed')
    assert.equal(job.conclusion, 'success', 'Skipped/failed jobs cannot qualify a publisher')
    assert.ok(job.steps?.some((step) => step.conclusion === 'success'), 'A job needs actual successful steps')
  }
}

export async function collectPublisherEvidence(state, stage, { api = githubApi, output }) {
  const response = api(`repos/${repository}/actions/runs/${stage.runId}/attempts/1/jobs?per_page=100`)
  assert.equal(response.total_count, response.jobs.length, 'Incomplete job listing')
  validateWorkflowJobs(response.jobs, state, stage)
  if (stage.component === 'npm') return { jobsVerified: true, runAttempt: 1 }
  const artifactName = stage.component === 'node'
    ? `node-publisher-verification-${stage.runId}-1` : `runtime-publisher-evidence-${stage.runId}-1`
  const artifacts = api(`repos/${repository}/actions/runs/${stage.runId}/artifacts?per_page=100`)
  assert.equal(artifacts.total_count, artifacts.artifacts.length, 'Incomplete artifact listing')
  const matches = artifacts.artifacts.filter((entry) => entry.name === artifactName)
  assert.equal(matches.length, 1, 'Missing unique publisher evidence artifact')
  const artifact = matches[0]
  assert.equal(artifact.expired, false)
  assert.equal(artifact.workflow_run.id, Number(stage.runId))
  assert.equal(artifact.workflow_run.head_sha, state.headSha)
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
  const directory = path.join(output, `${stage.component}-${stage.runId}-evidence`)
  try {
    await fs.mkdir(directory)
    execFileSync('gh', ['run', 'download', stage.runId, '--repo', repository, '--name', artifactName, '--dir', directory],
      { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Evidence download incomplete; inspect saved files before recovery')
  }
  assert.ok(!(await fs.lstat(directory)).isSymbolicLink())
  const filename = path.join(directory, stage.component === 'node' ? 'publisher-verification.json' : 'publisher.json')
  assert.ok(!(await fs.lstat(filename)).isSymbolicLink())
  const raw = await fs.readFile(filename)
  assert.ok(raw.length < 16_384, 'Publisher receipt too large')
  const receipt = JSON.parse(raw)
  assert.equal(receipt.schema, 'physicalsystems.publisher-verification.v1')
  for (const [key, expected] of Object.entries({ component: stage.component, repository, workflow: stage.workflow,
    distribution: stage.component === 'runtime' ? 'tinyedge-runtime' : 'physicalsystems-node',
    environment: stage.component === 'runtime' ? 'runtime-pypi' : 'physical-node-pypi', runId: stage.runId,
    runAttempt: '1', headSha: state.headSha, tokenExchangeVerified: true, publicationPerformed: false,
    distributionAuthorizationVerified: false, pypiEnvironmentBindingVerified: false })) assert.equal(receipt[key], expected, `Publisher receipt ${key} mismatch`)
  return { jobsVerified: true, runAttempt: 1, artifactId: artifact.id, artifactDigest: artifact.digest,
    receiptSha256: createHash('sha256').update(raw).digest('hex'), receipt }
}

// Check every active run once. Resume is bounded, not a background daemon and
// never automatically re-dispatches, retries uploads, approves or changes trust.
export async function advanceCoordinator(state, { api = githubApi, save, published, release, evidence }) {
  validateCoordinatorState(state)
  for (const stage of state.stages) {
    if (stage.status === 'reused') {
      assert.ok(await published(stage.component, release), 'Previously completed component is missing from the registry')
      continue
    }
    if (stage.status === 'success') assert.ok(stage.runId && stage.evidence, 'Successful stage needs saved run evidence')
    if (stage.status === 'pending') {
      const main = api(`repos/${repository}/branches/main`)
      assert.equal(main.commit.sha, state.headSha, 'main changed; do not dispatch a different release revision')
      stage.status = 'dispatch-requested'
      await save(state) // Write intent BEFORE the network mutation.
      api(`repos/${repository}/actions/workflows/${stage.workflow}/dispatches`, {
        ref: 'main', inputs: { ...stage.inputs, coordinator_id: state.id, expected_head_sha: state.headSha },
      })
    }
    let run
    if (stage.runId) run = api(`repos/${repository}/actions/runs/${stage.runId}`)
    else {
      const data = api(`repos/${repository}/actions/workflows/${stage.workflow}/runs?event=workflow_dispatch&branch=main&per_page=100`)
      const candidates = data.workflow_runs.filter((entry) => entry.display_title?.split(/\s+/).includes(state.id))
      assert.ok(candidates.length <= 1, 'Ambiguous dispatch; inspect runs instead of retrying')
      run = candidates[0]
      if (!run) {
        // A missing run after an uncertain request is not permission to dispatch
        // again. Keep the saved intent and allow read-only recovery with resume.
        if (state.action === 'publish') break
        continue
      }
    }
    validateRun(run, state, stage)
    stage.runId = String(run.id)
    stage.url = `https://github.com/${repository}/actions/runs/${run.id}`
    stage.status = 'running'
    stage.runStatus = run.status
    await save(state)
    if (run.status !== 'completed') {
      if (state.action === 'publish') break
      continue // Independent unchanged component verification may run in parallel.
    }
    assert.equal(run.conclusion, 'success', `Release job failed: ${stage.url}. Inspect it; no automatic retry.`)
    stage.evidence = await evidence(state, stage)
    assert.ok(await published(stage.component, release), 'Successful workflow has no matching public registry readback')
    stage.status = 'success'
    await save(state)
  }
  state.workflowVerificationComplete = state.stages.every((stage) => ['reused', 'success'].includes(stage.status))
  // This is deliberately NOT a claim that PyPI project registration was audited
  // or the legacy workflows were disabled. Those remain migration evidence.
  await save(state)
  return state
}

export async function runPublishCoordinator(action, args, { sourceRoot = root, api = githubApi,
  published = readPublishedComponent, print = console.log } = {}) {
  const values = parsePublishArguments(args)
  if (action === 'resume') assert.deepEqual(Object.keys(values), ['--output'], 'Resume accepts only its saved receipt directory')
  if (action !== 'publish-component') assert.ok(!values['--component'], 'Component selector is only for publish-component')
  const output = path.resolve(values['--output'])
  const parent = await fs.realpath(path.dirname(output))
  const source = await fs.realpath(sourceRoot)
  const relative = path.relative(source, parent)
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Release receipts must stay outside source')
  const receipt = path.join(output, 'coordinator.json')
  const release = await readProductRelease(sourceRoot)
  const plan = await createReleasePlan(sourceRoot)
  let state
  if (action === 'resume') {
    assert.ok(!(await fs.lstat(output)).isSymbolicLink() && !(await fs.lstat(receipt)).isSymbolicLink(), 'Coordinator receipt cannot be a link')
    state = validateCoordinatorState(JSON.parse(await fs.readFile(receipt, 'utf8')))
    assert.equal(state.planDigest, plan.planDigest, 'Local product plan changed; do not resume against different pins')
  } else {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), '', 'Dispatch requires a clean reviewed checkout')
    assert.equal(api(`repos/${repository}/branches/main`).commit.sha, head, 'Dispatch requires the current remote main revision')
    let stages, componentPin
    if (action === 'publish-component') {
      const component = values['--component']
      assert.ok(component, 'publish-component requires --component runtime|node')
      assert.ok(!values[`--${component === 'runtime' ? 'node' : 'runtime'}-candidate`], 'Publish one explicit component per request')
      componentPin = await readComponentCandidate(component, values, { api })
      assert.equal(await published(component, { ...release, components: { ...release.components, [component]: componentPin } }), false, 'Component version already exists; inspect instead of republishing')
      stages = [{ component, workflow: workflows[component], status: 'pending', inputs: { operation: 'publish',
        candidate_release_id: values[`--${component}-candidate`], release_metadata_sha256: values[`--${component}-metadata-sha256`] } }]
    } else stages = await createDispatchStages(action, release, values, published)
    state = { contractVersion: 'physicalsystems-release-coordinator-v1', repository, id: randomUUID(),
      action, headSha: head, planDigest: plan.planDigest, createdAt: new Date().toISOString(), stages }
    if (componentPin) Object.assign(state, { component: values['--component'], componentPin })
    await fs.mkdir(output) // Exclusive; never overwrite a previous release receipt.
  }
  const lock = await fs.open(path.join(output, 'coordinator.lock'), 'wx')
  try {
    const save = async (value) => {
      const temporary = path.join(output, 'coordinator.next.json')
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
      await fs.rename(temporary, receipt)
    }
    await save(state)
    const readbackRelease = state.action === 'publish-component'
      ? { ...release, components: { ...release.components, [state.component]: state.componentPin } } : release
    await advanceCoordinator(state, { api, save, published, release: readbackRelease,
      evidence: (current, stage) => collectPublisherEvidence(current, stage, { api, output }) })
    print(JSON.stringify(state, null, 2))
    if (!state.workflowVerificationComplete) print('Workflows dispatched. Approve their protected environments when GitHub requests review, then run: npm run release -- resume --output "' + output + '"')
    return state
  } finally { await lock.close(); await fs.unlink(path.join(output, 'coordinator.lock')) }
}
