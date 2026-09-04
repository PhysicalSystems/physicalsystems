import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createMigrationReport, readMigrationPlan } from '../scripts/release-migration.mjs'
import { parseReleaseArguments, runReleaseCommand } from '../scripts/release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function fixture(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ps-migration-'))
  try {
    mkdirSync(path.join(directory, 'release'))
    copyFileSync(path.join(root, 'release/migration.json'), path.join(directory, 'release/migration.json'))
    mkdirSync(path.join(directory, '.github/workflows'), { recursive: true })
    for (const component of ['runtime', 'node']) copyFileSync(path.join(root, `.github/workflows/${component}-release.yml`), path.join(directory, `.github/workflows/${component}-release.yml`))
    body(directory)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('one maintainer entry reports source consolidation separately from publisher authority', async () => {
  assert.deepEqual(parseReleaseArguments(['migration']), { action: 'migration' })
  const lines = []
  const report = await runReleaseCommand(['migration'], { print: (line) => lines.push(line), prepare() { throw new Error('must not prepare') } })
  assert.deepEqual(JSON.parse(lines[0]), report)
  assert.equal(report.imports.length, 2)
  assert.equal(report.publicationAuthorized, false)
  assert.equal(report.livePublisherConfigurationVerified, false)
  assert.equal(report.repositoryRetirementAuthorized, false)
})

test('configuration cannot claim cutover success or change the publisher identity', () => fixture((directory) => {
  const location = path.join(directory, 'release/migration.json')
  const original = readFileSync(location, 'utf8')
  for (const mutate of [
    (value) => { value.publisherCutover = 'complete' },
    (value) => { value.preserveHistoricalAssets = false },
    (value) => { value.publishers.node.target.environment = 'unprotected' },
  ]) {
    const value = JSON.parse(original)
    mutate(value)
    writeFileSync(location, JSON.stringify(value))
    assert.throws(() => readMigrationPlan(directory))
  }
}))

test('replacement workflows must retain manual verification and protected environments', () => fixture((directory) => {
  writeFileSync(path.join(directory, '.github/workflows/node-release.yml'), 'name: not-yet-authorized\n')
  assert.throws(() => readMigrationPlan(directory), /must be manually dispatched/)
}))

test('source migration report is deterministic and preserves existing distributions', () => {
  assert.deepEqual(createMigrationReport(), createMigrationReport())
  assert.equal(createMigrationReport().publishers.runtime.distribution, 'tinyedge-runtime')
  assert.equal(createMigrationReport().publishers.node.distribution, 'physicalsystems-node')
})
