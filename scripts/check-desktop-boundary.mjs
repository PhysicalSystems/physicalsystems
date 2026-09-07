// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'

export function checkDesktopManifest(manifest) {
  assert.equal(manifest.name, '@physicalsystems/desktop-development', 'desktop development package identity')
  assert.equal(manifest.private, true, 'desktop development must remain private')
  assert.equal(manifest.version, '0.0.0', 'desktop development does not select a product release version')
  assert.equal(manifest.license, 'Apache-2.0', 'desktop client source preserves the project license')
  for (const field of ['publishConfig', 'bin', 'build']) assert.equal(manifest[field], undefined, 'desktop development must not add publication or installer configuration: ' + field)
  assert.deepEqual(Object.keys(manifest.dependencies || {}), [], 'desktop has no separately shipped runtime dependency closure')
  assert.deepEqual(manifest.devDependencies, { electron: '44.2.0' }, 'desktop development tooling must remain exactly pinned and reviewed')
  for (const [name, command] of Object.entries(manifest.scripts || {})) {
    assert.ok(['start', 'check', 'test'].includes(name), 'desktop lifecycle, publication and installer scripts require separate review: ' + name)
    assert.doesNotMatch(command, /(?:\b(?:publish|prepublish|electron-builder|electron-forge|make-installer)\b|\bnpm\s+pack\b)/i, 'desktop development scripts cannot package or publish an installer')
  }
}
