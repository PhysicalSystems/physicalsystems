// Preparation stays in the existing manual publisher. Registry reads determine
// the next candidate; they never replace protected exact-artifact qualification.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareReleaseVersion, requireNewVersion } from './prepare-release-version.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const repository = 'PhysicalSystems/physicalsystems'
const registry = 'https://registry.npmjs.org/'
const stable = (value) => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.trim() === value
const compare = (a, b) => {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt)
  const index = left.findIndex((value, i) => value !== right[i])
  return index < 0 ? 0 : left[index] > right[index] ? 1 : -1
}
export function planReleaseRequest({ current, published, previousPreview, changed, requested = '', mode = 'auto' }) {
  assert.ok(['auto', 'publish'].includes(mode), 'Unknown release mode')
  assert.ok(stable(current) && stable(published) && (!requested || stable(requested)), 'Expected stable major.minor.patch versions')
  const order = compare(current, published)
  assert.ok(order >= 0, 'Source version is older than published preview; update main first')
  if (order > 0) {
    assert.ok(!requested || requested === current, 'A different candidate is already prepared; review it before requesting another version')
    assert.equal(previousPreview, published, 'Reviewed previous preview differs from the registry')
    return { action: 'publish', version: current }
  }
  assert.equal(mode, 'auto', 'This version is already published; use auto to prepare the next release')
  if (!changed && !requested) return { action: 'noop', version: current }
  const parts = current.split('.')
  parts[2] = String(BigInt(parts[2]) + 1n)
  const version = requested || parts.join('.')
  requireNewVersion(current, version)
  return { action: 'prepare', version }
}

export function releaseChanges(files) {
  return {
    changed: files.some((file) => /^(packages\/cli\/|packages\/pi-runtime\/|scripts\/|\.github\/workflows\/|release\/product\.json$|package\.json$|LICENSE$|NOTICE$|SBOM\.cdx\.json$)/.test(file)),
    backend: files.some((file) => /^packages\/runtime\/(?:src\/|pyproject\.toml$|LICENSE$|NOTICE$)/.test(file)) ? ['runtime'] : [],
  }
}

export function publishedCommit(metadata, attestations) {
  assert.equal(metadata.name, 'physicalsystems')
  assert.ok(stable(metadata.version))
  assert.match(metadata.dist?.integrity || '', /^sha512-[A-Za-z0-9+/]{86}==$/)
  const matches = attestations.attestations?.filter((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1')
  assert.equal(matches?.length, 1, 'Expected unique registry provenance')
  const statement = JSON.parse(Buffer.from(matches[0].bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1')
  assert.equal(statement.subject?.length, 1)
  assert.equal(statement.subject[0].name, `pkg:npm/physicalsystems@${metadata.version}`)
  assert.equal(statement.subject[0].digest.sha512, Buffer.from(metadata.dist.integrity.slice(7), 'base64').toString('hex'), 'Registry provenance digest differs')
  const definition = statement.predicate.buildDefinition
  assert.deepEqual(definition.externalParameters.workflow, {
    ref: 'refs/heads/main', repository: `https://github.com/${repository}`, path: '.github/workflows/npm-release.yml',
  }, 'Unexpected published source workflow')
  const dependencies = definition.resolvedDependencies.filter((entry) => entry.uri === `git+https://github.com/${repository}@refs/heads/main`)
  assert.equal(dependencies.length, 1, 'Expected one published source dependency')
  const sha = dependencies[0].digest.gitCommit
  assert.match(sha, /^[a-f0-9]{40}$/)
  // This is an HTTPS registry change-detection hint, not Sigstore verification.
  return sha
}

export async function registryJson(suffix, { fetchImpl = fetch, allowMissing = false } = {}) {
  const response = await fetchImpl(new URL(suffix, registry), { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (response.status === 404 && allowMissing) return null
  assert.equal(response.status, 200, 'Registry lookup failed; do not infer an unpublished version from a network error')
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= 2 * 1024 * 1024, 'Oversized registry response')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const git = (sourceRoot, ...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export async function inspectReleaseRequest(sourceRoot, { requested = '', mode = 'auto', readJson = registryJson } = {}) {
  const release = JSON.parse(await fs.readFile(path.join(sourceRoot, 'release/product.json'), 'utf8'))
  const metadata = await readJson('physicalsystems/preview')
  const attestations = await readJson(`-/npm/v1/attestations/physicalsystems@${metadata.version}`)
  const baseline = publishedCommit(metadata, attestations)
  try { git(sourceRoot, 'merge-base', '--is-ancestor', baseline, 'HEAD') }
  catch { throw new Error('Published source must be an available ancestor of main. Use a full-history checkout and inspect rewritten or unrelated history before releasing') }
  const files = git(sourceRoot, 'diff', '--name-only', baseline, 'HEAD').split('\n').filter(Boolean)
  const changes = releaseChanges(files)
  if (changes.backend.length) {
    const before = JSON.parse(git(sourceRoot, 'show', `${baseline}:release/product.json`))
    assert.notEqual(release.components.runtime.version, before.components.runtime.version,
      'Runtime source changed but the product still pins the previous Runtime. Qualify, publish and adopt that component through its existing workflow first')
  }
  const plan = planReleaseRequest({ current: release.product.version, published: metadata.version,
    previousPreview: release.previousTags.preview, changed: changes.changed, requested, mode })
  if (plan.action !== 'noop') assert.equal(await readJson(`physicalsystems/${plan.version}`, { allowMissing: true }), null,
    'Requested version already exists in npm; inspect the registry and source before continuing')
  return { ...plan, base: git(sourceRoot, 'rev-parse', 'HEAD'), baseline, published: metadata.version,
    branch: `release/physicalsystems-${plan.version}`, changedFiles: files }
}

export async function prepareRequest(sourceRoot, plan, directory) {
  assert.equal(plan.action, 'prepare')
  assert.equal(git(sourceRoot, 'rev-parse', 'HEAD'), plan.base, 'Source changed after release planning')
  assert.ok(path.isAbsolute(directory), 'Evidence directory must be absolute')
  const parent = await fs.realpath(path.dirname(directory))
  let resolved = path.join(parent, path.basename(directory))
  try { resolved = await fs.realpath(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const relative = path.relative(await fs.realpath(sourceRoot), resolved)
  assert.ok(path.isAbsolute(relative) || relative.split(path.sep)[0] === '..', 'Evidence must be outside the checkout')
  await fs.mkdir(directory, { recursive: true })
  await prepareReleaseVersion(sourceRoot, plan.version)
  const changed = git(sourceRoot, 'diff', '--name-only').split('\n')
  assert.ok(changed.every((file) => !file.startsWith('.github/')), 'Automatic version changes must not edit workflows')
  await fs.writeFile(path.join(directory, 'release.patch'), execFileSync('git', ['diff', '--binary'], { cwd: sourceRoot }))
  await fs.writeFile(path.join(directory, 'request.json'), `${JSON.stringify(plan, null, 2)}\n`)
}

export async function submitRequest(sourceRoot, plan, directory, { api, authenticate } = {}) {
  const gh = (args, input) => {
    try { return execFileSync('gh', args, { cwd: sourceRoot, input, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim() }
    catch { throw new Error('GitHub release preparation failed. Inspect the branch/PR before retrying. The release.patch artifact is preserved. An owner may need to allow GitHub Actions to create pull requests in Settings > Actions > General; no repository setting was changed.') }
  }
  api ||= (endpoint, body) => JSON.parse(gh(['api', `repos/${repository}/${endpoint}`, ...(body ? ['--method', 'POST', '--input', '-'] : [])], body ? JSON.stringify(body) : undefined) || 'null')
  assert.equal(api('git/ref/heads/main').object.sha, plan.base, 'main advanced; run the workflow again before preparing a PR')
  const files = git(sourceRoot, 'diff', 'HEAD', '--name-only').split('\n')
  assert.ok(files.length && files.every((file) => file && !file.startsWith('.github/')), 'Expected a scoped version diff')
  git(sourceRoot, 'add', '--', ...files)
  const tree = git(sourceRoot, 'write-tree')
  const existing = api(`pulls?state=all&head=PhysicalSystems:${plan.branch}&base=main&per_page=100`)
  assert.ok(existing.length <= 1, 'Multiple release PRs require manual inspection')
  if (existing.length) {
    const pr = existing[0]
    assert.equal(pr.state, 'open', `Release PR ${pr.html_url} is closed; inspect it before another request`)
    assert.equal(api(`git/commits/${pr.head.sha}`).tree.sha, tree, `Release PR ${pr.html_url} differs from this request; review it without overwriting`)
    return pr.html_url
  }
  // Empty lease requires an absent remote branch, including recovery after an
  // uncertain push. Never replace another run's or operator's release branch.
  if (authenticate) authenticate()
  else gh(['auth', 'setup-git', '--hostname', 'github.com'])
  const remote = git(sourceRoot, 'ls-remote', '--heads', 'origin', `refs/heads/${plan.branch}`)
  if (remote) {
    const sha = remote.split(/\s+/)[0]
    assert.match(sha, /^[a-f0-9]{40}$/)
    const commit = api(`git/commits/${sha}`)
    assert.equal(commit.tree.sha, tree, 'Existing release branch differs; inspect it instead of overwriting')
    assert.deepEqual(commit.parents.map((entry) => entry.sha), [plan.base], 'Existing release branch has a different base')
  } else {
    git(sourceRoot, 'switch', '-c', plan.branch)
    git(sourceRoot, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--signoff', '-m', `Prepare physicalsystems ${plan.version}`)
    git(sourceRoot, 'push', `--force-with-lease=refs/heads/${plan.branch}:`, 'origin', `HEAD:refs/heads/${plan.branch}`)
  }
  const body = `Prepare physicalsystems ${plan.version} from reviewed main ${plan.base}.\n\nDefault patch selection compares npm preview ${plan.published} with main. Backend versions, hashes and dependency pins are preserved. Version consistency, SBOM and source provenance were regenerated; native qualification is still pending.\n\nReview the diff, approve/run the existing Physical Systems CLI checks, and merge when ready. Then run **Publish Physical Systems npm preview** on main again with the default auto operation. Its existing protected qualification and publication gates remain required. Nothing was published by preparation.\n\nRefs #43.\n`
  await fs.writeFile(path.join(directory, 'review.md'), body)
  const pr = api('pulls', { title: `Prepare physicalsystems ${plan.version}`, head: plan.branch, base: 'main', body })
  return pr.html_url
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2]
    const directory = path.join(process.env.RUNNER_TEMP, 'release-request')
    if (action === 'plan') {
      const plan = await inspectReleaseRequest(root, { requested: process.env.REQUESTED_VERSION || '', mode: process.env.COORDINATOR_ID ? 'publish' : process.env.RELEASE_OPERATION || 'auto' })
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'request.json'), `${JSON.stringify(plan, null, 2)}\n`)
      await fs.appendFile(process.env.GITHUB_OUTPUT, `action=${plan.action}\nversion=${plan.version}\n`)
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Release decision: **${plan.action} ${plan.version}**. Published preview: ${plan.published}.\n`)
    } else {
      const plan = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8'))
      if (action === 'prepare') await prepareRequest(root, plan, directory)
      else if (action === 'submit') {
        const url = await submitRequest(root, plan, directory)
        await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Review [the release PR](${url}), then run this same workflow on main after merging. Nothing was published.\n`)
      } else throw new Error('Expected plan, prepare or submit')
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
