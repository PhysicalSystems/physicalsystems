import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { generateReleaseInputs, restoreReleaseInputs } from '../scripts/workflow-release-inputs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
test('CI generates and restores exact candidate metadata without committing, preserves backend pins, and stamps provenance into the package', async (t) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'ps-generated-release-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const checkout = path.join(temporary, 'source'), evidence = path.join(temporary, 'inputs')
  await fs.cp(root, checkout, { recursive: true, filter: (source) => !['.git', 'node_modules', 'release-artifacts', 'candidate-artifacts', 'verification-evidence'].includes(path.basename(source)) })
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-b', 'main', '--quiet')
  git('config', 'gc.auto', '0')
  git('config', 'maintenance.auto', 'false')
  git('config', 'core.autocrlf', 'false')
  git('add', '.')
  git('-c', 'user.name=Release fixture', '-c', 'user.email=release@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'reviewed main fixture')
  const base = git('rev-parse', 'HEAD')
  const before = JSON.parse(await fs.readFile(path.join(checkout, 'release/product.json')))
  const parts = before.product.version.split('.')
  parts[2] = String(BigInt(parts[2]) + 1n)
  const published = parts.join('.') // main's template can lag the registry.
  parts[2] = String(BigInt(parts[2]) + 1n)
  const next = parts.join('.')
  const plan = { action: 'publish', base, published, version: next }
  const hash = await generateReleaseInputs(checkout, plan, evidence)
  assert.equal(git('status', '--porcelain'), '', 'Preparation leaves the exact main tree unchanged')
  assert.equal(git('rev-parse', 'HEAD'), base)
  const filename = path.join(evidence, 'release-inputs.json')
  const bytes = await fs.readFile(filename)
  assert.equal(digest(bytes), hash)
  const original = JSON.parse(bytes)
  const restore = (expected = hash, version = next) => restoreReleaseInputs(checkout, filename, expected, version)
  await assert.rejects(restore('0'.repeat(64)), /digest differs/)
  await assert.rejects(restore(hash, '9.0.0'), /version mismatch/)
  for (const mutate of [
    (bundle) => { bundle.sourceCommit = 'f'.repeat(40) },
    (bundle) => { bundle.files['../escape'] = 'injected' },
    (bundle) => { bundle.files['packages/cli/src/cli.js'] = 'injected' },
    (bundle) => { bundle.files['packages/cli/scripts/check-release-packages.js'] += '\n// arbitrary code injection\n' },
    (bundle) => { bundle.files['SBOM.cdx.json'] = '{}' },
    (bundle) => { bundle.files['EXPORT-PROVENANCE.json'] = '{}' },
  ]) {
    const bundle = structuredClone(original)
    mutate(bundle)
    const tampered = JSON.stringify(bundle)
    await fs.writeFile(filename, tampered)
    await assert.rejects(restore(digest(tampered)))
    assert.equal(git('status', '--porcelain'), '', 'Rejected inputs do not leave source changes behind')
  }
  await fs.writeFile(filename, bytes)
  const record = await restore()
  const after = JSON.parse(await fs.readFile(path.join(checkout, 'release/product.json')))
  assert.equal(after.product.version, next)
  assert.equal(after.previousTags.preview, published)
  assert.deepEqual(after.components, before.components)
  assert.equal(after.backendIndexSha256, before.backendIndexSha256)
  assert.deepEqual(after.selectors, before.selectors)
  assert.deepEqual(after.toolchain, before.toolchain)
  const pkg = JSON.parse(await fs.readFile(path.join(checkout, 'packages/cli/package.json')))
  assert.deepEqual(pkg.physicalsystemsRelease, record)
  assert.equal(record.sourceCommit, base)
  assert.equal(record.sourceVersion, before.product.version)
  assert.equal(record.version, next)
  assert.equal(await fs.readFile(path.join(checkout, 'packages/cli/package-lock.json'), 'utf8'),
    await fs.readFile(path.join(checkout, 'packages/cli/npm-shrinkwrap.json'), 'utf8'))
  assert.doesNotMatch(git('diff', '--name-only'), /\.github\/|packages\/runtime\/|node-releases/)
  assert.equal(git('rev-parse', 'HEAD'), base, 'The generated workspace is not a new source commit')
  await assert.rejects(restore(), /clean source checkout/)
  // A precommitted version is stamped without an additional increment.
  git('restore', '--worktree', '.')
  const sameDirectory = path.join(temporary, 'same-version-inputs')
  const samePlan = { ...plan, version: before.product.version, published: before.previousTags.preview }
  const sameHash = await generateReleaseInputs(checkout, samePlan, sameDirectory)
  assert.equal(git('status', '--porcelain'), '')
  const same = await restoreReleaseInputs(checkout, path.join(sameDirectory, 'release-inputs.json'), sameHash, before.product.version)
  assert.equal(same.version, before.product.version)
  assert.equal(same.sourceCommit, base)
})

test('the one-click workflow keeps manual main and protected publishing gates without PR-write permissions', async () => {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/npm-release.yml'), 'utf8')
  assert.doesNotMatch(workflow, /pull-requests: write|contents: write|release-request\.mjs (?:prepare|submit)|pull_request:/)
  assert.match(workflow, /test "\$GITHUB_EVENT_NAME" = "workflow_dispatch"/)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/)
  assert.match(workflow, /environment: npm-release/)
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1)
  assert.equal((workflow.match(/run: node scripts\/workflow-release-inputs\.mjs/g) || []).length, 4)
  assert.equal((workflow.match(/RELEASE_INPUTS_SHA256: \$\{\{ needs.require-main.outputs.inputs-sha256 \}\}/g) || []).length, 4)
  assert.match(workflow, /needs.require-main.outputs.action == 'publish'/)
  assert.match(workflow, /assert.deepEqual\(packedPackage.physicalsystemsRelease, generated/)
})
