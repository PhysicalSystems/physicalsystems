// Preparation stays in the existing manual publisher. Registry reads determine
// the next candidate; they never replace protected exact-artifact qualification.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireNewVersion } from './prepare-release-version.mjs'
import { generateReleaseInputs } from './workflow-release-inputs.mjs'

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
  if (mode === 'publish') {
    assert.ok(order > 0, 'This source version is already published; use auto to generate the next release')
    assert.ok(!requested || requested === current, 'Publish mode accepts only the source version')
    assert.equal(previousPreview, published, 'Reviewed previous preview differs from the registry')
  }
  if (mode === 'auto' && !changed && !requested && order <= 0) return { action: 'noop', version: published }
  const parts = published.split('.')
  parts[2] = String(BigInt(parts[2]) + 1n)
  const next = requested || (order > 0 ? current : parts.join('.'))
  requireNewVersion(published, next)
  assert.ok(compare(next, current) >= 0, 'Requested version is older than the source template')
  return { action: 'publish', version: next }
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
    changedFiles: files }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv[2], 'plan', 'Expected plan')
    const directory = path.join(process.env.RUNNER_TEMP, 'release-request')
    const plan = await inspectReleaseRequest(root, { requested: process.env.REQUESTED_VERSION || '', mode: process.env.COORDINATOR_ID ? 'publish' : process.env.RELEASE_OPERATION || 'auto' })
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'request.json'), `${JSON.stringify(plan, null, 2)}\n`)
    let inputHash = ''
    if (plan.action === 'publish') inputHash = await generateReleaseInputs(root, plan, directory)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `action=${plan.action}\nversion=${plan.version}\ninputs-sha256=${inputHash}\n`)
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Release decision: **${plan.action} ${plan.version}**. Published preview: ${plan.published}.\nSource commit: ${plan.base}. Generated-input SHA-256: ${inputHash || 'none'}.\nVersion metadata is generated only inside CI. No release PR or source commit was created. Publication requires the existing qualification and protected approval.\n`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
