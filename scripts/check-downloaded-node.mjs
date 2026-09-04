#!/usr/bin/env node
// Native software-only canary. Load the installer and pinned selector from the
// installed npm package, download only that selector's exact wheel closure,
// then prove verified reuse. No Node server, discovery, camera or motor starts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkBundledNodeReleaseIndex } from './check-node-release-index.mjs'
import { readProductRelease } from './release-plan.mjs'

async function assertNoEmbeddedWheels(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert.doesNotMatch(entry.name, /\.whl$/i, 'Downloadable mode must not embed Python wheels anywhere in the npm package')
    // Do not follow directory links out of the installed package.
    if (entry.isDirectory()) await assertNoEmbeddedWheels(path.join(directory, entry.name))
  }
}

export async function checkDownloadableNodePackage(packageDirectory) {
  assert.ok(packageDirectory && path.isAbsolute(packageDirectory), 'Provide the absolute installed npm package directory')
  const metadata = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
  assert.equal(metadata.name, 'physicalsystems')
  assert.equal(Object.hasOwn(metadata, 'physicalsystemsNodeBundle'), false, 'Downloadable mode must not declare an embedded backend bundle')
  await assert.rejects(fs.lstat(path.join(packageDirectory, 'node-bundle')), { code: 'ENOENT' }, 'Downloadable mode must not contain an embedded backend bundle')
  await assertNoEmbeddedWheels(packageDirectory)
  const product = await readProductRelease()
  assert.equal(metadata.version, product.product.version)
  const index = await checkBundledNodeReleaseIndex(path.join(packageDirectory, 'src/physical'), {
    expectedRelease: product.components.node.version, expectedSelectors: product.selectors,
  })
  return { metadata, index }
}

export function createDownloadRecorder(artifacts, fetchImpl = fetch) {
  const expected = new Map(artifacts.map((artifact) => [artifact.url, artifact]))
  assert.equal(expected.size, artifacts.length, 'Selected manifest must identify distinct download URLs')
  const records = []
  return {
    records,
    async fetchImpl(url, options) {
      assert.ok(expected.has(url), 'Installer requested a URL outside the selected manifest')
      assert.equal(records.some((item) => item.url === url), false, 'Installer downloaded a selected wheel more than once')
      assert.equal(options.redirect, 'error', 'Installer must reject download redirects')
      assert.equal(options.credentials, 'omit', 'Wheel fetch must omit credentials')
      const artifact = expected.get(url)
      const response = await fetchImpl(url, options)
      assert.ok(response.ok && response.body, 'Selected wheel download must succeed')
      assert.ok(!response.url || response.url === url, 'Selected wheel response changed origin or path')
      const record = { url, status: response.status, bytes: 0, sha256: null }
      records.push(record)
      const body = (async function* () {
        const digest = createHash('sha256')
        for await (const chunk of response.body) {
          record.bytes += chunk.length
          assert.ok(record.bytes <= artifact.bytes, 'Selected wheel exceeded its approved byte count')
          digest.update(chunk)
          yield chunk
        }
        record.sha256 = digest.digest('hex')
        assert.equal(record.bytes, artifact.bytes, 'Selected wheel download has the wrong byte count')
        assert.equal(record.sha256, artifact.sha256, 'Selected wheel download has the wrong SHA-256')
      })()
      return { ok: response.ok, status: response.status, url: response.url, headers: response.headers, body }
    },
  }
}

export async function checkDownloadedNode(packageDirectory, { python, onProgress = console.log } = {}) {
  const { metadata, index } = await checkDownloadableNodePackage(packageDirectory)
  const implementation = await import(pathToFileURL(path.join(packageDirectory, 'src/physical/node-installation.js')))
  const release = await implementation.bundledNodeRelease({ packageDirectory, python })
  assert.ok(release, 'Installed product must select an approved downloadable backend')
  assert.equal(release.wheelhouse, undefined, 'Downloadable canary must not use an offline wheelhouse')
  const product = await readProductRelease()
  assert.equal(release.manifest.release, product.components.node.version)
  assert.equal(release.manifest.runtimeVersion, product.components.runtime.version)
  assert.equal(release.manifest.platform, `${process.platform}-${process.arch}`)
  const recorder = createDownloadRecorder(release.manifest.artifacts)
  const expectedBytes = release.manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0)
  const base = await fs.realpath(tmpdir()), configDir = await fs.mkdtemp(path.join(base, 'ps-dc-'))
  let consents = 0
  try {
    const options = { ...release, configDir, python, fetchImpl: recorder.fetchImpl, onProgress,
      authorize: async (details) => {
        assert.deepEqual(details, { release: product.components.node.version, bytes: expectedBytes })
        assert.equal(++consents, 1, 'First installation must ask for software consent exactly once')
        return true
      } }
    const result = await implementation.installManagedNode(options)
    assert.equal(result.reused, false)
    assert.equal(result.digest, release.digest)
    assert.equal(consents, 1)
    assert.deepEqual(recorder.records.map(({ url }) => url), release.manifest.artifacts.map(({ url }) => url))
    assert.equal(recorder.records.reduce((sum, item) => sum + item.bytes, 0), expectedBytes)
    const reused = await implementation.installManagedNode({ ...options,
      fetchImpl() { assert.fail('Verified reuse must not download any wheel') },
      authorize() { assert.fail('Verified reuse must not ask for installation consent') } })
    assert.equal(reused.reused, true)
    assert.equal(reused.digest, result.digest)
    assert.equal(reused.executable, result.executable)
    return { result: 'passed', proof: 'downloadable-backend-installation', product: metadata.version,
      node: result.release, runtime: release.manifest.runtimeVersion,
      platform: release.manifest.platform, python: release.manifest.python,
      manifestDigest: result.digest, checkedSelectors: index.selectors,
      downloads: recorder.records, downloadCount: recorder.records.length, downloadBytes: expectedBytes,
      firstInstallConsents: consents, reused: true, reuseDownloads: 0, reuseConsents: 0,
      offlineBackend: false, hardwareAccess: false }
  } finally {
    assert.equal(path.dirname(configDir), base)
    assert.ok(path.basename(configDir).startsWith('ps-dc-'))
    assert.equal(await fs.realpath(configDir), configDir)
    await fs.rm(configDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [packageDirectory, python, ...extra] = process.argv.slice(2)
  assert.ok(packageDirectory && !extra.length, 'Usage: check-downloaded-node.mjs ABSOLUTE_INSTALLED_PACKAGE_ROOT [ABSOLUTE_PYTHON_EXECUTABLE]')
  console.log(JSON.stringify(await checkDownloadedNode(packageDirectory, { python })))
}
