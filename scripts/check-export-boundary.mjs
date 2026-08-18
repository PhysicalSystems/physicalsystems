#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedRepository = 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git'
const expectedBugs = 'https://github.com/TinyEdgeAI/tinyedge-edge/issues'
const tinyedgePackageFiles = [
  'packages/cli/package.json',
  'packages/npx/package.json',
  'packages/pi/package.json',
]
const runtimePackageFile = 'packages/pi-runtime/package.json'
const apacheLicenseTemplate = readFileSync(path.join(root, 'scripts/legal/templates/Apache-2.0.txt'))
const noticeTemplate = readFileSync(path.join(root, 'scripts/legal/templates/NOTICE.txt'))
const runtimeNoticeTemplate = readFileSync(path.join(root, 'scripts/legal/templates/NOTICE.pi-runtime.txt'))
const thirdPartyNoticesTemplate = readFileSync(path.join(root, 'scripts/legal/templates/THIRD_PARTY_NOTICES.md'))
const trademarkPolicyTemplate = readFileSync(path.join(root, 'scripts/legal/templates/TRADEMARKS.md'))
const allowedTopLevel = new Set([
  '.git',
  '.gitattributes',
  '.github',
  '.gitignore',
  'AGENTS.md',
  'BOUNDARY.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'DCO',
  'DEVELOPMENT.md',
  'DEPENDENCIES.md',
  'EXPORT-PROVENANCE.json',
  'LICENSE',
  'LICENSE-PENDING.md',
  'NPM-RELEASE-PENDING.md',
  'NOTICE',
  'README.md',
  'SBOM.cdx.json',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'TRADEMARKS.md',
  'package.json',
  'packages',
  'scripts',
  'test',
])
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'release-artifacts',
  'verification-evidence',
])
const forbiddenFile = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$)|\.(?:key|pem|p12|pfx|sqlite|tgz|zip)$/i

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(absolute, files)
    else files.push(absolute)
  }
  return files
}

function isHashVerifiedUpstreamRuntimePayload(relative) {
  return relative === 'packages/pi-runtime/CHANGELOG.md'
    || relative === 'packages/pi-runtime/UPSTREAM_README.md'
    || relative.startsWith('packages/pi-runtime/dist/')
    || relative.startsWith('packages/pi-runtime/docs/')
}

for (const entry of readdirSync(root, { withFileTypes: true })) {
  assert.ok(allowedTopLevel.has(entry.name), 'unexpected top-level export entry: ' + entry.name)
}

assert.deepEqual(
  readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
  ['cli', 'npx', 'pi', 'pi-runtime'],
  'the clean export must contain only the four reviewed npm package directories',
)

const licensePending = existsSync(path.join(root, 'LICENSE-PENDING.md'))
const npmReleasePending = existsSync(path.join(root, 'NPM-RELEASE-PENDING.md'))
assert.ok(
  !licensePending || npmReleasePending,
  'LICENSE-PENDING.md must retain the separate NPM-RELEASE-PENDING.md publication lock',
)
if (licensePending) {
  assert.ok(
    !existsSync(path.join(root, 'LICENSE')),
    'the source-license lock must not coexist with a live root LICENSE',
  )
}
const workspaceManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(workspaceManifest.private, true, 'workspace package must remain private')
assert.equal(workspaceManifest.repository?.url, expectedRepository, 'workspace repository identity')
assert.equal(workspaceManifest.bugs?.url, expectedBugs, 'workspace issue tracker identity')
assert.equal(
  workspaceManifest.homepage,
  'https://github.com/TinyEdgeAI/tinyedge-edge#readme',
  'workspace homepage identity',
)
assert.equal(
  workspaceManifest.license,
  licensePending ? 'UNLICENSED' : 'Apache-2.0',
  'workspace package license must match the source-license state',
)
for (const packageFile of [...tinyedgePackageFiles, runtimePackageFile]) {
  const manifest = JSON.parse(readFileSync(path.join(root, packageFile), 'utf8'))
  assert.equal(manifest.repository?.url, expectedRepository, packageFile + ' repository identity')
  assert.equal(manifest.bugs?.url, expectedBugs, packageFile + ' issue tracker identity')
  assert.match(
    manifest.homepage || '',
    /^https:\/\/github\.com\/TinyEdgeAI\/tinyedge-edge(?:\/tree\/main\/packages\/[^#]+)?#readme$/,
    packageFile + ' homepage identity',
  )
}
for (const packageFile of tinyedgePackageFiles) {
  const manifest = JSON.parse(readFileSync(path.join(root, packageFile), 'utf8'))
  if (licensePending) {
    assert.equal(manifest.license, 'UNLICENSED', packageFile + ' must remain unlicensed while licensing is pending')
    assert.ok(
      !existsSync(path.join(root, path.dirname(packageFile), 'LICENSE')),
      packageFile + ' must not have a live TinyEdge-authored LICENSE while licensing is pending',
    )
    assert.ok(
      !manifest.files?.includes('LICENSE'),
      packageFile + ' must not pack a TinyEdge-authored LICENSE while licensing is pending',
    )
  } else {
    assert.equal(manifest.license, 'Apache-2.0', packageFile + ' must use the approved release license')
    for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']) {
      assert.ok(manifest.files?.includes(legalFile), packageFile + ' must pack ' + legalFile)
      assert.ok(existsSync(path.join(root, path.dirname(packageFile), legalFile)), packageFile + ' is missing ' + legalFile)
    }
    assert.deepEqual(
      readFileSync(path.join(root, path.dirname(packageFile), 'LICENSE')),
      apacheLicenseTemplate,
      packageFile + ' LICENSE must match the reviewed Apache-2.0 template exactly',
    )
    assert.deepEqual(
      readFileSync(path.join(root, path.dirname(packageFile), 'NOTICE')),
      noticeTemplate,
      packageFile + ' NOTICE must match the reviewed founder notice exactly',
    )
    assert.deepEqual(
      readFileSync(path.join(root, path.dirname(packageFile), 'THIRD_PARTY_NOTICES.md')),
      thirdPartyNoticesTemplate,
      packageFile + ' third-party notices must match the reviewed evidence bundle exactly',
    )
  }
  if (npmReleasePending) {
    assert.equal(manifest.private, true, packageFile + ' must remain private while npm publication is pending')
  } else {
    assert.notEqual(manifest.private, true, packageFile + ' must be publishable only after npm approval')
  }
}
const runtimeManifest = JSON.parse(readFileSync(path.join(root, runtimePackageFile), 'utf8'))
assert.equal(runtimeManifest.license, 'MIT', runtimePackageFile + ' must preserve the upstream MIT license')
if (npmReleasePending) {
  assert.equal(runtimeManifest.private, true, runtimePackageFile + ' must remain private while npm publication is pending')
} else {
  assert.notEqual(runtimeManifest.private, true, runtimePackageFile + ' must be publishable only after npm approval')
}
for (const legalFile of ['LICENSE', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM_README.md']) {
  assert.ok(runtimeManifest.files?.includes(legalFile), runtimePackageFile + ' must pack ' + legalFile)
  assert.ok(existsSync(path.join(root, 'packages/pi-runtime', legalFile)), runtimePackageFile + ' is missing ' + legalFile)
}

if (!licensePending) {
  for (const legalFile of ['NOTICE', 'SBOM.cdx.json']) {
    assert.ok(runtimeManifest.files?.includes(legalFile), runtimePackageFile + ' must pack ' + legalFile)
    assert.ok(existsSync(path.join(root, 'packages/pi-runtime', legalFile)), runtimePackageFile + ' is missing ' + legalFile)
  }
  assert.deepEqual(
    readFileSync(path.join(root, 'packages/pi-runtime/NOTICE')),
    runtimeNoticeTemplate,
    runtimePackageFile + ' NOTICE must match the separately scoped reviewed runtime notice exactly',
  )
  assert.deepEqual(
    readFileSync(path.join(root, 'packages/pi-runtime/THIRD_PARTY_NOTICES.md')),
    thirdPartyNoticesTemplate,
    runtimePackageFile + ' third-party notices must match the reviewed evidence bundle exactly',
  )
}

if (!licensePending) {
  for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json', 'TRADEMARKS.md']) {
    assert.ok(existsSync(path.join(root, legalFile)), 'approved release is missing root ' + legalFile)
  }
  assert.deepEqual(
    readFileSync(path.join(root, 'LICENSE')),
    apacheLicenseTemplate,
    'root LICENSE must match the reviewed Apache-2.0 template exactly',
  )
  assert.deepEqual(
    readFileSync(path.join(root, 'NOTICE')),
    noticeTemplate,
    'root NOTICE must match the reviewed founder notice exactly',
  )
  assert.deepEqual(
    readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md')),
    thirdPartyNoticesTemplate,
    'root third-party notices must match the reviewed evidence bundle exactly',
  )
  assert.deepEqual(
    readFileSync(path.join(root, 'TRADEMARKS.md')),
    trademarkPolicyTemplate,
    'root trademark policy must match the reviewed policy exactly',
  )
}

const provenance = JSON.parse(readFileSync(path.join(root, 'EXPORT-PROVENANCE.json'), 'utf8'))
assert.equal(provenance.schemaVersion, 2)
assert.equal(provenance.exportKind, 'public-clean-root-snapshot')
assert.equal(provenance.source, undefined, 'public provenance must not disclose the private source record')
assert.equal(provenance.destination?.repository, 'https://github.com/TinyEdgeAI/tinyedge-edge.git')
assert.equal(provenance.destination?.status, 'public-canonical')
for (const forbiddenField of ['branchAtExport', 'sourceCommitTimestamp', 'gitObject']) {
  assert.ok(
    !JSON.stringify(provenance).includes(forbiddenField),
    'public provenance must not contain private export field ' + forbiddenField,
  )
}

const payloadFiles = collectFiles(root)
  .filter((absolute) => path.relative(root, absolute).replaceAll('\\', '/') !== 'EXPORT-PROVENANCE.json')
  .sort((left, right) => {
    const leftPath = path.relative(root, left).replaceAll('\\', '/')
    const rightPath = path.relative(root, right).replaceAll('\\', '/')
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
const payloadIndex = payloadFiles.map((absolute) => {
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const raw = readFileSync(absolute)
  const canonical = raw.includes(0)
    ? raw
    : Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
  const digest = createHash('sha256').update(canonical).digest('hex')
  return digest + '  ' + relative + '\n'
}).join('')
const payloadDigest = createHash('sha256').update(payloadIndex, 'utf8').digest('hex')
assert.equal(provenance.candidatePayload?.fileCount, payloadFiles.length)
assert.equal(provenance.candidatePayload?.sha256, payloadDigest)

for (const absolute of collectFiles(root)) {
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  assert.doesNotMatch(relative, forbiddenFile, 'forbidden export file: ' + relative)
  const buffer = readFileSync(absolute)
  if (buffer.includes(0)) continue
  const text = buffer.toString('utf8')
  if (!isHashVerifiedUpstreamRuntimePayload(relative)) {
    assert.doesNotMatch(text, /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/[^/]+\/)/, 'local user path leaked by ' + relative)
  }
}

for (const governanceFile of [
  '.github/CODEOWNERS',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'DCO',
  'SUPPORT.md',
]) {
  assert.ok(existsSync(path.join(root, governanceFile)), 'public repository is missing ' + governanceFile)
}

console.log('Verified public TinyEdge edge-client source boundary')
