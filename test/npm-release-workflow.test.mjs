import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(path.join(root, '.github/workflows/npm-release.yml'), 'utf8')
const cliWorkflow = readFileSync(path.join(root, '.github/workflows/cli.yml'), 'utf8')

test('PR and main source checks share one candidate without running release qualification or publishing', () => {
  assert.equal((cliWorkflow.match(/run release:prepare --/g) || []).length, 1)
  assert.doesNotMatch(cliWorkflow, /run release:pack --|bootstrap:pi-runtime --/)
  assert.doesNotMatch(cliWorkflow, /run check:release-packages|npm publish|id-token: write|environment: npm-release/)
  assert.match(cliWorkflow, /needs: candidate/)
  assert.match(cliWorkflow, /name: Build one review candidate/)
  assert.match(cliWorkflow, /hydrate-review-dependencies\.mjs candidate-artifacts \$\{\{ github.sha \}\}/)
  assert.match(cliWorkflow, /actions\/download-artifact@[a-f0-9]{40}/)
  assert.doesNotMatch(cliWorkflow, /release:verify|--require-downloadable-node|--require-node-bundle|check-(?:downloaded|bundled)-node\.mjs|check-linux-harness-pty\.py/)
  assert.doesNotMatch(cliWorkflow, /ubuntu-canary/)
  assert.equal((cliWorkflow.match(/name: physicalsystems-0\.2\.3-source-review-\$\{\{ github.sha \}\}/g) || []).length, 2)
  assert.match(cliWorkflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/)
  assert.match(cliWorkflow, /pull_request:\r?\n\s+push:\r?\n\s+branches:\r?\n\s+- main/)
  assert.match(cliWorkflow, /name: test \(\$\{\{ matrix.check_name \}\}\)/)
  assert.deepEqual([...cliWorkflow.matchAll(/check_name: ([^\r\n]+)/g)].map((match) => match[1]),
    ['windows x64', 'windows arm64', 'ubuntu-22.04 x64', 'linux x64'])
  const summaryIndex = cliWorkflow.indexOf('      - name: Record successful source-only verification scope')
  assert.ok(summaryIndex > cliWorkflow.indexOf('run: node --test test/npm-release-workflow.test.mjs'))
  const summary = cliWorkflow.slice(summaryIndex)
  assert.doesNotMatch(summary, /if:/, 'Success summary must retain the default successful-step condition')
  assert.match(summary, /NOT install-qualified/)
  assert.match(summary, /No publishing was performed or authorized/)
  assert.match(summary, /Full exact-artifact npm 11\/12 installation qualification remains/)
})

test('both routes prepare pinned metadata but only protected releases require native download acceptance', () => {
  const prepare = readFileSync(path.join(root, 'scripts/prepare-product-candidate.mjs'), 'utf8')
  const canary = readFileSync(path.join(root, 'scripts/check-downloaded-node.mjs'), 'utf8')
  const offlineCanary = readFileSync(path.join(root, 'scripts/check-bundled-node.mjs'), 'utf8')
  const checker = readFileSync(path.join(root, 'packages/cli/scripts/check-release-packages.js'), 'utf8')
  assert.match(prepare, /if \(values\.offline\)\s*\{\s*const bundle = await assembleNodeBundle/)
  assert.match(prepare, /'--node-bundle', bundle\.output/)
  for (const candidateWorkflow of [cliWorkflow, workflow]) {
    assert.equal((candidateWorkflow.match(/run release:prepare --/g) || []).length, 1)
    assert.doesNotMatch(candidateWorkflow, /--offline|--require-node-bundle/)
    assert.match(candidateWorkflow, /actions\/setup-python@[a-f0-9]{40}/)
    assert.match(candidateWorkflow, /if: matrix\.architecture == 'x64'/)
  }
  const verifiers = workflow.match(/npm --prefix packages\/cli run release:verify --[^\n]+/g) || []
  assert.equal(verifiers.length, 2)
  for (const verifier of verifiers) assert.match(verifier, /--require-downloadable-node/)
  assert.match(checker, /if \(requireDownloadableNode\)\s*\{\s*const \{ index \} = await checkDownloadableNodePackage/)
  assert.match(checker, /scripts\/check-downloaded-node\.mjs/)
  assert.match(checker, /if \(requireNodeBundle\)[\s\S]{0,150}installed\.physicalsystemsNodeBundle, 'node-bundle'/)
  assert.match(checker, /if \(process\.arch === 'x64'\)[\s\S]{0,450}scripts\/check-bundled-node\.mjs/)
  assert.match(canary, /import\(pathToFileURL\(path\.join\(packageDirectory, 'src\/physical\/node-installation\.js'\)\)\)/)
  assert.match(canary, /Installer requested a URL outside the selected manifest/)
  assert.match(canary, /Selected wheel download has the wrong SHA-256/)
  assert.match(canary, /Selected wheel download has the wrong byte count/)
  assert.match(canary, /Verified reuse must not download any wheel/)
  assert.match(canary, /Verified reuse must not ask for installation consent/)
  assert.match(canary, /assert\.equal\(reused\.reused, true\)/)
  assert.match(canary, /offlineBackend: false/)
  assert.match(canary, /hardwareAccess: false/)
  assert.match(offlineCanary, /fetchImpl\(\) \{ assert\.fail\('Bundled Node installation attempted a network download'\)/)
  const releaseIndex = readFileSync(path.join(root, 'scripts/check-node-release-index.mjs'), 'utf8')
  assert.match(releaseIndex, /expectedRelease: release\.components\.node\.version/)
  assert.match(releaseIndex, /expectedSelectors: release\.selectors/)
  for (const candidateWorkflow of [cliWorkflow, workflow]) {
    assert.match(candidateWorkflow, /run: node scripts\/release\.mjs check/)
  }
})

test('the real pre-publish checksum gate refuses oversized archives and falsified sizes', () => {
  const step = workflow.slice(workflow.indexOf('      - name: Recheck the exact manifest and every tarball checksum'),
    workflow.indexOf('      - name: Refuse unresolved package licenses before publishing'))
  const match = step.match(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n          NODE/)
  assert.ok(match, 'Execute the exact checksum/size gate from the protected publisher')
  const fixture = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ps-publish-size-')))
  const policy = 'packages/cli/scripts/product-size-policy.js'
  try {
    writeFixtureFile(fixture, 'package.json', '{"type":"module"}\n')
    writeFixtureFile(fixture, policy, readFileSync(path.join(root, policy)))
    mkdirSync(path.join(fixture, 'candidate'))
    const commit = 'a'.repeat(40)
    const artifacts = [
      { key: 'pi-runtime', name: '@tinyedge/pi-runtime', version: '0.84.2-tinyedge.1', filename: 'tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz' },
      { key: 'physicalsystems', name: 'physicalsystems', version: '0.2.3', filename: 'physicalsystems-0.2.3.tgz' },
    ]
    const setPayload = (index, bytes) => {
      const artifact = artifacts[index]
      writeFixtureFile(fixture, `candidate/${artifact.filename}`, bytes)
      Object.assign(artifact, { size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` })
    }
    const check = () => {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.2.3', commit, artifacts }))
      writeFixtureFile(fixture, 'candidate/release-manifest.json', bytes)
      return spawnSync(process.execPath, ['--input-type=module'], { cwd: fixture,
        input: match[1].replace(/^          /gm, ''), encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, GITHUB_SHA: commit, RELEASE_VERSION: '0.2.3',
          PI_RUNTIME_VERSION: '0.84.2-tinyedge.1', RELEASE_ARTIFACT_DIRECTORY: 'candidate',
          EXPECTED_MANIFEST_SHA256: createHash('sha256').update(bytes).digest('hex') } })
    }
    setPayload(0, Buffer.from('reviewed runtime fixture'))
    setPayload(1, Buffer.from('small reviewed product fixture'))
    const valid = check()
    assert.equal(valid.status, 0, valid.stderr || valid.stdout)
    artifacts[1].size += 1
    const falsified = check()
    assert.notEqual(falsified.status, 0)
    assert.match(falsified.stderr, /archive byte count must match the approved manifest/)
    setPayload(1, Buffer.alloc(50 * 1024 * 1024 + 1))
    const oversized = check()
    assert.notEqual(oversized.status, 0)
    assert.match(oversized.stderr, /npm product archive must be at most/)
  } finally {
    assert.equal(path.dirname(fixture), realpathSync.native(tmpdir()))
    assert.ok(path.basename(fixture).startsWith('ps-publish-size-'))
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('CI dependency hydration checks source SHA and artifact hash before extraction and refuses overwrite', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'ps-hydrate-'))
  try {
    writeFixtureFile(fixture, 'scripts/hydrate-review-dependencies.mjs', readFileSync(path.join(root, 'scripts/hydrate-review-dependencies.mjs')))
    writeFixtureFile(fixture, 'payload/package/node_modules/demo/index.js', 'export default 42\n')
    mkdirSync(path.join(fixture, 'candidate'))
    mkdirSync(path.join(fixture, 'packages/cli'), { recursive: true })
    const archive = path.join(fixture, 'candidate/physicalsystems-0.2.0.tgz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', path.join(fixture, 'payload'), 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const commit = 'a'.repeat(40), sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const manifest = { commit, artifacts: [{ key: 'physicalsystems', filename: path.basename(archive), sha256 }] }
    const writeManifest = () => writeFixtureFile(fixture, 'candidate/release-manifest.json', JSON.stringify(manifest))
    writeManifest()
    const hydrate = (sha = commit) => spawnSync(process.execPath, [path.join(fixture, 'scripts/hydrate-review-dependencies.mjs'), path.join(fixture, 'candidate'), sha], { encoding: 'utf8' })
    assert.notEqual(hydrate('b'.repeat(40)).status, 0)
    assert.equal(existsSync(path.join(fixture, 'packages/cli/node_modules')), false)
    manifest.artifacts[0].sha256 = '0'.repeat(64); writeManifest()
    assert.notEqual(hydrate().status, 0)
    assert.equal(existsSync(path.join(fixture, 'packages/cli/node_modules')), false)
    manifest.artifacts[0].sha256 = sha256; writeManifest()
    const success = hydrate()
    assert.equal(success.status, 0, success.stderr)
    assert.equal(readFileSync(path.join(fixture, 'packages/cli/node_modules/demo/index.js'), 'utf8'), 'export default 42\n')
    assert.notEqual(hydrate().status, 0)
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()))
    assert.ok(path.basename(fixture).startsWith('ps-hydrate-'))
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('CI dependency hydration refuses traversal and links before extracting any dependencies', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'ps-hydrate-'))
  const tarEntry = (name, type = '0', link = '') => {
    const header = Buffer.alloc(512)
    const field = (offset, length, value) => header.write(value, offset, length, 'ascii')
    field(0, 100, name); field(100, 8, '0000644\0'); field(108, 8, '0000000\0')
    field(116, 8, '0000000\0'); field(124, 12, '00000000000\0'); field(136, 12, '00000000000\0')
    header.fill(32, 148, 156); field(156, 1, type); field(157, 100, link)
    field(257, 6, 'ustar\0'); field(263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
    return header
  }
  try {
    writeFixtureFile(fixture, 'scripts/hydrate-review-dependencies.mjs', readFileSync(path.join(root, 'scripts/hydrate-review-dependencies.mjs')))
    mkdirSync(path.join(fixture, 'candidate'))
    mkdirSync(path.join(fixture, 'packages/cli'), { recursive: true })
    const filename = 'physicalsystems-0.2.3.tgz', commit = 'a'.repeat(40)
    for (const unsafe of [tarEntry('package/node_modules/../../escape.txt'),
      tarEntry('package/node_modules/demo/link', '2', '../../../../escape.txt')]) {
      // tar recognizes this deliberately tiny uncompressed ustar fixture by
      // its bytes; the product filename remains subject to the normal checks.
      const archive = Buffer.concat([tarEntry('package/node_modules/demo/index.js'), unsafe, Buffer.alloc(1024)])
      writeFileSync(path.join(fixture, 'candidate', filename), archive)
      writeFixtureFile(fixture, 'candidate/release-manifest.json', JSON.stringify({ commit,
        artifacts: [{ key: 'physicalsystems', filename, sha256: createHash('sha256').update(archive).digest('hex') }] }))
      const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/hydrate-review-dependencies.mjs'), path.join(fixture, 'candidate'), commit], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(path.join(fixture, 'packages/cli/node_modules')), false)
      assert.equal(existsSync(path.join(fixture, 'escape.txt')), false)
    }
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()))
    assert.ok(path.basename(fixture).startsWith('ps-hydrate-'))
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('protected npm publication requires all pinned Node manifests before build, not source candidates', () => {
  const requireMain = workflow.slice(workflow.indexOf('  require-main:'), workflow.indexOf('\n  build:'))
  assert.match(requireMain, /run: node scripts\/check-node-release-index\.mjs/)
  assert.match(workflow, /\n  build:[\s\S]{0,120}needs: require-main/)
  assert.doesNotMatch(requireMain, /continue-on-error: true/)
  assert.doesNotMatch(cliWorkflow, /check-node-release-index/)
  const packer = readFileSync(path.join(root, 'packages/cli/scripts/check-release-packages.js'), 'utf8')
  assert.doesNotMatch(packer, /check-node-release-index/)
})

test('Linux publication verifies first-run managed readiness with deterministic Python, not just a header', () => {
  const linux = workflow.slice(workflow.indexOf('  verify-linux:'), workflow.indexOf('\n  publish:'))
  for (const [runner, python] of [['22.04', '3.10'], ['24.04', '3.12']]) {
    assert.equal((linux.match(new RegExp(`runner: ubuntu-${runner.replace('.', '\\.')}[\\s\\S]{0,120}python-version: '${python.replace('.', '\\.')}'`, 'g')) || []).length, 2)
  }
  assert.match(linux, /actions\/setup-python@[a-f0-9]{40}/)
  assert.match(linux, /python-version: \$\{\{ matrix\.python-version \}\}/)
  assert.match(linux, /python3 -I -c 'import sys, venv, ensurepip/)
  const checker = readFileSync(path.join(root, 'packages/cli/scripts/check-release-packages.js'), 'utf8')
  const wrapper = readFileSync(path.join(root, 'packages/cli/scripts/check-managed-harness.mjs'), 'utf8')
  assert.match(checker, /check-linux-harness-pty\.py'[\s\S]{0,200}process\.execPath,[\s\S]{0,200}check-managed-harness\.mjs'[\s\S]{0,100}installedPhysicalSystemsDirectory/)
  assert.match(checker, /timeout: 12 \* 60_000/)
  assert.match(wrapper, /const \{ runCli \} = await import\(new URL\('cli\.js', source\)\)/)
  assert.match(wrapper, /const \{ harnessCommand \} = await import/)
  assert.match(wrapper, /await runCli\(\[\],/)
  assert.match(wrapper, /harnessCommand: \(options\) => harnessCommand/)
  assert.doesNotMatch(wrapper, /managedNodeEnvironmentImpl:|authorize:|createMode:|createExtension:/)
  assert.match(wrapper, /selected\?\.digest, release\.digest/)
  assert.match(wrapper, /await execution\.status\(\)/)
  assert.match(wrapper, /status\.configurations, \[\]/)
  assert.match(wrapper, /camera\.phase, 'idle'/)
  assert.match(wrapper, /await host\?\.dispose\(\)/)
  const pty = readFileSync(path.join(root, 'packages/cli/scripts/check-linux-harness-pty.py'), 'utf8')
  assert.match(pty, /except ConnectionRefusedError:\r?\n\s+return True/)
  assert.match(pty, /listener_stopped=stopped/)
  assert.match(wrapper, /kind: release \? 'managed' : 'source-only'/)
  assert.match(wrapper, /XDG_CONFIG_HOME = path\.join\(configDir, 'xdg'\)/)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')).files.includes('scripts'), false)
})
const boundaryCheck = readFileSync(path.join(root, 'scripts/check-export-boundary.mjs'), 'utf8')
const rootReadme = readFileSync(path.join(root, 'README.md'), 'utf8')
const developmentGuide = readFileSync(path.join(root, 'DEVELOPMENT.md'), 'utf8')
const dependencyGuide = readFileSync(path.join(root, 'DEPENDENCIES.md'), 'utf8')
const reviewedInventorySource = readFileSync(path.join(root, 'scripts/legal/reviewed-inventory.mjs'), 'utf8')
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
const launcher = readFileSync(path.join(root, 'packages/cli/bin/physicalsystems.js'), 'utf8')
const unsupportedNodeCheck = readFileSync(
  path.join(root, 'packages/cli/scripts/check-unsupported-node.cjs'),
  'utf8',
)
const cliPackage = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'))
const cliPackageLock = readFileSync(path.join(root, 'packages/cli/package-lock.json'), 'utf8')
const parsedCliPackageLock = JSON.parse(cliPackageLock)
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
const physicalsystemsBootstrapDirectory = path.join(
  root,
  'scripts/npm-bootstrap/physicalsystems-0.0.0',
)
const physicalsystemsBootstrapPackage = JSON.parse(
  readFileSync(path.join(physicalsystemsBootstrapDirectory, 'package.json'), 'utf8'),
)
const legacyPackages = [
  JSON.parse(readFileSync(path.join(root, 'packages/npx/package.json'), 'utf8')),
  JSON.parse(readFileSync(path.join(root, 'packages/pi/package.json'), 'utf8')),
]
const packedReadme = readFileSync(path.join(root, 'packages/cli/README.md'), 'utf8')

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
      repository: 'https://github.com/PhysicalSystems/physicalsystems.git',
      status: 'public-canonical',
    },
    candidatePayload: {
      fileCount: payloadFiles.length,
      sha256: createHash('sha256').update(payloadIndex, 'utf8').digest('hex'),
    },
  }, null, 2) + '\n')
}

function setFixtureReleaseState(fixtureRoot, { licenseIsPending, npmReleaseIsPending }) {
  const repository = { url: 'git+https://github.com/PhysicalSystems/physicalsystems.git' }
  const bugs = { url: 'https://github.com/PhysicalSystems/physicalsystems/issues' }
  const frozenRepository = { url: 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git' }
  const frozenBugs = { url: 'https://github.com/TinyEdgeAI/tinyedge-edge/issues' }
  writeFixtureFile(fixtureRoot, 'package.json', JSON.stringify({
    private: true,
    license: licenseIsPending ? 'UNLICENSED' : 'Apache-2.0',
    repository,
    bugs,
    homepage: 'https://github.com/PhysicalSystems/physicalsystems#readme',
  }, null, 2) + '\n')
  const tinyedgePackages = ['cli', 'npx', 'pi']
  for (const packageName of tinyedgePackages) {
    const frozen = packageName !== 'cli'
    const legalFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']
    writeFixtureFile(fixtureRoot, `packages/${packageName}/package.json`, JSON.stringify({
      version: frozen ? '0.1.3' : '0.2.3',
      private: frozen || npmReleaseIsPending,
      license: licenseIsPending ? 'UNLICENSED' : 'Apache-2.0',
      repository: frozen ? frozenRepository : repository,
      bugs: frozen ? frozenBugs : bugs,
      homepage: frozen
        ? `https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/${packageName}#readme`
        : `https://github.com/PhysicalSystems/physicalsystems/tree/main/packages/${packageName}#readme`,
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
    repository: frozenRepository,
    bugs: frozenBugs,
    homepage: 'https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/pi-runtime#readme',
    version: '0.84.2-tinyedge.1',
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
      repository: frozenRepository,
      bugs: frozenBugs,
      homepage: 'https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/pi-runtime#readme',
      version: '0.84.2-tinyedge.1',
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

test('source licensing and npm publication approval are operative while workflow guards remain fail-closed', () => {
  const npmPendingGuard = workflow.indexOf(
    'Refuse release while npm publication approval is pending',
  )
  const licensePendingGuard = workflow.indexOf(
    'Refuse release while source licensing is pending',
  )
  const releaseContextGuard = workflow.indexOf(
    'Refuse every repository, event, or ref except Physical Systems main',
  )
  const buildJob = workflow.indexOf('\n  build:')
  const firstPublish = workflow.indexOf('npm publish "./$RELEASE_ARTIFACT_DIRECTORY/physicalsystems-0.2.3.tgz"')

  assert.ok(npmPendingGuard >= 0)
  assert.ok(licensePendingGuard > npmPendingGuard)
  assert.ok(licensePendingGuard < releaseContextGuard)
  assert.ok(releaseContextGuard < buildJob)
  assert.ok(buildJob < firstPublish)
  assert.match(workflow, /if \[\[ -e NPM-RELEASE-PENDING\.md \]\]/)
  assert.match(workflow, /if \[\[ -e LICENSE-PENDING\.md \]\]/)
  assert.match(workflow, /npm release pending/)
  assert.match(workflow, /License pending/)
  assert.equal(existsSync(path.join(root, 'LICENSE-PENDING.md')), false)
  assert.equal(existsSync(path.join(root, 'NPM-RELEASE-PENDING.md')), false)
  assert.equal(rootPackage.private, true)
  assert.equal(rootPackage.license, 'Apache-2.0')
  for (const packagePath of ['packages/cli/package.json']) {
    const manifest = JSON.parse(readFileSync(path.join(root, packagePath), 'utf8'))
    assert.notEqual(manifest.private, true)
    assert.equal(manifest.license, 'Apache-2.0')
    for (const legalFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']) {
      assert.ok(manifest.files.includes(legalFile))
    }
  }
  for (const manifest of legacyPackages) {
    assert.equal(manifest.version, '0.1.3')
    assert.equal(manifest.private, true)
  }
  assert.notEqual(piRuntimePackage.private, true)
  assert.equal(piRuntimePackage.license, 'MIT')
})

test('the export boundary accepts the guarded source-license transition without unlocking npm', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'tinyedge-release-locks-'))
  try {
    mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true })
    for (const script of ['check-export-boundary.mjs', 'check-source-imports.mjs', 'release-migration.mjs']) {
      copyFileSync(path.join(root, 'scripts', script), path.join(fixtureRoot, 'scripts', script))
    }
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/Apache-2.0.txt', apacheLicenseTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/NOTICE.txt', noticeTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/NOTICE.pi-runtime.txt', runtimeNoticeTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/THIRD_PARTY_NOTICES.md', thirdPartyNoticesTemplate)
    writeFixtureFile(fixtureRoot, 'scripts/legal/templates/TRADEMARKS.md', trademarksTemplate)
    for (const file of ['product.json', 'migration.json', 'README.md', 'publisher-verification.py']) {
      writeFixtureFile(fixtureRoot, `release/${file}`, readFileSync(path.join(root, 'release', file)))
    }
    // Exercise the real import gate in every license-state scenario. Preserve
    // original receipt/payload bytes rather than replacing the gate with a stub.
    for (const directory of ['packages/runtime', 'release/node', 'release/runtime']) {
      cpSync(path.join(root, directory), path.join(fixtureRoot, directory), { recursive: true, errorOnExist: true, force: false })
    }
    for (const component of ['runtime', 'node']) writeFixtureFile(fixtureRoot, `.github/workflows/${component}-release.yml`, readFileSync(path.join(root, `.github/workflows/${component}-release.yml`)))
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

test('direct preview publishing fails closed on environment, provenance, and license policy', () => {
  const publishJob = workflow.indexOf('\n  publish:')
  const policyGuard = workflow.indexOf(
    'NPM_RELEASE_POLICY_VERSION: ${{ vars.NPM_RELEASE_POLICY_VERSION }}',
    publishJob,
  )
  const publicRepositoryGuard = workflow.indexOf(
    'RELEASE_REPOSITORY_PRIVATE: ${{ github.event.repository.private }}',
    publishJob,
  )
  const sourceCheckout = workflow.indexOf(
    'Check out the exact reviewed source for legal-file comparison',
    publishJob,
  )
  const environmentGuard = workflow.indexOf(
    'Recheck public visibility and protected release-environment rules',
    sourceCheckout,
  )
  const licenseGuard = workflow.indexOf('Refuse unresolved package licenses before publishing', publishJob)
  const archiveSizeGuard = workflow.indexOf("if (key === 'physicalsystems') assertProductArchiveSize(bytes.length)", publishJob)
  const bootstrapGuard = workflow.indexOf(
    'Require the published runtime and an unpublished Physical Systems candidate',
    publishJob,
  )
  const firstPublish = workflow.indexOf('npm publish "./$RELEASE_ARTIFACT_DIRECTORY/physicalsystems-0.2.3.tgz"', publishJob)

  assert.ok(publishJob >= 0)
  assert.ok(policyGuard > publishJob)
  assert.ok(publicRepositoryGuard > policyGuard)
  assert.ok(sourceCheckout > publicRepositoryGuard)
  assert.ok(environmentGuard > sourceCheckout)
  assert.ok(archiveSizeGuard > environmentGuard)
  assert.ok(licenseGuard > archiveSizeGuard)
  assert.ok(bootstrapGuard > licenseGuard)
  assert.ok(firstPublish > bootstrapGuard)
  assert.match(workflow, /"\$NPM_RELEASE_POLICY_VERSION" != "v3-physicalsystems-preview"/)
  assert.match(workflow, /"\$RELEASE_REPOSITORY_PRIVATE" != "false"/)
  assert.match(workflow, /environments\/npm-release/)
  assert.match(workflow, /type === 'required_reviewers'/)
  assert.match(workflow, /reviewerRule\?\.reviewers\?\.length >= 1/)
  assert.match(workflow, /environment\.can_admins_bypass/)
  assert.match(workflow, /deployment-branch-policies\?per_page=100/)
  assert.match(workflow, /policies\.total_count,[\s\S]{0,30}1/)
  assert.match(workflow, /\[\{ name: 'main', type: 'branch' \}\]/)
  const publishBeforeCheckout = workflow.slice(publishJob, sourceCheckout)
  assert.match(publishBeforeCheckout, /permissions:\s*\n\s+contents: read/)
  assert.match(publishBeforeCheckout, /actions: read/)
  assert.doesNotMatch(publishBeforeCheckout, /(?:contents|actions|deployments|administration): write/)
  assert.match(publishBeforeCheckout, /id-token: write/)
  const publishBeforeLicense = workflow.slice(sourceCheckout, licenseGuard)
  assert.match(
    publishBeforeLicense,
    /uses: actions\/checkout@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/,
  )
  assert.match(publishBeforeLicense, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(publishBeforeLicense, /fetch-depth: 1/)
  assert.match(publishBeforeLicense, /persist-credentials: false/)
  assert.match(workflow, /\['-xOf', path\.join\(directory, filename\), 'package\/package\.json'\]/)
  assert.match(workflow, /packedPackage\.private, true/)
  assert.match(workflow, /license: 'MIT'/)
  assert.match(workflow, /license: 'Apache-2\.0'/)
  assert.match(workflow, /\['LICENSE', 'NOTICE', 'SBOM\.cdx\.json', 'THIRD_PARTY_NOTICES\.md'\]/)
  assert.match(workflow, /\['LICENSE', 'NOTICE', 'SBOM\.cdx\.json', 'UPSTREAM\.md', 'THIRD_PARTY_NOTICES\.md', 'UPSTREAM_README\.md'\]/)
  assert.match(workflow, /packed \$\{legalFile\} must match the reviewed source bytes/)
  assert.match(workflow, /readFileSync\(path\.join\(sourceDirectory, legalFile\)\)/)
  assert.match(workflow, /maxBuffer: 64 \* 1024 \* 1024/)
  for (const filename of [
    'tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz',
    'physicalsystems-0.2.3.tgz',
  ]) {
    assert.match(workflow.slice(licenseGuard, firstPublish), new RegExp(filename.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(workflow.slice(0, publishJob), /UNLICENSED/)
  assert.doesNotMatch(packageChecker, /must declare its intended release license/)
  const dispatchInputs = workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:'))
  assert.deepEqual([...dispatchInputs.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]), ['coordinator_id', 'expected_head_sha'])
  assert.match(workflow, /test "\$EXPECTED_HEAD_SHA" = "\$GITHUB_SHA"/)
  assert.doesNotMatch(dispatchInputs, /(?:version|token|artifact|publish_mode):/)
  assert.doesNotMatch(
    workflow,
    /allow-private|license-override|policy-override|acknowledge-private|acknowledge-provenance/i,
  )

  assert.match(releaseGuide, /NPM_RELEASE_POLICY_VERSION=v3-physicalsystems-preview/)
  assert.match(releaseGuide, /Keep the canonical source repository public for npm provenance/)
  assert.match(releaseGuide, /Configure the npm trusted publisher/)
  assert.match(releaseGuide, /exact `main` branch/)
  assert.match(releaseGuide, /Local packing and tests[\s\S]{0,30}never publish/)
})

test('preview update preflight accepts the existing release and rejects unexpected tag changes', () => {
  const guard = workflow.match(/const tags = JSON\.parse\(process\.env\.PHYSICALSYSTEMS_TAGS_JSON\)([\s\S]*?)const \[packed\]/)
  assert.ok(guard, 'exercise the actual pre-publication tag assertion')
  const check = (tags) => spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; const tags = JSON.parse(process.env.PHYSICALSYSTEMS_TAGS_JSON); ${guard[1]}`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PHYSICALSYSTEMS_TAGS_JSON: JSON.stringify(tags) },
  })
  const prior = JSON.parse(readFileSync(path.join(root, 'release/product.json'), 'utf8')).previousTags
  const accepted = check(prior)
  assert.equal(accepted.status, 0, accepted.stderr)
  for (const rejected of [
    { bootstrap: '0.0.0', latest: '0.0.0' },
    { ...prior, preview: '0.2.0' },
    { ...prior, preview: '0.2.3' },
    { ...prior, latest: '0.2.0' },
    { ...prior, bootstrap: '0.2.0' },
    { ...prior, unexpected: '0.2.0' },
  ]) {
    assert.notEqual(check(rejected).status, 0, JSON.stringify(rejected))
  }
})

test('namespace bootstraps are inert, the runtime is reused, and only physicalsystems is published', () => {
  const bootstrapGuard = workflow.indexOf(
    'Require the published runtime and an unpublished Physical Systems candidate',
  )
  const physicalsystemsExistence = workflow.indexOf(
    "npm view 'physicalsystems@0.0.0' name version license publishConfig",
    bootstrapGuard,
  )
  const physicalsystemsTag = workflow.indexOf(
    'npm view physicalsystems dist-tags --json',
    physicalsystemsExistence,
  )
  const packageExistence = workflow.indexOf(
    "npm view '@tinyedge/pi-runtime@0.0.0' name version license publishConfig",
    bootstrapGuard,
  )
  const bootstrapTag = workflow.indexOf(
    "npm view '@tinyedge/pi-runtime' dist-tags --json",
    packageExistence,
  )
  const publishedRuntime = workflow.indexOf(
    'npm view "@tinyedge/pi-runtime@$PI_RUNTIME_VERSION" name version dist --json',
    bootstrapTag,
  )
  const candidateE404 = workflow.indexOf(
    'check_unpublished \'physicalsystems\' "$RELEASE_VERSION" physicalsystems',
    bootstrapTag,
  )
  const runtimePublish = workflow.indexOf(
    'npm publish "./$RELEASE_ARTIFACT_DIRECTORY/tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz"',
  )
  const physicalsystemsPublish = workflow.indexOf(
    'npm publish "./$RELEASE_ARTIFACT_DIRECTORY/physicalsystems-0.2.3.tgz"',
    candidateE404,
  )

  assert.ok(bootstrapGuard >= 0)
  assert.ok(physicalsystemsExistence > bootstrapGuard)
  assert.ok(physicalsystemsTag > physicalsystemsExistence)
  assert.ok(packageExistence > bootstrapGuard)
  assert.ok(bootstrapTag > packageExistence)
  assert.ok(candidateE404 > physicalsystemsTag)
  assert.ok(publishedRuntime > bootstrapTag)
  assert.equal(runtimePublish, -1)
  assert.ok(physicalsystemsPublish > publishedRuntime)
  assert.match(workflow, /tags\.bootstrap,\s*'0\.0\.0'/)
  assert.match(workflow, /tags\.latest,\s*process\.env\.PI_RUNTIME_VERSION/)
  assert.match(workflow, /tags\.preview,\s*process\.env\.PI_RUNTIME_VERSION/)
  assert.match(workflow, /packed runtime tarball must match the already-published registry artifact/)
  assert.match(workflow, /tags\.latest, '0\.0\.0'/)
  assert.match(workflow, /tags\.bootstrap, '0\.0\.0'/)
  assert.match(workflow, /this release reuses it and must not republish it/)
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
  assert.match(workflow, /namespace bootstrap must contain only its license/)
  assert.match(workflow, /this workflow[\s\S]{0,100}never republishes it/i)
  assert.match(workflow, /Automatic provenance applies to physicalsystems@0\.2\.3/)

  assert.match(releaseGuide, /scripts\/npm-bootstrap\/physicalsystems-0\.0\.0/)
  assert.match(releaseGuide, /no command, code, dependencies,\s+bundles, or lifecycle scripts/)
  assert.match(releaseGuide, /PI_RUNTIME_BOOTSTRAP_INTEGRITY/)
  assert.match(releaseGuide, /PI_RUNTIME_BOOTSTRAP_SHASUM/)
  assert.match(releaseGuide, /PHYSICALSYSTEMS_BOOTSTRAP_INTEGRITY/)
  assert.match(releaseGuide, /PHYSICALSYSTEMS_BOOTSTRAP_SHASUM/)
  assert.match(releaseGuide, /publish PATH_TO_PHYSICALSYSTEMS_0\.0\.0_TARBALL/)
  assert.match(releaseGuide, /interactive exception[\s\S]{0,140}not an\s+alternate route for application code/)
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
  assert.match(runtimeBootstrapRegistryErratum, /`latest` resolved to the same exact inert `0\.0\.0` bytes/)
  assert.match(runtimeBootstrapRegistryErratum, /`preview` was absent/)
  assert.match(runtimeBootstrapRegistryErratum, /`bootstrap` remains pinned to the inert `0\.0\.0` artifact/)
  assert.match(runtimeBootstrapRegistryErratum, /`preview` and `latest` both resolve to the audited/)
  assert.match(
    runtimeBootstrapRegistryErratum,
    /sha512-uYd5UDXq76shmjwrszLmxzKXm163VHl8yHEzrAEaDjXD1QrrHtlRKh2T\+CbrDXWgS0Q\/HpUYgKkA5zrkUcG3Hg==/,
  )
  assert.match(runtimeBootstrapRegistryErratum, /d5ad1e7bbd5b82e04211dbf6b81750cdd90a0380/)
})

test('the physicalsystems namespace bootstrap is inert and reproducible from source', () => {
  assert.equal(physicalsystemsBootstrapPackage.name, 'physicalsystems')
  assert.equal(physicalsystemsBootstrapPackage.version, '0.0.0')
  assert.equal(physicalsystemsBootstrapPackage.license, 'Apache-2.0')
  assert.deepEqual(physicalsystemsBootstrapPackage.publishConfig, { access: 'public' })
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
    assert.equal(physicalsystemsBootstrapPackage[forbiddenField], undefined)
  }
  assert.deepEqual(
    readdirSync(physicalsystemsBootstrapDirectory).sort(),
    ['LICENSE', 'README.md', 'package.json'],
  )
  assert.deepEqual(physicalsystemsBootstrapPackage.files, ['LICENSE', 'README.md'])
  assert.equal(
    readFileSync(path.join(physicalsystemsBootstrapDirectory, 'LICENSE'), 'utf8').replace(/\r\n?/g, '\n').trimEnd(),
    apacheLicenseTemplate.replace(/\r\n?/g, '\n').trimEnd(),
  )
})

test('one candidate is reused for Windows, Ubuntu, npm 11/12, and direct preview publishing', () => {
  assert.match(workflow, /run release:prepare --/)
  assert.match(workflow, /run release:verify --/)
  assert.match(workflow, /runner: windows-latest/)
  assert.match(workflow, /runner: windows-11-arm/)
  assert.match(workflow, /runner: ubuntu-22\.04/)
  assert.match(workflow, /runner: ubuntu-24\.04/)
  assert.match(workflow, /npm-version: 11\.19\.0/)
  assert.match(workflow, /npm-version: 12\.0\.2/)
  assert.match(workflow, /node-version: 24\.15\.0/)
  const windows = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  verify-linux:'))
  const linux = workflow.slice(workflow.indexOf('\n  verify-linux:'), workflow.indexOf('\n  verify-unsupported-node:'))
  assert.deepEqual([...windows.matchAll(/- architecture: ([^\r\n]+)\r?\n\s+runner: ([^\r\n]+)\r?\n\s+npm-version: ([^\r\n]+)\r?\n\s+node-version: ([^\r\n]+)/g)]
    .map((match) => match.slice(1)), [
    ['x64', 'windows-latest', '11.19.0', '22.19.0'],
    ['x64', 'windows-latest', '12.0.2', '24.15.0'],
    ['arm64', 'windows-11-arm', '11.19.0', '22.19.0'],
    ['arm64', 'windows-11-arm', '12.0.2', '24.15.0'],
  ], 'Keep all four Windows release qualification cases')
  assert.deepEqual([...linux.matchAll(/- runner: ([^\r\n]+)\r?\n\s+npm-version: ([^\r\n]+)\r?\n\s+node-version: ([^\r\n]+)\r?\n\s+python-version: '([^']+)'/g)]
    .map((match) => match.slice(1)), [
    ['ubuntu-22.04', '11.19.0', '22.19.0', '3.10'],
    ['ubuntu-22.04', '12.0.2', '24.15.0', '3.10'],
    ['ubuntu-24.04', '11.19.0', '22.19.0', '3.12'],
    ['ubuntu-24.04', '12.0.2', '24.15.0', '3.12'],
  ], 'Keep all four Ubuntu release qualification cases')
  for (const native of [windows, linux]) {
    assert.match(native, /needs: build/)
    assert.match(native, /--require-downloadable-node/)
    assert.doesNotMatch(native, /continue-on-error/)
  }
  assert.match(workflow, /RELEASE_VERSION: 0\.2\.3/)
  assert.match(workflow, /PI_RUNTIME_VERSION: 0\.84\.2-tinyedge\.1/)
  assert.match(workflow, /endsWith\([\s\S]{0,120}physicalsystems@\$\{process\.env\.RELEASE_VERSION\}/)
  assert.match(workflow, /node -p 'process\.arch'/)
  assert.match(workflow, /processArchitecture = \(node -p 'process\.arch'\)\.Trim\(\)/)
  assert.match(workflow, /publish:\n[\s\S]{0,260}needs:\n\s+- build\n\s+- verify\n\s+- verify-linux\n\s+- verify-unsupported-node/)

  const publish = workflow.indexOf('npm publish "./$RELEASE_ARTIFACT_DIRECTORY/physicalsystems-0.2.3.tgz" --registry="$NPM_REGISTRY" --provenance --tag preview')
  assert.ok(publish >= 0)
  assert.equal(
    workflow.indexOf('npm publish "./$RELEASE_ARTIFACT_DIRECTORY/tinyedge-pi-runtime-0.84.2-tinyedge.1.tgz"'),
    -1,
  )

  assert.doesNotMatch(workflow, /npm\s+stage\s+publish/)
  assert.doesNotMatch(workflow, /--tag\s+latest/)
  const publishCommands = workflow.match(/^\s*npm publish[^\n]+/gm) || []
  assert.equal(publishCommands.length, 1)
  for (const command of publishCommands) {
    assert.match(command, /npm publish "\.\/\$RELEASE_ARTIFACT_DIRECTORY\//)
    assert.doesNotMatch(command, /npm publish "\$RELEASE_ARTIFACT_DIRECTORY\//)
    assert.match(
      command,
      /--registry="\$NPM_REGISTRY" --provenance --tag preview --access public/,
    )
  }
  const liveVisibility = workflow.indexOf('Recheck public visibility and protected release-environment rules')
  assert.ok(liveVisibility >= 0)
  assert.ok(liveVisibility < publish)
  assert.match(workflow, /repository\.private, false/)
  assert.match(workflow, /repository\.visibility, 'public'/)
  assert.match(workflow, /github\.run_attempt/)
  assert.match(workflow, /npm audit signatures/)
  assert.match(workflow, /npm install --ignore-scripts --no-audit --no-fund/)
  assert.doesNotMatch(workflow, /npm install --ignore-scripts --force/)
  assert.doesNotMatch(workflow, /npm install --package-lock-only/)
  assert.match(workflow, /verification_succeeded=false/)
  assert.match(workflow, /Registry convergence failed/)
  assert.match(workflow, /publishing preview must not move the inert initial latest tag/)
  assert.match(workflow, /preview must resolve to 0\.2\.3/)
  assert.match(workflow, /SLSA v1 provenance predicate/)
  assert.match(workflow, /manifest-sha256: \$\{\{ steps\.candidate\.outputs\.manifest-sha256 \}\}/)
  assert.match(workflow, /EXPECTED_MANIFEST_SHA256: \$\{\{ needs\.build\.outputs\.manifest-sha256 \}\}/)
  assert.match(workflow, /downloaded release manifest must match the trusted build-job digest/)
  assert.match(workflow, /Downloaded release manifest digest/)
  assert.match(workflow, /packedPackage\.publishConfig,[\s\S]{0,80}\{ access: 'public' \}/)
})

test('unsupported Node fails before application imports and blocks publication', () => {
  assert.doesNotMatch(launcher, /^import\s/m)
  assert.match(launcher, /minimumNodeVersion = \[22, 19, 0\]/)
  assert.match(launcher, /Physical Systems requires Node\.js 22\.19\.0 or newer/)
  assert.match(launcher, /import\('\.\.\/src\/index\.js'\)/)
  assert.match(launcher, /import\('\.\.\/src\/cli\.js'\)/)
  assert.doesNotMatch(launcher, /failed to start: \$\{(?:error|message)/)
  assert.match(unsupportedNodeCheck, /result\.status, 1/)
  assert.match(unsupportedNodeCheck, /result\.stdout, ''/)
  assert.match(unsupportedNodeCheck, /SyntaxError\|src/)

  const pullRequestTests = cliWorkflow.indexOf('\n  test:')
  assert.ok(pullRequestTests >= 0)
  const pullRequestSlice = cliWorkflow.slice(pullRequestTests)
  assert.match(pullRequestSlice, /name: test \(\$\{\{ matrix\.check_name \}\}\)/)
  assert.match(pullRequestSlice, /if: matrix\.check_name == 'linux x64'/)
  assert.match(pullRequestSlice, /node-version: 12\.22\.9/)
  assert.match(pullRequestSlice, /node packages\/cli\/scripts\/check-unsupported-node\.cjs/)
  assert.doesNotMatch(pullRequestSlice, /continue-on-error/)

  const releaseGuard = workflow.indexOf('\n  verify-unsupported-node:')
  const publishJob = workflow.indexOf('\n  publish:', releaseGuard)
  assert.ok(releaseGuard >= 0)
  assert.ok(publishJob > releaseGuard)
  const releaseSlice = workflow.slice(releaseGuard, publishJob)
  assert.match(releaseSlice, /needs: build/)
  assert.match(releaseSlice, /node-version: 12\.22\.9/)
  assert.match(releaseSlice, /npm@8\.5\.1/)
  assert.match(releaseSlice, /name: \$\{\{ needs\.build\.outputs\.artifact-name \}\}/)
  assert.match(releaseSlice, /EXPECTED_MANIFEST_SHA256: \$\{\{ needs\.build\.outputs\.manifest-sha256 \}\}/)
  assert.match(releaseSlice, /manifest\.schemaVersion, 1/)
  assert.match(releaseSlice, /manifest\.version, process\.env\.RELEASE_VERSION/)
  assert.match(releaseSlice, /manifest\.commit, process\.env\.GITHUB_SHA/)
  assert.match(releaseSlice, /createHash\('sha256'\)/)
  assert.match(releaseSlice, /artifact\.sha256/)
  assert.match(
    releaseSlice,
    /check-unsupported-node\.cjs "\$unpacked\/package\/bin\/physicalsystems\.js"/,
  )
  assert.match(releaseSlice, /npm exec --yes --package="\$artifact_path" -- physicalsystems/)
  assert.match(releaseSlice, /test "\$status" -eq 1/)
  assert.match(releaseSlice, /test ! -s "\$stdout"/)
  assert.match(releaseSlice, /Physical Systems requires Node\.js 22\.19\.0 or newer \(detected 12\.22\.9\)/)
  assert.match(releaseSlice, /grep -E 'SyntaxError\|src\[\/\\\\\]auth/)
  assert.doesNotMatch(releaseSlice, /continue-on-error/)
  assert.match(
    workflow.slice(publishJob, workflow.indexOf('\n    if:', publishJob)),
    /- verify-unsupported-node/,
  )
})

test('release verification uses real npm lifecycle and platform command shims', () => {
  assert.deepEqual(cliPackage.bin, { physicalsystems: 'bin/physicalsystems.js' })
  assert.equal(cliPackage.dependencies['@tinyedge/cli'], undefined)
  assert.equal(cliPackage.bundleDependencies, true)
  assert.doesNotMatch(packageChecker, /'install',\s*'--ignore-scripts'/)
  assert.doesNotMatch(workflow, /npm ci --prefix packages\/cli/)
  const prepare = readFileSync(path.join(root, 'scripts/prepare-product-candidate.mjs'), 'utf8')
  assert.match(workflow, /Prepare one small product with pinned backend manifests/)
  assert.ok(
    prepare.indexOf("runNpm(['run', 'bootstrap:pi-runtime'")
      < prepare.indexOf("runNpm(['run', 'release:pack'"),
    'the reviewed dependency tree must be installed before npm pack bundles it',
  )
  assert.match(packageChecker, /function npmFileSpec\(file\)/)
  assert.match(packageChecker, /file:\$\{path\.resolve\(file\)\.replaceAll\('\\\\', '\/'\)\}/)
  assert.match(packageChecker, /const localDependencies = \{ physicalsystems: npmFileSpec\(physicalSystemsArtifact\.file\) \}/)
  assert.match(packageChecker, /verification must reproduce the advertised one-package install/)
  assert.match(packageChecker, /'--offline'/)
  assert.match(packageChecker, /local-npm-cache/)
  assert.match(packageChecker, /global-npm-cache/)
  assert.match(packageChecker, /const npmExecRoot = mkdtempSync\(path\.join\(realpathSync\.native\(tmpdir\(\)\), 'physicalsystems-npm-exec-'\)\)/)
  assert.match(packageChecker, /npm exec verification must start without a local dependency tree/)
  assert.match(packageChecker, /cwd: npmExecRoot/)
  assert.match(packageChecker, /npm exec must materialize the packed artifact in its isolated cache/)
  const npmExecVerificationStart = packageChecker.indexOf('const [, npxReportedVersion] = await runConcurrentChecks([')
  const npmExecVerificationEnd = packageChecker.indexOf(
    'assert.equal(npxReportedVersion',
    npmExecVerificationStart,
  )
  assert.ok(npmExecVerificationStart >= 0 && npmExecVerificationEnd > npmExecVerificationStart)
  const npmExecVerification = packageChecker.slice(
    npmExecVerificationStart,
    npmExecVerificationEnd,
  )
  assert.match(npmExecVerification, /'--offline'/)
  assert.match(npmExecVerification, /'--no-audit'/)
  assert.match(npmExecVerification, /'--no-fund'/)
  assert.match(npmExecVerification, /'--timing'/)
  assert.match(npmExecVerification, /timeout: NPM_EXEC_TIMEOUT_MS/)
  assert.doesNotMatch(npmExecVerification, /'--prefer-offline'/)
  assert.doesNotMatch(npmExecVerification, /'--ignore-scripts'/)
  assert.match(packageChecker, /'node_modules\/@tinyedge\/pi-runtime'/)
  assert.match(packageChecker, /function commandShim\(directory\)/)
  assert.match(packageChecker, /assertCommandShimTargets\(localShim, localEntry/)
  assert.match(packageChecker, /assertCommandShimTargets\(globalShim, globalEntry/)
  assert.match(packageChecker, /\[localEntry, '--version'\]/)
  assert.match(packageChecker, /\[globalEntry, '--version'\]/)
  assert.match(packageChecker, /'--global',\s*'--prefix'/)
  assert.match(packageChecker, /function globalCommandShim\(prefix\)/)
  assert.match(packageChecker, /function globalNodeModulesDirectory\(prefix\)/)
  assert.match(packageChecker, /local\/global\/npm-exec commands/)
  assert.match(packageChecker, /check-linux-harness-pty\.py/)
  assert.match(packageChecker, /createLinuxSecretServiceSecretStore/)
  assert.match(
    packageChecker,
    /path\.join\(installedPhysicalSystemsDirectory, 'src\/auth\/secret-store\.js'\)/,
  )
  assert.doesNotMatch(packageChecker, /installedTinyEdgeDirectory/)
  assert.match(packageChecker, /const NPM_INSTALL_TIMEOUT_MS = 10 \* 60_000/)
  assert.match(
    packageChecker,
    /const NPM_EXEC_TIMEOUT_MS = process\.platform === 'win32' && process\.arch === 'x64'[\s\S]{0,80}\? 15 \* 60_000[\s\S]{0,80}: NPM_INSTALL_TIMEOUT_MS/,
  )
  assert.equal((packageChecker.match(/timeout: NPM_INSTALL_TIMEOUT_MS/g) || []).length, 2)
  assert.equal((packageChecker.match(/timeout: NPM_EXEC_TIMEOUT_MS/g) || []).length, 1)
  assert.match(packageChecker, /phase: 'local npm install'/)
  assert.match(packageChecker, /phase: 'isolated npm exec'/)
  assert.match(packageChecker, /phase: 'global npm install'/)
  assert.match(
    packageChecker,
    /if \(result\.error\)[\s\S]{0,500}result\.error\.message[\s\S]{0,500}result\.stdout\?\.trim\(\)[\s\S]{0,500}result\.stderr\?\.trim\(\)/,
  )
  assert.match(packageChecker, /Completed \$\{phase\} in \$\{elapsedMs\} ms/)
})

test('Windows release verifier resolves substituted temporary drives for every install path and cleanup', { skip: process.platform !== 'win32' }, (t) => {
  const base = realpathSync.native(tmpdir())
  const fixture = mkdtempSync(path.join(base, 'ps-release-temp-'))
  t.after(() => {
    assert.equal(path.dirname(fixture), base)
    assert.equal(realpathSync.native(fixture), fixture)
    assert.ok(path.basename(fixture).startsWith('ps-release-temp-'))
    rmSync(fixture, { recursive: true, force: true })
  })
  let drive
  for (const letter of 'ZYXWVUTSR') {
    try { lstatSync(`${letter}:\\`) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      drive = `${letter}:`; break
    }
  }
  assert.ok(drive, 'A free drive letter is required for the Windows path-alias regression')
  // Exercise the real verifier expressions without invoking npm, a server, or
  // the CLI's top-level packaging entrypoint. Keep the strict bundle checker real.
  const allocations = [...packageChecker.matchAll(/const (extractionRoot|temporaryRoot|npmExecRoot|temporaryArtifacts) = (mkdtempSync\([^\r\n]+\))/g)]
  assert.deepEqual(allocations.map((match) => match[1]), ['extractionRoot', 'temporaryRoot', 'npmExecRoot', 'temporaryArtifacts'])
  const cleanupStart = packageChecker.indexOf('function removeTemporaryDirectory(directory) {')
  assert.ok(cleanupStart >= 0)
  const cleanup = packageChecker.slice(cleanupStart).match(/^function removeTemporaryDirectory\(directory\) \{[\s\S]*?\r?\n\}/)?.[0]
  assert.ok(cleanup, 'The verifier cleanup function must be extractable with LF or CRLF source')
  const bundleModule = pathToFileURL(path.join(root, 'packages/cli/src/physical/node-bundle.js')).href
  const exercises = allocations.map(([declaration, name]) => `{
    ${declaration};
    const directory = ${name};
    try {
      for (const layout of ['node_modules/physicalsystems/node-bundle', 'global-prefix/node_modules/physicalsystems/node-bundle', 'npm-cache/_npx/fixture/node_modules/physicalsystems/node-bundle']) {
        const bundle = path.join(directory, layout);
        mkdirSync(bundle, { recursive: true });
        await bundleDirectory(bundle);
      }
      assert.equal(path.dirname(directory), expectedBase);
      assert.equal(realpathSync.native(directory), directory);
    } finally {
      const resolved = realpathSync.native(directory);
      assert.equal(path.dirname(resolved), expectedBase);
      assert.match(path.basename(resolved), /^(tinyedge|physicalsystems)-/);
      removeTemporaryDirectory(directory);
    }
    assert.equal(existsSync(directory), false);
  }`).join('\n')
  const code = `
    import assert from 'node:assert/strict';
    import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { bundleDirectory } from ${JSON.stringify(bundleModule)};
    const expectedBase = process.argv[1];
    assert.notEqual(realpathSync(tmpdir()), realpathSync.native(tmpdir()));
    ${cleanup}
    ${exercises}
    const keep = path.join(expectedBase, 'keep-unowned-directory');
    mkdirSync(keep);
    assert.throws(() => removeTemporaryDirectory(keep), /Unexpected release temporary directory/);
    assert.equal(existsSync(keep), true);
    const linked = path.join(expectedBase, 'tinyedge-release-verify-LINKED');
    symlinkSync(keep, linked, 'junction');
    try {
      await assert.rejects(bundleDirectory(linked), /must not use links or junctions/);
      assert.throws(() => removeTemporaryDirectory(linked), /Unexpected release temporary directory/);
      assert.equal(existsSync(keep), true);
    } finally {
      assert.equal(path.dirname(linked), expectedBase);
      assert.equal(lstatSync(linked).isSymbolicLink(), true);
      unlinkSync(linked);
    }
  `
  execFileSync('subst', [drive, fixture], { windowsHide: true })
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, fixture], {
      env: { ...process.env, TMP: `${drive}\\`, TEMP: `${drive}\\` },
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  } finally { execFileSync('subst', [drive, '/D'], { windowsHide: true }) }
})

test('the published physicalsystems package carries the reviewed dependency closure', () => {
  assert.equal(cliShrinkwrap, cliPackageLock)
  assert.equal(cliPackage.bundleDependencies, true)
  assert.ok(cliPackage.files.includes('npm-shrinkwrap.json'))
  assert.equal(cliPackage.files.includes('RELEASE.md'), false)
  assert.match(packageChecker, /REVIEWED_PI_VERSION = '0\.84\.2'/)
  assert.match(packageChecker, /PI_RUNTIME_VERSION = '0\.84\.2-tinyedge\.1'/)
  assert.match(packageChecker, /RELEASE_NPM_VERSION = '11\.19\.0'/)
  assert.match(packageChecker, /CONSUMER_NPM_VERSIONS = new Set\(\[RELEASE_NPM_VERSION, '12\.0\.2'\]\)/)
  assert.match(packageChecker, /release packaging requires npm/)
  assert.match(packageChecker, /consumer verification requires one of npm/)
  assert.match(packageChecker, /the physicalsystems tarball must bundle direct dependency/)
  assert.match(packageChecker, /npm pack must account for every top-level bundled dependency/)
  assert.match(packageChecker, /exactly the reviewed name\/version dependency identities/)
  assert.match(packageChecker, /FORBIDDEN_RUNTIME_PACKAGES/)
  assert.match(packageChecker, /@silvia-odwyer\/photon-node/)
  assert.match(packageChecker, /@mariozechner\/clipboard/)
  assert.match(packageChecker, /isForbiddenInstalledPackage/)
  assert.doesNotMatch(packageChecker, /missing Pi clipboard loader/)
  assert.match(packageChecker, /peerDependenciesMeta/)
  assert.match(packageChecker, /physicalsystems must own its command directly/)
  assert.match(packageChecker, /the physicalsystems tarball must contain its reviewed npm-shrinkwrap\.json/)
  assert.match(packageChecker, /the internal release checklist must not be published/)
  assert.match(packageChecker, /packed \$\{legalFile\} must match the reviewed source bytes/)
  assert.match(packageChecker, /ignore LICENSE-MIT bytes drifted/)
})

test('the compatibility runtime is an exact MIT artifact without default native extras', () => {
  assert.equal(piRuntimePackage.name, '@tinyedge/pi-runtime')
  assert.equal(piRuntimePackage.version, '0.84.2-tinyedge.1')
  assert.equal(piRuntimePackage.repository?.url, 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git')
  assert.equal(piRuntimePackage.homepage, 'https://github.com/TinyEdgeAI/tinyedge-edge/tree/main/packages/pi-runtime#readme')
  assert.equal(piRuntimePackage.bugs?.url, 'https://github.com/TinyEdgeAI/tinyedge-edge/issues')
  assert.deepEqual(piRuntimePackage.publishConfig, { access: 'public' })
  const lockedRuntime = parsedCliPackageLock.packages['node_modules/@tinyedge/pi-runtime']
  assert.equal(lockedRuntime.version, '0.84.2-tinyedge.1')
  assert.equal(
    lockedRuntime.resolved,
    'https://registry.npmjs.org/@tinyedge/pi-runtime/-/pi-runtime-0.84.2-tinyedge.1.tgz',
  )
  assert.equal(
    lockedRuntime.integrity,
    'sha512-k51lJ+KuNHodGgwBpgQuo+7VyKmFuzToGVBIdmjJgcuEJ7wbIFvMD+456ApkuxS/9/zcqXnHu8MTD7CVrx9O7A==',
  )
  assert.notEqual(piRuntimePackage.private, true)
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
  assert.match(piRuntimeReadme, /manifest is publishable[\s\S]{0,180}protected workflow/i)
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

test('the clean export uses the standalone identity while preserving the frozen runtime artifact', () => {
  const expectedRepository = 'git+https://github.com/PhysicalSystems/physicalsystems.git'
  const expectedBugs = 'https://github.com/PhysicalSystems/physicalsystems/issues'
  assert.equal(cliPackage.repository.url, expectedRepository)
  assert.equal(cliPackage.bugs.url, expectedBugs)
  assert.deepEqual(cliPackage.publishConfig, { access: 'public' })
  assert.match(workflow, /GITHUB_REPOSITORY" = "PhysicalSystems\/physicalsystems"/)
  assert.match(releaseGuide, /repository `physicalsystems`/)
  assert.match(packageChecker, /PhysicalSystems\/physicalsystems\.git/)
  assert.equal(provenance.source, undefined)
  assert.equal(provenance.schemaVersion, 2)
  assert.equal(provenance.exportKind, 'public-clean-root-snapshot')
  assert.equal(
    provenance.destination.repository,
    'https://github.com/PhysicalSystems/physicalsystems.git',
  )
  assert.equal(provenance.destination.status, 'public-canonical')
  assert.match(provenance.candidatePayload.canonicalization, /normalize CRLF or CR to LF/)
  assert.doesNotMatch(JSON.stringify(provenance), /branchAtExport|sourceCommitTimestamp|gitObject/)
})

test('released documentation is truthful and the export boundary is executable', () => {
  assert.match(rootReadme, /historical `tinyedge` names above are immutable npm identities/i)
  assert.match(rootReadme, /npx --yes physicalsystems@preview/)
  assert.match(rootReadme, /publishes reviewed application builds on the `preview` tag/)
  assert.match(rootReadme, /npm view physicalsystems@preview version --json/)
  assert.match(rootReadme, /does not contain a hosted control plane/)
  assert.match(rootReadme, /DEVELOPMENT\.md/)
  assert.match(rootReadme, /licensed under Apache License 2\.0/i)
  assert.match(developmentGuide, /checkout --detach b6cf55f6adf3b953d0e5e00a4049444e300e3af8/)
  assert.doesNotMatch(developmentGuide, /\|\s*bash/)
  assert.match(rootReadme, /Publication is restricted[\s\S]{0,120}main-only OIDC workflow[\s\S]{0,160}only[\s\S]{0,30}`physicalsystems` to `preview`/i)
  assert.match(releaseGuide, /Package transition/)
  assert.match(releaseGuide, /rollback/)
  assert.match(releaseGuide, /npm audit signatures/)
  assert.match(releaseGuide, /npm install --ignore-scripts --no-audit --no-fund physicalsystems@0\.2\.3/)
  assert.match(releaseGuide, /Configure the npm trusted publisher/)
  assert.match(dependencyGuide, /npm 12 ignores a dependency[\s\S]{0,30}package's shrinkwrap/)
  assert.match(dependencyGuide, /empty caches under npm 11\.19\.0 and npm 12\.0\.2/)
  assert.match(runtimeBootstrapRegistryErratum, /`bootstrap` remains pinned[\s\S]{0,160}`preview` and `latest` both resolve/)
  assert.match(dependencyGuide, /Physical Systems policy[\s\S]{0,100}one publishable `physicalsystems` candidate[\s\S]{0,120}direct OIDC workflow to `preview`/i)
  assert.match(dependencyGuide, /npm owner may technically[\s\S]{0,40}retain[\s\S]{0,160}outside the[\s\S]{0,30}approved procedure/i)
  assert.doesNotMatch(dependencyGuide, /NPM-RELEASE-PENDING\.md[\s\S]{0,100}private:\s*true/i)
  assert.match(reviewedInventorySource, /Direct publication is limited to preview[\s\S]{0,120}protected OIDC[\s\S]{0,40}workflow/i)
  assert.doesNotMatch(reviewedInventorySource, /publication lock[\s\S]{0,100}private package flags/i)
  assert.match(boundaryCheck, /unexpected top-level export entry/)
  assert.match(boundaryCheck, /local user path leaked/)
  assert.match(boundaryCheck, /must remain private while npm publication is pending/)
  assert.match(boundaryCheck, /must be publishable only after npm approval/)
  assert.match(boundaryCheck, /!licensePending \|\| npmReleasePending/)
  assert.match(workflow, /node scripts\/check-export-boundary\.mjs/)
  assert.match(cliWorkflow, /node scripts\/check-export-boundary\.mjs/)
})

test('the packed README describes the one-package physicalsystems 0.2.3 release', () => {
  assert.match(packedReadme, /tinyedge@0\.1\.3|`0\.1\.3` release/)
  assert.match(packedReadme, /0\.1\.5/)
  assert.doesNotMatch(
    packedReadme,
    /0\.2\.3[\s\S]{0,100}\b(?:candidate|unavailable|unpublished|not published)\b/i,
  )
  assert.match(packedReadme, /npx physicalsystems@0\.2\.3/)
  assert.match(packedReadme, /npm view physicalsystems@0\.2\.3 version --json/)
  assert.match(packedReadme, /npm install --global physicalsystems@0\.2\.3/)
  assert.match(packedReadme, /command opens the local-first operator Harness/i)
})

test('pull-request CI covers release-workflow changes and its regression test', () => {
  assert.doesNotMatch(cliWorkflow, /^\s+paths:/m)
  assert.match(cliWorkflow, /platform: linux/)
  assert.match(cliWorkflow, /runner: ubuntu-22\.04/)
  assert.match(cliWorkflow, /runner: ubuntu-24\.04/)
  assert.match(cliWorkflow, /Native source checks reuse the shared candidate's exact dependency tree/)
  assert.match(cliWorkflow, /check_name: windows x64/)
  assert.match(cliWorkflow, /check_name: windows arm64/)
  assert.match(cliWorkflow, /check_name: linux x64/)
  assert.match(cliWorkflow, /TINYEDGE_LINUX_SECRET_SERVICE_CANARY=1/)
  assert.match(cliWorkflow, /gnome-keyring-daemon --unlock --components=secrets/)
  assert.match(cliWorkflow, /libsecret-tools xdg-utils/)
  assert.match(cliWorkflow, /Prepare the small npm product with pinned backend manifests once/)
  assert.match(cliWorkflow, /physicalsystems-0\.2\.3-source-review-\$\{\{ github\.sha \}\}/)
  assert.deepEqual(cliPackage.os, ['win32', 'linux'])
  assert.match(cliWorkflow, /node --test test\/npm-release-workflow\.test\.mjs/)
  assert.match(cliWorkflow, /npm install --global "npm@11\.19\.0"/)
  assert.match(cliWorkflow, /run release:prepare -- --output \$productDirectory/)
  assert.match(cliWorkflow, /name: Check scoped Harness consent and readiness transcript regressions\r?\n\s+if: matrix.architecture == 'x64'\r?\n\s+run: python -B -m unittest discover -s packages\/cli\/test -p test_packaged_harness_transcript\.py -v/)
  assert.match(cliWorkflow, /npm run check:legal/)
  const bootstrapIndex = cliWorkflow.indexOf('run release:prepare -- --output $productDirectory')
  const legalIndex = cliWorkflow.indexOf('npm run check:legal')
  assert.notEqual(bootstrapIndex, -1)
  assert.notEqual(legalIndex, -1)
  assert.ok(bootstrapIndex < legalIndex, 'CI must install the exact reviewed dependency tree before verifying artifact-contained legal files')
  assert.doesNotMatch(cliWorkflow, /npm ci --prefix packages\/cli/)
  assert.doesNotMatch(cliWorkflow, /npm --prefix packages\/cli ci/)
  assert.match(cliWorkflow, /npm --prefix packages\/cli run check/)
  assert.match(cliWorkflow, /npm --prefix packages\/cli test/)
})
