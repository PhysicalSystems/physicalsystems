#!/usr/bin/env node
// Local metadata planning only. No subprocesses, registry requests, private
// exports, artifact writes, installation, hardware access or publishing.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundledNodeReleaseIndex } from './check-node-release-index.mjs'
import { readInstallationFile, readNodeInstallManifest } from '../packages/cli/src/physical/node-installation.js'

const defaultRoot = fileURLToPath(new URL('../', import.meta.url))
const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const SELECTORS = ['linux-x64:3.10', 'linux-x64:3.11', 'linux-x64:3.12',
  'win32-x64:3.10', 'win32-x64:3.11', 'win32-x64:3.12']
const METADATA_LIMIT = 128 * 1024
const LOCK_LIMIT = 8 * 1024 * 1024
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)

function exact(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unexpected fields`)
}

function version(value, label) {
  assert.ok(typeof value === 'string' && value.length <= 64 && VERSION.test(value), `${label} must be an exact version, not a range or tag`)
}

export function validateProductRelease(value) {
  exact(value, ['contractVersion', 'product', 'components', 'backendIndexSha256', 'selectors', 'toolchain', 'previousTags'], 'Product release')
  assert.equal(value.contractVersion, 'physicalsystems-product-release-v1', 'Unsupported product release contract')
  exact(value.product, ['name', 'version'], 'Product')
  assert.equal(value.product.name, 'physicalsystems', 'Product identity must remain physicalsystems')
  version(value.product.version, 'Product version')
  exact(value.components, ['node', 'runtime', 'piRuntime'], 'Components')
  for (const [key, distribution] of [['node', 'physicalsystems-node'], ['runtime', 'tinyedge-runtime']]) {
    const component = value.components[key]
    exact(component, ['distribution', 'version', 'wheelSha256'], key)
    assert.equal(component.distribution, distribution, `${key} distribution identity must not change`)
    version(component.version, `${key} version`)
    assert.ok(typeof component.wheelSha256 === 'string' && SHA256.test(component.wheelSha256), `${key} requires an exact wheel SHA-256`)
  }
  exact(value.components.piRuntime, ['name', 'version'], 'Pi compatibility runtime')
  assert.equal(value.components.piRuntime.name, '@tinyedge/pi-runtime', 'Pi compatibility runtime identity must not change')
  version(value.components.piRuntime.version, 'Pi compatibility runtime version')
  assert.ok(typeof value.backendIndexSha256 === 'string' && SHA256.test(value.backendIndexSha256), 'Backend index requires an exact SHA-256')
  assert.deepEqual(value.selectors, SELECTORS, 'Product requires the exact sorted six backend selectors')
  exact(value.toolchain, ['node', 'npm', 'consumerNode', 'consumerNpm'], 'Toolchain')
  for (const [key, value_] of Object.entries(value.toolchain)) version(value_, `Toolchain ${key}`)
  exact(value.previousTags, ['bootstrap', 'latest', 'preview'], 'Previous npm tags')
  for (const [key, value_] of Object.entries(value.previousTags)) version(value_, `Previous ${key} tag`)
  assert.equal(value.previousTags.bootstrap, '0.0.0', 'Bootstrap must retain its inert version')
  assert.equal(value.previousTags.latest, '0.0.0', 'Preview release must not move latest')
  return structuredClone(value)
}

function parseJson(bytes, label) {
  let value, text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text) }
  catch { throw new Error(`${label} must be valid UTF-8 JSON`) }
  // JSON.parse validates the grammar; token scanning additionally refuses
  // duplicate object keys, including differently escaped spellings.
  const stack = []
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    if (token[0] === '{') stack.push(new Set())
    else if (token[0] === '[') stack.push(null)
    else if (token[0] === '}' || token[0] === ']') stack.pop()
    else if (/^\s*:/.test(text.slice(token.index + token[0].length))) {
      const key = JSON.parse(token[0]), keys = stack.at(-1)
      assert.ok(keys && !keys.has(key), `${label} must not contain duplicate JSON keys`)
      keys.add(key)
    }
  }
  return value
}

async function checkedRoot(sourceRoot) {
  assert.ok(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot), 'Source root must be absolute')
  try { return await fs.realpath(sourceRoot) }
  catch { throw new Error('Source root is unavailable') }
}

async function readMetadata(root, relative, maximum = METADATA_LIMIT) {
  const filename = path.join(root, relative)
  try {
    assert.ok(normalized(await fs.realpath(filename)) === normalized(filename), 'Metadata must not cross linked paths')
    const bytes = await readInstallationFile(filename, maximum)
    return { bytes, value: parseJson(bytes, relative) }
  } catch (error) {
    // Do not expose machine-specific paths or raw file contents in plan errors.
    if (error.code && !error.code.startsWith('ERR_ASSERTION')) throw new Error(`Cannot read bounded regular ${relative}`)
    throw error
  }
}

export async function readProductRelease(sourceRoot = defaultRoot) {
  const root = await checkedRoot(sourceRoot)
  return validateProductRelease((await readMetadata(root, 'release/product.json')).value)
}

export async function createReleasePlan(sourceRoot = defaultRoot) {
  const root = await checkedRoot(sourceRoot)
  const descriptor = await readProductRelease(root)
  const { product, components } = descriptor
  const physical = 'packages/cli/src/physical'
  const productMetadata = await readMetadata(root, 'packages/cli/package.json')
  const productPackage = productMetadata.value
  const lock = await readMetadata(root, 'packages/cli/package-lock.json', LOCK_LIMIT)
  const shrinkwrap = await readMetadata(root, 'packages/cli/npm-shrinkwrap.json', LOCK_LIMIT)
  const piMetadata = await readMetadata(root, 'packages/pi-runtime/package.json')
  const piPackage = piMetadata.value
  assert.equal(productPackage.name, product.name, 'Product package identity disagrees with descriptor')
  assert.equal(productPackage.version, product.version, 'Product package version disagrees with descriptor')
  assert.equal(productPackage.dependencies?.[components.piRuntime.name], components.piRuntime.version, 'Product must pin the exact Pi compatibility runtime')
  assert.ok(lock.bytes.equals(shrinkwrap.bytes), 'Product package-lock and shrinkwrap must be byte-identical')
  for (const metadata of [lock.value, shrinkwrap.value]) {
    assert.equal(metadata.name, product.name, 'Lock package identity disagrees with descriptor')
    assert.equal(metadata.version, product.version, 'Lock package version disagrees with descriptor')
    assert.equal(metadata.packages?.['']?.name, product.name, 'Lock root identity disagrees with descriptor')
    assert.equal(metadata.packages?.['']?.version, product.version, 'Lock root version disagrees with descriptor')
    assert.equal(metadata.packages?.['']?.dependencies?.[components.piRuntime.name], components.piRuntime.version, 'Lock must pin the exact Pi compatibility runtime')
    assert.equal(metadata.packages?.[`node_modules/${components.piRuntime.name}`]?.version, components.piRuntime.version, 'Locked Pi installation version disagrees with descriptor')
  }
  assert.equal(piPackage.name, components.piRuntime.name, 'Pi package identity disagrees with descriptor')
  assert.equal(piPackage.version, components.piRuntime.version, 'Pi package version disagrees with descriptor')
  const index = await readMetadata(root, `${physical}/node-releases.json`)
  assert.equal(sha256(index.bytes), descriptor.backendIndexSha256, 'Backend index differs from the pinned release descriptor')
  const checked = await checkBundledNodeReleaseIndex(path.join(root, physical), {
    expectedRelease: components.node.version, expectedSelectors: descriptor.selectors,
  })
  assert.deepEqual(checked.selectors, descriptor.selectors, 'Backend coverage disagrees with descriptor')
  const artifacts = new Map(), common = new Map(), dependencyVersions = new Map(), manifests = []
  const expectedNames = ['numpy', 'opencv-python-headless', components.node.distribution, components.runtime.distribution].sort()
  for (const entry of index.value.releases) {
    const filename = path.join(root, physical, 'node-releases', entry.manifest)
    const { manifest } = await readNodeInstallManifest(filename, entry.sha256)
    assert.equal(manifest.release, components.node.version, 'Node manifest release disagrees with descriptor')
    assert.equal(manifest.runtimeVersion, components.runtime.version, 'Runtime manifest release disagrees with descriptor')
    assert.equal(`${manifest.platform}:${manifest.python}`, `${entry.platform}:${entry.python}`, 'Manifest selector changed during planning')
    assert.deepEqual(manifest.artifacts.map(({ name }) => name).sort(), expectedNames, 'Backend must retain the reviewed four-distribution closure')
    manifests.push({ selector: `${entry.platform}:${entry.python}`, sha256: entry.sha256 })
    for (const artifact of manifest.artifacts) {
      const url = new URL(artifact.url)
      assert.equal(url.hostname, 'files.pythonhosted.org', 'Backend pins must use the approved public wheel origin')
      const previous = artifacts.get(artifact.filename)
      if (previous) assert.deepEqual(artifact, previous, 'A repeated wheel filename has conflicting immutable identity')
      else artifacts.set(artifact.filename, artifact)
      const previousVersion = dependencyVersions.get(artifact.name)
      if (previousVersion) assert.equal(artifact.version, previousVersion, 'Backend distribution versions must agree across selectors')
      dependencyVersions.set(artifact.name, artifact.version)
      for (const component of [components.node, components.runtime]) {
        if (artifact.name !== component.distribution) continue
        assert.equal(artifact.version, component.version, 'Backend artifact version disagrees with descriptor')
        assert.equal(artifact.sha256, component.wheelSha256, 'Backend wheel differs from its immutable descriptor pin')
        assert.equal(artifact.filename, `${component.distribution.replaceAll('-', '_')}-${component.version}-py3-none-any.whl`, 'Backend must retain its exact pure-Python wheel filename')
        if (common.has(artifact.name)) assert.deepEqual(artifact, common.get(artifact.name), 'Node and Runtime wheel identity must agree across every selector')
        common.set(artifact.name, artifact)
      }
    }
  }
  assert.equal(artifacts.size, 10, 'Product must retain exactly ten distinct backend wheels')
  // Recheck the exact index after reading its manifests; a concurrent edit must
  // never produce a plan combining two different reviewed selections.
  assert.ok(index.bytes.equals((await readMetadata(root, `${physical}/node-releases.json`)).bytes), 'Backend index changed during planning')
  manifests.sort((a, b) => a.selector.localeCompare(b.selector, 'en'))
  const manifestDigest = sha256(canonical(manifests))
  // This detects package metadata drift, not arbitrary source-code changes.
  // Source-commit and exact candidate-archive evidence remain separate gates.
  const packageMetadataSha256 = { product: sha256(productMetadata.bytes), lock: sha256(lock.bytes),
    shrinkwrap: sha256(shrinkwrap.bytes), piRuntime: sha256(piMetadata.bytes) }
  const planDigest = sha256(canonical({ descriptor, indexSha256: sha256(index.bytes), manifests, packageMetadataSha256 }))
  return {
    contractVersion: 'physicalsystems-release-plan-v1',
    product, components,
    backend: { action: 'reuse-pinned-artifacts', selectors: checked.selectors, artifactCount: artifacts.size, manifestDigest },
    planDigest,
    publicationAuthorized: false,
    installationQualified: false,
    pendingSteps: [
      'Prepare one size-checked Harness candidate from the reviewed source; reuse the exact pinned Pi compatibility runtime and backend artifacts.',
      'Qualify that exact candidate through the protected release workflow on all supported native npm 11/12 targets.',
      'Recheck registry state and obtain the existing human environment approval before the protected npm preview publisher runs.',
      'Only if changing backend artifacts: complete the separate reviewed Node export/Runtime release and update immutable pins; this planner never exports or publishes a backend.',
    ],
  }
}

if (process.argv[1] && normalized(process.argv[1]) === normalized(fileURLToPath(import.meta.url))) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/release-plan.mjs')
    console.log(JSON.stringify(await createReleasePlan(), null, 2))
  } catch (error) {
    console.error(`Release plan refused: ${error.message.split('\n')[0]}`)
    process.exitCode = 1
  }
}
