import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ALLOWED_LICENSE_IDS,
  APACHE_2_TEMPLATE,
  ARTIFACT_LICENSE_FILE_EVIDENCE,
  EXCLUDED_OPTIONAL_PEERS,
  EXCLUDED_PI_HOST_PEER,
  MISSING_LICENSE_FILE_OVERRIDES,
  NOTICE_TEMPLATE,
  PI_RUNTIME_LICENSE,
  PI_RUNTIME_NOTICE_TEMPLATE,
  PI_TUI_ARTIFACT,
  PI_TUI_NATIVE_FILES,
  SBOM_TARGET_KEYS,
  TARGETS,
  THIRD_PARTY_NOTICES_TEMPLATE,
  TRADEMARK_POLICY_TEMPLATE,
  VENDORED_COMPONENTS,
  WORKSPACE_TARGET,
  WRAPPER_TARGETS,
} from './reviewed-inventory.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptDir, '..', '..')
const allowedLicenses = new Set(ALLOWED_LICENSE_IDS)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeRelative(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length > 0, 'expected a non-empty relative path')
  assert(!path.isAbsolute(relativePath), `absolute path is not allowed in reviewed inventory: ${relativePath}`)
  const normalized = relativePath.replaceAll('\\', '/')
  assert(!normalized.split('/').includes('..'), `parent traversal is not allowed in reviewed inventory: ${relativePath}`)
  return normalized
}

function splitPackageName(name) {
  assert(typeof name === 'string' && name.length > 0, 'component name is required')
  if (!name.startsWith('@')) return { name }
  const separator = name.indexOf('/')
  assert(separator > 1 && separator < name.length - 1, `invalid scoped npm package name: ${name}`)
  return { group: name.slice(0, separator), name: name.slice(separator + 1) }
}

function encodePurlSegment(value) {
  return encodeURIComponent(value).replaceAll('%2F', '/')
}

function npmPurl(name, version) {
  const { group, name: unscopedName } = splitPackageName(name)
  const packagePath = group
    ? `${encodeURIComponent(group)}/${encodePurlSegment(unscopedName)}`
    : encodePurlSegment(unscopedName)
  return `pkg:npm/${packagePath}@${encodeURIComponent(version)}`
}

function inventoryPurl(component) {
  const base = component.purlType === 'npm'
    ? npmPurl(component.name, component.version)
    : `pkg:generic/${encodePurlSegment(component.name)}@${encodeURIComponent(component.version)}`
  if (!component.purlQualifier) return base
  const separator = component.purlQualifier.indexOf('=')
  assert(separator > 0, `invalid purl qualifier for ${component.name}`)
  const key = component.purlQualifier.slice(0, separator)
  const value = component.purlQualifier.slice(separator + 1)
  assert(/^[a-z][a-z0-9._-]*$/.test(key), `invalid purl qualifier key for ${component.name}`)
  return `${base}?${key}=${encodeURIComponent(value)}`
}

function parseIntegrity(integrity, label) {
  assert(typeof integrity === 'string', `${label} is missing integrity`)
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  assert(match, `${label} has invalid SRI integrity: ${integrity}`)
  const bytes = Buffer.from(match[2], 'base64')
  const expectedBytes = match[1] === 'sha512' ? 64 : 32
  assert(bytes.length === expectedBytes && bytes.toString('base64') === match[2], `${label} has non-canonical SRI integrity`)
  return {
    alg: match[1] === 'sha512' ? 'SHA-512' : 'SHA-256',
    content: bytes.toString('hex'),
  }
}

function integrityFromSha256(hex, label) {
  assert(/^[a-f0-9]{64}$/.test(hex), `${label} has invalid SHA-256`)
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`
}

function assertResolved(resolved, label, allowedOrigins = ['https://registry.npmjs.org']) {
  assert(typeof resolved === 'string' && resolved.length > 0, `${label} is missing resolved URL`)
  let url
  try {
    url = new URL(resolved)
  } catch {
    throw new Error(`${label} has invalid resolved URL: ${resolved}`)
  }
  assert(url.protocol === 'https:', `${label} resolved URL must use HTTPS: ${resolved}`)
  assert(allowedOrigins.includes(url.origin), `${label} resolved URL has unreviewed origin: ${url.origin}`)
}

function assertLicenses(licenseIds, label) {
  assert(Array.isArray(licenseIds) && licenseIds.length > 0, `${label} is missing license metadata`)
  for (const licenseId of licenseIds) {
    assert(allowedLicenses.has(licenseId), `${label} uses unapproved license ${licenseId}`)
  }
}

function licensesFor(licenseIds, expression) {
  assertLicenses(licenseIds, 'component')
  if (expression) return [{ expression }]
  return licenseIds.map((id) => ({ license: { id } }))
}

function properties(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value: String(value) }))
}

function packageNameFromPath(packagePath) {
  const marker = 'node_modules/'
  const index = packagePath.lastIndexOf(marker)
  assert(index >= 0, `invalid npm package path: ${packagePath}`)
  const tail = packagePath.slice(index + marker.length)
  const segments = tail.split('/')
  return tail.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function resolveDependencyPath(packages, packagePath, dependencyName) {
  let ancestor = packagePath
  while (true) {
    const candidate = ancestor
      ? `${ancestor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`
    if (Object.hasOwn(packages, candidate)) return candidate
    if (!ancestor) return undefined
    const nestedIndex = ancestor.lastIndexOf('/node_modules/')
    ancestor = nestedIndex >= 0 ? ancestor.slice(0, nestedIndex) : ''
  }
}

function componentRefForPackage(packagePath, metadata) {
  return npmPurl(packageNameFromPath(packagePath), metadata.version)
}

function dependencyNames(metadata) {
  return [...new Set([
    ...Object.keys(metadata.dependencies ?? {}),
    ...Object.keys(metadata.optionalDependencies ?? {}),
  ])].sort((left, right) => left.localeCompare(right))
}

function npmComponent(packagePath, metadata) {
  const name = packageNameFromPath(packagePath)
  const label = `${packagePath} (${name}@${metadata.version ?? 'missing-version'})`
  assert(typeof metadata.version === 'string' && metadata.version.length > 0, `${label} is missing version`)
  assertLicenses([metadata.license], label)
  assertResolved(metadata.resolved, label)
  const hash = parseIntegrity(metadata.integrity, label)
  const purl = npmPurl(name, metadata.version)
  const splitName = splitPackageName(name)
  return {
    type: 'library',
    'bom-ref': purl,
    ...(splitName.group ? { group: splitName.group } : {}),
    name: splitName.name,
    version: metadata.version,
    scope: metadata.optional === true ? 'optional' : 'required',
    hashes: [hash],
    licenses: licensesFor([metadata.license]),
    purl,
    externalReferences: [{
      type: 'distribution',
      url: metadata.resolved,
      hashes: [hash],
    }],
    properties: properties({
      'tinyedge:npm:integrity': metadata.integrity,
      'tinyedge:npm:package-path': packagePath,
      'tinyedge:npm:resolved': metadata.resolved,
    }),
  }
}

function inventoryComponent(component, kind) {
  assertLicenses(component.licenseIds, `${kind} ${component.name}`)
  assertResolved(component.resolved, `${kind} ${component.name}`, [
    'https://github.com',
    'https://registry.npmjs.org',
  ])
  const integrity = component.integrity ?? integrityFromSha256(component.sha256, `${kind} ${component.name}`)
  const hash = parseIntegrity(integrity, `${kind} ${component.name}`)
  const purl = inventoryPurl(component)
  const splitName = splitPackageName(component.name)
  return {
    type: kind === 'native-file' ? 'file' : 'library',
    'bom-ref': purl,
    ...(splitName.group ? { group: splitName.group } : {}),
    name: splitName.name,
    version: component.version,
    scope: component.scope ?? 'required',
    hashes: [hash],
    licenses: licensesFor(component.licenseIds, component.licenseExpression),
    purl,
    externalReferences: [{
      type: 'distribution',
      url: component.resolved,
      hashes: [hash],
    }],
    properties: properties({
      'tinyedge:distribution:kind': kind,
      'tinyedge:source:integrity': integrity,
      'tinyedge:source:resolved': component.resolved,
      'tinyedge:source:retained-path': component.retainedPath,
      'tinyedge:review:note': component.note,
      'tinyedge:review:status': component.scope === 'excluded' ? 'excluded-optional-peer' : 'reviewed',
      'tinyedge:payload:path': component.reviewedPayload?.path,
      'tinyedge:payload:sha256': component.reviewedPayload?.sha256,
      'tinyedge:payload:size': component.reviewedPayload?.size,
      'tinyedge:native:archive-path': component.archivePath,
      'tinyedge:native:arch': component.arch,
      'tinyedge:native:os': component.os,
      'tinyedge:native:size': component.size,
    }),
  }
}

function nativeComponent(nativeFile) {
  const qualifiers = [
    ['arch', nativeFile.arch],
    ['file_name', nativeFile.name],
    ['os', nativeFile.os],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return inventoryComponent({
    ...nativeFile,
    name: `pi-tui-${nativeFile.name}`,
    purlType: 'generic',
    purlQualifier: qualifiers,
    licenseIds: PI_TUI_ARTIFACT.licenseIds,
    resolved: `${PI_TUI_ARTIFACT.resolved}#${nativeFile.archivePath}`,
    note: `Native console helper embedded in ${PI_TUI_ARTIFACT.name}@${PI_TUI_ARTIFACT.version}.`,
  }, 'native-file')
}

function purlWithQualifiers(component) {
  if (component.purlQualifier?.includes('&')) {
    const base = `pkg:generic/${encodePurlSegment(component.name)}@${encodeURIComponent(component.version)}`
    return `${base}?${component.purlQualifier}`
  }
  return inventoryPurl(component)
}

function stableSortComponents(components) {
  return components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
}

function stableSortDependencies(dependencies) {
  return dependencies
    .map(({ ref, dependsOn }) => ({
      ref,
      dependsOn: [...new Set(dependsOn)].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function fileExists(absolutePath) {
  try {
    await access(absolutePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function bindArtifactLicenseFileEvidence({
  components,
  packageEntries,
  evidenceRecords,
  targetKey,
}) {
  assert(evidenceRecords.length === 1, `${targetKey} must bind exactly one separately reviewed artifact-contained legal file record`)
  for (const evidence of evidenceRecords) {
    const identity = `${evidence.name}@${evidence.version}`
    assert(evidence.status === 'verified-artifact-contained', `${identity} has invalid artifact legal-file evidence status`)
    assert(evidence.artifactLegalFile === 'LICENSE-MIT', `${identity} must retain its exact artifact legal-file name`)
    assert(evidence.artifactLegalFileSize === 1095, `${identity} artifact legal-file size drifted`)
    assert(/^[a-f0-9]{64}$/.test(evidence.artifactLegalFileSha256), `${identity} has invalid artifact legal-file SHA-256`)
    assertLicenses([evidence.declaredLicense], `artifact legal-file evidence ${identity}`)
    assertResolved(evidence.resolved, `artifact legal-file evidence ${identity}`)
    parseIntegrity(evidence.integrity, `artifact legal-file evidence ${identity}`)

    const matches = packageEntries.filter(([packagePath, metadata]) =>
      packageNameFromPath(packagePath) === evidence.name && metadata.version === evidence.version)
    assert(matches.length === 1, `${targetKey} must contain exactly one installed ${identity}; found ${matches.length}`)
    const [packagePath, metadata] = matches[0]
    for (const [field, expected] of [
      ['resolved', evidence.resolved],
      ['integrity', evidence.integrity],
      ['license', evidence.declaredLicense],
    ]) {
      assert(metadata[field] === expected, `${targetKey} ${identity} ${field} drifted from its artifact legal-file evidence`)
    }

    const componentRef = componentRefForPackage(packagePath, metadata)
    const component = components.find((candidate) => candidate['bom-ref'] === componentRef)
    assert(component, `${targetKey} is missing SBOM component ${componentRef}`)
    component.properties = [
      ...component.properties,
      ...properties({
        'tinyedge:legal-file:artifact-contained': evidence.artifactLegalFile,
        'tinyedge:legal-file:artifact-contained-sha256': evidence.artifactLegalFileSha256,
        'tinyedge:legal-file:artifact-contained-size': evidence.artifactLegalFileSize,
        'tinyedge:legal-file:attribution': evidence.attribution,
        'tinyedge:legal-file:evidence-status': evidence.status,
      }),
    ].sort((left, right) => left.name.localeCompare(right.name))
  }
}

function bindMissingLegalFileOverrides({
  components,
  packageEntries,
  overrides,
  targetKey,
}) {
  assert(overrides.length === 12, `${targetKey} must bind exactly 12 missing-artifact-legal-file overrides`)
  const seen = new Set()
  for (const override of overrides) {
    const identity = `${override.name}@${override.version}`
    assert(!seen.has(identity), `${targetKey} has duplicate missing legal file override ${identity}`)
    seen.add(identity)
    assert(
      override.status === 'pending-owner-approval' || override.status === 'approved',
      `${identity} has invalid override status ${override.status}`,
    )
    assertLicenses([override.declaredLicense], `missing legal file override ${identity}`)
    assertResolved(override.resolved, `missing legal file override ${identity}`)
    parseIntegrity(override.integrity, `missing legal file override ${identity}`)
    assert(
      Array.isArray(override.missingArtifactLegalFiles)
        && override.missingArtifactLegalFiles.join('|') === 'LICENSE|NOTICE|COPYING',
      `${identity} must record the exact missing LICENSE/NOTICE/COPYING file set`,
    )
    assert(typeof override.evidence === 'string' && override.evidence.length > 0, `${identity} is missing evidence`)
    assert(typeof override.provenanceLimitation === 'string' && override.provenanceLimitation.length > 0, `${identity} is missing provenance limitation`)
    assert(typeof override.approvedDisposition === 'string' && override.approvedDisposition.length > 0, `${identity} is missing approved disposition`)
    if (override.sourceCommit !== null && override.sourceCommit !== undefined) {
      assert(/^[a-f0-9]{40}$/.test(override.sourceCommit), `${identity} has invalid source commit`)
    }
    if (override.candidateSourceCommit) {
      assert(/^[a-f0-9]{40}$/.test(override.candidateSourceCommit), `${identity} has invalid candidate source commit`)
    }
    if (override.licenseEvidenceSha256) {
      assert(/^[a-f0-9]{64}$/.test(override.licenseEvidenceSha256), `${identity} has invalid evidence SHA-256`)
    }
    if (override.name === 'xml-naming') {
      assert(override.provenanceStrength === 'reproducible-exact-bytes-unattested', 'xml-naming must retain its explicit reproducible-but-unattested provenance classification')
      assert(override.sourceCommit === null, 'xml-naming must not claim a release-bound source commit')
      assert(override.shippedFileCount === 4, 'xml-naming must retain the exact four-file artifact map')
      assert(Object.keys(override.shippedFilesSha256 ?? {}).length === 4, 'xml-naming must retain all four shipped-file hashes')
    }

    const matches = packageEntries.filter(([packagePath, metadata]) =>
      packageNameFromPath(packagePath) === override.name && metadata.version === override.version)
    assert(matches.length === 1, `${targetKey} must contain exactly one installed ${identity}; found ${matches.length}`)
    const [packagePath, metadata] = matches[0]
    for (const [field, expected] of [
      ['resolved', override.resolved],
      ['integrity', override.integrity],
      ['license', override.declaredLicense],
    ]) {
      assert(metadata[field] === expected, `${targetKey} ${identity} ${field} drifted from its missing-legal-file override`)
    }

    const componentRef = componentRefForPackage(packagePath, metadata)
    const component = components.find((candidate) => candidate['bom-ref'] === componentRef)
    assert(component, `${targetKey} is missing SBOM component ${componentRef}`)
    component.properties = [
      ...component.properties,
      ...properties({
        'tinyedge:legal-file:artifact-missing': override.missingArtifactLegalFiles.join('|'),
        'tinyedge:legal-file:artifact-sha1': override.artifactSha1,
        'tinyedge:legal-file:artifact-sha256': override.artifactSha256,
        'tinyedge:legal-file:artifact-size': override.artifactSize,
        'tinyedge:legal-file:attribution': override.attribution ?? 'not-available-from-artifact',
        'tinyedge:legal-file:candidate-source-commit': override.candidateSourceCommit,
        'tinyedge:legal-file:candidate-source-tree': override.candidateSourceTree,
        'tinyedge:legal-file:candidate-commit-date': override.candidateCommitDate,
        'tinyedge:legal-file:disposition': override.status === 'approved'
          ? `approved:${override.approvedDisposition}`
          : `pending-owner-approval:${override.approvedDisposition}`,
        'tinyedge:legal-file:evidence': override.evidence,
        'tinyedge:legal-file:evidence-hash': override.licenseEvidenceSha256 ?? override.integrity,
        'tinyedge:legal-file:evidence-section': override.licenseEvidenceSection,
        'tinyedge:legal-file:evidence-url': override.licenseEvidenceUrl ?? override.resolved,
        'tinyedge:legal-file:override-requirement': override.overrideRequirement,
        'tinyedge:legal-file:override-status': override.status,
        'tinyedge:legal-file:provenance-limitation': override.provenanceLimitation,
        'tinyedge:legal-file:provenance-strength': override.provenanceStrength ?? 'reviewed-bound-or-artifact-only',
        'tinyedge:legal-file:registry-publish-date': override.registryPublishDate,
        'tinyedge:legal-file:registry-signature-key-id': override.npmSignatureKeyId,
        'tinyedge:legal-file:reproducible-pack-result': override.reproduciblePackResult,
        'tinyedge:legal-file:reproducible-pack-toolchain': override.reproduciblePackToolchain,
        'tinyedge:legal-file:shipped-file-count': override.shippedFileCount,
        'tinyedge:legal-file:shipped-files-sha256': override.shippedFilesSha256
          ? JSON.stringify(override.shippedFilesSha256)
          : undefined,
        'tinyedge:legal-file:source-commit': override.sourceCommit ?? 'not-bound-to-artifact',
        'tinyedge:legal-file:source-directory': override.sourceDirectory,
        'tinyedge:legal-file:source-license-file-sha256': override.sourceLicenseFileSha256,
        'tinyedge:legal-file:source-repository': override.sourceRepository,
      }),
    ].sort((left, right) => left.name.localeCompare(right.name))
  }
  return overrides.filter(({ status }) => status !== 'approved')
}

export async function buildSbomFromSnapshot({
  target,
  shrinkwrapText,
  expectedSha256,
  root = repositoryRoot,
  missingLicenseFileOverrides = MISSING_LICENSE_FILE_OVERRIDES,
  artifactLicenseFileEvidence = ARTIFACT_LICENSE_FILE_EVIDENCE,
}) {
  const reviewedTarget = typeof target === 'string' ? TARGETS[target] : target
  assert(reviewedTarget, `unknown SBOM target: ${String(target)}`)
  assert(typeof shrinkwrapText === 'string', `${reviewedTarget.key} shrinkwrap must be supplied as text`)
  const actualSha256 = sha256(shrinkwrapText)
  assert(actualSha256 === expectedSha256, `${reviewedTarget.key} shrinkwrap fingerprint drifted: expected ${expectedSha256}, got ${actualSha256}`)

  let shrinkwrap
  try {
    shrinkwrap = JSON.parse(shrinkwrapText)
  } catch (error) {
    throw new Error(`${reviewedTarget.key} shrinkwrap is invalid JSON: ${error.message}`)
  }
  assert(shrinkwrap.lockfileVersion === 3, `${reviewedTarget.key} shrinkwrap must use lockfileVersion 3`)
  assert(shrinkwrap.packages && typeof shrinkwrap.packages === 'object', `${reviewedTarget.key} shrinkwrap is missing packages`)
  const rootMetadata = shrinkwrap.packages['']
  assert(rootMetadata, `${reviewedTarget.key} shrinkwrap is missing its root record`)
  assert(rootMetadata.name === reviewedTarget.rootName, `${reviewedTarget.key} root name drifted`)
  assert(rootMetadata.version === reviewedTarget.rootVersion, `${reviewedTarget.key} root version drifted`)
  assert(rootMetadata.license === reviewedTarget.rootLicense, `${reviewedTarget.key} root release-lock license drifted`)

  const packageEntries = Object.entries(shrinkwrap.packages)
    .filter(([packagePath]) => packagePath !== '')
    .sort(([left], [right]) => left.localeCompare(right))
  assert(packageEntries.length === reviewedTarget.dependencyNodeCount, `${reviewedTarget.key} dependency node count drifted`)

  const seenRefs = new Map()
  const components = packageEntries.map(([packagePath, metadata]) => {
    const component = npmComponent(packagePath, metadata)
    const previous = seenRefs.get(component['bom-ref'])
    assert(!previous, `${reviewedTarget.key} has duplicate component identity ${component['bom-ref']} at ${previous} and ${packagePath}`)
    seenRefs.set(component['bom-ref'], packagePath)
    return component
  })

  const rootRef = npmPurl(reviewedTarget.rootName, reviewedTarget.rootVersion)
  const dependencies = []
  for (const [packagePath, metadata] of [['', rootMetadata], ...packageEntries]) {
    const ref = packagePath ? componentRefForPackage(packagePath, metadata) : rootRef
    const dependsOn = []
    for (const dependencyName of dependencyNames(metadata)) {
      const dependencyPath = resolveDependencyPath(shrinkwrap.packages, packagePath, dependencyName)
      assert(dependencyPath, `${reviewedTarget.key} graph cannot resolve ${dependencyName} from ${packagePath || '<root>'}`)
      dependsOn.push(componentRefForPackage(dependencyPath, shrinkwrap.packages[dependencyPath]))
    }
    dependencies.push({ ref, dependsOn })
  }

  bindArtifactLicenseFileEvidence({
    components,
    packageEntries,
    evidenceRecords: artifactLicenseFileEvidence,
    targetKey: reviewedTarget.key,
  })

  const pendingLegalFileOverrides = bindMissingLegalFileOverrides({
    components,
    packageEntries,
    overrides: missingLicenseFileOverrides,
    targetKey: reviewedTarget.key,
  })
  const licensePendingPresent = await fileExists(path.join(root, 'LICENSE-PENDING.md'))
  assert(
    licensePendingPresent || pendingLegalFileOverrides.length === 0,
    `${reviewedTarget.key} source-license cutover blocked: LICENSE-PENDING.md is absent but ${pendingLegalFileOverrides.length} missing-artifact-legal-file overrides still await explicit owner approval`,
  )

  const runtimeMetadata = shrinkwrap.packages[reviewedTarget.runtimePackagePath]
  assert(runtimeMetadata, `${reviewedTarget.key} is missing the reviewed Pi runtime node`)
  for (const optionalPeer of EXCLUDED_OPTIONAL_PEERS) {
    assert(runtimeMetadata.peerDependencies?.[optionalPeer.name] === optionalPeer.version, `${reviewedTarget.key} optional peer declaration drifted for ${optionalPeer.name}`)
    assert(runtimeMetadata.peerDependenciesMeta?.[optionalPeer.name]?.optional === true, `${reviewedTarget.key} optional peer must remain optional: ${optionalPeer.name}`)
    for (const packagePath of Object.keys(shrinkwrap.packages)) {
      assert(!packagePath.includes(`node_modules/${optionalPeer.name}`), `${reviewedTarget.key} must not install excluded optional peer ${optionalPeer.name}`)
    }
    components.push(inventoryComponent({
      ...optionalPeer,
      purlType: 'npm',
      scope: 'excluded',
      note: optionalPeer.reason,
    }, 'optional-peer'))
  }

  const runtimeRef = reviewedTarget.runtimePackagePath
    ? componentRefForPackage(reviewedTarget.runtimePackagePath, runtimeMetadata)
    : rootRef
  const runtimeDependency = dependencies.find(({ ref }) => ref === runtimeRef)
  assert(runtimeDependency, `${reviewedTarget.key} is missing the Pi runtime dependency record`)

  for (const vendored of VENDORED_COMPONENTS) {
    const retainedPath = normalizeRelative(vendored.retainedPath)
    const retainedBytes = await readFile(path.join(root, ...retainedPath.split('/')))
    const retainedSha256 = sha256(retainedBytes)
    assert(retainedSha256 === vendored.sha256, `${vendored.name} vendored payload drifted: expected ${vendored.sha256}, got ${retainedSha256}`)
    const component = inventoryComponent(vendored, 'vendored')
    components.push(component)
    runtimeDependency.dependsOn.push(component['bom-ref'])
    dependencies.push({ ref: component['bom-ref'], dependsOn: [] })
  }

  const piTuiMetadata = shrinkwrap.packages[PI_TUI_ARTIFACT.packagePath]
  assert(piTuiMetadata, `${reviewedTarget.key} is missing ${PI_TUI_ARTIFACT.packagePath}`)
  for (const field of ['version', 'license', 'resolved', 'integrity']) {
    const expected = field === 'license' ? PI_TUI_ARTIFACT.licenseIds[0] : PI_TUI_ARTIFACT[field]
    assert(piTuiMetadata[field] === expected, `${reviewedTarget.key} Pi TUI ${field} drifted`)
  }
  const piTuiRef = componentRefForPackage(PI_TUI_ARTIFACT.packagePath, piTuiMetadata)
  const piTuiDependency = dependencies.find(({ ref }) => ref === piTuiRef)
  assert(piTuiDependency, `${reviewedTarget.key} is missing the Pi TUI dependency record`)
  for (const nativeFile of PI_TUI_NATIVE_FILES) {
    const component = nativeComponent(nativeFile)
    // inventoryComponent handles single qualifiers; native files have three.
    component.purl = purlWithQualifiers({
      name: `pi-tui-${nativeFile.name}`,
      version: nativeFile.version,
      purlType: 'generic',
      purlQualifier: [
        ['arch', nativeFile.arch],
        ['file_name', nativeFile.name],
        ['os', nativeFile.os],
      ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&'),
    })
    component['bom-ref'] = component.purl
    components.push(component)
    piTuiDependency.dependsOn.push(component['bom-ref'])
    dependencies.push({ ref: component['bom-ref'], dependsOn: [] })
  }

  for (const optionalPeer of EXCLUDED_OPTIONAL_PEERS) {
    const ref = npmPurl(optionalPeer.name, optionalPeer.version)
    dependencies.push({ ref, dependsOn: [] })
  }

  const rootSplitName = splitPackageName(reviewedTarget.rootName)
  const rootLicenses = allowedLicenses.has(reviewedTarget.rootLicense)
    ? licensesFor([reviewedTarget.rootLicense])
    : [{ license: { name: reviewedTarget.rootLicense } }]
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'library',
        'bom-ref': rootRef,
        ...(rootSplitName.group ? { group: rootSplitName.group } : {}),
        name: rootSplitName.name,
        version: reviewedTarget.rootVersion,
        licenses: rootLicenses,
        purl: rootRef,
        properties: properties({
          'tinyedge:release:root-integrity-override': 'npm shrinkwrap root records do not carry registry resolved/integrity metadata',
          'tinyedge:release:source-license-state': reviewedTarget.rootLicense,
          'tinyedge:sbom:shrinkwrap-path': reviewedTarget.shrinkwrapPath,
          'tinyedge:sbom:shrinkwrap-sha256': actualSha256,
        }),
      },
      properties: properties({
        'tinyedge:sbom:default-install': 'Only dependency graph edges from the root are installed by default',
        'tinyedge:sbom:generator': 'scripts/legal/sbom.mjs',
        'tinyedge:sbom:optional-peer-policy': 'scope=excluded components are reviewed metadata and are not default install edges',
        'tinyedge:legal-file:license-pending-lock-present': licensePendingPresent,
        'tinyedge:legal-file:override-count': missingLicenseFileOverrides.length,
        'tinyedge:legal-file:pending-override-count': pendingLegalFileOverrides.length,
        'tinyedge:legal-file:override-policy': 'Only the twelve exact approved records and documented limitations are accepted; any status or artifact drift fails closed',
      }),
    },
    components: stableSortComponents(components),
    dependencies: stableSortDependencies(dependencies),
  }

  const componentRefs = new Set([rootRef, ...bom.components.map((component) => component['bom-ref'])])
  assert(componentRefs.size === bom.components.length + 1, `${reviewedTarget.key} generated duplicate bom-ref values`)
  for (const dependency of bom.dependencies) {
    assert(componentRefs.has(dependency.ref), `${reviewedTarget.key} dependency record has unknown ref ${dependency.ref}`)
    for (const ref of dependency.dependsOn) {
      assert(componentRefs.has(ref), `${reviewedTarget.key} dependency record references unknown component ${ref}`)
    }
  }
  const excludedRefs = new Set(EXCLUDED_OPTIONAL_PEERS.map((peer) => npmPurl(peer.name, peer.version)))
  const rootDependencies = bom.dependencies.find(({ ref }) => ref === rootRef)
  for (const excludedRef of excludedRefs) {
    assert(!rootDependencies.dependsOn.includes(excludedRef), `${reviewedTarget.key} incorrectly claims excluded peer ${excludedRef} installs by default`)
  }

  return clone(bom)
}

export async function buildSbomForTarget(target, { root = repositoryRoot } = {}) {
  await verifyOperativeLegalBundle({ root })
  if (target === WORKSPACE_TARGET.key) return buildWorkspaceSbom({ root })
  if (WRAPPER_TARGETS[target]) return buildWrapperSbom(WRAPPER_TARGETS[target], { root })
  const reviewedTarget = TARGETS[target]
  assert(reviewedTarget, `unknown SBOM target: ${target}`)
  const shrinkwrapText = await readFile(path.join(root, ...reviewedTarget.shrinkwrapPath.split('/')), 'utf8')
  return buildSbomFromSnapshot({
    target: reviewedTarget,
    shrinkwrapText,
    expectedSha256: reviewedTarget.shrinkwrapSha256,
    root,
  })
}

async function buildWrapperSbom(wrapperTarget, { root }) {
  const packageJsonPath = normalizeRelative(wrapperTarget.packageJsonPath)
  const packageJsonText = await readFile(path.join(root, ...packageJsonPath.split('/')), 'utf8')
  let manifest
  try {
    manifest = JSON.parse(packageJsonText)
  } catch (error) {
    throw new Error(`${wrapperTarget.packageJsonPath} is invalid JSON: ${error.message}`)
  }
  assert(manifest.name === wrapperTarget.rootName, `${wrapperTarget.key} wrapper name drifted`)
  assert(manifest.version === wrapperTarget.rootVersion, `${wrapperTarget.key} wrapper version drifted`)
  assert(manifest.license === wrapperTarget.rootLicense, `${wrapperTarget.key} wrapper release-lock license drifted`)
  assert(manifest.dependencies?.['@tinyedge/cli'] === wrapperTarget.cliVersion, `${wrapperTarget.key} wrapper must pin @tinyedge/cli@${wrapperTarget.cliVersion}`)
  assert(Object.keys(manifest.dependencies).length === 1, `${wrapperTarget.key} wrapper has dependencies outside the composed CLI graph`)
  if (wrapperTarget.excludedOptionalPeer) {
    const peerName = wrapperTarget.excludedOptionalPeer.name
    const peerVersion = wrapperTarget.excludedOptionalPeer.version
    assert(manifest.peerDependencies?.[peerName] === peerVersion, `${wrapperTarget.key} optional peer declaration drifted`)
    assert(manifest.peerDependenciesMeta?.[peerName]?.optional === true, `${wrapperTarget.key} existing-Pi host peer must remain optional`)
  }

  const cliBom = await buildSbomForTarget('cli', { root })
  const cliRef = cliBom.metadata.component['bom-ref']
  const cliComponent = {
    ...clone(cliBom.metadata.component),
    scope: 'required',
    properties: [
      ...cliBom.metadata.component.properties,
      ...properties({
        'tinyedge:composition:role': 'exact CLI graph root',
        'tinyedge:composition:resolved': 'unpublished release candidate; registry SRI is unavailable while npm release lock is present',
      }),
    ].sort((left, right) => left.name.localeCompare(right.name)),
  }
  const rootRef = npmPurl(wrapperTarget.rootName, wrapperTarget.rootVersion)
  const rootSplitName = splitPackageName(wrapperTarget.rootName)
  const rootLicenses = allowedLicenses.has(wrapperTarget.rootLicense)
    ? licensesFor([wrapperTarget.rootLicense])
    : [{ license: { name: wrapperTarget.rootLicense } }]
  const wrapperComponents = [...cliBom.components, cliComponent]
  const wrapperDependencies = [...cliBom.dependencies, { ref: rootRef, dependsOn: [cliRef] }]
  if (wrapperTarget.excludedOptionalPeer) {
    const component = inventoryComponent({
      ...wrapperTarget.excludedOptionalPeer,
      purlType: 'npm',
      scope: 'excluded',
      note: wrapperTarget.excludedOptionalPeer.reason,
    }, 'optional-peer')
    wrapperComponents.push(component)
    wrapperDependencies.push({ ref: component['bom-ref'], dependsOn: [] })
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'library',
        'bom-ref': rootRef,
        ...(rootSplitName.group ? { group: rootSplitName.group } : {}),
        name: rootSplitName.name,
        version: wrapperTarget.rootVersion,
        licenses: rootLicenses,
        purl: rootRef,
        properties: properties({
          'tinyedge:release:root-integrity-override': 'npm package root is an unpublished release candidate without registry resolved/integrity metadata',
          'tinyedge:release:source-license-state': wrapperTarget.rootLicense,
          'tinyedge:sbom:package-json-path': wrapperTarget.packageJsonPath,
          'tinyedge:sbom:package-json-sha256': sha256(packageJsonText),
          'tinyedge:wrapper:excluded-optional-peer': wrapperTarget.excludedOptionalPeer
            ? `${wrapperTarget.excludedOptionalPeer.name}@${wrapperTarget.excludedOptionalPeer.version}`
            : undefined,
        }),
      },
      properties: [
        ...cliBom.metadata.properties,
        ...properties({
          'tinyedge:sbom:composition': `${wrapperTarget.rootName}@${wrapperTarget.rootVersion} -> @tinyedge/cli@${wrapperTarget.cliVersion}`,
        }),
      ].sort((left, right) => left.name.localeCompare(right.name)),
    },
    components: stableSortComponents(wrapperComponents),
    dependencies: stableSortDependencies(wrapperDependencies),
  }
}

async function buildWorkspaceSbom({ root }) {
  const readManifest = async (manifestPath) => {
    const normalized = normalizeRelative(manifestPath)
    const text = await readFile(path.join(root, ...normalized.split('/')), 'utf8')
    try {
      return { manifest: JSON.parse(text), text }
    } catch (error) {
      throw new Error(`${manifestPath} is invalid JSON: ${error.message}`)
    }
  }
  const { manifest: workspaceManifest, text: workspaceManifestText } = await readManifest(WORKSPACE_TARGET.packageJsonPath)
  assert(workspaceManifest.name === WORKSPACE_TARGET.rootName, 'workspace root name drifted')
  assert(workspaceManifest.version === WORKSPACE_TARGET.rootVersion, 'workspace root version drifted')
  assert(workspaceManifest.license === WORKSPACE_TARGET.rootLicense, 'workspace root release-lock license drifted')

  const cliBom = await buildSbomForTarget('cli', { root })
  const components = clone(cliBom.components)
  const dependencies = clone(cliBom.dependencies)
  const componentsByRef = new Map(components.map((component) => [component['bom-ref'], component]))
  const packageRootRefs = []
  for (const packageRoot of WORKSPACE_TARGET.packageRoots) {
    const { manifest, text } = await readManifest(packageRoot.packageJsonPath)
    assert(manifest.name === packageRoot.name, `${packageRoot.packageJsonPath} name drifted`)
    assert(manifest.version === packageRoot.version, `${packageRoot.packageJsonPath} version drifted`)
    assert(manifest.license === packageRoot.license, `${packageRoot.packageJsonPath} license drifted`)
    const ref = npmPurl(packageRoot.name, packageRoot.version)
    packageRootRefs.push(ref)
    const workspaceProperties = properties({
      'tinyedge:workspace:package-json-path': packageRoot.packageJsonPath,
      'tinyedge:workspace:package-json-sha256': sha256(text),
      'tinyedge:workspace:package-root': true,
      'tinyedge:wrapper:excluded-optional-peer': packageRoot.name === '@tinyedge/pi'
        ? `${EXCLUDED_PI_HOST_PEER.name}@${EXCLUDED_PI_HOST_PEER.version}`
        : undefined,
    })
    const existing = componentsByRef.get(ref)
    if (existing) {
      existing.properties = [...existing.properties, ...workspaceProperties]
        .sort((left, right) => left.name.localeCompare(right.name))
      continue
    }
    let component
    if (packageRoot.name === '@tinyedge/cli') {
      component = {
        ...clone(cliBom.metadata.component),
        scope: 'required',
        properties: [...cliBom.metadata.component.properties, ...workspaceProperties]
          .sort((left, right) => left.name.localeCompare(right.name)),
      }
    } else {
      const splitName = splitPackageName(packageRoot.name)
      component = {
        type: 'library',
        'bom-ref': ref,
        ...(splitName.group ? { group: splitName.group } : {}),
        name: splitName.name,
        version: packageRoot.version,
        scope: 'required',
        licenses: allowedLicenses.has(packageRoot.license)
          ? licensesFor([packageRoot.license])
          : [{ license: { name: packageRoot.license } }],
        purl: ref,
        properties: [
          ...workspaceProperties,
          ...properties({
            'tinyedge:release:root-integrity-override': 'workspace package root is an unpublished release candidate without registry resolved/integrity metadata',
            'tinyedge:release:source-license-state': packageRoot.license,
          }),
        ].sort((left, right) => left.name.localeCompare(right.name)),
      }
    }
    components.push(component)
    componentsByRef.set(ref, component)
  }

  const cliRef = npmPurl('@tinyedge/cli', '0.1.2')
  const npxRef = npmPurl('tinyedge', '0.1.2')
  const piRef = npmPurl('@tinyedge/pi', '0.1.2')
  dependencies.push({ ref: npxRef, dependsOn: [cliRef] })
  dependencies.push({ ref: piRef, dependsOn: [cliRef] })
  const hostPeer = inventoryComponent({
    ...EXCLUDED_PI_HOST_PEER,
    purlType: 'npm',
    scope: 'excluded',
    note: EXCLUDED_PI_HOST_PEER.reason,
  }, 'optional-peer')
  assert(!componentsByRef.has(hostPeer['bom-ref']), 'workspace host peer collides with installed CLI graph')
  components.push(hostPeer)
  dependencies.push({ ref: hostPeer['bom-ref'], dependsOn: [] })

  const rootRef = npmPurl(WORKSPACE_TARGET.rootName, WORKSPACE_TARGET.rootVersion)
  dependencies.push({ ref: rootRef, dependsOn: packageRootRefs })
  const sortedComponents = stableSortComponents(components)
  const sortedDependencies = stableSortDependencies(dependencies)
  const componentRefs = new Set(sortedComponents.map((component) => component['bom-ref']))
  assert(componentRefs.size === sortedComponents.length, 'workspace SBOM contains duplicate component bom-refs')
  assert(new Set(sortedDependencies.map(({ ref }) => ref)).size === sortedDependencies.length, 'workspace SBOM contains duplicate dependency records')
  assert(!sortedDependencies.some(({ dependsOn }) => dependsOn.includes(hostPeer['bom-ref'])), 'excluded existing-Pi host must not be an install edge')
  for (const dependency of sortedDependencies) {
    assert(dependency.ref === rootRef || componentRefs.has(dependency.ref), `workspace dependency has unknown ref ${dependency.ref}`)
    for (const ref of dependency.dependsOn) assert(componentRefs.has(ref), `workspace dependency references unknown component ${ref}`)
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: WORKSPACE_TARGET.rootName,
        version: WORKSPACE_TARGET.rootVersion,
        licenses: licensesFor([WORKSPACE_TARGET.rootLicense]),
        purl: rootRef,
        properties: properties({
          'tinyedge:release:source-license-state': WORKSPACE_TARGET.rootLicense,
          'tinyedge:sbom:package-json-path': WORKSPACE_TARGET.packageJsonPath,
          'tinyedge:sbom:package-json-sha256': sha256(workspaceManifestText),
        }),
      },
      properties: [
        ...cliBom.metadata.properties,
        ...properties({
          'tinyedge:sbom:composition': `${WORKSPACE_TARGET.rootName}@${WORKSPACE_TARGET.rootVersion} -> four explicit TinyEdge package roots`,
        }),
      ].sort((left, right) => left.name.localeCompare(right.name)),
    },
    components: sortedComponents,
    dependencies: sortedDependencies,
  }
}

export async function verifyApacheTemplate({ root = repositoryRoot } = {}) {
  return verifyCanonicalLegalSource(APACHE_2_TEMPLATE, { root })
}

async function verifyCanonicalLegalSource(reviewedFile, { root = repositoryRoot } = {}) {
  const templatePath = normalizeRelative(reviewedFile.path)
  const template = await readFile(path.join(root, ...templatePath.split('/')))
  const actualSha256 = sha256(template)
  assert(actualSha256 === reviewedFile.sha256, `${reviewedFile.path} drifted: expected ${reviewedFile.sha256}, got ${actualSha256}`)
  return {
    path: reviewedFile.path,
    sha256: actualSha256,
    status: reviewedFile.status,
  }
}

export async function verifyNoticeTemplate({ root = repositoryRoot } = {}) {
  return verifyCanonicalLegalSource(NOTICE_TEMPLATE, { root })
}

export async function verifyPiRuntimeNoticeTemplate({ root = repositoryRoot } = {}) {
  return verifyCanonicalLegalSource(PI_RUNTIME_NOTICE_TEMPLATE, { root })
}

export async function verifyThirdPartyNoticesTemplate({ root = repositoryRoot } = {}) {
  return verifyCanonicalLegalSource(THIRD_PARTY_NOTICES_TEMPLATE, { root })
}

export async function verifyTrademarkPolicyTemplate({ root = repositoryRoot } = {}) {
  return verifyCanonicalLegalSource(TRADEMARK_POLICY_TEMPLATE, { root })
}

async function readRequired(root, relativePath) {
  const normalized = normalizeRelative(relativePath)
  try {
    return await readFile(path.join(root, ...normalized.split('/')))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${relativePath} is missing from the operative legal bundle`)
    throw error
  }
}

function assertExactBytes(actual, expected, label) {
  assert(actual.equals(expected), `${label} must match its reviewed canonical source byte-for-byte`)
}

export async function verifyOperativeLegalBundle({ root = repositoryRoot } = {}) {
  assert(!(await fileExists(path.join(root, 'LICENSE-PENDING.md'))), 'operative legal bundle must not coexist with LICENSE-PENDING.md')
  const npmPublicationLocked = await fileExists(path.join(root, 'NPM-RELEASE-PENDING.md'))

  const canonical = {
    apache: await readRequired(root, APACHE_2_TEMPLATE.path),
    notice: await readRequired(root, NOTICE_TEMPLATE.path),
    runtimeNotice: await readRequired(root, PI_RUNTIME_NOTICE_TEMPLATE.path),
    thirdParty: await readRequired(root, THIRD_PARTY_NOTICES_TEMPLATE.path),
    trademarks: await readRequired(root, TRADEMARK_POLICY_TEMPLATE.path),
    runtimeLicense: await readRequired(root, PI_RUNTIME_LICENSE.path),
  }
  for (const reviewedFile of [
    APACHE_2_TEMPLATE,
    NOTICE_TEMPLATE,
    PI_RUNTIME_NOTICE_TEMPLATE,
    THIRD_PARTY_NOTICES_TEMPLATE,
    TRADEMARK_POLICY_TEMPLATE,
    PI_RUNTIME_LICENSE,
  ]) {
    const key = reviewedFile === APACHE_2_TEMPLATE
      ? 'apache'
      : reviewedFile === NOTICE_TEMPLATE
        ? 'notice'
        : reviewedFile === PI_RUNTIME_NOTICE_TEMPLATE
          ? 'runtimeNotice'
          : reviewedFile === THIRD_PARTY_NOTICES_TEMPLATE
            ? 'thirdParty'
            : reviewedFile === TRADEMARK_POLICY_TEMPLATE
              ? 'trademarks'
              : 'runtimeLicense'
    const actualSha256 = sha256(canonical[key])
    assert(actualSha256 === reviewedFile.sha256, `${reviewedFile.path} drifted: expected ${reviewedFile.sha256}, got ${actualSha256}`)
  }

  for (const relativePath of ['LICENSE', 'packages/cli/LICENSE', 'packages/npx/LICENSE', 'packages/pi/LICENSE']) {
    assertExactBytes(await readRequired(root, relativePath), canonical.apache, relativePath)
  }
  for (const relativePath of ['NOTICE', 'packages/cli/NOTICE', 'packages/npx/NOTICE', 'packages/pi/NOTICE']) {
    assertExactBytes(await readRequired(root, relativePath), canonical.notice, relativePath)
  }
  assertExactBytes(await readRequired(root, 'packages/pi-runtime/NOTICE'), canonical.runtimeNotice, 'packages/pi-runtime/NOTICE')
  assert(!canonical.runtimeNotice.equals(canonical.notice), 'Pi runtime NOTICE must remain distinct from the TinyEdge Apache NOTICE')
  for (const relativePath of [
    'THIRD_PARTY_NOTICES.md',
    'packages/cli/THIRD_PARTY_NOTICES.md',
    'packages/npx/THIRD_PARTY_NOTICES.md',
    'packages/pi/THIRD_PARTY_NOTICES.md',
    'packages/pi-runtime/THIRD_PARTY_NOTICES.md',
  ]) {
    assertExactBytes(await readRequired(root, relativePath), canonical.thirdParty, relativePath)
  }
  assertExactBytes(await readRequired(root, 'TRADEMARKS.md'), canonical.trademarks, 'TRADEMARKS.md')

  const thirdPartyText = canonical.thirdParty.toString('utf8')
  assert(thirdPartyText.includes(canonical.runtimeLicense.toString('utf8').trim()), 'third-party notices must reproduce the exact upstream Pi MIT license')
  assert(thirdPartyText.includes(canonical.apache.toString('utf8').trim()), 'third-party notices must reproduce canonical Apache-2.0 terms for the AWS exceptions')
  for (const override of MISSING_LICENSE_FILE_OVERRIDES) {
    const identity = `${override.name}@${override.version}`
    assert(override.status === 'approved', `${identity} must retain explicit owner-approved status after source-license cutover`)
    for (const evidence of [
      identity,
      override.resolved,
      override.integrity,
      override.approvedDisposition,
      override.licenseEvidenceSha256,
    ].filter(Boolean)) {
      assert(thirdPartyText.includes(evidence), `third-party notices are missing approved evidence ${evidence} for ${identity}`)
    }
  }
  for (const evidence of ARTIFACT_LICENSE_FILE_EVIDENCE) {
    for (const exactValue of [
      `${evidence.name}@${evidence.version}`,
      evidence.resolved,
      evidence.integrity,
      evidence.artifactLegalFile,
      evidence.artifactLegalFileSha256,
    ]) {
      assert(thirdPartyText.includes(exactValue), `third-party notices are missing artifact-contained legal-file evidence ${exactValue}`)
    }
  }

  const manifestFor = async (relativePath) => {
    const text = (await readRequired(root, relativePath)).toString('utf8')
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`${relativePath} is invalid JSON: ${error.message}`)
    }
  }
  const workspaceManifest = await manifestFor('package.json')
  assert(workspaceManifest.license === 'Apache-2.0', 'workspace package must declare Apache-2.0')
  assert(workspaceManifest.private === true, 'workspace must remain private')
  for (const relativePath of ['packages/cli/package.json', 'packages/npx/package.json', 'packages/pi/package.json']) {
    const manifest = await manifestFor(relativePath)
    assert(manifest.license === 'Apache-2.0', `${relativePath} must declare Apache-2.0`)
    if (npmPublicationLocked) {
      assert(manifest.private === true, `${relativePath} must remain private while npm publication is locked`)
    } else {
      assert(manifest.private !== true, `${relativePath} must be publishable after npm publication approval`)
    }
    for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']) {
      assert(manifest.files?.includes(legalFile), `${relativePath} must pack ${legalFile}`)
    }
  }
  const runtimeManifest = await manifestFor('packages/pi-runtime/package.json')
  assert(runtimeManifest.license === 'MIT', 'Pi runtime must retain MIT')
  if (npmPublicationLocked) {
    assert(runtimeManifest.private === true, 'Pi runtime must remain private while npm publication is locked')
  } else {
    assert(runtimeManifest.private !== true, 'Pi runtime must be publishable after npm publication approval')
  }
  for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']) {
    assert(runtimeManifest.files?.includes(legalFile), `Pi runtime must pack ${legalFile}`)
  }

  return {
    sourceLicense: 'Apache-2.0',
    npmPublicationLocked,
    approvedMissingNamedLegalFileExceptions: MISSING_LICENSE_FILE_OVERRIDES.length,
    artifactContainedLegalFileRecords: ARTIFACT_LICENSE_FILE_EVIDENCE.length,
    thirdPartyNoticesSha256: sha256(canonical.thirdParty),
  }
}

export function serializeSbom(bom) {
  return `${JSON.stringify(bom, null, 2)}\n`
}

export async function verifyReviewedInputs(options = {}) {
  const result = {
    apache2Template: await verifyApacheTemplate(options),
    noticeTemplate: await verifyNoticeTemplate(options),
    piRuntimeNoticeTemplate: await verifyPiRuntimeNoticeTemplate(options),
    thirdPartyNoticesTemplate: await verifyThirdPartyNoticesTemplate(options),
    trademarkPolicyTemplate: await verifyTrademarkPolicyTemplate(options),
    operativeLegalBundle: await verifyOperativeLegalBundle(options),
  }
  for (const target of SBOM_TARGET_KEYS) {
    const bom = await buildSbomForTarget(target, options)
    result[target] = {
      components: bom.components.length,
      dependencies: bom.dependencies.length,
      pendingLegalFileOverrides: Number(bom.metadata.properties.find(({ name }) => name === 'tinyedge:legal-file:pending-override-count').value),
      sha256: sha256(serializeSbom(bom)),
    }
  }
  return result
}

export async function writeSboms({ root = repositoryRoot } = {}) {
  const result = {}
  for (const target of SBOM_TARGET_KEYS) {
    const reviewedTarget = TARGETS[target] ?? WRAPPER_TARGETS[target] ?? WORKSPACE_TARGET
    const serialized = serializeSbom(await buildSbomForTarget(target, { root }))
    const outputPath = path.join(root, ...reviewedTarget.outputPath.split('/'))
    await writeFile(outputPath, serialized, 'utf8')
    result[target] = { outputPath: reviewedTarget.outputPath, sha256: sha256(serialized) }
  }
  return result
}

export async function checkSboms({ root = repositoryRoot } = {}) {
  const result = {}
  for (const target of SBOM_TARGET_KEYS) {
    const reviewedTarget = TARGETS[target] ?? WRAPPER_TARGETS[target] ?? WORKSPACE_TARGET
    const expected = serializeSbom(await buildSbomForTarget(target, { root }))
    const outputPath = path.join(root, ...reviewedTarget.outputPath.split('/'))
    let actual
    try {
      actual = await readFile(outputPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${reviewedTarget.outputPath} is missing; run node scripts/legal/sbom.mjs --write`)
      throw error
    }
    assert(actual === expected, `${reviewedTarget.outputPath} drifted; regenerate and review it`)
    result[target] = { outputPath: reviewedTarget.outputPath, sha256: sha256(actual) }
  }
  return result
}

async function main(argv) {
  const [command = '--verify', target, ...extra] = argv
  assert(extra.length === 0, `unexpected arguments: ${extra.join(' ')}`)
  if (command === '--verify') {
    assert(target === undefined, '--verify does not accept a target')
    console.error(JSON.stringify(await verifyReviewedInputs(), null, 2))
    return
  }
  if (command === '--write') {
    assert(target === undefined, '--write does not accept a target')
    console.error(JSON.stringify(await writeSboms(), null, 2))
    return
  }
  if (command === '--check') {
    assert(target === undefined, '--check does not accept a target')
    console.error(JSON.stringify(await checkSboms(), null, 2))
    return
  }
  if (command === '--stdout') {
    assert(SBOM_TARGET_KEYS.includes(target), `--stdout requires target ${SBOM_TARGET_KEYS.join(', ')}`)
    process.stdout.write(serializeSbom(await buildSbomForTarget(target)))
    return
  }
  throw new Error('usage: node scripts/legal/sbom.mjs [--verify|--write|--check|--stdout <pi-runtime|cli>]')
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`legal SBOM check failed: ${error.message}`)
    process.exitCode = 1
  })
}
