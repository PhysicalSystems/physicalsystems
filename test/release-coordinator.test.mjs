import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseReleaseArguments, runReleaseCommand, checkWorkflowReleaseConfiguration } from '../scripts/release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

async function withFixture(body) {
  const fixture = await fs.mkdtemp(path.join(tmpdir(), 'ps-release-check-'))
  try {
    const files = ['release/product.json', '.github/workflows/npm-release.yml',
      'packages/cli/package.json', 'packages/cli/package-lock.json', 'packages/cli/npm-shrinkwrap.json',
      'packages/pi-runtime/package.json', 'packages/cli/src/physical/node-releases.json']
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(fixture, file)), { recursive: true })
      await fs.copyFile(path.join(root, file), path.join(fixture, file))
    }
    await fs.cp(path.join(root, 'packages/cli/src/physical/node-releases'),
      path.join(fixture, 'packages/cli/src/physical/node-releases'), { recursive: true })
    await body(fixture)
  } finally { await fs.rm(fixture, { recursive: true, force: true }) }
}

test('publishing needs explicit receipt arguments and accepts no shell, ref or manifest override', () => {
  assert.deepEqual(parseReleaseArguments([]), { action: 'plan' })
  assert.deepEqual(parseReleaseArguments(['check']), { action: 'check' })
  for (const args of [['publish'], ['plan', '--publish'], ['check', '--ref', 'other'], ['check', '--metadata', 'other']]) {
    assert.throws(() => parseReleaseArguments(args), /Usage/)
  }
  assert.throws(() => parseReleaseArguments(['prepare', '--output', path.join(tmpdir(), 'offline-output'), '--offline']), /offline/)
})

test('the protected workflow direct index checker terminates without an ESM import cycle', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-release-index.mjs'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /metadata verified: 6 entries/)
  assert.doesNotMatch(result.stderr, /unsettled|await/i)
})

test('workflow drift fails before creating outputs or invoking preparation', async () => {
  await withFixture(async (fixture) => {
    const filename = path.join(fixture, '.github/workflows/npm-release.yml')
    const workflow = await fs.readFile(filename, 'utf8')
    await fs.writeFile(filename, workflow.replace('  RELEASE_VERSION: 0.2.1', '  RELEASE_VERSION: 9.9.9'))
    let prepared = false
    const output = path.join(fixture, 'never-created')
    await assert.rejects(runReleaseCommand(['prepare', '--output', output], {
      sourceRoot: fixture,
      prepare() { prepared = true },
    }), /RELEASE_VERSION differs/)
    assert.equal(prepared, false)
    await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  })
})

test('consumer toolchain and previous-tag drift are rejected too', async () => {
  for (const mutate of [
    (release) => { release.toolchain.consumerNode = '24.16.0' },
    (release) => { release.previousTags.preview = '0.2.1' },
  ]) await withFixture(async (fixture) => {
    const filename = path.join(fixture, 'release/product.json')
    const release = JSON.parse(await fs.readFile(filename, 'utf8'))
    mutate(release)
    await fs.writeFile(filename, JSON.stringify(release))
    await assert.rejects(checkWorkflowReleaseConfiguration(fixture), /matrix differs|tags differ/)
  })
})

test('the checked-in protected workflow and descriptor agree without starting a build', async () => {
  await checkWorkflowReleaseConfiguration()
  const output = []
  let prepared = false
  const plan = await runReleaseCommand(['check'], {
    print: (line) => output.push(line),
    prepare() { prepared = true; throw new Error('check must not prepare') },
  })
  assert.equal(prepared, false)
  assert.equal(plan.publicationAuthorized, false)
  assert.match(output.join('\n'), /locally consistent/)
  assert.match(output.join('\n'), /not implied/)
})

test('plan emits deterministic JSON without preparing or publishing', async () => {
  const first = [], second = []
  const forbidden = () => { throw new Error('read-only planning must not prepare') }
  await runReleaseCommand(['plan'], { print: (line) => first.push(line), prepare: forbidden })
  await runReleaseCommand(['plan'], { print: (line) => second.push(line), prepare: forbidden })
  assert.deepEqual(first, second)
  const plan = JSON.parse(first[0])
  assert.equal(plan.backend.action, 'reuse-pinned-artifacts')
  assert.equal(plan.installationQualified, false)
})
