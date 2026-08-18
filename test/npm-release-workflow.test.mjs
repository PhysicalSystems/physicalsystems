import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(path.join(root, '.github/workflows/npm-release.yml'), 'utf8')
const cliWorkflow = readFileSync(path.join(root, '.github/workflows/cli.yml'), 'utf8')
const boundaryCheck = readFileSync(path.join(root, 'scripts/check-export-boundary.mjs'), 'utf8')
const npmReleasePending = readFileSync(path.join(root, 'NPM-RELEASE-PENDING.md'), 'utf8')
const rootReadme = readFileSync(path.join(root, 'README.md'), 'utf8')
const provenance = JSON.parse(readFileSync(path.join(root, 'EXPORT-PROVENANCE.json'), 'utf8'))
const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const apacheLicenseTemplate = readFileSync(path.join(root, 'scripts/legal/templates/Apache-2.0.txt'), 'utf8')
const noticeTemplate = readFileSync(path.join(root, 'scripts/legal/templates/NOTICE.txt'), 'utf8')
const runtimeNoticeTemplate = readFileSync(path.join(root, 'scripts/legal/templates/NOTICE.pi-runtime.txt'), 'utf8')
const thirdPartyNoticesTemplate = readFileSync(path.join(root, 'scripts/legal/templates/THIRD_PARTY_NOTICES.md'), 'utf8')
const trademarksTemplate = readFileSync(path.join(root, 'scripts/legal/templates/TRADEMARKS.md'), 'utf8')
const releaseGuide = readFileSync(path.join(root, 'packages/cli/RELEASE.md'), 'utf8')
const packageChecker = readFileSync(
  path.join(root, 'packages/cli/scripts/check-release-packages.js'),
  'utf8',
)
const cliPackage = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'))
const cliPackageLock = readFileSync(path.join(root, 'packages/cli/package-lock.json'), 'utf8')
const cliShrinkwrap = readFileSync(path.join(root, 'packages/cli/npm-shrinkwrap.json'), 'utf8')
const piRuntimePackage = JSON.parse(
  readFileSync(path.join(root, 'packages/pi-runtime/package.json'), 'utf8'),
)
const piRuntimeReadme = readFileSync(path.join(root, 'packages/pi-runtime/README.md'), 'utf8')
const runtimeBootstrapDirectory = path.join(root, 'scripts/npm-bootstrap/pi-runtime-0.0.0')
const runtimeBootstrapPackage = JSON.parse(
  readFileSync(path.join(runtimeBootstrapDirectory, 'package.json'), 'utf8'),
)
const runtimeBootstrapRegistryErratum = readFileSync(
  path.join(root, 'scripts/npm-bootstrap/REGISTRY-ERRATUM.md'),
  'utf8',
)
const releasePackages = [
  cliPackage,
  JSON.parse(readFileSync(path.join(root, 'packages/npx/package.json'), 'utf8')),
  JSON.parse(readFileSync(path.join(root, 'packages/pi/package.json'), 'utf8')),
  piRuntimePackage,
]
const packedReadmes = [
  readFileSync(path.join(root, 'packages/npx/README.md'), 'utf8'),
  readFileSync(path.join(root, 'packages/cli/README.md'), 'utf8'),
  readFileSync(path.join(root, 'packages/pi/README.md'), 'utf8'),
]

function writeFixtureFile(fixtureRoot, relative, contents) {
  const absolute = path.join(fixtureRoot, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
}

function collectFixtureFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collectFixtureFiles(absolute, files)
    else files.push(absolute)
  }
  return files
}

function refreshFixtureProvenance(fixtureRoot) {
  const payloadFiles = collectFixtureFiles(fixtureRoot)
    .filter((absolute) => path.relative(fixtureRoot, absolute).replaceAll('\\', '/') !== 'EXPORT-PROVENANCE.json')
    .sort((left, right) => {
      const leftPath = path.relative(fixtureRoot, left).replaceAll('\\', '/')
      const rightPath = path.relative(fixtureRoot, right).replaceAll('\\', '/')
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    })
  const payloadIndex = payloadFiles.map((absolute) => {
    const relative = path.relative(fixtureRoot, absolute).replaceAll('\\', '/')
    const raw = readFileSync(absolute)
    const canonical = raw.includes(0)
      ? raw
      : Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
    return createHash('sha256').update(canonical).digest('hex') + '  ' + relative + '\n'
  }).join('')
  writeFixtureFile(fixtureRoot, 'EXPORT-PROVENANCE.json', JSON.stringify({
    schemaVersion: 2,
    exportKind: 'public-clean-root-snapshot',
    destination: {
      repository: 'https://github.com/TinyEdgeAI/tinyedge-edge.git',
      status: 'public-canonical',
    },
    candidatePayload: {
      fileCount: payloadFiles.length,
      sha256: createHash('sha256').update(payloadIndex, 'utf8').digest('hex'),
    },
  }, null, 2) + '\n')
}

function setFixtureReleaseState(fixtureRoot, { licenseIsPending, npmReleaseIsPending }) {
  const repository = { url: 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git' }
  const bugs = { url: 'https://github.com/TinyEdgeAI/tinyedge-edge/issues' }
  writeFixtureFile(fixtureRoot, 'package.json', JSON.stringify({
    private: true,
    license: licenseIsPending ? 'UNLICENSED' : 'Apache-2.0',
    repository,
    bugs,
    homepage: 'https://github.com/TinyEdgeAI/tinyedge-edge#readme',
  }, null, 2) + '\n')
  const tinyedgePackages = ['cli', 'npx', 'pi']
  for (const packageName of tinyedgePackages) {
    const legalFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']
    writeFixtureFile(fixtureRoot, `packages/${packageName}/package.json`, JSON.stringify({
      private: npmReleaseIsPending,
      license: licenseIsPending ? 'UNLICENSED' : 'Apache-2.0',
      repository,
      bugs,
      homepage: `https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/${packageName}#readme`,
      files: licenseIsPending ? [] : legalFiles,
    }, null, 2) + '\n')
    for (const legalFile of legalFiles) {
      const legalPath = path.join(fixtureRoot, 'packages', packageName, legalFile)
      if (licenseIsPending) rmSync(legalPath, { force: true })
      else writeFixtureFile(
        fixtureRoot,
        `packages/${packageName}/${legalFile}`,
        legalFile === 'LICENSE'
          ? apacheLicenseTemplate
          : legalFile === 'NOTICE'
            ? noticeTemplate
            : legalFile === 'THIRD_PARTY_NOTICES.md'
              ? thirdPartyNoticesTemplate
              : `${legalFile} fixture\n`,
      )
    }
  }

  const runtimeLegalFiles = ['LICENSE', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM_README.md']
  writeFixtureFile(fixtureRoot, 'packages/pi-runtime/package.json', JSON.stringify({
    private: npmReleaseIsPending,
    license: 'MIT',
    repository,
    bugs,
    homepage: 'https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/pi-runtime#readme',
    files: runtimeLegalFiles,
  }, null, 2) + '\n')
  for (const legalFile of runtimeLegalFiles) {
    writeFixtureFile(
      fixtureRoot,
      `packages/pi-runtime/${legalFile}`,
      legalFile === 'THIRD_PARTY_NOTICES.md' ? thirdPartyNoticesTemplate : `${legalFile} fixture\n`,
    )
  }
  if (!licenseIsPending) {
    for (const legalFile of ['NOTICE', 'SBOM.cdx.json']) {
      runtimeLegalFiles.push(legalFile)
      writeFixtureFile(
        fixtureRoot,
        `packages/pi-runtime/${legalFile}`,
        legalFile === 'NOTICE' ? runtimeNoticeTemplate : `${legalFile} fixture\n`,
      )
    }
    writeFixtureFile(fixtureRoot, 'packages/pi-runtime/package.json', JSON.stringify({
      private: npmReleaseIsPending,
      license: 'MIT',
      repository,
      bugs,
      homepage: 'https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/pi-runtime#readme',
      files: runtimeLegalFiles,
    }, null, 2) + '\n')
  }

  for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json', 'TRADEMARKS.md']) {
    const legalPath = path.join(fixtureRoot, legalFile)
    if (licenseIsPending) rmSync(legalPath, { force: true })
    else writeFixtureFile(
      fixtureRoot,
      legalFile,
      legalFile === 'LICENSE'
        ? apacheLicenseTemplate
        : legalFile === 'NOTICE'
          ? noticeTemplate
          : legalFile === 'TRADEMARKS.md'
            ? trademarksTemplate
            : legalFile === 'THIRD_PARTY_NOTICES.md'
              ? thirdPartyNoticesTemplate
              : `${legalFile} fixture\n`,
    )
  }
  const licenseLock = path.join(fixtureRoot, 'LICENSE-PENDING.md')
  if (licenseIsPending) writeFixtureFile(fixtureRoot, 'LICENSE-PENDING.md', 'source license pending\n')
  else rmSync(licenseLock, { force: true })
  const npmReleaseLock = path.join(fixtureRoot, 'NPM-RELEASE-PENDING.md')
  if (npmReleaseIsPending) writeFixtureFile(fixtureRoot, 'NPM-RELEASE-PENDING.md', 'npm release pending\n')
  else rmSync(npmReleaseLock, { force: true })
  refreshFixtureProvenance(fixtureRoot)
}

function runFixtureBoundaryCheck(fixtureRoot) {
  return spawnSync(process.execPath, ['scripts/check-export-boundary.mjs'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })
}

test('the npm release workflow is manual, main-only, protected, and tokenless', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main"/)
  assert.match(workflow, /environment: npm-release/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /NPM_VERSION: 11\.19\.0/)
  assert.match(workflow, /NPM_REGISTRY: https:\/\/registry\.npmjs\.org\//)
  assert.match(workflow, /NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org\//)
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|release):/m)
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./)
})

test('source licensing is operative while npm publication remains independently locked', () => {
  const npmPendingGuard = workflow.indexOf(
    'Refuse release while npm publication approval is pending',
  )
  const licensePendingGuard = workflow.indexOf(
    'Refuse release while source licensing is pending',
  )
  const releaseContextGuard = workflow.indexOf(
    'Refuse every repository, event, or ref except TinyEdge main',
  )
  const buildJob = workflow.indexOf('\n  build:')
  const firstStagePublish = workflow.indexOf('npm stage publish')

  assert.ok(npmPendingGuard >= 0)
  assert.ok(licensePendingGuard > npmPendingGuard)
  assert.ok(licensePendingGuard < releaseContextGuard)
  assert.ok(releaseContextGuard < buildJob)
  assert.ok(buildJob < firstStagePublish)
  assert.match(workflow, /if \[\[ -e NPM-RELEASE-PENDING\.md \]\]/)
  assert.match(workflow, /if \[\[ -e LICENSE-PENDING\.md \]\]/)
  assert.match(workflow, /npm release pending/)
  assert.match(workflow, /License pending/)
  assert.equal(existsSync(path.join(root, 'LICENSE-PENDING.md')), false)
  assert.match(npmReleasePending, /separate from the completed source-license decision/)
  assert.match(npmReleasePending, /all four npm package\s+manifests must keep `"private": true`/)
  assert.match(npmReleasePending, /Source licensing does not authorize npm publication/i)
  assert.equal(rootPackage.private, true)
  assert.equal(rootPackage.license, 'Apache-2.0')
  for (const packagePath of [
    'packages/cli/package.json',
    'packages/npx/package.json',
    'packages/pi/package.json',
  ]) {
    const manifest = JSON.parse(readFileSync(path.join(root, packagePath), 'utf8'))
    assert.equal(manifest.private, true)
    assert.equal(manifest.license, 'Apache-2.0')
    for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']) {
      assert.ok(manifest.files.includes(legalFile))
    }
  }
  assert.equal(piRuntimePackage.private, true)
  assert.equal(piRuntimePackage.license, 'MIT')
})

test('the export boundary accepts the guarded source-license transition without unlocking npm', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'tinyedge-release-locks-'))
  try {
    mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true })
    copyFileSync(
      path.join(root, 'scripts/check-export-boundary.mjs'),
      path.join(fixtureRoot, 'scripts/check-export-boundary.mjs'),
    )
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/Apache-2.0.txt', apacheLicenseTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/NOTICE.txt', noticeTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/NOTICE.pi-runtime.txt', runtimeNoticeTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/THIRD_PARTY_NOTICES.md', thirdPartyNoticesTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/TRADEMARKS.md', trademarksTemplate)
    for (const governanceFile of [
      '.github/CODEOWNERS',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'DCO',
      'SUPPORT.md',
    ]) {
      writeFixtureFile(fixtureRoot, governanceFile, `${governanceFile} fixture\n`)
    }

    setFixtureReleaseState(fixtureRoot, {
      licenseIsPending: true,
      npmReleaseIsPending: true,
    })
    let result = runFixtureBoundaryCheck(fixtureRoot)
    assert.equal(result.status, 0, result.stderr || result.stdout)

    writeFixtureFile(fixtureRoot, 'LICENSE', 'operative license must not coexist with the pending lock\n')
    refreshFixtureProvenance(fixtureRoot)
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /source-license lock must not coexist with a live root LICENSE/)
    rmSync(path.join(fixtureRoot, 'LICENSE'), { force: true })

    writeFixtureFile(fixtureRoot, 'packages/cli/LICENSE', 'package license must not coexist with the pending lock\n')
    refreshFixtureProvenance(fixtureRoot)
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /packages\/cli\/package\.json must not have a live TinyEdge-authored LICENSE/)
    rmSync(path.join(fixtureRoot, 'packages/cli/LICENSE'), { force: true })

    const pendingCliManifestPath = path.join(fixtureRoot, 'packages/cli/package.json')
    const pendingCliManifest = JSON.parse(readFileSync(pendingCliManifestPath, 'utf8'))
    pendingCliManifest.files = ['LICENSE']
    writeFileSync(pendingCliManifestPath, JSON.stringify(pendingCliManifest, null, 2) + '\n')
    refreshFixtureProvenance(fixtureRoot)
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /packages\/cli\/package\.json must not pack a TinyEdge-authored LICENSE/)

    setFixtureReleaseState(fixtureRoot, {
      licenseIsPending: false,
      npmReleaseIsPending: true,
    })
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.equal(result.status, 0, result.stderr || result.stdout)

    setFixtureReleaseState(fixtureRoot, {
      licenseIsPending: true,
      npmReleaseIsPending: false,
    })
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr + result.stdout,
      /LICENSE-PENDING\.md must retain the separate NPM-RELEASE-PENDING\.md publication lock/,
    )

    setFixtureReleaseState(fixtureRoot, {
      licenseIsPending: false,
      npmReleaseIsPending: false,
    })
    result = runFixtureBoundaryCheck(fixtureRoot)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('every release action is pinned to an immutable commit', () => {
  for (const source of [workflow, cliWorkflow]) {
    const actionUses = source.split('\n').filter((line) => /^\s*(?:-\s*)?uses:/.test(line))
    assert.ok(actionUses.length > 0)
    for (const actionUse of actionUses) {
      assert.match(
        actionUse,
        /^\s*(?:-\s*)?uses:\s*[^@\s]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/,
      )
    }
  }
})

test('staging fails closed on environment, provenance, and license policy', () => {
  const stageJob = workflow.indexOf('\n  stage:')
  const policyGuard = workflow.indexOf(
    'NPM_RELEASE_POLICY_VERSION: ${{ vars.NPM_RELEASE_POLICY_VERSION }}',
    stageJob,
  )
  const publicRepositoryGuard = workflow.indexOf(
    'RELEASE_REPOSITORY_PRIVATE: ${{ github.event.repository.private }}',
    stageJob,
  )
  const licenseGuard = workflow.indexOf('Refuse unresolved package licenses before staging', stageJob)
  const bootstrapGuard = workflow.indexOf(
    'Require the runtime bootstrap and refuse published candidate versions',
    stageJob,
  )
  const firstStagePublish = workflow.indexOf('npm stage publish', stageJob)

  assert.ok(stageJob >= 0)
  assert.ok(policyGuard > stageJob)
  assert.ok(publicRepositoryGuard > policyGuard)
  assert.ok(licenseGuard > publicRepositoryGuard)
  assert.ok(bootstrapGuard > licenseGuard)
  assert.ok(firstStagePublish > bootstrapGuard)
  assert.match(workflow, /"\$NPM_RELEASE_POLICY_VERSION" != "v1"/)
  assert.match(workflow, /"\$RELEASE_REPOSITORY_PRIVATE" != "false"/)
  assert.match(workflow, /\['-xOf', path\.join\(directory, filename\), 'package\/package\.json'\]/)
  assert.match(workflow, /packedPackage\.private, true/)
  assert.match(workflow, /license: 'MIT'/)
  assert.match(workflow, /license: 'Apache-2\.0'/)
  assert.match(workflow, /\['LICENSE', 'NOTICE', 'SBOM\.cdx\.json', 'THIRD_PARTY_NOTICES\.md'\]/)
  assert.match(workflow, /\['LICENSE', 'NOTICE', 'SBOM\.cdx\.json', 'UPSTREAM\.md', 'THIRD_PARTY_NOTICES\.md', 'UPSTREAM_README\.md'\]/)
  assert.match(workflow, /packed \$\{legalFile\} must match the reviewed source bytes/)
  assert.match(workflow, /readFileSync\(path\.join\(sourceDirectory, legalFile\)\)/)
  for (const filename of [
    'tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz',
    'tinyedge-cli-0.1.2.tgz',
    'tinyedge-pi-0.1.2.tgz',
    'tinyedge-0.1.2.tgz',
  ]) {
    assert.match(workflow.slice(licenseGuard, firstStagePublish), new RegExp(filename.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(workflow.slice(0, stageJob), /UNLICENSED/)
  assert.doesNotMatch(packageChecker, /must declare its intended release license/)
  assert.doesNotMatch(workflow, /workflow_dispatch:\s*\n\s+inputs:/)
  assert.doesNotMatch(
    workflow,
    /allow-private|license-override|policy-override|acknowledge-private|acknowledge-provenance/i,
  )

  assert.match(releaseGuide, /NPM_RELEASE_POLICY_VERSION` to `v1`/)
  assert.match(releaseGuide, /canonical source repository is public before dispatch/)
  assert.match(releaseGuide, /use `UNLICENSED`/)
  assert.match(releaseGuide, /Local packing and pull-request x64\/arm64 checks remain available/)
})

test('a brand-new runtime requires a separate no-code bootstrap before staged publishing', () => {
  const bootstrapGuard = workflow.indexOf(
    'Require the runtime bootstrap and refuse published candidate versions',
  )
  const packageExistence = workflow.indexOf(
    "npm view '@tinyedge/pi-runtime@0.0.0' name version license publishConfig",
    bootstrapGuard,
  )
  const bootstrapTag = workflow.indexOf(
    "npm view '@tinyedge/pi-runtime' dist-tags --json",
    packageExistence,
  )
  const candidateE404 = workflow.indexOf(
    'check_unpublished \'@tinyedge/pi-runtime\' "$PI_RUNTIME_VERSION" pi-runtime',
    bootstrapTag,
  )
  const runtimeStage = workflow.indexOf(
    'npm stage publish "$RELEASE_ARTIFACT_DIRECTORY/tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz"',
    candidateE404,
  )

  assert.ok(bootstrapGuard >= 0)
  assert.ok(packageExistence > bootstrapGuard)
  assert.ok(bootstrapTag > packageExistence)
  assert.ok(candidateE404 > bootstrapTag)
  assert.ok(runtimeStage > candidateE404)
  assert.match(workflow, /npm staged publishing cannot create a brand-new package/)
  assert.match(workflow, /tags\.bootstrap,\s*'0\.0\.0'/)
  assert.match(workflow, /tags\.latest,\s*'0\.0\.0'/)
  assert.match(workflow, /tags\.preview, undefined/)
  assert.match(workflow, /PI_RUNTIME_BOOTSTRAP_INTEGRITY: \$\{\{ vars\.PI_RUNTIME_BOOTSTRAP_INTEGRITY \}\}/)
  assert.match(workflow, /PI_RUNTIME_BOOTSTRAP_SHASUM: \$\{\{ vars\.PI_RUNTIME_BOOTSTRAP_SHASUM \}\}/)
  assert.match(workflow, /metadata\.dist\?\.integrity, process\.env\.PI_RUNTIME_BOOTSTRAP_INTEGRITY/)
  assert.match(workflow, /metadata\.dist\?\.shasum, process\.env\.PI_RUNTIME_BOOTSTRAP_SHASUM/)
  assert.match(workflow, /npm pack '@tinyedge\/pi-runtime@0\.0\.0' --json --ignore-scripts/)
  assert.match(workflow, /manifest\.publishConfig, \{ access: 'public' \}/)
  assert.match(workflow, /peerDependencies peerDependenciesMeta devDependencies/)
  assert.match(workflow, /'peerDependencies',[\s\S]{0,80}'peerDependenciesMeta',[\s\S]{0,80}'devDependencies'/)
  assert.match(workflow, /'package\/package\.json'/)
  assert.match(workflow, /assertInertBootstrap\(packedManifest, 'downloaded tarball'\)/)
  assert.match(workflow, /\['LICENSE', 'README\.md', 'package\.json'\]/)
  assert.match(workflow, /bootstrap must not declare \$\{field\}/)
  assert.match(workflow, /exact inert namespace bootstrap/)
  assert.match(workflow, /this workflow never direct-publishes it/i)
  assert.match(workflow, /Automatic provenance applies to these staged candidate artifacts/)

  assert.match(releaseGuide, /cannot create a brand-new package/)
  assert.match(releaseGuide, /minimal `@tinyedge\/pi-runtime@0\.0\.0` tarball/)
  assert.match(releaseGuide, /no executable code, binary, dependency, command, bundle, or\s+lifecycle/)
  assert.match(releaseGuide, /PI_RUNTIME_BOOTSTRAP_INTEGRITY/)
  assert.match(releaseGuide, /PI_RUNTIME_BOOTSTRAP_SHASUM/)
  assert.match(releaseGuide, /npx --yes npm@11\.19\.0 publish PATH_TO_TARBALL --tag bootstrap --access public --registry=https:\/\/registry\.npmjs\.org\//)
  assert.match(releaseGuide, /unauthenticated clean environment/)
  assert.match(releaseGuide, /publish it interactively with 2FA under the `bootstrap` tag/)
  assert.match(releaseGuide, /both `bootstrap` and `latest` to resolve only to these exact inert/)
  assert.match(releaseGuide, /separate, one-time release action and requires explicit\s+human approval/)
  assert.match(releaseGuide, /does not receive this workflow's automatic provenance/)
  assert.match(releaseGuide, /Automatic\s+provenance applies later to the real staged candidate built from the public/)
})

test('the reviewed runtime namespace bootstrap is inert and reproducible from source', () => {
  assert.equal(runtimeBootstrapPackage.name, '@tinyedge/pi-runtime')
  assert.equal(runtimeBootstrapPackage.version, '0.0.0')
  assert.equal(runtimeBootstrapPackage.license, 'MIT')
  assert.deepEqual(runtimeBootstrapPackage.publishConfig, { access: 'public' })
  for (const forbiddenField of [
    'private',
    'bin',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'devDependencies',
    'bundledDependencies',
    'bundleDependencies',
    'scripts',
  ]) {
    assert.equal(runtimeBootstrapPackage[forbiddenField], undefined)
  }
  assert.deepEqual(
    readdirSync(runtimeBootstrapDirectory).sort(),
    ['LICENSE', 'README.md', 'package.json'],
  )
  assert.deepEqual(runtimeBootstrapPackage.files, ['LICENSE', 'README.md'])
  assert.match(
    readFileSync(path.join(runtimeBootstrapDirectory, 'README.md'), 'utf8'),
    /no\s+executable code, commands, dependencies, lifecycle scripts, or bundled files/i,
  )
  assert.match(runtimeBootstrapRegistryErratum, /immutable `0\.0\.0` tarball's README/)
  assert.match(runtimeBootstrapRegistryErratum, /`bootstrap` resolves to `0\.0\.0`/)
  assert.match(runtimeBootstrapRegistryErratum, /`latest` resolves to the same exact inert `0\.0\.0` bytes/)
  assert.match(runtimeBootstrapRegistryErratum, /`preview` is absent/)
  assert.match(
    runtimeBootstrapRegistryErratum,
    /sha512-uYd5UDXq76shmjwrszLmxzKXm163VHl8yHEzrAEaDjXD1QrrHtlRKh2T\+CbrDXWgS0Q\/HpUYgKkA5zrkUcG3Hg==/,
  )
  assert.match(runtimeBootstrapRegistryErratum, /d5ad1e7bbd5b82e04211dbf6b81750cdd90a0380/)
})

test('one Windows candidate is reused for x64, arm64, and ordered staging', () => {
  assert.match(workflow, /run release:pack --/)
  assert.match(workflow, /run release:verify --/)
  assert.match(workflow, /runner: windows-latest/)
  assert.match(workflow, /runner: windows-11-arm/)
  assert.match(workflow, /RELEASE_VERSION: 0\.1\.2/)
  assert.match(workflow, /PI_RUNTIME_VERSION: 0\.84\.2-tinyedge\.1/)
  assert.match(workflow, /node -p 'process\.arch'/)
  assert.match(workflow, /processArchitecture = \(node -p 'process\.arch'\)\.Trim\(\)/)

  const runtime = workflow.indexOf('npm stage publish "$RELEASE_ARTIFACT_DIRECTORY/tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz" --registry="$NPM_REGISTRY" --provenance --tag preview')
  const cli = workflow.indexOf('npm stage publish "$RELEASE_ARTIFACT_DIRECTORY/tinyedge-cli-0.1.2.tgz" --registry="$NPM_REGISTRY" --provenance --tag preview')
  const pi = workflow.indexOf('npm stage publish "$RELEASE_ARTIFACT_DIRECTORY/tinyedge-pi-0.1.2.tgz" --registry="$NPM_REGISTRY" --provenance --tag preview')
  const facade = workflow.indexOf('npm stage publish "$RELEASE_ARTIFACT_DIRECTORY/tinyedge-0.1.2.tgz" --registry="$NPM_REGISTRY" --provenance --tag preview')
  assert.ok(runtime >= 0)
  assert.ok(runtime < cli)
  assert.ok(cli < pi)
  assert.ok(pi < facade)

  const directPublish = /npm\s+publish(?:\s|$)/m
  assert.doesNotMatch(workflow, directPublish)
  assert.doesNotMatch(workflow, /--tag\s+latest/)
  const stageCommands = workflow.match(/^\s*npm stage publish[^\n]+/gm) || []
  assert.equal(stageCommands.length, 4)
  for (const command of stageCommands) {
    assert.match(
      command,
      /--registry="\$NPM_REGISTRY" --provenance --tag preview --access public/,
    )
  }
  const liveVisibility = workflow.indexOf('Recheck live public GitHub visibility')
  assert.ok(liveVisibility >= 0)
  assert.ok(liveVisibility < runtime)
  assert.match(workflow, /repository\.private, false/)
  assert.match(workflow, /repository\.visibility, 'public'/)
  assert.match(workflow, /manifest-sha256: \$\{\{ steps\.candidate\.outputs\.manifest-sha256 \}\}/)
  assert.match(workflow, /EXPECTED_MANIFEST_SHA256: \$\{\{ needs\.build\.outputs\.manifest-sha256 \}\}/)
  assert.match(workflow, /downloaded release manifest must match the trusted build-job digest/)
  assert.match(workflow, /Downloaded release manifest digest/)
  assert.match(workflow, /packedPackage\.publishConfig,[\s\S]{0,80}\{ access: 'public' \}/)
})

test('release verification uses real npm lifecycle and Windows command shims', () => {
  const facadePackage = releasePackages.find(({ name }) => name === 'tinyedge')
  assert.equal(cliPackage.bin, undefined)
  assert.deepEqual(facadePackage.bin, { tinyedge: 'bin/tinyedge.js' })
  assert.doesNotMatch(packageChecker, /'install',\s*'--ignore-scripts'/)
  assert.doesNotMatch(workflow, /npm ci --prefix packages\/cli/)
  assert.match(workflow, /Bootstrap checks from the locally packed runtime/)
  assert.match(packageChecker, /function npmFileSpec\(file\)/)
  assert.match(packageChecker, /file:\$\{path\.resolve\(file\)\.replaceAll\('\\\\', '\/'\)\}/)
  assert.match(packageChecker, /candidateArtifacts\.map\(\(\{ name, file \}\) => \[name, npmFileSpec\(file\)\]\)/)
  assert.match(packageChecker, /verification must consume the locally packed runtime tarball/)
  assert.match(packageChecker, /'node_modules', '\.bin', 'tinyedge\.cmd'/)
  assert.match(packageChecker, /assertWindowsShimTargets\(localShim, localFacadeEntry/)
  assert.match(packageChecker, /assertWindowsShimTargets\(globalShim, globalFacadeEntry/)
  assert.match(packageChecker, /\[localFacadeEntry, '--version'\]/)
  assert.match(packageChecker, /\[globalFacadeEntry, '--version'\]/)
  assert.match(packageChecker, /'--global',\s*'--prefix'/)
  assert.match(packageChecker, /path\.join\(globalPrefix, 'tinyedge\.cmd'\)/)
})

test('the published CLI carries the reviewed dependency closure', () => {
  assert.equal(cliShrinkwrap, cliPackageLock)
  assert.ok(cliPackage.files.includes('npm-shrinkwrap.json'))
  assert.equal(cliPackage.files.includes('RELEASE.md'), false)
  assert.match(packageChecker, /REVIEWED_PI_VERSION = '0\.84\.2'/)
  assert.match(packageChecker, /PI_RUNTIME_VERSION = '0\.84\.2-tinyedge\.1'/)
  assert.match(packageChecker, /RELEASE_NPM_VERSION = '11\.19\.0'/)
  assert.match(packageChecker, /release package verification requires npm/)
  assert.match(packageChecker, /FORBIDDEN_RUNTIME_PACKAGES/)
  assert.match(packageChecker, /@silvia-odwyer\/photon-node/)
  assert.match(packageChecker, /@mariozechner\/clipboard/)
  assert.match(packageChecker, /isForbiddenInstalledPackage/)
  assert.doesNotMatch(packageChecker, /missing Pi clipboard loader/)
  assert.match(packageChecker, /peerDependenciesMeta/)
  assert.match(packageChecker, /the Pi add-on must depend on the exact core version/)
  assert.match(packageChecker, /the CLI tarball must contain its reviewed npm-shrinkwrap\.json/)
  assert.match(packageChecker, /the internal release checklist must not be published/)
  assert.match(packageChecker, /packed \$\{legalFile\} must match the reviewed source bytes/)
  assert.match(packageChecker, /ignore LICENSE-MIT bytes drifted/)
})

test('the compatibility runtime is an exact MIT artifact without default native extras', () => {
  assert.equal(piRuntimePackage.name, '@tinyedge/pi-runtime')
  assert.equal(piRuntimePackage.version, '0.84.2-tinyedge.1')
  assert.equal(piRuntimePackage.private, true)
  assert.equal(piRuntimePackage.license, 'MIT')
  assert.equal(piRuntimePackage.bin, undefined)
  assert.deepEqual(Object.keys(piRuntimePackage.devDependencies || {}), [])
  for (const [name, version] of [
    ['@mariozechner/clipboard', '0.3.9'],
    ['@silvia-odwyer/photon-node', '0.3.4'],
  ]) {
    assert.equal(piRuntimePackage.peerDependencies[name], version)
    assert.equal(piRuntimePackage.peerDependenciesMeta[name].optional, true)
    assert.equal(piRuntimePackage.dependencies[name], undefined)
    assert.equal(piRuntimePackage.optionalDependencies?.[name], undefined)
  }
  for (const requiredFile of [
    'LICENSE',
    'NOTICE',
    'SBOM.cdx.json',
    'THIRD_PARTY_NOTICES.md',
    'UPSTREAM.md',
    'UPSTREAM_README.md',
    'npm-shrinkwrap.json',
  ]) {
    assert.ok(piRuntimePackage.files.includes(requiredFile))
  }
  assert.equal(piRuntimePackage.files.includes('examples'), false)
  assert.match(piRuntimeReadme, /@tinyedge\/pi-runtime/)
  assert.match(piRuntimeReadme, /candidate preparation[\s\S]{0,120}private: true/i)
  assert.doesNotMatch(piRuntimeReadme, /remains\s+`?private:\s*true/i)
  assert.match(piRuntimeReadme, /source maps[\s\S]{0,100}npm[\s\S]{0,80}omits/i)

  assert.match(packageChecker, /914cf1472e715297caa30db4b9535d534a9eb718/)
  assert.match(packageChecker, /e4d4c1e769963c816959f5cea02a0a10ccc0495a/)
  assert.match(packageChecker, /the runtime must carry the exact upstream MIT license/)
  assert.match(packageChecker, /\(\?:wasm\|node\|dll\|exe\|so\|dylib\|ttf\|otf\|woff2\?\|png/)
  assert.match(packageChecker, /sha512Integrity/)
  assert.match(
    packageChecker,
    /https:\/\/registry\.npmjs\.org\/@tinyedge\/pi-runtime\/-\/pi-runtime-/,
  )
  assert.match(packageChecker, /binds the runtime dependency to the locally packed tarball bytes/)
  assert.match(workflow, /lockedRuntime\?\.integrity, runtimeArtifact\.integrity/)
})

test('the clean export uses only the standalone repository identity', () => {
  const expectedRepository = 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git'
  const expectedBugs = 'https://github.com/TinyEdgeAI/tinyedge-edge/issues'
  for (const manifest of releasePackages) {
    assert.equal(manifest.repository.url, expectedRepository)
    assert.equal(manifest.bugs.url, expectedBugs)
    assert.deepEqual(manifest.publishConfig, { access: 'public' })
  }
  assert.match(workflow, /GITHUB_REPOSITORY" = "TinyEdgeAI\/tinyedge-edge"/)
  assert.match(releaseGuide, /repository `tinyedge-edge`/)
  assert.match(packageChecker, /TinyEdgeAI\/tinyedge-edge\.git/)
  assert.equal(provenance.source, undefined)
  assert.equal(provenance.schemaVersion, 2)
  assert.equal(provenance.exportKind, 'public-clean-root-snapshot')
  assert.equal(
    provenance.destination.repository,
    'https://github.com/TinyEdgeAI/tinyedge-edge.git',
  )
  assert.equal(provenance.destination.status, 'public-canonical')
  assert.match(provenance.candidatePayload.canonicalization, /normalize CRLF or CR to LF/)
  assert.doesNotMatch(JSON.stringify(provenance), /branchAtExport|sourceCommitTimestamp|gitObject/)
})

test('candidate documentation is truthful and the export boundary is executable', () => {
  assert.match(rootReadme, /Version `0\.1\.2` is \*\*not published to npm\*\*/)
  assert.match(rootReadme, /supported source-development targets are Windows x64 and native Windows/)
  assert.match(rootReadme, /does not contain the TinyEdge hosted control/)
  assert.match(rootReadme, /DEVELOPMENT\.md/)
  assert.match(rootReadme, /source is available under the licenses in this repository/i)
  assert.match(rootReadme, /NPM-RELEASE-PENDING\.md[\s\S]{0,140}private:\s*true/)
  assert.match(boundaryCheck, /unexpected top-level export entry/)
  assert.match(boundaryCheck, /local user path leaked/)
  assert.match(boundaryCheck, /must remain private while npm publication is pending/)
  assert.match(boundaryCheck, /!licensePending \|\| npmReleasePending/)
  assert.match(workflow, /node scripts\/check-export-boundary\.mjs/)
  assert.match(cliWorkflow, /node scripts\/check-export-boundary\.mjs/)
})

test('packed READMEs remain truthful when the exact 0.1.2 artifacts are public', () => {
  for (const readme of packedReadmes) {
    assert.match(readme, /0\.1\.1/)
    assert.doesNotMatch(
      readme,
      /0\.1\.2[\s\S]{0,100}\b(?:candidate|unavailable|unpublished|not published)\b/i,
    )
    assert.doesNotMatch(
      readme,
      /\b(?:candidate|unavailable|unpublished|not published)\b[\s\S]{0,100}0\.1\.2/i,
    )
  }
  assert.match(packedReadmes[0], /npx tinyedge@0\.1\.2/)
  assert.match(packedReadmes[0], /npm view tinyedge@0\.1\.2 version --json/)
  assert.match(packedReadmes[0], /npm install --global tinyedge@0\.1\.2/)
  assert.match(packedReadmes[1], /npx tinyedge@0\.1\.2/)
  assert.match(packedReadmes[1], /npm view tinyedge@0\.1\.2 version --json/)
  assert.match(packedReadmes[1], /npm install --global tinyedge@0\.1\.2/)
  assert.match(packedReadmes[2], /pi install npm:@tinyedge\/pi@0\.1\.2/)
  assert.match(packedReadmes[2], /npm view @tinyedge\/pi@0\.1\.2 version --json/)
})

test('pull-request CI covers release-workflow changes and its regression test', () => {
  assert.doesNotMatch(cliWorkflow, /^\s+paths:/m)
  assert.match(cliWorkflow, /node --test test\/npm-release-workflow\.test\.mjs/)
  assert.match(cliWorkflow, /npm install --global "npm@11\.19\.0"/)
  assert.match(cliWorkflow, /bootstrap:pi-runtime -- --cache \$cacheDirectory --install-cli/)
  const bootstrapIndex = cliWorkflow.indexOf('bootstrap:pi-runtime -- --cache $cacheDirectory --install-cli')
  const legalIndex = cliWorkflow.indexOf('npm run check:legal')
  assert.notEqual(bootstrapIndex, -1)
  assert.notEqual(legalIndex, -1)
  assert.ok(bootstrapIndex < legalIndex, 'CI must install the exact reviewed dependency tree before verifying artifact-contained legal files')
  assert.doesNotMatch(cliWorkflow, /npm ci --prefix packages\/cli/)
  assert.match(cliWorkflow, /npm --prefix packages\/cli run check/)
  assert.match(cliWorkflow, /npm --prefix packages\/cli test/)
})
