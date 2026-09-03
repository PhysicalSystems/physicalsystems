#!/usr/bin/env node
// Software-only canary. Import from the installed npm package, prohibit all
// wheel downloads, and use a fresh isolated environment. No Node server,
// camera access, device discovery or motor command is started here.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const [packageDirectory, python, ...extra] = process.argv.slice(2)
assert.ok(packageDirectory && path.isAbsolute(packageDirectory) && !extra.length, 'Provide the absolute installed npm package directory [absolute Python executable]')
const metadata = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
assert.equal(metadata.name, 'physicalsystems')
assert.equal(metadata.physicalsystemsNodeBundle, 'node-bundle')
const implementation = await import(pathToFileURL(path.join(packageDirectory, 'src/physical/node-installation.js')))
const release = await implementation.bundledNodeRelease({ packageDirectory, python })
assert.ok(release.wheelhouse)
const base = await fs.realpath(tmpdir()), configDir = await fs.mkdtemp(path.join(base, 'ps-bc-'))
try {
  const options = { ...release, configDir, python, authorize: async () => true,
    fetchImpl() { assert.fail('Bundled Node installation attempted a network download') }, onProgress: console.log }
  const result = await implementation.installManagedNode(options)
  assert.equal(result.reused, false)
  const reused = await implementation.installManagedNode({ ...options, authorize() { assert.fail('Verified reuse must not reinstall') } })
  assert.equal(reused.reused, true)
  console.log(JSON.stringify({ result: 'passed', product: metadata.version, node: result.release,
    platform: `${process.platform}-${process.arch}`, python: release.manifest.python,
    manifestDigest: result.digest, downloads: 0, reused: reused.reused, hardwareAccess: false }))
} finally {
  assert.equal(path.dirname(configDir), base)
  assert.ok(path.basename(configDir).startsWith('ps-bc-'))
  assert.equal(await fs.realpath(configDir), configDir)
  await fs.rm(configDir, { recursive: true, force: true })
}
