#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { stageNodeBundle } from './node-bundle-stage.js'
import { verifyNodeBundle } from '../src/physical/node-bundle.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const NPM_CLI = process.env.npm_execpath
const RELEASE_NPM_VERSION = '11.19.0'
const CONSUMER_NPM_VERSIONS = new Set([RELEASE_NPM_VERSION, '12.0.2'])
const PHYSICAL_SYSTEMS_VERSION = '0.2.1'
const PI_RUNTIME_VERSION = '0.84.2-tinyedge.1'
const PACKAGES = [
  {
    key: 'pi-runtime',
    directory: 'packages/pi-runtime',
    name: '@tinyedge/pi-runtime',
    version: PI_RUNTIME_VERSION,
  },
  { key: 'physicalsystems', directory: 'packages/cli', name: 'physicalsystems' },
]
const FROZEN_PACKAGES = [
  { directory: 'packages/npx', name: 'tinyedge', version: '0.1.3' },
  { directory: 'packages/pi', name: '@tinyedge/pi', version: '0.1.3' },
]
const REVIEWED_PI_VERSION = '0.84.2'
const REVIEWED_PI_HOST_PACKAGE = '@earendil-works/pi-coding-agent'
const REVIEWED_PI_PACKAGES = new Set([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-client',
  '@earendil-works/pi-protocol',
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-tui',
])
const REVIEWED_PI_INTEGRITIES = new Map([
  ['@earendil-works/pi-agent-core', 'sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA=='],
  ['@earendil-works/pi-ai', 'sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig=='],
  ['@earendil-works/pi-client', 'sha512-/RFSPhD/bZbpOp1oJj+UneSUFSgZhWxzcSENUY+8+8xhoBrWXMYI2t77XNx4Yf+c8YK2qTHquForhNcelYpXvg=='],
  ['@earendil-works/pi-protocol', 'sha512-jbBh03fkeckWEroHpcZBr4w5/Ibat8WwdXFlXHivYQImrQNFtLpDeL0t1cku4hmK0q3pceIRQHkw4fwbM4YILQ=='],
  ['@earendil-works/pi-telemetry', 'sha512-wg5caea7uIv1BHRBm2Y116RvFG4oSAiP5qk9tA2463PDGIr4K8M1Ceyyg5DOpF/shUUl0gk826yQJAeAcHYB9g=='],
  ['@earendil-works/pi-tui', 'sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg=='],
])
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  '@mariozechner/clipboard',
  '@mariozechner/clipboard-win32-arm64-msvc',
  '@mariozechner/clipboard-win32-x64-msvc',
  '@silvia-odwyer/photon-node',
])
const OPTIONAL_RUNTIME_PEERS = new Map([
  ['@mariozechner/clipboard', '0.3.9'],
  ['@silvia-odwyer/photon-node', '0.3.4'],
])
const PI_RUNTIME_UPSTREAM_REPOSITORY = 'https://github.com/earendil-works/pi'
const PI_RUNTIME_UPSTREAM_COMMIT = '914cf1472e715297caa30db4b9535d534a9eb718'
const PI_RUNTIME_UPSTREAM_PACKAGE = '@earendil-works/pi-coding-agent@0.84.2'
const PI_RUNTIME_UPSTREAM_INTEGRITY = 'sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA=='
const PI_RUNTIME_UPSTREAM_SHASUM = 'e4d4c1e769963c816959f5cea02a0a10ccc0495a'
const APACHE_LICENSE_SOURCE = path.join(REPOSITORY_ROOT, 'scripts/legal/templates/Apache-2.0.txt')
const TINYEDGE_NOTICE_SOURCE = path.join(REPOSITORY_ROOT, 'scripts/legal/templates/NOTICE.txt')
const PI_RUNTIME_NOTICE_SOURCE = path.join(REPOSITORY_ROOT, 'scripts/legal/templates/NOTICE.pi-runtime.txt')
const THIRD_PARTY_NOTICES_SOURCE = path.join(REPOSITORY_ROOT, 'scripts/legal/templates/THIRD_PARTY_NOTICES.md')
const PACKED_LEGAL_FILES = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SBOM.cdx.json']
const IGNORE_LICENSE_EVIDENCE = Object.freeze({
  package: 'ignore@7.0.5',
  file: 'LICENSE-MIT',
  size: 1095,
  sha256: '9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0',
})
const EXPECTED_PI_RUNTIME_LICENSE = `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const REVIEWED_RUNTIME_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
])
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000
const NPM_EXEC_TIMEOUT_MS = process.platform === 'win32' && process.arch === 'x64'
  ? 15 * 60_000
  : NPM_INSTALL_TIMEOUT_MS

function run(command, args, options = {}) {
  const phase = options.phase
  const timeout = options.timeout ?? 300_000
  const startedAt = Date.now()
  if (phase) console.log(`Starting ${phase} (timeout ${timeout} ms)`)
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...options.env },
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  const elapsedMs = Date.now() - startedAt
  if (result.error) {
    const error = new Error([
      `${phase || 'command'} failed after ${elapsedMs} ms: ${result.error.message}`,
      `${command} ${args.join(' ')}`,
      `timeout: ${timeout} ms`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'), { cause: result.error })
    error.code = result.error.code
    throw error
  }
  if (result.status !== 0) {
    throw new Error([
      `${phase || 'command'} failed after ${elapsedMs} ms: ${command} ${args.join(' ')} exited with ${result.status}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'))
  }
  if (phase) console.log(`Completed ${phase} in ${elapsedMs} ms`)
  return result.stdout.trim()
}

function runBuffer(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPOSITORY_ROOT,
    env: { ...process.env, NO_COLOR: '1', ...options.env },
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 300_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited with ${result.status}`,
      result.stdout?.toString('utf8').trim(),
      result.stderr?.toString('utf8').trim(),
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

function runNpm(args, options = {}) {
  assert.ok(NPM_CLI, 'run this checker through an npm script so npm_execpath is available')
  return run(process.execPath, [NPM_CLI, ...args], options)
}

function runCommandShim(shim, args, options = {}) {
  if (process.platform === 'win32') {
    const commandInterpreter = process.env.ComSpec || 'cmd.exe'
    return run(commandInterpreter, ['/d', '/s', '/c', 'call', shim, ...args], options)
  }
  return run(shim, args, options)
}

function npmFileSpec(file) {
  return `file:${path.resolve(file).replaceAll('\\', '/')}`
}

function assertCommandShimTargets(shim, target, source) {
  if (process.platform === 'win32') {
    const normalizedShim = readFileSync(shim, 'utf8').replaceAll('\\', '/').toLowerCase()
    const relativeTarget = path.relative(path.dirname(shim), target).replaceAll('\\', '/').toLowerCase()
    assert.ok(
      normalizedShim.includes(relativeTarget),
      `${source} must target the packed tinyedge entry (${relativeTarget})`,
    )
    return
  }

  assert.equal(lstatSync(shim).isSymbolicLink(), true, `${source} must be an npm-created symlink`)
  assert.equal(realpathSync(shim), realpathSync(target), `${source} must target the packed tinyedge entry`)
  assert.notEqual(statSync(target).mode & 0o111, 0, `${source} target must be executable`)
}

function commandShim(directory) {
  return path.join(directory, process.platform === 'win32' ? 'physicalsystems.cmd' : 'physicalsystems')
}

function globalNodeModulesDirectory(prefix) {
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib/node_modules')
}

function globalPackageDirectory(prefix) {
  return path.join(globalNodeModulesDirectory(prefix), 'physicalsystems')
}

function globalCommandShim(prefix) {
  return process.platform === 'win32'
    ? path.join(prefix, 'physicalsystems.cmd')
    : path.join(prefix, 'bin/physicalsystems')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function findFiles(directory, predicate, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, result)
    else if (predicate(file)) result.push(file)
  }
  return result
}

function collectInstalledPackages(nodeModules, result = []) {
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      collectInstalledPackages(path.join(nodeModules, entry.name), result)
      continue
    }
    const packageDirectory = path.join(nodeModules, entry.name)
    const packageJson = path.join(packageDirectory, 'package.json')
    if (!existsSync(packageJson)) continue
    result.push({ directory: packageDirectory, metadata: readJson(packageJson) })
    const nestedNodeModules = path.join(packageDirectory, 'node_modules')
    if (existsSync(nestedNodeModules)) collectInstalledPackages(nestedNodeModules, result)
  }
  return result
}

function packageVersionIdentities(packages) {
  return [...new Set(packages
    .filter(({ name, version }) => name && version && name !== 'physicalsystems')
    .map(({ name, version }) => `${name}@${version}`))]
    .sort()
}

function reviewedVersionIdentities(lock) {
  return packageVersionIdentities(Object.entries(lock.packages || {})
    .filter(([packagePath]) => packagePath)
    .map(([packagePath, metadata]) => ({
      name: packageNameFromLockPath(packagePath),
      version: metadata.version,
    })))
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function sha512Integrity(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

function removeTemporaryDirectory(directory) {
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}

function packageMetadata(definition) {
  const directory = path.join(REPOSITORY_ROOT, definition.directory)
  const metadata = readJson(path.join(directory, 'package.json'))
  assert.equal(metadata.name, definition.name)
  return { ...definition, directory, metadata }
}

function packageNameFromLockPath(packagePath) {
  return packagePath.split('/node_modules/').at(-1)?.replace(/^node_modules\//, '')
}

function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').trim()
}

function isForbiddenInstalledPackage(name) {
  return name === REVIEWED_PI_HOST_PACKAGE
    || FORBIDDEN_RUNTIME_PACKAGES.has(name)
    || name?.startsWith('@mariozechner/clipboard')
}

function assertOptionalPeer(metadata, name, version, source) {
  assert.equal(
    metadata.peerDependencies?.[name],
    version,
    `${source} must declare ${name}@${version} only as an optional peer`,
  )
  assert.equal(
    metadata.peerDependenciesMeta?.[name]?.optional,
    true,
    `${source} must mark ${name} as an optional peer`,
  )
  assert.equal(metadata.dependencies?.[name], undefined, `${source} must not install ${name}`)
  assert.equal(metadata.optionalDependencies?.[name], undefined, `${source} must not install ${name}`)
}

function validatePiRuntimeProvenance(directory, metadata) {
  assert.equal(metadata.version, PI_RUNTIME_VERSION)
  assert.equal(metadata.license, 'MIT')
  assert.equal(metadata.bin, undefined, 'the compatibility runtime must not shadow a command')
  assert.equal(metadata.bundledDependencies, undefined, 'the runtime must not bundle dependencies')
  assert.equal(metadata.bundleDependencies, undefined, 'the runtime must not bundle dependencies')
  assert.deepEqual(
    Object.keys(metadata.devDependencies || {}),
    [],
    'the publishable compatibility runtime must not carry development dependencies',
  )
  for (const [name, version] of OPTIONAL_RUNTIME_PEERS) {
    assertOptionalPeer(metadata, name, version, '@tinyedge/pi-runtime')
  }

  const shrinkwrap = readJson(path.join(directory, 'npm-shrinkwrap.json'))
  assert.equal(shrinkwrap.name, '@tinyedge/pi-runtime')
  assert.equal(shrinkwrap.version, PI_RUNTIME_VERSION)
  assert.equal(shrinkwrap.lockfileVersion, 3)
  for (const [packagePath, dependency] of Object.entries(shrinkwrap.packages || {})) {
    const name = packageNameFromLockPath(packagePath)
    assert.equal(
      isForbiddenInstalledPackage(name),
      false,
      `@tinyedge/pi-runtime shrinkwrap must not install ${name}`,
    )
    if (!packagePath) continue
    assert.match(dependency.resolved || '', /^https:\/\/registry\.npmjs\.org\//)
    assert.match(dependency.integrity || '', /^sha512-[A-Za-z0-9+/]+={0,2}$/)
    assert.ok(REVIEWED_RUNTIME_LICENSES.has(dependency.license))
  }

  const license = normalizeText(readFileSync(path.join(directory, 'LICENSE'), 'utf8'))
  assert.equal(license, EXPECTED_PI_RUNTIME_LICENSE, 'the runtime must carry the exact upstream MIT license')
  const upstream = readFileSync(path.join(directory, 'UPSTREAM.md'), 'utf8')
  for (const exactProvenance of [
    PI_RUNTIME_UPSTREAM_PACKAGE,
    PI_RUNTIME_UPSTREAM_REPOSITORY,
    PI_RUNTIME_UPSTREAM_COMMIT,
    PI_RUNTIME_UPSTREAM_INTEGRITY,
    PI_RUNTIME_UPSTREAM_SHASUM,
  ]) {
    assert.ok(
      upstream.includes(exactProvenance),
      `the runtime UPSTREAM.md must record ${exactProvenance}`,
    )
  }
}

function assertReviewedClosure(lock, source, expectedRuntimeIntegrity) {
  assert.equal(lock.name, 'physicalsystems', `${source} must describe physicalsystems`)
  assert.equal(lock.lockfileVersion, 3, `${source} must use lockfileVersion 3`)
  assert.equal(lock.version, PHYSICAL_SYSTEMS_VERSION, `${source} must describe Physical Systems ${PHYSICAL_SYSTEMS_VERSION}`)
  assert.equal(lock.packages?.['']?.version, lock.version, `${source} root version must match`)
  assert.deepEqual(
    [...lock.packages?.['']?.bundleDependencies || []].sort(),
    Object.keys(lock.packages?.['']?.dependencies || {}).sort(),
    `${source} must mark every direct runtime dependency for bundling`,
  )
  assert.equal(
    lock.packages?.['']?.dependencies?.['@tinyedge/pi-runtime'],
    PI_RUNTIME_VERSION,
    `${source} must depend on the exact compatibility runtime`,
  )

  const piPackages = new Set()
  const piRuntimePackages = new Set()
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    const name = packageNameFromLockPath(packagePath)
    if (isForbiddenInstalledPackage(name)) {
      assert.fail(`${source} must not contain default-installed native or superseded Pi package ${name}`)
    }
    if (name === '@tinyedge/pi-runtime') {
      assert.equal(metadata.version, PI_RUNTIME_VERSION, `${source} pins @tinyedge/pi-runtime`)
      assert.equal(metadata.license, 'MIT', `${source} records the runtime's MIT license`)
      assert.equal(
        metadata.resolved,
        `https://registry.npmjs.org/@tinyedge/pi-runtime/-/pi-runtime-${PI_RUNTIME_VERSION}.tgz`,
        `${source} records the canonical future runtime tarball URL`,
      )
      assert.equal(
        metadata.integrity,
        expectedRuntimeIntegrity,
        `${source} binds the runtime dependency to the locally packed tarball bytes`,
      )
      piRuntimePackages.add(name)
    } else if (packagePath) {
      assert.match(
        metadata.resolved || '',
        /^https:\/\/registry\.npmjs\.org\//,
        `${source} resolves ${packagePath} from the npm registry`,
      )
      assert.match(
        metadata.integrity || '',
        /^sha512-[A-Za-z0-9+/]+={0,2}$/,
        `${source} records a SHA-512 integrity for ${packagePath}`,
      )
      assert.ok(
        REVIEWED_RUNTIME_LICENSES.has(metadata.license),
        `${source} records a reviewed runtime license for ${packagePath}`,
      )
    }
    if (name?.startsWith('@earendil-works/pi-')) {
      assert.equal(metadata.version, REVIEWED_PI_VERSION, `${source} pins ${name}`)
      assert.equal(
        metadata.resolved,
        `https://registry.npmjs.org/${name}/-/${name.slice('@earendil-works/'.length)}-${REVIEWED_PI_VERSION}.tgz`,
        `${source} resolves ${name} from the reviewed npm registry artifact`,
      )
      assert.equal(
        metadata.integrity,
        REVIEWED_PI_INTEGRITIES.get(name),
        `${source} pins the reviewed integrity for ${name}`,
      )
      assert.equal(metadata.license, 'MIT', `${source} records the reviewed MIT declaration for ${name}`)
      piPackages.add(name)
    }
  }
  assert.deepEqual([...piPackages].sort(), [...REVIEWED_PI_PACKAGES].sort())
  assert.deepEqual([...piRuntimePackages], ['@tinyedge/pi-runtime'])

  const runtimeShrinkwrap = readJson(
    path.join(REPOSITORY_ROOT, 'packages/pi-runtime/npm-shrinkwrap.json'),
  )
  const expectedPaths = Object.keys(runtimeShrinkwrap.packages || {})
    .filter(Boolean)
    .sort()
  const actualPaths = Object.keys(lock.packages || {})
    .filter((packagePath) => packagePath
      && packagePath !== 'node_modules/@tinyedge/pi-runtime')
    .sort()
  assert.deepEqual(
    actualPaths,
    expectedPaths,
    `${source} package paths must exactly match the audited compatibility-runtime closure`,
  )
  for (const packagePath of expectedPaths) {
    assert.deepEqual(
      lock.packages[packagePath],
      runtimeShrinkwrap.packages[packagePath],
      `${source} drifted from the audited compatibility-runtime closure at ${packagePath}`,
    )
  }
}

function validateReviewedShrinkwrap(expectedRuntimeIntegrity) {
  const packageDirectory = path.join(REPOSITORY_ROOT, 'packages/cli')
  const packageLockText = readFileSync(path.join(packageDirectory, 'package-lock.json'), 'utf8')
  const shrinkwrapPath = path.join(packageDirectory, 'npm-shrinkwrap.json')
  const shrinkwrapText = readFileSync(shrinkwrapPath, 'utf8')
  assert.equal(
    shrinkwrapText,
    packageLockText,
    'the publishable npm-shrinkwrap must exactly match the reviewed development package-lock',
  )
  assertReviewedClosure(
    JSON.parse(shrinkwrapText),
    'packages/cli/npm-shrinkwrap.json',
    expectedRuntimeIntegrity,
  )
}

function assertInstalledReviewedClosure(nodeModules, source, reviewedLock) {
  const versions = new Map()
  const ignoreLicenseFiles = []
  const installedPackages = collectInstalledPackages(nodeModules)
  assert.deepEqual(
    packageVersionIdentities(installedPackages.map(({ metadata }) => metadata)),
    reviewedVersionIdentities(reviewedLock),
    `${source} must contain exactly the reviewed name/version dependency identities`,
  )
  for (const { directory, metadata } of installedPackages) {
    const name = metadata.name
    if (name === 'ignore') {
      assert.equal(metadata.version, '7.0.5', `${source} must retain ignore@7.0.5`)
      ignoreLicenseFiles.push(path.join(directory, IGNORE_LICENSE_EVIDENCE.file))
    }
    if (!name?.startsWith('@earendil-works/pi-')
      && name !== '@tinyedge/pi-runtime'
      && !isForbiddenInstalledPackage(name)) {
      continue
    }
    if (!versions.has(name)) versions.set(name, new Set())
    versions.get(name).add(metadata.version)
  }

  const installedPiPackages = [...versions.keys()]
    .filter((name) => name.startsWith('@earendil-works/pi-'))
    .sort()
  assert.deepEqual(installedPiPackages, [...REVIEWED_PI_PACKAGES].sort())
  for (const name of REVIEWED_PI_PACKAGES) {
    assert.deepEqual([...versions.get(name) || []], [REVIEWED_PI_VERSION], `${source} pins ${name}`)
  }
  assert.deepEqual(
    [...versions.get('@tinyedge/pi-runtime') || []],
    [PI_RUNTIME_VERSION],
    `${source} must use the bundled compatibility runtime`,
  )
  for (const name of versions.keys()) {
    assert.equal(
      isForbiddenInstalledPackage(name),
      false,
      `${source} must not install ${name}`,
    )
  }
  assert.ok(ignoreLicenseFiles.length > 0, `${source} is missing ${IGNORE_LICENSE_EVIDENCE.package}`)
  for (const ignoreLicense of ignoreLicenseFiles) {
    assert.ok(existsSync(ignoreLicense), `${source} is missing ${IGNORE_LICENSE_EVIDENCE.package}/${IGNORE_LICENSE_EVIDENCE.file}`)
    const ignoreLicenseBytes = readFileSync(ignoreLicense)
    assert.equal(ignoreLicenseBytes.length, IGNORE_LICENSE_EVIDENCE.size, `${source} ignore LICENSE-MIT size drifted`)
    assert.equal(
      createHash('sha256').update(ignoreLicenseBytes).digest('hex'),
      IGNORE_LICENSE_EVIDENCE.sha256,
      `${source} ignore LICENSE-MIT bytes drifted`,
    )
  }
}

function validateSourceLegalBundle(packages) {
  const apacheLicense = readFileSync(APACHE_LICENSE_SOURCE)
  const tinyedgeNotice = readFileSync(TINYEDGE_NOTICE_SOURCE)
  const runtimeNotice = readFileSync(PI_RUNTIME_NOTICE_SOURCE)
  const thirdPartyNotices = readFileSync(THIRD_PARTY_NOTICES_SOURCE)
  assert.notDeepEqual(runtimeNotice, tinyedgeNotice, 'the runtime NOTICE must remain separately scoped')

  for (const { key, directory, metadata } of packages) {
    for (const legalFile of PACKED_LEGAL_FILES) {
      assert.ok(metadata.files?.includes(legalFile), `${metadata.name} must pack ${legalFile}`)
      assert.ok(existsSync(path.join(directory, legalFile)), `${metadata.name} is missing ${legalFile}`)
    }
    const expectedLicense = key === 'pi-runtime'
      ? readFileSync(path.join(directory, 'LICENSE'))
      : apacheLicense
    const expectedNotice = key === 'pi-runtime' ? runtimeNotice : tinyedgeNotice
    assert.deepEqual(readFileSync(path.join(directory, 'LICENSE')), expectedLicense, `${metadata.name} source LICENSE bytes`)
    assert.deepEqual(readFileSync(path.join(directory, 'NOTICE')), expectedNotice, `${metadata.name} source NOTICE bytes`)
    assert.deepEqual(
      readFileSync(path.join(directory, 'THIRD_PARTY_NOTICES.md')),
      thirdPartyNotices,
      `${metadata.name} source third-party notice bytes`,
    )
    assert.equal(metadata.license, key === 'pi-runtime' ? 'MIT' : 'Apache-2.0', `${metadata.name} source license metadata`)
  }
}

function validatePackageContracts(packages) {
  const runtime = packages.find(({ key }) => key === 'pi-runtime')
  const physicalsystems = packages.find(({ key }) => key === 'physicalsystems').metadata
  const version = physicalsystems.version
  assert.equal(version, PHYSICAL_SYSTEMS_VERSION)
  validateSourceLegalBundle(packages)
  validatePiRuntimeProvenance(runtime.directory, runtime.metadata)
  assert.equal(
    physicalsystems.dependencies['@tinyedge/pi-runtime'],
    PI_RUNTIME_VERSION,
    'physicalsystems must depend on the exact compatibility runtime',
  )
  assert.deepEqual(
    physicalsystems.bin,
    { physicalsystems: 'bin/physicalsystems.js' },
    'physicalsystems must own its command directly',
  )
  assert.deepEqual(
    physicalsystems.exports,
    {
      '.': './src/index.js',
      './run': './src/cli.js',
      './pi-extension': './src/pi-extension.js',
    },
    'physicalsystems must carry the former core import surface in the same artifact',
  )
  assert.equal(
    physicalsystems.bundleDependencies,
    true,
    'physicalsystems must bundle its reviewed dependency closure for npm 12 consumers',
  )
  assert.equal(physicalsystems.dependencies['@tinyedge/cli'], undefined)
  assert.equal(physicalsystems.repository?.url, 'git+https://github.com/PhysicalSystems/physicalsystems.git')
  assert.deepEqual(
    physicalsystems.publishConfig,
    { access: 'public' },
    'physicalsystems publishConfig must not redirect registry or authentication',
  )
  assert.deepEqual(physicalsystems.os, ['win32', 'linux'])
  assert.match(physicalsystems.engines?.node || '', />=22\.19\.0/)
  for (const frozen of FROZEN_PACKAGES) {
    const metadata = readJson(path.join(REPOSITORY_ROOT, frozen.directory, 'package.json'))
    assert.equal(metadata.name, frozen.name)
    assert.equal(metadata.version, frozen.version)
    assert.equal(metadata.private, true, `${frozen.name}@${frozen.version} must remain frozen source`)
  }
  assert.equal(runtime.metadata.repository?.url, 'git+https://github.com/TinyEdgeAI/tinyedge-edge.git')
  assert.deepEqual(
    runtime.metadata.publishConfig,
    { access: 'public' },
    '@tinyedge/pi-runtime publishConfig must not redirect registry or authentication',
  )
  assert.match(runtime.metadata.engines?.node || '', />=22\.19\.0/)
  return version
}

function validateReleaseReadmes(packages) {
  const runtime = packages.find(({ key }) => key === 'pi-runtime')
  const runtimeReadme = readFileSync(path.join(runtime.directory, 'README.md'), 'utf8')
  assert.match(runtimeReadme, /@tinyedge\/pi-runtime/)
  assert.match(runtimeReadme, /MIT[- ]licensed|MIT license/i)
  assert.match(runtimeReadme, /optional peers/i)
  assert.match(runtimeReadme, /manifest is publishable[\s\S]{0,180}protected workflow/i)
  assert.doesNotMatch(runtimeReadme, /remains\s+`?private:\s*true/i)
  assert.match(runtimeReadme, /source maps[\s\S]{0,100}npm[\s\S]{0,80}omits/i)
  for (const { key, directory, metadata } of packages) {
    if (key === 'pi-runtime') continue
    const readme = readFileSync(path.join(directory, 'README.md'), 'utf8')
    assert.match(
      readme,
      /npm view physicalsystems@0\.2\.1 version --json/,
      `${metadata.name} README must make exact registry availability independently verifiable`,
    )
    assert.doesNotMatch(
      readme,
      /0\.2\.1[\s\S]{0,100}\b(?:candidate|unavailable|unpublished|not published)\b/i,
      `${metadata.name} README must not describe its own 0.2.1 artifact as pre-publication`,
    )
    assert.doesNotMatch(
      readme,
      /\b(?:candidate|unavailable|unpublished|not published)\b[\s\S]{0,100}0\.2\.1/i,
      `${metadata.name} README must not describe its own 0.2.1 artifact as pre-publication`,
    )
    assert.match(readme, /0\.1\.3/, `${metadata.name} README must retain the package-migration distinction`)
    assert.match(
      readme,
      /(?:did not|do not|does not)[\s\S]{0,160}(?:validate|exercise)[\s\S]{0,80}(?:OAuth|login|live|production)/i,
      `${metadata.name} README must preserve the live-validation boundary`,
    )
    assert.match(readme, /npx physicalsystems@0\.2\.1/)
    assert.match(readme, /npm install --global physicalsystems@0\.2\.1/)
    assert.match(
      readme,
      /npx[\s\S]{0,100}does not[\s\S]{0,80}(?:global|persistent)/i,
      `${metadata.name} README must distinguish npx from a persistent install`,
    )
  }
}

function assertSafePackList(name, files) {
  const packedPaths = files.map(({ path: file }) => file)
  const sensitivePath = /(^|\/)(?:\.npmrc|\.env)(?:\/|$)/i
  const firstPartyForbiddenPath = /(^|\/)(?:test|tests|fixtures?|sessions?)(?:\/|$)|\.map$/i
  const offending = packedPaths.find((file) => sensitivePath.test(file)
    || (!file.startsWith('node_modules/') && firstPartyForbiddenPath.test(file)))
  assert.equal(offending, undefined, `${name} packed forbidden release file ${offending}`)
}

function assertPackedLegalBundle(tarball, files, directory, metadata) {
  for (const legalFile of PACKED_LEGAL_FILES) {
    assert.ok(
      files.some(({ path: file }) => file === legalFile),
      `${metadata.name} tarball must contain ${legalFile}`,
    )
    assert.deepEqual(
      runBuffer('tar', ['-xOf', tarball, `package/${legalFile}`]),
      readFileSync(path.join(directory, legalFile)),
      `${metadata.name} packed ${legalFile} must match the reviewed source bytes`,
    )
  }
}

function assertPackedPiRuntime(tarball, files) {
  for (const legalFile of ['UPSTREAM.md', 'UPSTREAM_README.md']) {
    assert.ok(
      files.some(({ path: file }) => file === legalFile),
      `@tinyedge/pi-runtime tarball must contain ${legalFile}`,
    )
  }
  const forbiddenPayload = files
    .map(({ path: file }) => file)
    .find((file) => /(^|\/)examples\//i.test(file)
      || /\.(?:wasm|node|dll|exe|so|dylib|ttf|otf|woff2?|png|jpe?g|gif|webp|svg)$/i.test(file))
  assert.equal(
    forbiddenPayload,
    undefined,
    `@tinyedge/pi-runtime must not pack native, font, WASM, image, or example payload ${forbiddenPayload}`,
  )
  assert.equal(
    normalizeText(run('tar', ['-xOf', tarball, 'package/LICENSE'])),
    EXPECTED_PI_RUNTIME_LICENSE,
    'the packed runtime must carry the exact upstream MIT license',
  )
  const packedUpstream = run('tar', ['-xOf', tarball, 'package/UPSTREAM.md'])
  for (const exactProvenance of [
    PI_RUNTIME_UPSTREAM_PACKAGE,
    PI_RUNTIME_UPSTREAM_REPOSITORY,
    PI_RUNTIME_UPSTREAM_COMMIT,
    PI_RUNTIME_UPSTREAM_INTEGRITY,
    PI_RUNTIME_UPSTREAM_SHASUM,
  ]) {
    assert.ok(
      packedUpstream.includes(exactProvenance),
      `the packed runtime UPSTREAM.md must record ${exactProvenance}`,
    )
  }
  const extractionRoot = mkdtempSync(path.join(tmpdir(), 'tinyedge-pi-runtime-pack-'))
  try {
    run('tar', ['-xf', tarball, '-C', extractionRoot])
    runNpm(['test'], { cwd: path.join(extractionRoot, 'package') })
  } finally {
    removeTemporaryDirectory(extractionRoot)
  }
}

function ensureOutputDirectory(directory) {
  if (existsSync(directory)) {
    assert.equal(readdirSync(directory).length, 0, `artifact directory must be empty: ${directory}`)
  } else {
    mkdirSync(directory, { recursive: true })
  }
}

function packRelease(outputDirectory, bundledPackageDirectory) {
  const packages = PACKAGES.map(packageMetadata)
  if (bundledPackageDirectory) {
    const item = packages.find(({ key }) => key === 'physicalsystems')
    item.directory = bundledPackageDirectory
    item.metadata = readJson(path.join(bundledPackageDirectory, 'package.json'))
  }
  const version = validatePackageContracts(packages)
  validateReleaseReadmes(packages)
  ensureOutputDirectory(outputDirectory)

  let runtimeIntegrity
  let reviewedShrinkwrapValidated = false
  const artifacts = packages.map(({ key, directory, metadata, version: fixedVersion }) => {
    if (key === 'physicalsystems') {
      assert.ok(runtimeIntegrity, 'the compatibility runtime must be packed before physicalsystems')
      validateReviewedShrinkwrap(runtimeIntegrity)
      reviewedShrinkwrapValidated = true
    }
    const artifactVersion = fixedVersion || version
    const output = runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      outputDirectory,
    ], { cwd: directory })
    const result = JSON.parse(output)[0]
    assert.equal(result.name, metadata.name)
    assert.equal(result.version, artifactVersion)
    assertSafePackList(metadata.name, result.files)
    if (key === 'physicalsystems') {
      const bundledNames = [...result.bundled || []].sort()
      for (const dependency of Object.keys(metadata.dependencies || {})) {
        assert.ok(
          bundledNames.includes(dependency),
          `the physicalsystems tarball must bundle direct dependency ${dependency}`,
        )
      }
      const bundleRoots = [...new Set(result.files
        .map(({ path: file }) => file)
        .filter((file) => file.startsWith('node_modules/'))
        .map((file) => {
          const [, first, second] = file.split('/')
          return first.startsWith('@') ? `${first}/${second}` : first
        }))].sort()
      assert.deepEqual(
        bundleRoots,
        bundledNames,
        'npm pack must account for every top-level bundled dependency',
      )
      const reviewedLock = readJson(path.join(directory, 'npm-shrinkwrap.json'))
      const reviewedNames = new Set(Object.keys(reviewedLock.packages || {})
        .filter(Boolean)
        .map(packageNameFromLockPath))
      const unexpectedBundle = bundledNames.find((name) => !reviewedNames.has(name))
      assert.equal(
        unexpectedBundle,
        undefined,
        `the physicalsystems tarball contains unexpected bundled dependency ${unexpectedBundle}`,
      )
      assert.ok(
        result.files.some(({ path: file }) => /(^|\/)npm-shrinkwrap\.json$/.test(file)),
        'the physicalsystems tarball must contain its reviewed npm-shrinkwrap.json',
      )
      assert.equal(
        result.files.some(({ path: file }) => /(^|\/)RELEASE\.md$/i.test(file)),
        false,
        'the internal release checklist must not be published in the physicalsystems tarball',
      )
    }
    const file = path.join(outputDirectory, result.filename)
    assert.ok(existsSync(file), `npm pack did not create ${file}`)
    assertPackedLegalBundle(file, result.files, directory, metadata)
    const integrity = sha512Integrity(file)
    if (key === 'pi-runtime') {
      assertPackedPiRuntime(file, result.files)
      runtimeIntegrity = integrity
    }
    return {
      key,
      name: metadata.name,
      version: artifactVersion,
      filename: result.filename,
      sha256: sha256(file),
      integrity,
      size: result.size,
      unpackedSize: result.unpackedSize,
    }
  })
  assert.equal(reviewedShrinkwrapValidated, true)

  const manifest = {
    schemaVersion: 1,
    version,
    commit: process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']),
    artifacts,
  }
  writeFileSync(
    path.join(outputDirectory, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  console.log(`Packed Physical Systems ${version} release artifacts in ${outputDirectory}`)
}

async function verifyRelease(artifactDirectory, { requireNodeBundle = false } = {}) {
  assert.match(process.platform, /^(?:win32|linux)$/, 'release packages must be verified on Windows or Linux')
  if (process.platform === 'linux') {
    assert.equal(process.arch, 'x64', 'the qualified Linux package route is Ubuntu desktop x64')
  } else {
    assert.match(process.arch, /^(?:x64|arm64)$/)
  }
  const manifest = readJson(path.join(artifactDirectory, 'release-manifest.json'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.version, PHYSICAL_SYSTEMS_VERSION)
  assert.equal(manifest.artifacts.length, PACKAGES.length)

  const candidateArtifacts = manifest.artifacts.map((artifact, index) => {
    const definition = PACKAGES[index]
    const expectedVersion = definition.version || manifest.version
    assert.equal(artifact.key, definition.key)
    assert.equal(artifact.name, definition.name)
    assert.equal(artifact.version, expectedVersion)
    const file = path.join(artifactDirectory, artifact.filename)
    assert.ok(existsSync(file), `missing release artifact ${artifact.filename}`)
    assert.equal(sha256(file), artifact.sha256, `checksum mismatch for ${artifact.filename}`)
    assert.equal(sha512Integrity(file), artifact.integrity, `integrity mismatch for ${artifact.filename}`)
    return { ...artifact, file }
  })
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'tinyedge-release-verify-'))
  const npmExecRoot = mkdtempSync(path.join(tmpdir(), 'physicalsystems-npm-exec-'))
  try {
    const physicalSystemsArtifact = candidateArtifacts.find(({ key }) => key === 'physicalsystems')
    const runtimeArtifact = candidateArtifacts.find(({ key }) => key === 'pi-runtime')
    assert.ok(physicalSystemsArtifact, 'the release manifest is missing the physicalsystems artifact')
    assert.ok(runtimeArtifact, 'the release manifest is missing the compatibility runtime artifact')
    const localDependencies = { physicalsystems: npmFileSpec(physicalSystemsArtifact.file) }
    writeFileSync(
      path.join(temporaryRoot, 'package.json'),
      `${JSON.stringify({
        name: 'physicalsystems-release-verification',
        private: true,
        version: '0.0.0',
        dependencies: localDependencies,
      }, null, 2)}\n`,
      'utf8',
    )
    runNpm([
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
    ], {
      cwd: temporaryRoot,
      env: { npm_config_cache: path.join(temporaryRoot, 'local-npm-cache') },
      phase: 'local npm install',
      timeout: NPM_INSTALL_TIMEOUT_MS,
    })

    const installed = readJson(path.join(temporaryRoot, 'node_modules/physicalsystems/package.json'))
    const installedPhysicalSystemsDirectory = path.join(temporaryRoot, 'node_modules/physicalsystems')
    if (requireNodeBundle) {
      assert.equal(installed.physicalsystemsNodeBundle, 'node-bundle', 'Product verification requires the included Python backend')
    }
    if (installed.physicalsystemsNodeBundle) {
      assert.equal(installed.physicalsystemsNodeBundle, 'node-bundle')
      await verifyNodeBundle(path.join(installedPhysicalSystemsDirectory, 'node-bundle'))
      assert.ok(existsSync(path.join(installedPhysicalSystemsDirectory, 'BACKEND-NOTICE.txt')))
      if (process.arch === 'x64') {
        const pythonArguments = process.env.pythonLocation
          ? [path.join(process.env.pythonLocation, process.platform === 'win32' ? 'python.exe' : 'bin/python')]
          : []
        const evidence = run(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/check-bundled-node.mjs'), installedPhysicalSystemsDirectory, ...pythonArguments], {
          phase: 'offline bundled backend installation and verified reuse',
          timeout: 10 * 60_000,
        })
        console.log(evidence)
      } else {
        console.log('Backend installation not qualified on this architecture; Harness and exact bundle bytes are still verified')
      }
    }
    const installedRuntimeDirectory = path.join(
      installedPhysicalSystemsDirectory,
      'node_modules/@tinyedge/pi-runtime',
    )
    const installedRuntime = readJson(path.join(installedRuntimeDirectory, 'package.json'))
    assert.equal(installed.version, manifest.version)
    assert.equal(installed.name, 'physicalsystems')
    assert.equal(installed.dependencies?.['@tinyedge/cli'], undefined)
    assert.equal(installedRuntime.version, PI_RUNTIME_VERSION)
    validatePiRuntimeProvenance(installedRuntimeDirectory, installedRuntime)

    const verificationLock = readJson(path.join(temporaryRoot, 'package-lock.json'))
    assert.deepEqual(
      verificationLock.packages?.['']?.dependencies,
      localDependencies,
      'verification must reproduce the advertised one-package install',
    )

    const installedShrinkwrap = path.join(installedPhysicalSystemsDirectory, 'npm-shrinkwrap.json')
    assert.ok(existsSync(installedShrinkwrap), 'the installed physicalsystems package is missing npm-shrinkwrap.json')
    const reviewedLock = readJson(installedShrinkwrap)
    assertReviewedClosure(
      reviewedLock,
      'local installed physicalsystems shrinkwrap',
      runtimeArtifact.integrity,
    )
    assertInstalledReviewedClosure(
      path.join(temporaryRoot, 'node_modules'),
      'local consumer install',
      reviewedLock,
    )

    const localShim = commandShim(path.join(temporaryRoot, 'node_modules', '.bin'))
    const localEntry = path.join(temporaryRoot, 'node_modules/physicalsystems/bin/physicalsystems.js')
    assert.ok(existsSync(localShim), 'npm did not create the local physicalsystems command shim')
    assert.ok(existsSync(localEntry), 'the local install is missing the packed physicalsystems entry')
    assertCommandShimTargets(localShim, localEntry, 'local npm command shim')
    assert.equal(
      run(process.execPath, [localEntry, '--version'], {
        cwd: temporaryRoot,
        timeout: 120_000,
      }),
      manifest.version,
      'the packed local physicalsystems entry must execute the reviewed client',
    )
    const reportedVersion = runCommandShim(localShim, ['--version'], {
      cwd: temporaryRoot,
      timeout: 120_000,
    })
    assert.equal(reportedVersion, manifest.version)

    assert.equal(
      existsSync(path.join(npmExecRoot, 'node_modules')),
      false,
      'npm exec verification must start without a local dependency tree',
    )
    const npmExecCache = path.join(npmExecRoot, 'npm-cache')
    const npxReportedVersion = runNpm([
      'exec',
      '--yes',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--timing',
      '--package',
      npmFileSpec(physicalSystemsArtifact.file),
      '--',
      'physicalsystems',
      '--version',
    ], {
      cwd: npmExecRoot,
      env: { npm_config_cache: npmExecCache },
      phase: 'isolated npm exec',
      timeout: NPM_EXEC_TIMEOUT_MS,
    })
    assert.equal(npxReportedVersion, manifest.version, 'npm exec must launch the exact packed artifact')
    const npmExecInstalls = path.join(npmExecCache, '_npx')
    assert.ok(
      existsSync(npmExecInstalls) && readdirSync(npmExecInstalls).length > 0,
      'npm exec must materialize the packed artifact in its isolated cache',
    )

    const globalPrefix = path.join(temporaryRoot, 'global-prefix')
    runNpm([
      'install',
      '--global',
      '--prefix',
      globalPrefix,
      '--offline',
      '--no-audit',
      '--no-fund',
      physicalSystemsArtifact.file,
    ], {
      cwd: temporaryRoot,
      env: { npm_config_cache: path.join(temporaryRoot, 'global-npm-cache') },
      phase: 'global npm install',
      timeout: NPM_INSTALL_TIMEOUT_MS,
    })
    const globalPhysicalSystemsDirectory = globalPackageDirectory(globalPrefix)
    const globalShim = globalCommandShim(globalPrefix)
    const globalEntry = path.join(globalPhysicalSystemsDirectory, 'bin/physicalsystems.js')
    assert.ok(existsSync(globalShim), 'npm did not create the global physicalsystems command shim')
    assert.ok(existsSync(globalEntry), 'the global install is missing the packed physicalsystems entry')
    assertCommandShimTargets(globalShim, globalEntry, 'global npm command shim')
    assert.equal(
      run(process.execPath, [globalEntry, '--version'], {
        cwd: temporaryRoot,
        timeout: 120_000,
      }),
      manifest.version,
      'the packed global physicalsystems entry must execute the reviewed client',
    )
    const globalReportedVersion = runCommandShim(globalShim, ['--version'], {
      cwd: temporaryRoot,
      timeout: 120_000,
    })
    assert.equal(globalReportedVersion, manifest.version)
    const globalShrinkwrap = path.join(globalPhysicalSystemsDirectory, 'npm-shrinkwrap.json')
    assert.ok(existsSync(globalShrinkwrap), 'the global physicalsystems package is missing npm-shrinkwrap.json')
    assertReviewedClosure(
      readJson(globalShrinkwrap),
      'global installed physicalsystems shrinkwrap',
      runtimeArtifact.integrity,
    )
    assertInstalledReviewedClosure(
      globalNodeModulesDirectory(globalPrefix),
      'global consumer install',
      readJson(globalShrinkwrap),
    )
    const globalRuntimeDirectory = path.join(
      globalPhysicalSystemsDirectory,
      'node_modules/@tinyedge/pi-runtime',
    )
    validatePiRuntimeProvenance(
      globalRuntimeDirectory,
      readJson(path.join(globalRuntimeDirectory, 'package.json')),
    )

    const coreEntry = path.join(temporaryRoot, 'node_modules/physicalsystems/src/cli.js')
    const defaultDispatchCheck = `
      const { runCli } = await import(${JSON.stringify(pathToFileURL(coreEntry).href)});
      let harnessStarted = false;
      const code = await runCli([], {
        config: { configDir: ${JSON.stringify(path.join(temporaryRoot, 'config'))} },
        tokenStore: {},
        io: { log() {}, error() {} },
        harnessCommand: async () => { harnessStarted = true; },
      });
      if (code !== 0 || !harnessStarted) {
        throw new Error('bare physicalsystems did not dispatch to the native Harness');
      }
    `
    run(process.execPath, ['--input-type=module', '--eval', defaultDispatchCheck], {
      cwd: temporaryRoot,
      timeout: 120_000,
    })

    const piEntry = path.join(temporaryRoot, 'node_modules/physicalsystems/src/pi-extension.js')
    const piImportCheck = `
      const extension = await import(${JSON.stringify(pathToFileURL(piEntry).href)});
      if (typeof extension.default !== 'function') {
        throw new Error('the packed Physical Systems Pi extension is not callable');
      }
    `
    run(process.execPath, ['--input-type=module', '--eval', piImportCheck], {
      cwd: temporaryRoot,
      timeout: 120_000,
    })

    if (process.platform === 'win32') {
      const installedModules = path.join(temporaryRoot, 'node_modules')
      const nativeConsoleHelpers = findFiles(
        installedModules,
        (file) => file.endsWith('win32-console-mode.node')
          && file.includes(`${path.sep}win32-${process.arch}${path.sep}`),
      )
      assert.ok(nativeConsoleHelpers.length >= 1, `missing Pi TUI ${process.arch} console helper`)
      const nativeDependencyCheck = `
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        for (const helperPath of ${JSON.stringify(nativeConsoleHelpers)}) {
          const helper = require(helperPath);
          if (typeof helper.enableVirtualTerminalInput !== 'function'
            || typeof helper.isModifierPressed !== 'function') {
            throw new Error('the Pi TUI native console helper has an unexpected contract');
          }
        }
      `
      run(process.execPath, ['--input-type=module', '--eval', nativeDependencyCheck], {
        cwd: temporaryRoot,
        timeout: 120_000,
      })
    } else {
      const secretStoreEntry = path.join(installedPhysicalSystemsDirectory, 'src/auth/secret-store.js')
      const secretServiceCheck = `
        import assert from 'node:assert/strict';
        const { createLinuxSecretServiceSecretStore } = await import(
          ${JSON.stringify(pathToFileURL(secretStoreEntry).href)}
        );
        const store = createLinuxSecretServiceSecretStore();
        const name = 'release-package-canary';
        const value = 'tinyedge-linux-secret-service-canary';
        await store.delete(name);
        try {
          await store.write(name, value);
          assert.equal(await store.read(name), value);
        } finally {
          await store.delete(name);
        }
        assert.equal(await store.read(name), null);
      `
      run(process.execPath, ['--input-type=module', '--eval', secretServiceCheck], {
        cwd: temporaryRoot,
        timeout: 120_000,
      })
      console.log(run('python3', [
        path.join(SCRIPT_DIR, 'check-linux-harness-pty.py'),
        process.execPath,
        path.join(SCRIPT_DIR, 'check-managed-harness.mjs'),
        installedPhysicalSystemsDirectory,
      ], {
        cwd: temporaryRoot,
        env: {
          TINYEDGE_CONFIG_DIR: path.join(temporaryRoot, 'linux-harness-config'),
          TERM: 'xterm-256color',
        },
        timeout: 12 * 60_000,
        phase: 'Linux instrumented packaged Harness first-run acceptance',
      }))
    }
  } finally {
    removeTemporaryDirectory(temporaryRoot)
    removeTemporaryDirectory(npmExecRoot)
  }

  console.log(
    `Verified Physical Systems ${manifest.version} as one offline-installable package with bundled @tinyedge/pi-runtime@${PI_RUNTIME_VERSION}, normal-lifecycle local/global/npm-exec commands, embedded client and Pi extension, bare Harness dispatch, and ${process.platform === 'win32' ? 'native console helper' : 'interactive pseudo-terminal smoke'} on ${process.platform} ${process.arch}`,
  )
}

function usage() {
  throw new Error('Usage: check-release-packages.js <pack|verify|check> [artifact-directory] [--node-bundle ABSOLUTE_DIRECTORY | --require-node-bundle]')
}

const [mode, directoryArgument, bundleFlag, bundleArgument, ...extra] = process.argv.slice(2)
if (!['pack', 'verify', 'check'].includes(mode)) usage()
const requireNodeBundle = mode === 'verify' && bundleFlag === '--require-node-bundle' && !bundleArgument
if (extra.length || (bundleFlag && !requireNodeBundle && (mode !== 'pack' || bundleFlag !== '--node-bundle' || !bundleArgument || !path.isAbsolute(bundleArgument))) || (!bundleFlag && bundleArgument)) usage()
const npmVersion = runNpm(['--version'])
if (mode === 'verify') {
  assert.ok(
    CONSUMER_NPM_VERSIONS.has(npmVersion),
    `consumer verification requires one of npm ${[...CONSUMER_NPM_VERSIONS].join(', ')}`,
  )
} else {
  assert.equal(
    npmVersion,
    RELEASE_NPM_VERSION,
    `release packaging requires npm ${RELEASE_NPM_VERSION}`,
  )
}

if (mode === 'check') {
  const temporaryArtifacts = mkdtempSync(path.join(tmpdir(), 'tinyedge-release-pack-'))
  try {
    packRelease(temporaryArtifacts)
    await verifyRelease(temporaryArtifacts)
  } finally {
    removeTemporaryDirectory(temporaryArtifacts)
  }
} else {
  if (!directoryArgument) usage()
  const artifactDirectory = path.resolve(process.cwd(), directoryArgument)
  if (mode === 'pack') {
    const stage = bundleArgument ? await stageNodeBundle(path.join(REPOSITORY_ROOT, 'packages/cli'), bundleArgument) : null
    try { packRelease(artifactDirectory, stage?.directory) } finally { stage?.dispose() }
  } else await verifyRelease(artifactDirectory, { requireNodeBundle })
}
