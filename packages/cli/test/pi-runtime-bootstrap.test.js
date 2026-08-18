import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCliConsumerLock,
  validateCliRuntimeContract,
} from '../scripts/bootstrap-pi-runtime.js'

const runtimeName = '@tinyedge/pi-runtime'
const runtimeVersion = '0.84.2-tinyedge.1'
const runtimeIntegrity = 'sha512-VGlue='

function fixtures() {
  const manifest = {
    name: '@tinyedge/cli',
    version: '0.1.2',
    license: 'Apache-2.0',
    dependencies: {
      [runtimeName]: runtimeVersion,
    },
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
