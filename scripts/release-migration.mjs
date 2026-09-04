// Read-only source/cutover report. Configuration is not proof of live registry
// permissions. Never upload, enable a workflow, or archive a repository here.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSourceImports } from './check-source-imports.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export function readMigrationPlan(sourceRoot = root) {
  const location = path.join(sourceRoot, 'release/migration.json')
  assert.ok(!lstatSync(location).isSymbolicLink(), 'migration descriptor cannot be a link')
  const migration = JSON.parse(readFileSync(location, 'utf8'))
  assert.equal(migration.contractVersion, 'physicalsystems-source-migration-v1')
  assert.equal(migration.publicSourceRepository, 'PhysicalSystems/physicalsystems')
  assert.equal(migration.privateNodeRepository, 'PhysicalSystems/node')
  assert.equal(migration.publisherCutover, 'pending-verification', 'publisher cutover requires separate reviewed verification, not a status toggle')
  assert.equal(migration.preserveHistoricalAssets, true)
  assert.deepEqual(migration.publishers, {
    runtime: {
      distribution: 'tinyedge-runtime',
      existing: { repository: 'PhysicalSystems/runtime', workflow: 'release.yml', environment: 'pypi' },
      target: { repository: 'PhysicalSystems/physicalsystems', workflow: 'runtime-release.yml', environment: 'runtime-pypi' },
    },
    node: {
      distribution: 'physicalsystems-node',
      existing: { repository: 'PhysicalSystems/node-releases', workflow: 'publish.yml', environment: 'physical-node-pypi' },
      target: { repository: 'PhysicalSystems/physicalsystems', workflow: 'node-release.yml', environment: 'physical-node-pypi' },
    },
  }, 'publisher identities require a deliberate, reviewed cutover')
  for (const publisher of Object.values(migration.publishers)) {
    assert.ok(!existsSync(path.join(sourceRoot, '.github/workflows', publisher.target.workflow)), 'replacement publisher must not be active before cutover verification')
  }
  return migration
}

export function createMigrationReport(sourceRoot = root) {
  const migration = readMigrationPlan(sourceRoot)
  const imports = checkSourceImports(sourceRoot)
  return {
    ...migration,
    imports,
    publicationAuthorized: false,
    livePublisherConfigurationVerified: false,
    repositoryRetirementAuthorized: false,
    changedComponentOrder: ['runtime-if-changed', 'node-if-changed', 'npm-product'],
    nextSteps: [
      'Verify new GitHub environment protections and the exact PyPI Trusted Publisher repository/workflow/environment identities.',
      'Qualify the replacement component publisher with explicitly authorized new artifacts; keep existing package versions and downloads immutable.',
      'Record exact public readback and rollback references before disabling legacy publishers; retain historical assets.',
    ],
  }
}
