#!/usr/bin/env node

// Publication gate only. Source tests and review-candidate packaging deliberately
// remain possible before separately approved Node artifacts exist. This checks
// bundled metadata and raw file hashes; it never downloads or installs artifacts.
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNodeInstallManifest } from '../packages/cli/src/physical/node-installation.js'

const sourceDirectory = fileURLToPath(new URL('../packages/cli/src/physical/', import.meta.url))
const maximumIndexBytes = 128 * 1024
const requiredSelectors = ['linux-x64:3.10', 'linux-x64:3.12']
const productSelectors = ['linux-x64:3.10', 'linux-x64:3.11', 'linux-x64:3.12',
  'win32-x64:3.10', 'win32-x64:3.11', 'win32-x64:3.12']
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

async function boundedIndex(filename) {
  const before = await fs.lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumIndexBytes) {
    throw new Error('Node release index must be a bounded regular file')
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) {
      throw new Error('Node release index changed while opening')
    }
    const buffer = Buffer.alloc(maximumIndexBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maximumIndexBytes || bytesRead !== opened.size) throw new Error('Node release index exceeded its bound or changed')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}

function rejectPlaceholderHost(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || isIP(host.replace(/^\[|\]$/g, ''))
    || /(^|\.)(invalid|test|example|localhost)(\.|$)/.test(host)) {
    throw new Error('Bundled Node artifact URLs must not use placeholder or local hosts')
  }
}

export async function checkBundledNodeReleaseIndex(directory = sourceDirectory, { expectedRelease, expectedSelectors = productSelectors } = {}) {
  directory = path.resolve(directory)
  if (normalized(await fs.realpath(directory)) !== normalized(directory)) throw new Error('Bundled Node metadata directory must not use links')
  const index = await boundedIndex(path.join(directory, 'node-releases.json'))
  if (!exact(index, ['contractVersion', 'releases']) || index.contractVersion !== 'physicalsystems-node-index-v1'
    || !Array.isArray(index.releases) || index.releases.length < 1 || index.releases.length > 12) {
    throw new Error('npm publication requires a nonempty bounded bundled Node release index')
  }
  const selectors = new Set(), filenames = new Set()
  for (const entry of index.releases) {
    if (!exact(entry, ['platform', 'python', 'manifest', 'sha256'])
      || !['linux-x64', 'win32-x64', 'win32-arm64'].includes(entry.platform)
      || typeof entry.python !== 'string' || !/^3\.(10|11|12|13)$/.test(entry.python)
      || typeof entry.manifest !== 'string' || entry.manifest.length > 128 || !/^[a-z0-9-]+\.json$/.test(entry.manifest)
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Invalid bundled Node release index entry')
    }
    const selector = `${entry.platform}:${entry.python}`
    if (selectors.has(selector) || filenames.has(entry.manifest)) throw new Error('Duplicate bundled Node selector or manifest filename')
    selectors.add(selector); filenames.add(entry.manifest)
  }
  if (requiredSelectors.some((selector) => !selectors.has(selector))) {
    throw new Error('npm publication requires bundled linux-x64 Node manifests for Python 3.10 and 3.12')
  }
  const manifestsDirectory = path.join(directory, 'node-releases')
  if (normalized(await fs.realpath(manifestsDirectory)) !== normalized(manifestsDirectory)) {
    throw new Error('Bundled Node manifests directory must not use links')
  }
  for (const entry of index.releases) {
    const { manifest } = await readNodeInstallManifest(path.join(manifestsDirectory, entry.manifest), entry.sha256)
    if (manifest.platform !== entry.platform || manifest.python !== entry.python) {
      throw new Error('Bundled Node index selector does not match its hashed manifest')
    }
    if (expectedRelease && manifest.release !== expectedRelease) {
      throw new Error(`npm publication requires Node ${expectedRelease} for every bundled selector`)
    }
    for (const artifact of manifest.artifacts) rejectPlaceholderHost(artifact.url)
  }
  if (expectedRelease && JSON.stringify([...selectors].sort()) !== JSON.stringify([...expectedSelectors].sort())) {
    throw new Error(`Node ${expectedRelease} publication requires exactly all six approved Windows/Linux x64 Python 3.10–3.12 selectors`)
  }
  return { entries: index.releases.length, selectors: [...selectors].sort() }
}

if (process.argv[1] && normalized(process.argv[1]) === normalized(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) throw new Error('The publication gate accepts no index override')
    // Keep this entry point independent of release-plan.mjs: that module uses
    // this checker, so importing it during top-level CLI evaluation deadlocks.
    // The following coordinated check performs full descriptor validation.
    const release = await boundedIndex(fileURLToPath(new URL('../release/product.json', import.meta.url)))
    if (release.contractVersion !== 'physicalsystems-product-release-v1'
      || typeof release.components?.node?.version !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(release.components.node.version)
      || JSON.stringify(release.selectors) !== JSON.stringify(productSelectors)) {
      throw new Error('Product descriptor must identify an exact Node version and the approved selectors')
    }
    const result = await checkBundledNodeReleaseIndex(sourceDirectory, {
      expectedRelease: release.components.node.version, expectedSelectors: release.selectors,
    })
    console.log(`Bundled Node release metadata verified: ${result.entries} entries; no artifacts downloaded`)
  } catch (error) {
    console.error(`Node publication gate failed: ${error.message}`)
    process.exitCode = 1
  }
}
