#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI_DIRECTORY = path.resolve(SCRIPT_DIR, '..')
const RUNTIME_DIRECTORY = path.resolve(CLI_DIRECTORY, '../pi-runtime')
const PINNED_NPM_VERSION = '11.19.0'
const RUNTIME_NAME = '@tinyedge/pi-runtime'
const RUNTIME_VERSION = '0.84.2-tinyedge.1'
export const NPM_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000
const FORBIDDEN_RUNTIME_PACKAGES = Object.freeze([
  '@earendil-works/pi-coding-agent',
  '@silvia-odwyer/photon-node',
])

function isForbiddenRuntimePackage(name) {
  return FORBIDDEN_RUNTIME_PACKAGES.includes(name)
    || name?.startsWith('@mariozechner/clipboard')
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'run this bootstrap through npm so npm_execpath is available')
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: options.cwd || CLI_DIRECTORY,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: options.timeout ?? NPM_BOOTSTRAP_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `npm ${args.join(' ')} exited with ${result.status}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'))
  }
  return result.stdout.trim()
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function sha512Integrity(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

export function canonicalRuntimeTarballUrl(
  name = RUNTIME_NAME,
  version = RUNTIME_VERSION,
) {
  const filenameName = name.split('/').at(-1)
  return `https://registry.npmjs.org/${name}/-/${filenameName}-${version}.tgz`
}

function packageNameFromLockPath(packagePath) {
  return packagePath.split('/node_modules/').at(-1)?.replace(/^node_modules\//, '')
}

function runtimePackageEntry(runtimeLock, runtimeIntegrity) {
  const root = runtimeLock.packages?.['']
  assert.ok(root, 'Pi runtime shrinkwrap is missing its root package')
  return {
    version: RUNTIME_VERSION,
    resolved: canonicalRuntimeTarballUrl(),
    integrity: runtimeIntegrity,
    hasShrinkwrap: true,
    license: root.license,
    dependencies: structuredClone(root.dependencies),
    engines: structuredClone(root.engines),
    peerDependencies: structuredClone(root.peerDependencies),
    peerDependenciesMeta: structuredClone(root.peerDependenciesMeta),
  }
}

export function buildCliConsumerLock({ manifest, runtimeLock, runtimeIntegrity }) {
  const root = {}
  for (const key of ['name', 'version']) {
    if (manifest[key] !== undefined) root[key] = structuredClone(manifest[key])
  }
  if (manifest.bundleDependencies === true) {
    root.bundleDependencies = Object.keys(manifest.dependencies || {})
  }
  for (const key of ['license', 'bin', 'os', 'dependencies', 'engines']) {
    if (manifest[key] !== undefined) root[key] = structuredClone(manifest[key])
  }

  const packageEntries = new Map([
    [`node_modules/${RUNTIME_NAME}`, runtimePackageEntry(runtimeLock, runtimeIntegrity)],
  ])
  for (const [packagePath, metadata] of Object.entries(runtimeLock.packages || {})) {
    if (!packagePath) continue
    packageEntries.set(packagePath, structuredClone(metadata))
  }

  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': root,
      ...Object.fromEntries([...packageEntries].sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      ))),
    },
  }
}

export function validateCliRuntimeContract({
  manifest,
  lock,
  shrinkwrapText,
  packageLockText,
  runtimeLock,
  runtimeIntegrity,
}) {
  assert.equal(shrinkwrapText, packageLockText, 'CLI package-lock and shrinkwrap must be byte-identical')
  assert.equal(manifest.dependencies?.[RUNTIME_NAME], RUNTIME_VERSION)
  assert.equal(
    manifest.bundleDependencies,
    true,
    'CLI manifest must set bundleDependencies=true',
  )
  assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], undefined)
  assert.equal(lock.packages?.['']?.dependencies?.[RUNTIME_NAME], RUNTIME_VERSION)
  assert.deepEqual(
    [...lock.packages?.['']?.bundleDependencies || []].sort(),
    Object.keys(manifest.dependencies || {}).sort(),
    'CLI lock must mark every direct dependency for bundling',
  )

  const runtime = lock.packages?.[`node_modules/${RUNTIME_NAME}`]
  assert.ok(runtime, `CLI lock is missing ${RUNTIME_NAME}`)
  assert.equal(runtime.version, RUNTIME_VERSION)
  assert.equal(runtime.resolved, canonicalRuntimeTarballUrl())
  assert.equal(runtime.integrity, runtimeIntegrity)
  assert.deepEqual(runtime, runtimePackageEntry(runtimeLock, runtimeIntegrity))

  for (const packagePath of Object.keys(lock.packages || {})) {
    const name = packageNameFromLockPath(packagePath)
    assert.ok(
      !isForbiddenRuntimePackage(name),
      `CLI lock must omit ${name}`,
    )
  }

  const expectedPackagePaths = new Set([
    `node_modules/${RUNTIME_NAME}`,
    ...Object.keys(runtimeLock.packages || {}).filter(Boolean),
  ])
  assert.deepEqual(
    new Set(Object.keys(lock.packages || {}).filter(Boolean)),
    expectedPackagePaths,
    'CLI lock package paths must exactly match the reviewed runtime closure',
  )
  for (const [packagePath, metadata] of Object.entries(runtimeLock.packages || {})) {
    if (!packagePath) continue
    assert.deepEqual(
      lock.packages[packagePath],
      metadata,
      `CLI lock must preserve the reviewed runtime entry ${packagePath}`,
    )
  }

}

function packRuntime(outputDirectory) {
  const output = runNpm([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    outputDirectory,
  ], { cwd: RUNTIME_DIRECTORY })
  const [result] = JSON.parse(output)
  assert.equal(result.name, RUNTIME_NAME)
  assert.equal(result.version, RUNTIME_VERSION)
  const tarball = path.join(outputDirectory, result.filename)
  assert.equal(result.integrity, sha512Integrity(tarball))
  return { ...result, tarball }
}

function createSeedInstall({ directory, tarball, manifest, lock }) {
  const localSpec = `file:${tarball.replaceAll('\\', '/')}`
  const seedManifest = structuredClone(manifest)
  seedManifest.dependencies[RUNTIME_NAME] = localSpec

  const seedLock = structuredClone(lock)
  seedLock.packages[''].dependencies[RUNTIME_NAME] = localSpec
  seedLock.packages[`node_modules/${RUNTIME_NAME}`].resolved = localSpec

  writeJson(path.join(directory, 'package.json'), seedManifest)
  writeJson(path.join(directory, 'npm-shrinkwrap.json'), seedLock)
}

function parseArguments(args) {
  let cacheDirectory
  let installCli = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--cache') {
      cacheDirectory = args[index + 1]
      index += 1
    } else if (argument === '--install-cli') {
      installCli = true
    } else {
      throw new Error('Usage: bootstrap-pi-runtime.js --cache DIRECTORY [--install-cli]')
    }
  }
  if (!cacheDirectory) {
    throw new Error('Usage: bootstrap-pi-runtime.js --cache DIRECTORY [--install-cli]')
  }
  return { cacheDirectory: path.resolve(cacheDirectory), installCli }
}

export function main(args = process.argv.slice(2)) {
  const { cacheDirectory, installCli } = parseArguments(args)
  assert.equal(
    runNpm(['--version']),
    PINNED_NPM_VERSION,
    `Pi runtime bootstrap requires npm ${PINNED_NPM_VERSION}`,
  )

  const runtimeManifest = readJson(path.join(RUNTIME_DIRECTORY, 'package.json'))
  assert.equal(runtimeManifest.name, RUNTIME_NAME)
  assert.equal(runtimeManifest.version, RUNTIME_VERSION)
  runNpm(['run', 'verify'], { cwd: RUNTIME_DIRECTORY })

  mkdirSync(cacheDirectory, { recursive: true })
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'tinyedge-pi-runtime-bootstrap-'))
  try {
    const firstDirectory = path.join(temporaryRoot, 'pack-one')
    const secondDirectory = path.join(temporaryRoot, 'pack-two')
    const seedDirectory = path.join(temporaryRoot, 'seed-install')
    mkdirSync(firstDirectory)
    mkdirSync(secondDirectory)
    mkdirSync(seedDirectory)

    const first = packRuntime(firstDirectory)
    const second = packRuntime(secondDirectory)
    assert.ok(
      readFileSync(first.tarball).equals(readFileSync(second.tarball)),
      'Pi runtime packs must be byte-identical',
    )
    assert.equal(first.integrity, second.integrity)

    const manifest = readJson(path.join(CLI_DIRECTORY, 'package.json'))
    const runtimeLock = readJson(path.join(RUNTIME_DIRECTORY, 'npm-shrinkwrap.json'))
    const packageLockText = readFileSync(path.join(CLI_DIRECTORY, 'package-lock.json'), 'utf8')
    const shrinkwrapText = readFileSync(path.join(CLI_DIRECTORY, 'npm-shrinkwrap.json'), 'utf8')
    const lock = JSON.parse(packageLockText)
    validateCliRuntimeContract({
      manifest,
      lock,
      shrinkwrapText,
      packageLockText,
      runtimeLock,
      runtimeIntegrity: first.integrity,
    })

    runNpm(['cache', 'add', first.tarball, '--cache', cacheDirectory])
    createSeedInstall({ directory: seedDirectory, tarball: first.tarball, manifest, lock })
    runNpm([
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cacheDirectory,
    ], { cwd: seedDirectory })

    if (installCli) {
      runNpm([
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        cacheDirectory,
      ], { cwd: CLI_DIRECTORY })
    }

    console.log([
      `Verified deterministic ${RUNTIME_NAME}@${RUNTIME_VERSION}`,
      `integrity ${first.integrity}`,
      `seeded npm cache ${cacheDirectory}`,
      installCli ? 'installed the CLI offline' : 'ready for npm ci --offline',
    ].join(' · '))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error?.stack || error?.message || String(error))
    process.exitCode = 1
  }
}
