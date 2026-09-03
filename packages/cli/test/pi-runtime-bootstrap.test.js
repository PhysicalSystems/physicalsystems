import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCliConsumerLock,
  NPM_BOOTSTRAP_TIMEOUT_MS,
  validateCliRuntimeContract,
} from '../scripts/bootstrap-pi-runtime.js'

const runtimeName = '@tinyedge/pi-runtime'
const runtimeVersion = '0.84.2-tinyedge.1'
const runtimeIntegrity = 'sha512-VGlue='

test('Pi runtime bootstrap gives cold hosted-runner installs ten bounded minutes', () => {
  assert.equal(NPM_BOOTSTRAP_TIMEOUT_MS, 600_000)
})

function fixtures() {
  const manifest = {
    name: 'physicalsystems',
    version: '0.2.1',
    license: 'Apache-2.0',
    dependencies: {
      [runtimeName]: runtimeVersion,
    },
    bundleDependencies: true,
  }
  const runtimeLock = {
    name: runtimeName,
    version: runtimeVersion,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: runtimeName,
        version: runtimeVersion,
        license: 'MIT',
        dependencies: { chalk: '5.6.2' },
        engines: { node: '>=22.19.0' },
        peerDependencies: {},
        peerDependenciesMeta: {},
      },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-Chalk=',
        license: 'MIT',
      },
    },
  }
  const lock = buildCliConsumerLock({ manifest, runtimeLock, runtimeIntegrity })
  return { manifest, lock, runtimeLock }
}

function validateFixture(fixture) {
  const lockText = `${JSON.stringify(fixture.lock, null, 2)}\n`
  return validateCliRuntimeContract({
    ...fixture,
    packageLockText: lockText,
    shrinkwrapText: lockText,
    runtimeIntegrity,
  })
}

test('Pi runtime bootstrap accepts the exact canonical reviewed closure', () => {
  assert.doesNotThrow(() => validateFixture(fixtures()))
})

test('Pi runtime bootstrap requires every direct dependency to be bundled', () => {
  const unbundled = fixtures()
  delete unbundled.manifest.bundleDependencies
  assert.throws(() => validateFixture(unbundled), /bundleDependencies/)

  const incompleteLock = fixtures()
  incompleteLock.lock.packages[''].bundleDependencies = []
  assert.throws(() => validateFixture(incompleteLock), /mark every direct dependency for bundling/)
})

test('Pi runtime bootstrap rejects local resolutions and banned native packages', () => {
  const local = fixtures()
  local.lock.packages[`node_modules/${runtimeName}`].resolved = 'file:../pi-runtime.tgz'
  assert.throws(() => validateFixture(local), /registry\.npmjs\.org/)

  for (const bannedName of [
    '@mariozechner/clipboard',
    '@mariozechner/clipboard-win32-x64-msvc',
  ]) {
    const banned = fixtures()
    banned.lock.packages[`node_modules/${bannedName}`] = { version: '0.3.9' }
    assert.throws(
      () => validateFixture(banned),
      new RegExp(`must omit ${bannedName.replaceAll('/', '\\/')}`),
    )
  }
})

test('Pi runtime bootstrap rejects any transitive closure drift', () => {
  const drifted = fixtures()
  drifted.lock.packages['node_modules/chalk'].version = '5.6.3'
  assert.throws(
    () => validateFixture(drifted),
    /preserve the reviewed runtime entry node_modules\/chalk/,
  )
})
