import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildSbomForTarget,
  buildSbomFromSnapshot,
  serializeSbom,
  verifyApacheTemplate,
  verifyNoticeTemplate,
  verifyOperativeLegalBundle,
  verifyPiRuntimeNoticeTemplate,
  verifyReviewedInputs,
  verifyThirdPartyNoticesTemplate,
  verifyTrademarkPolicyTemplate,
} from '../scripts/legal/sbom.mjs'
import {
  ALLOWED_LICENSE_IDS,
  APACHE_2_TEMPLATE,
  ARTIFACT_LICENSE_FILE_EVIDENCE,
  EXCLUDED_OPTIONAL_PEERS,
  MISSING_LICENSE_FILE_OVERRIDES,
  NOTICE_TEMPLATE,
  PI_RUNTIME_NOTICE_TEMPLATE,
  PI_TUI_NATIVE_FILES,
  SBOM_TARGET_KEYS,
  TARGETS,
  THIRD_PARTY_NOTICES_TEMPLATE,
  TRADEMARK_POLICY_TEMPLATE,
  VENDORED_COMPONENTS,
  WORKSPACE_TARGET,
} from '../scripts/legal/reviewed-inventory.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function currentSnapshot(target) {
  const reviewedTarget = TARGETS[target]
  const shrinkwrapText = await readFile(path.join(root, reviewedTarget.shrinkwrapPath), 'utf8')
  return { reviewedTarget, shrinkwrapText, shrinkwrap: JSON.parse(shrinkwrapText) }
}

function mutatedText(shrinkwrap, mutate) {
  const copy = structuredClone(shrinkwrap)
  mutate(copy)
  return `${JSON.stringify(copy, null, 2)}\n`
}

function componentFullName(component) {
  return component.group ? `${component.group}/${component.name}` : component.name
}

async function verifyInstalledIgnoreLicense(cliDirectory) {
  const evidence = ARTIFACT_LICENSE_FILE_EVIDENCE[0]
  const dependencyRoot = await realpath(path.join(cliDirectory, 'node_modules'))
  const runtimePackage = path.join(dependencyRoot, '@tinyedge/pi-runtime/package.json')
  const runtime = JSON.parse(await readFile(runtimePackage, 'utf8'))
  assert.equal(runtime.name, '@tinyedge/pi-runtime')
  assert.equal(runtime.dependencies.ignore, evidence.version)
  // Resolve from the package which uses ignore: source installs may hoist it,
  // while npm's packed dependency closure keeps it inside the Pi runtime.
  // Resolving metadata does not import or execute third-party package code.
  const packageFile = createRequire(pathToFileURL(runtimePackage)).resolve('ignore/package.json')
  const relative = path.relative(dependencyRoot, packageFile)
  assert.ok(!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..', 'ignore must resolve inside this product dependency closure')
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'))
  assert.equal(metadata.name, evidence.name)
  assert.equal(metadata.version, evidence.version)
  assert.equal(metadata.license, evidence.declaredLicense)
  const licenseBytes = await readFile(path.join(path.dirname(packageFile), evidence.artifactLegalFile))
  assert.equal(licenseBytes.length, evidence.artifactLegalFileSize)
  assert.equal(sha256(licenseBytes), evidence.artifactLegalFileSha256)
  return { packageFile, licenseBytes }
}

test('reviewed shrinkwrap graphs produce deterministic CycloneDX 1.6 output offline', async () => {
  const first = await verifyReviewedInputs({ root })
  const second = await verifyReviewedInputs({ root })
  assert.deepEqual(first, second)

  for (const target of SBOM_TARGET_KEYS) {
    const firstBom = await buildSbomForTarget(target, { root })
    const secondBom = await buildSbomForTarget(target, { root })
    assert.equal(serializeSbom(firstBom), serializeSbom(secondBom))
    assert.equal(firstBom.bomFormat, 'CycloneDX')
    assert.equal(firstBom.specVersion, '1.6')
    assert.equal(firstBom.version, 1)
    const installedNodes = target === WORKSPACE_TARGET.key
      ? TARGETS.physicalsystems.dependencyNodeCount + 1
      : TARGETS[target].dependencyNodeCount
    assert.equal(firstBom.components.length, installedNodes + VENDORED_COMPONENTS.length + PI_TUI_NATIVE_FILES.length + EXCLUDED_OPTIONAL_PEERS.length)
    assert.equal(firstBom.dependencies.length, firstBom.components.length + 1)
  }
})

test('workspace SBOM composes tinyedge and its runtime without duplicate identities', async () => {
  const bom = await buildSbomForTarget('workspace', { root })
  assert.equal(bom.metadata.component.name, 'physicalsystems-workspace')
  assert.equal(bom.metadata.component.version, '0.0.0')
  assert.deepEqual(bom.metadata.component.licenses, [{ license: { id: 'Apache-2.0' } }])
  const componentRefs = bom.components.map((component) => component['bom-ref'])
  const dependencyRefs = bom.dependencies.map((dependency) => dependency.ref)
  assert.equal(new Set(componentRefs).size, componentRefs.length)
  assert.equal(new Set(dependencyRefs).size, dependencyRefs.length)

  const expectedRoots = [
    'pkg:npm/physicalsystems@0.2.3',
    'pkg:npm/%40tinyedge/pi-runtime@0.84.2-tinyedge.1',
  ].sort()
  const workspaceEdges = bom.dependencies.find(({ ref }) => ref === bom.metadata.component['bom-ref']).dependsOn
  assert.deepEqual(workspaceEdges, expectedRoots)
  for (const ref of expectedRoots) assert.equal(componentRefs.filter((candidate) => candidate === ref).length, 1)
})

test('Apache 2.0 remains a byte-exact approved canonical source', async () => {
  const verified = await verifyApacheTemplate({ root })
  assert.deepEqual(verified, APACHE_2_TEMPLATE)
  assert.equal(APACHE_2_TEMPLATE.status, 'approved-canonical-source')
})

test('approved NOTICE, runtime NOTICE, third-party notices, and trademark policy remain byte exact', async () => {
  const verified = await verifyNoticeTemplate({ root })
  assert.deepEqual(verified, NOTICE_TEMPLATE)
  assert.deepEqual(await verifyPiRuntimeNoticeTemplate({ root }), PI_RUNTIME_NOTICE_TEMPLATE)
  assert.deepEqual(await verifyThirdPartyNoticesTemplate({ root }), THIRD_PARTY_NOTICES_TEMPLATE)
  assert.deepEqual(await verifyTrademarkPolicyTemplate({ root }), TRADEMARK_POLICY_TEMPLATE)
  assert.equal(NOTICE_TEMPLATE.status, 'approved-canonical-source')
  const bundle = await verifyOperativeLegalBundle({ root })
  assert.deepEqual(bundle, {
    sourceLicense: 'Apache-2.0',
    npmPublicationLocked: false,
    approvedMissingNamedLegalFileExceptions: 12,
    artifactContainedLegalFileRecords: 1,
    thirdPartyNoticesSha256: THIRD_PARTY_NOTICES_TEMPLATE.sha256,
  })
})

test('operative legal bundle validates both locked and approved npm publication states', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'tinyedge-operative-legal-bundle-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))
  const fixtureFiles = [
    'package.json',
    APACHE_2_TEMPLATE.path,
    NOTICE_TEMPLATE.path,
    PI_RUNTIME_NOTICE_TEMPLATE.path,
    THIRD_PARTY_NOTICES_TEMPLATE.path,
    TRADEMARK_POLICY_TEMPLATE.path,
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'TRADEMARKS.md',
    'packages/cli/package.json',
    'packages/cli/LICENSE',
    'packages/cli/NOTICE',
    'packages/cli/THIRD_PARTY_NOTICES.md',
    'packages/cli/SBOM.cdx.json',
    'packages/npx/package.json',
    'packages/npx/LICENSE',
    'packages/npx/NOTICE',
    'packages/npx/THIRD_PARTY_NOTICES.md',
    'packages/npx/SBOM.cdx.json',
    'packages/pi/package.json',
    'packages/pi/LICENSE',
    'packages/pi/NOTICE',
    'packages/pi/THIRD_PARTY_NOTICES.md',
    'packages/pi/SBOM.cdx.json',
    'packages/pi-runtime/package.json',
    'packages/pi-runtime/LICENSE',
    'packages/pi-runtime/NOTICE',
    'packages/pi-runtime/THIRD_PARTY_NOTICES.md',
    'packages/pi-runtime/SBOM.cdx.json',
  ]
  for (const relativePath of fixtureFiles) {
    const destination = path.join(fixtureRoot, ...relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(root, ...relativePath.split('/')), destination)
  }

  assert.equal((await verifyOperativeLegalBundle({ root: fixtureRoot })).npmPublicationLocked, false)

  await writeFile(path.join(fixtureRoot, 'NPM-RELEASE-PENDING.md'), 'npm release pending\n', 'utf8')
  await assert.rejects(
    verifyOperativeLegalBundle({ root: fixtureRoot }),
    /must remain private while npm publication is locked/,
  )

  const packageManifestPaths = [
    'packages/cli/package.json',
    'packages/npx/package.json',
    'packages/pi/package.json',
    'packages/pi-runtime/package.json',
  ]
  for (const relativePath of packageManifestPaths) {
    const absolutePath = path.join(fixtureRoot, ...relativePath.split('/'))
    const manifest = JSON.parse(await readFile(absolutePath, 'utf8'))
    manifest.private = true
    await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  assert.equal((await verifyOperativeLegalBundle({ root: fixtureRoot })).npmPublicationLocked, true)

  await rm(path.join(fixtureRoot, 'NPM-RELEASE-PENDING.md'))
  await assert.rejects(
    verifyOperativeLegalBundle({ root: fixtureRoot }),
    /must be publishable after npm publication approval/,
  )
  for (const relativePath of packageManifestPaths) {
    const absolutePath = path.join(fixtureRoot, ...relativePath.split('/'))
    const manifest = JSON.parse(await readFile(absolutePath, 'utf8'))
    delete manifest.private
    await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  assert.equal((await verifyOperativeLegalBundle({ root: fixtureRoot })).npmPublicationLocked, false)

  await writeFile(path.join(fixtureRoot, 'NOTICE'), 'drifted notice\n', 'utf8')
  await assert.rejects(
    verifyOperativeLegalBundle({ root: fixtureRoot }),
    /NOTICE must match its reviewed canonical source byte-for-byte/,
  )
})

test('exactly 12 missing-named-file exceptions remain approved and bind to both graphs', async () => {
  assert.equal(MISSING_LICENSE_FILE_OVERRIDES.length, 12)
  assert.equal(new Set(MISSING_LICENSE_FILE_OVERRIDES.map(({ name, version }) => `${name}@${version}`)).size, 12)
  assert.ok(MISSING_LICENSE_FILE_OVERRIDES.every(({ status }) => status === 'approved'))
  assert.ok(MISSING_LICENSE_FILE_OVERRIDES.every(({ approvedDisposition }) => approvedDisposition.startsWith('accepted-exact-')))
  assert.ok(!MISSING_LICENSE_FILE_OVERRIDES.some(({ name }) => name === 'ignore'))
  const xmlNaming = MISSING_LICENSE_FILE_OVERRIDES.find(({ name }) => name === 'xml-naming')
  assert.equal(xmlNaming.provenanceStrength, 'reproducible-exact-bytes-unattested')
  assert.equal(xmlNaming.sourceCommit, null)
  assert.match(xmlNaming.provenanceLimitation, /UNATTESTED SOURCE BINDING/)
  assert.equal(xmlNaming.artifactSha256, '19347cbcba429e9f240427ce4e5998efe30a47cb9131b5673fc2f0441f7f4f57')
  assert.equal(Object.keys(xmlNaming.shippedFilesSha256).length, 4)
  assert.match(xmlNaming.reproduciblePackResult, /byte-for-byte/)

  const requiredProperties = [
    'tinyedge:legal-file:artifact-missing',
    'tinyedge:legal-file:attribution',
    'tinyedge:legal-file:disposition',
    'tinyedge:legal-file:evidence-hash',
    'tinyedge:legal-file:evidence-url',
    'tinyedge:legal-file:override-status',
    'tinyedge:legal-file:provenance-limitation',
    'tinyedge:legal-file:source-commit',
  ]
  for (const target of Object.keys(TARGETS)) {
    const bom = await buildSbomForTarget(target, { root })
    const overrideComponents = bom.components.filter((component) =>
      component.properties.some(({ name }) => name === 'tinyedge:legal-file:override-status'))
    assert.equal(overrideComponents.length, 12)
    assert.equal(
      bom.metadata.properties.find(({ name }) => name === 'tinyedge:legal-file:pending-override-count').value,
      '0',
    )
    for (const component of overrideComponents) {
      const names = new Set(component.properties.map(({ name }) => name))
      for (const property of requiredProperties) assert.ok(names.has(property), `${component.purl} is missing ${property}`)
      const disposition = component.properties.find(({ name }) => name === 'tinyedge:legal-file:disposition').value
      assert.match(disposition, /^approved:accepted-exact-/)
    }
    const xmlComponent = overrideComponents.find((component) => componentFullName(component) === 'xml-naming')
    const xmlProperties = Object.fromEntries(xmlComponent.properties.map(({ name, value }) => [name, value]))
    assert.equal(xmlProperties['tinyedge:legal-file:provenance-strength'], 'reproducible-exact-bytes-unattested')
    assert.equal(xmlProperties['tinyedge:legal-file:artifact-sha256'], xmlNaming.artifactSha256)
    assert.equal(xmlProperties['tinyedge:legal-file:shipped-file-count'], '4')
    assert.deepEqual(JSON.parse(xmlProperties['tinyedge:legal-file:shipped-files-sha256']), xmlNaming.shippedFilesSha256)
  }
})

test('ignore retains exact artifact-contained LICENSE-MIT evidence and is not an exception', async () => {
  assert.deepEqual(ARTIFACT_LICENSE_FILE_EVIDENCE.map(({ name, version, status }) => ({ name, version, status })), [{
    name: 'ignore',
    version: '7.0.5',
    status: 'verified-artifact-contained',
  }])
  const evidence = ARTIFACT_LICENSE_FILE_EVIDENCE[0]
  assert.equal(evidence.artifactLegalFile, 'LICENSE-MIT')
  assert.equal(evidence.artifactLegalFileSize, 1095)
  assert.equal(evidence.artifactLegalFileSha256, '9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0')
  for (const target of Object.keys(TARGETS)) {
    const bom = await buildSbomForTarget(target, { root })
    const component = bom.components.find((candidate) => componentFullName(candidate) === 'ignore' && candidate.version === '7.0.5')
    const properties = Object.fromEntries(component.properties.map(({ name, value }) => [name, value]))
    assert.equal(properties['tinyedge:legal-file:artifact-contained'], 'LICENSE-MIT')
    assert.equal(properties['tinyedge:legal-file:artifact-contained-sha256'], evidence.artifactLegalFileSha256)
    assert.equal(properties['tinyedge:legal-file:evidence-status'], evidence.status)
    assert.equal(properties['tinyedge:legal-file:override-status'], undefined)
  }
})

test('installed ignore artifact carries the reviewed LICENSE-MIT bytes', async () => {
  await verifyInstalledIgnoreLicense(path.join(root, 'packages/cli'))
})

test('installed license resolution accepts hoisted and nested layouts without hiding missing or altered evidence', async (t) => {
  const { licenseBytes } = await verifyInstalledIgnoreLicense(path.join(root, 'packages/cli'))
  for (const layout of ['hoisted', 'nested', 'nested-with-decoy', 'wrong-version', 'wrong-license', 'tampered', 'missing-file', 'outside-product']) {
    await t.test(layout, async () => {
      const temporaryBase = await realpath(tmpdir())
      const temporaryRoot = await mkdtemp(path.join(temporaryBase, 'ps-license-layout-'))
      try {
        const cliDirectory = path.join(temporaryRoot, 'product')
        const runtimeDirectory = path.join(cliDirectory, 'node_modules/@tinyedge/pi-runtime')
        await mkdir(runtimeDirectory, { recursive: true })
        await writeFile(path.join(runtimeDirectory, 'package.json'), JSON.stringify({
          name: '@tinyedge/pi-runtime', dependencies: { ignore: '7.0.5' },
        }))
        const writeIgnore = async (directory, metadata = {}, bytes = licenseBytes) => {
          await mkdir(directory, { recursive: true })
          await writeFile(path.join(directory, 'package.json'), JSON.stringify({
            name: 'ignore', version: '7.0.5', license: 'MIT', ...metadata,
          }))
          if (bytes) await writeFile(path.join(directory, 'LICENSE-MIT'), bytes)
        }
        const hoisted = path.join(cliDirectory, 'node_modules/ignore')
        const nested = path.join(runtimeDirectory, 'node_modules/ignore')
        const target = layout === 'hoisted' ? hoisted : layout === 'outside-product'
          ? path.join(temporaryRoot, 'node_modules/ignore') : nested
        const altered = Buffer.from(licenseBytes); altered[0] ^= 1
        await writeIgnore(target, layout === 'wrong-version' ? { version: '7.0.4' }
          : layout === 'wrong-license' ? { license: 'Unreviewed' } : {},
        layout === 'missing-file' ? null : layout === 'tampered' ? altered : licenseBytes)
        if (layout === 'nested-with-decoy') await writeIgnore(hoisted, {}, altered)
        // An intact hoisted copy must not conceal a broken nearer dependency.
        if (['wrong-version', 'wrong-license', 'tampered', 'missing-file'].includes(layout)) await writeIgnore(hoisted)
        if (['hoisted', 'nested', 'nested-with-decoy'].includes(layout)) {
          const verified = await verifyInstalledIgnoreLicense(cliDirectory)
          assert.equal(verified.packageFile, path.join(target, 'package.json'))
        } else {
          await assert.rejects(verifyInstalledIgnoreLicense(cliDirectory))
        }
      } finally {
        assert.equal(path.dirname(temporaryRoot), temporaryBase)
        assert.equal(await realpath(temporaryRoot), temporaryRoot)
        assert.ok(path.basename(temporaryRoot).startsWith('ps-license-layout-'))
        await rm(temporaryRoot, { recursive: true, force: true })
      }
    })
  }
})

test('every installed npm component has exact purl, version, license, integrity, and resolved metadata', async () => {
  const allowed = new Set(ALLOWED_LICENSE_IDS)
  for (const target of Object.keys(TARGETS)) {
    const bom = await buildSbomForTarget(target, { root })
    const npmComponents = bom.components.filter((component) =>
      component.properties.some(({ name }) => name === 'tinyedge:npm:package-path'))
    assert.equal(npmComponents.length, TARGETS[target].dependencyNodeCount)
    for (const component of npmComponents) {
      assert.match(component.purl, /^pkg:npm\//)
      assert.ok(component.version)
      assert.ok(component.hashes.some(({ alg, content }) => alg === 'SHA-512' && /^[a-f0-9]{128}$/.test(content)))
      assert.ok(component.externalReferences.some(({ type, url }) => type === 'distribution' && url.startsWith('https://registry.npmjs.org/')))
      for (const choice of component.licenses) {
        assert.ok(choice.license?.id)
        assert.ok(allowed.has(choice.license.id), `${componentFullName(component)} has unapproved license ${choice.license.id}`)
      }
    }
  }
})

test('graph fingerprint drift fails closed before producing an SBOM', async () => {
  const { reviewedTarget, shrinkwrapText } = await currentSnapshot('pi-runtime')
  const drifted = `${shrinkwrapText}\n`
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText: drifted,
      expectedSha256: reviewedTarget.shrinkwrapSha256,
      root,
    }),
    /shrinkwrap fingerprint drifted/,
  )
})

test('missing integrity and resolved metadata fail closed even in a re-reviewed graph', async () => {
  const { reviewedTarget, shrinkwrap } = await currentSnapshot('pi-runtime')
  const packagePath = 'node_modules/chalk'

  for (const field of ['integrity', 'resolved']) {
    const text = mutatedText(shrinkwrap, (copy) => {
      delete copy.packages[packagePath][field]
    })
    await assert.rejects(
      buildSbomFromSnapshot({
        target: reviewedTarget,
        shrinkwrapText: text,
        expectedSha256: sha256(text),
        root,
      }),
      new RegExp(`missing ${field}`),
    )
  }
})

test('unapproved dependency licenses fail closed', async () => {
  const { reviewedTarget, shrinkwrap } = await currentSnapshot('pi-runtime')
  const text = mutatedText(shrinkwrap, (copy) => {
    copy.packages['node_modules/chalk'].license = 'GPL-3.0-only'
  })
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText: text,
      expectedSha256: sha256(text),
      root,
    }),
    /uses unapproved license GPL-3\.0-only/,
  )
})

test('missing-artifact legal-file override metadata drift fails closed', async () => {
  const { reviewedTarget, shrinkwrapText } = await currentSnapshot('pi-runtime')
  const overrides = structuredClone(MISSING_LICENSE_FILE_OVERRIDES)
  overrides[0].resolved = `${overrides[0].resolved}?drifted=true`
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText,
      expectedSha256: reviewedTarget.shrinkwrapSha256,
      missingLicenseFileOverrides: overrides,
      root,
    }),
    /resolved drifted from its missing-legal-file override/,
  )
})

test('artifact-contained legal-file evidence drift fails closed', async () => {
  const { reviewedTarget, shrinkwrapText } = await currentSnapshot('pi-runtime')
  const evidence = structuredClone(ARTIFACT_LICENSE_FILE_EVIDENCE)
  evidence[0].resolved = `${evidence[0].resolved}?drifted=true`
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText,
      expectedSha256: reviewedTarget.shrinkwrapSha256,
      artifactLicenseFileEvidence: evidence,
      root,
    }),
    /resolved drifted from its artifact legal-file evidence/,
  )
})

test('an approved missing-file record reverting to pending fails closed', async (t) => {
  const { reviewedTarget, shrinkwrapText } = await currentSnapshot('pi-runtime')
  const cutoverRoot = await mkdtemp(path.join(tmpdir(), 'tinyedge-legal-cutover-'))
  t.after(() => rm(cutoverRoot, { recursive: true, force: true }))

  const partiallyApproved = structuredClone(MISSING_LICENSE_FILE_OVERRIDES)
  partiallyApproved[0].status = 'pending-owner-approval'
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText,
      expectedSha256: reviewedTarget.shrinkwrapSha256,
      missingLicenseFileOverrides: partiallyApproved,
      root: cutoverRoot,
    }),
    /LICENSE-PENDING\.md is absent but 1 .* await explicit owner approval/,
  )

  for (const vendored of VENDORED_COMPONENTS) {
    const destination = path.join(cutoverRoot, vendored.retainedPath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(root, vendored.retainedPath), destination)
  }
  const approvedBom = await buildSbomFromSnapshot({
    target: reviewedTarget,
    shrinkwrapText,
    expectedSha256: reviewedTarget.shrinkwrapSha256,
    root: cutoverRoot,
  })
  assert.equal(
    approvedBom.metadata.properties.find(({ name }) => name === 'tinyedge:legal-file:pending-override-count').value,
    '0',
  )
})

test('unresolvable dependency edges and duplicate component identities fail closed', async () => {
  const { reviewedTarget, shrinkwrap } = await currentSnapshot('pi-runtime')
  const missingText = mutatedText(shrinkwrap, (copy) => {
    copy.packages[''].dependencies['not-in-the-lock'] = '1.0.0'
  })
  await assert.rejects(
    buildSbomFromSnapshot({
      target: reviewedTarget,
      shrinkwrapText: missingText,
      expectedSha256: sha256(missingText),
      root,
    }),
    /graph cannot resolve not-in-the-lock/,
  )

  const duplicateText = mutatedText(shrinkwrap, (copy) => {
    copy.packages['node_modules/chalk/node_modules/chalk'] = structuredClone(copy.packages['node_modules/chalk'])
  })
  const duplicateTarget = {
    ...reviewedTarget,
    dependencyNodeCount: reviewedTarget.dependencyNodeCount + 1,
  }
  await assert.rejects(
    buildSbomFromSnapshot({
      target: duplicateTarget,
      shrinkwrapText: duplicateText,
      expectedSha256: sha256(duplicateText),
      root,
    }),
    /duplicate component identity/,
  )
})

test('native helpers and vendored payloads are exact reviewed components in the installed graph', async () => {
  const bom = await buildSbomForTarget('pi-runtime', { root })
  const rootRef = bom.metadata.component['bom-ref']
  const rootEdges = bom.dependencies.find(({ ref }) => ref === rootRef).dependsOn
  const piTui = bom.components.find((component) => componentFullName(component) === '@earendil-works/pi-tui')
  const piTuiEdges = bom.dependencies.find(({ ref }) => ref === piTui['bom-ref']).dependsOn

  for (const nativeFile of PI_TUI_NATIVE_FILES) {
    const component = bom.components.find((candidate) =>
      candidate.properties.some(({ name, value }) => name === 'tinyedge:native:archive-path' && value === nativeFile.archivePath))
    assert.ok(component, `missing ${nativeFile.archivePath}`)
    assert.ok(component.hashes.some(({ alg, content }) => alg === 'SHA-256' && content === nativeFile.sha256))
    assert.ok(piTuiEdges.includes(component['bom-ref']))
  }

  for (const vendored of VENDORED_COMPONENTS) {
    const component = bom.components.find((candidate) =>
      candidate.properties.some(({ name, value }) => name === 'tinyedge:source:retained-path' && value === vendored.retainedPath)
      && componentFullName(candidate) === vendored.name)
    assert.ok(component, `missing vendored ${vendored.name}`)
    assert.ok(component.hashes.some(({ alg, content }) => alg === 'SHA-256' && content === vendored.sha256))
    assert.ok(rootEdges.includes(component['bom-ref']))
  }
})

test('clipboard and Photon are explicitly excluded metadata, never default install edges', async () => {
  for (const target of Object.keys(TARGETS)) {
    const bom = await buildSbomForTarget(target, { root })
    const rootRef = bom.metadata.component['bom-ref']
    const rootEdges = bom.dependencies.find(({ ref }) => ref === rootRef).dependsOn
    for (const peer of EXCLUDED_OPTIONAL_PEERS) {
      const component = bom.components.find((candidate) => componentFullName(candidate) === peer.name && candidate.version === peer.version)
      assert.ok(component, `missing excluded ${peer.name}`)
      assert.equal(component.scope, 'excluded')
      assert.ok(component.properties.some(({ name, value }) => name === 'tinyedge:review:status' && value === 'excluded-optional-peer'))
      assert.ok(component.properties.some(({ name, value }) => name === 'tinyedge:review:note' && /not default|excluded|opt in/i.test(value)))
      assert.ok(!rootEdges.includes(component['bom-ref']), `${peer.name} must not be a default root edge`)
    }
  }
})

test('legacy facade and existing-Pi package sources are frozen and excluded from active SBOM targets', async () => {
  assert.equal(SBOM_TARGET_KEYS.includes('npx'), false)
  assert.equal(SBOM_TARGET_KEYS.includes('pi'), false)
  for (const [relativePath, sbomPath, expectedRef] of [
    ['packages/npx/package.json', 'packages/npx/SBOM.cdx.json', 'pkg:npm/tinyedge@0.1.3'],
    ['packages/pi/package.json', 'packages/pi/SBOM.cdx.json', 'pkg:npm/%40tinyedge/pi@0.1.3'],
  ]) {
    const manifestBytes = await readFile(path.join(root, relativePath))
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    assert.equal(manifest.version, '0.1.3')
    assert.equal(manifest.private, true)
    const sbom = JSON.parse(await readFile(path.join(root, sbomPath), 'utf8'))
    assert.equal(sbom.metadata.component['bom-ref'], expectedRef)
    assert.ok(sbom.metadata.component.properties.some(
      ({ name, value }) => name === 'tinyedge:sbom:package-json-sha256'
        && value === createHash('sha256').update(manifestBytes).digest('hex'),
    ))
    assert.ok(sbom.metadata.component.properties.some(
      ({ name, value }) => name === 'tinyedge:release:root-integrity-override'
        && /historical 0\.1\.3 release record/.test(value),
    ))
  }
})
