// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { checkDesktopManifest } from '../scripts/check-desktop-boundary.mjs'

const current = JSON.parse(await readFile(new URL('../packages/desktop/package.json', import.meta.url), 'utf8'))

test('desktop development remains private, unreleased and separate from the npm product', () => {
  checkDesktopManifest(current)
})

test('desktop boundary rejects publication, installers and unreviewed dependency changes', () => {
  const changes = [
    (manifest) => { manifest.private = false },
    (manifest) => { manifest.version = '0.2.6' },
    (manifest) => { manifest.publishConfig = { access: 'public' } },
    (manifest) => { manifest.scripts.postinstall = 'node install.js' },
    (manifest) => { manifest.scripts.build = 'electron-builder' },
    (manifest) => { manifest.scripts.start = 'npm publish' },
    (manifest) => { manifest.devDependencies.electron = '^44.2.0' },
    (manifest) => { manifest.dependencies = { unreviewed: '1.0.0' } },
  ]
  for (const change of changes) {
    const manifest = structuredClone(current)
    change(manifest)
    assert.throws(() => checkDesktopManifest(manifest))
  }
})
