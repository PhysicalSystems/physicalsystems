import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION = 'physicalsystems-node-install-v1'
const MAX_MANIFEST = 128 * 1024
const MAX_WHEEL = 200 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RELEASE = /^\d+(?:\.\d+){1,4}(?:(?:a|b|rc)\d+)?(?:\.post\d+)?$/
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

export function validateNodeInstallManifest(value) {
  if (!exact(value, ['contractVersion', 'release', 'distribution', 'runtimeVersion', 'platform', 'python', 'artifacts'])
    || value.contractVersion !== VERSION || value.distribution !== 'physicalsystems-node'
    || value.release !== '0.2.0' || value.runtimeVersion !== '0.2.0'
    || !['linux-x64', 'win32-x64', 'win32-arm64'].includes(value.platform)
    || !/^3\.(10|11|12|13)$/.test(value.python) || !Array.isArray(value.artifacts)
    || value.artifacts.length < 2 || value.artifacts.length > 32) throw new Error('Invalid Node installation manifest')
  const names = new Set(), files = new Set()
  let total = 0
  for (const artifact of value.artifacts) {
    if (!exact(artifact, ['name', 'version', 'filename', 'sha256', 'bytes', 'url'])
      || !NAME.test(artifact.name) || !RELEASE.test(artifact.version)
      || typeof artifact.filename !== 'string' || !/^[A-Za-z0-9_.+-]+\.whl$/.test(artifact.filename)
      || !artifact.filename.startsWith(`${artifact.name.replaceAll('-', '_')}-${artifact.version}-`)
      || !HEX.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes <= 0 || artifact.bytes > MAX_WHEEL || names.has(artifact.name) || files.has(artifact.filename)) {
      throw new Error('Invalid or duplicate Node wheel identity')
    }
    let url
    try { url = new URL(artifact.url) } catch { throw new Error('Node wheel URL must be HTTPS') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || decodeURIComponent(url.pathname.split('/').at(-1)) !== artifact.filename) throw new Error('Node wheel URL must identify one HTTPS artifact')
    names.add(artifact.name); files.add(artifact.filename); total += artifact.bytes
  }
  if (total > 512 * 1024 * 1024
    || !value.artifacts.some((item) => item.name === value.distribution && item.version === value.release)
    || !value.artifacts.some((item) => item.name === 'tinyedge-runtime' && item.version === value.runtimeVersion)) {
    throw new Error('Node manifest is missing its exact Node or Runtime wheel')
  }
  return structuredClone(value)
}

function localPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)
    || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')))) {
    throw new Error(`${label} must be an absolute local path`)
  }
  return path.resolve(value)
}

async function regularFile(filename, maximum) {
  const before = await fs.lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('Expected a bounded regular installation file')
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > maximum) throw new Error('Installation file changed while opening')
    const bytes = await handle.readFile()
    if (bytes.length > maximum) throw new Error('Installation file exceeded its bound')
    return bytes
  } finally { await handle.close() }
}

export { regularFile as readInstallationFile }

export async function readNodeInstallManifest(filename, expectedHash) {
  localPath(filename, 'Manifest')
  if (!HEX.test(expectedHash)) throw new Error('An exact manifest SHA-256 is required')
  const bytes = await regularFile(filename, MAX_MANIFEST)
  if (hash(bytes) !== expectedHash) throw new Error('Node manifest checksum mismatch')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Invalid Node manifest JSON') }
  return { manifest: validateNodeInstallManifest(value), digest: expectedHash, manifestBytes: bytes }
}

// No account/provider credentials, ambient Python paths, pip index/config
// settings or package-manager options are passed to setup subprocesses.
export function installationEnvironment(env = process.env) {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL'])
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())))
  result.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
  result.PYTHONNOUSERSITE = '1'
  return result
}

export function runInstallationProcess(executable, args, { env = process.env, cwd, timeoutMs = 120000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, output = '', count = 0, settled = false
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output) }
    const timer = setTimeout(() => { child?.kill(); finish(new Error('Node setup subprocess timed out; installation was not activated')) }, timeoutMs)
    try { child = spawnImpl(executable, args, { shell: false, windowsHide: true, cwd, env: installationEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { finish(new Error('Could not start the Node setup subprocess')); return }
    const collect = (chunk, keep) => {
      count += chunk.length
      if (count > 1024 * 1024) { child.kill(); finish(new Error('Node setup output exceeded its bound')); return }
      if (keep) output += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk) => collect(chunk, true))
    child.stderr.on('data', (chunk) => collect(chunk, false))
    child.once('error', () => finish(new Error('Could not start the Node setup subprocess')))
    child.once('close', (code) => finish(code === 0 ? null : new Error('Node setup subprocess failed; check Python venv support and the exact wheel set')))
  })
}

export async function inspectInstallationPython({ executable, env = process.env, run = runInstallationProcess } = {}) {
  const command = executable || (process.platform === 'win32' ? 'py' : 'python3')
  if (executable) localPath(executable, 'Python executable')
  const prefix = !executable && process.platform === 'win32' ? ['-3'] : []
  let info
  try {
    info = JSON.parse(await run(command, [...prefix, '-I', '-c', 'import json,sys,platform,venv,ensurepip; print(json.dumps({"version":"%s.%s"%sys.version_info[:2],"implementation":platform.python_implementation(),"executable":sys.executable}))'], { env, timeoutMs: 15000 }))
  } catch { throw new Error('Node setup needs CPython 3.10–3.13 with venv/ensurepip. On Ubuntu install python3-venv, then retry; system Python packages have not been changed.') }
  if (!exact(info, ['version', 'implementation', 'executable']) || info.implementation !== 'CPython' || !/^3\.(10|11|12|13)$/.test(info.version)) throw new Error('Node setup requires CPython 3.10–3.13')
  localPath(info.executable, 'Resolved Python executable')
  return info
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(await fs.realpath(directory)) !== normalize(directory)) throw new Error('Node installation directory must not use links or junctions')
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error('Node installation directory must be private to the current user (mode 0700)')
}

export async function downloadWheel(artifact, destination, { wheelhouse, fetchImpl = fetch }) {
  if (wheelhouse) {
    const { bundleDirectory } = await import('./node-bundle.js')
    await bundleDirectory(wheelhouse)
    const bytes = await regularFile(path.join(wheelhouse, artifact.filename), artifact.bytes)
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error('Node wheel checksum mismatch')
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
    return
  }
  const response = await fetchImpl(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(60000), credentials: 'omit', headers: { Accept: 'application/octet-stream' } })
  if (!response.ok || !response.body || (response.url && response.url !== artifact.url)) throw new Error('Node wheel download failed')
  const announced = response.headers.get('content-length')
  if (announced !== null && Number(announced) !== artifact.bytes) throw new Error('Node wheel length mismatch')
  const handle = await fs.open(destination, 'wx', 0o600)
  const digest = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > artifact.bytes) throw new Error('Node wheel exceeded its declared size')
      digest.update(chunk)
      await handle.writeFile(chunk)
    }
    await handle.sync()
  } finally { await handle.close() }
  if (size !== artifact.bytes || digest.digest('hex') !== artifact.sha256) throw new Error('Node wheel checksum mismatch')
}

async function verifyInstalled(environmentDir, manifest, run, env) {
  const python = path.join(environmentDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const interpreter = await inspectInstallationPython({ executable: python, env, run })
  if (interpreter.version !== manifest.python) throw new Error('Installed Python does not match the approved Node wheel set')
  const probe = await run(python, ['-I', '-m', 'tinyedge_agent.physical_node_cli', '--installation-info'], { env, timeoutMs: 15000 })
  let info
  try { info = JSON.parse(probe) } catch { throw new Error('Installed Node returned invalid compatibility information') }
  if (!exact(info, ['contractVersion', 'distribution', 'version', 'runtimeVersion', 'protocols'])
    || info.contractVersion !== 'physicalsystems-node-installation-v1' || info.distribution !== manifest.distribution
    || info.version !== manifest.release || info.runtimeVersion !== manifest.runtimeVersion
    || JSON.stringify(info.protocols) !== JSON.stringify(['physicalsystems-node-ready-v1'])) throw new Error('Installed Node does not match the approved release')
  await run(python, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'check'], { env, timeoutMs: 30000 })
  const versions = Object.fromEntries(manifest.artifacts.map((item) => [item.name, item.version]))
  await run(python, ['-I', '-c', 'import importlib.metadata as m,json,sys; expected=json.loads(sys.argv[1]); assert all(m.version(k)==v for k,v in expected.items()); import numpy,cv2,tinyedge_runtime', JSON.stringify(versions)], { env, timeoutMs: 30000 })
  const executable = path.join(environmentDir, process.platform === 'win32' ? 'Scripts/physicalsystems-node.exe' : 'bin/physicalsystems-node')
  const stat = await fs.lstat(executable)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Installed Node console entrypoint is not a regular file')
  await fs.access(executable, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  return executable
}

/** Install approved bytes into an isolated user environment, never into system
 * Python. No server or hardware is started here. Failed environments remain
 * inactive for diagnosis; no existing environment is overwritten or removed.
 */
export async function installManagedNode({ manifest, digest, manifestBytes, configDir, python, wheelhouse, env = process.env,
  fetchImpl = fetch, run = runInstallationProcess, authorize, onProgress = () => {} } = {}) {
  manifest = validateNodeInstallManifest(manifest)
  if (!HEX.test(digest)) throw new Error('Node installation needs its pinned manifest digest')
  manifestBytes = manifestBytes || Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > MAX_MANIFEST || hash(manifestBytes) !== digest
    || JSON.stringify(validateNodeInstallManifest(JSON.parse(manifestBytes.toString('utf8')))) !== JSON.stringify(manifest)) throw new Error('Node installation manifest bytes do not match the approved digest')
  localPath(configDir, 'Configuration directory')
  if (wheelhouse) localPath(wheelhouse, 'Wheelhouse')
  if (manifest.platform !== `${process.platform}-${process.arch}`) throw new Error('No Node wheel set is qualified for this Python/platform combination')
  const root = path.join(configDir, 'node-installations')
  const pointer = path.join(root, `${digest}.json`)
  // Reading an existing receipt does not authorize repairing/replacing it.
  let existing
  try { existing = await regularFile(pointer, 4096) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    const record = JSON.parse(existing.toString('utf8'))
    if (!exact(record, ['contractVersion', 'manifestDigest', 'directory']) || record.contractVersion !== 'physicalsystems-node-install-receipt-v1'
      || record.manifestDigest !== digest || !new RegExp(`^${digest.slice(0, 16)}-[a-f0-9]{16}$`).test(record.directory)) throw new Error('Invalid Node installation receipt')
    const environmentDir = path.join(root, record.directory, 'environment')
    await privateDirectory(root)
    await privateDirectory(path.dirname(environmentDir))
    await privateDirectory(environmentDir)
    const executable = await verifyInstalled(environmentDir, manifest, run, env)
    return { executable, release: manifest.release, digest, reused: true }
  }
  // The qualified 0.2.0 Windows wheel set has an installed suffix up to 114
  // characters (NumPy's native DLL). Reserve room below legacy MAX_PATH;
  // pip can otherwise report success with that required DLL missing. This is
  // a bound for this release, not a promise about arbitrary future packages.
  const plannedEnvironment = path.join(root, `${digest.slice(0, 16)}-${'0'.repeat(16)}`, 'environment')
  if (process.platform === 'win32' && path.resolve(plannedEnvironment).length > 126) {
    throw new Error('Node installation path is too long for this Windows release. Set TINYEDGE_CONFIG_DIR to a shorter absolute local directory, then retry. No installation was started.')
  }
  const interpreter = await inspectInstallationPython({ executable: python, env, run })
  if (manifest.python !== interpreter.version) throw new Error('No Node wheel set is qualified for this Python/platform combination')
  if (typeof authorize !== 'function' || await authorize({ release: manifest.release, bytes: manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0) }) !== true) {
    throw new Error('Node setup was not approved; no packages were installed')
  }
  await privateDirectory(root)
  const lock = path.join(root, 'setup.lock')
  let lockHandle
  try { lockHandle = await fs.open(lock, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another Node setup is active or interrupted. Inspect setup.lock before retrying; it will not be taken over automatically.'); throw error }
  let directory
  try {
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, manifestDigest: digest }))
    directory = path.join(root, `${digest.slice(0, 16)}-${randomBytes(8).toString('hex')}`)
    await privateDirectory(directory)
    const wheels = path.join(directory, 'wheels'), environmentDir = path.join(directory, 'environment')
    await privateDirectory(wheels)
    onProgress(wheelhouse ? 'Verifying the Node packages included in this product…' : 'Downloading and verifying the approved Node packages…')
    for (const artifact of manifest.artifacts) await downloadWheel(artifact, path.join(wheels, artifact.filename), { wheelhouse, fetchImpl })
    const requirements = manifest.artifacts.map((item) => `${item.name} @ ${pathToFileURL(path.join(wheels, item.filename)).href} --hash=sha256:${item.sha256}`).join('\n') + '\n'
    const requirementsFile = path.join(directory, 'requirements.txt')
    await fs.writeFile(requirementsFile, requirements, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(directory, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
    onProgress('Installing the Node in its private Python environment…')
    await privateDirectory(environmentDir)
    await run(interpreter.executable, ['-I', '-m', 'venv', '--copies', environmentDir], { env, cwd: directory })
    const environmentPython = path.join(environmentDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    await run(environmentPython, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-index', '--no-deps', '--only-binary=:all:', '--require-hashes', '--no-cache-dir', '-r', requirementsFile], { env, cwd: directory })
    const executable = await verifyInstalled(environmentDir, manifest, run, env)
    const receipt = { contractVersion: 'physicalsystems-node-install-receipt-v1', manifestDigest: digest, directory: path.basename(directory) }
    // Exclusive creation prevents overwriting another successful installation.
    const receiptHandle = await fs.open(pointer, 'wx', 0o600)
    try { await receiptHandle.writeFile(JSON.stringify(receipt)); await receiptHandle.sync() } finally { await receiptHandle.close() }
    onProgress('Node installation verified. No physical actions have been enabled.')
    return { executable, release: manifest.release, digest, reused: false }
  } finally {
    await lockHandle.close()
    await fs.unlink(lock)
  }
}

export async function selectManagedNode(configDir, digest) {
  localPath(configDir, 'Configuration directory')
  if (!HEX.test(digest)) throw new Error('Invalid managed Node selection')
  const root = path.join(configDir, 'node-installations')
  await privateDirectory(root)
  await regularFile(path.join(root, `${digest}.json`), 4096)
  const temporary = path.join(root, `selection-${randomBytes(8).toString('hex')}.tmp`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ contractVersion: 'physicalsystems-node-selection-v1', manifestDigest: digest })); await handle.sync() }
  finally { await handle.close() }
  await fs.rename(temporary, path.join(root, 'selected.json'))
}

export async function selectedNodeRelease(configDir) {
  localPath(configDir, 'Configuration directory')
  const root = path.join(configDir, 'node-installations')
  let bytes
  try { bytes = await regularFile(path.join(root, 'selected.json'), 4096) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  await privateDirectory(root)
  const selected = JSON.parse(bytes.toString('utf8'))
  if (!exact(selected, ['contractVersion', 'manifestDigest']) || selected.contractVersion !== 'physicalsystems-node-selection-v1' || !HEX.test(selected.manifestDigest)) throw new Error('Invalid managed Node selection')
  const receipt = JSON.parse((await regularFile(path.join(root, `${selected.manifestDigest}.json`), 4096)).toString('utf8'))
  if (!exact(receipt, ['contractVersion', 'manifestDigest', 'directory']) || receipt.contractVersion !== 'physicalsystems-node-install-receipt-v1'
    || receipt.manifestDigest !== selected.manifestDigest || !new RegExp(`^${selected.manifestDigest.slice(0, 16)}-[a-f0-9]{16}$`).test(receipt.directory)) throw new Error('Invalid managed Node receipt')
  return readNodeInstallManifest(path.join(root, receipt.directory, 'manifest.json'), selected.manifestDigest)
}

export async function bundledNodeRelease({ python, env, run, packageDirectory = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const metadata = JSON.parse((await regularFile(path.join(packageDirectory, 'package.json'), MAX_MANIFEST)).toString('utf8'))
  if (Object.hasOwn(metadata, 'physicalsystemsNodeBundle')) {
    const { NODE_BUNDLE_PATH, readNodeBundle } = await import('./node-bundle.js')
    if (metadata.physicalsystemsNodeBundle !== NODE_BUNDLE_PATH) throw new Error('Invalid packaged backend location')
    // A declared bundle that is absent/corrupt must never fall back to a download.
    const bundle = await readNodeBundle(path.join(packageDirectory, NODE_BUNDLE_PATH))
    const interpreter = await inspectInstallationPython({ executable: python, env, run })
    const matches = bundle.releases.filter(({ manifest }) => manifest.platform === `${process.platform}-${process.arch}` && manifest.python === interpreter.version)
    if (matches.length !== 1) throw new Error('No bundled Node release is qualified for this Python/platform combination')
    return matches[0]
  }
  const indexFile = fileURLToPath(new URL('./node-releases.json', import.meta.url))
  const index = JSON.parse((await regularFile(indexFile, MAX_MANIFEST)).toString('utf8'))
  if (!exact(index, ['contractVersion', 'releases']) || index.contractVersion !== 'physicalsystems-node-index-v1' || !Array.isArray(index.releases)) throw new Error('Invalid bundled Node release index')
  if (!index.releases.length) return null // No invented URLs/hashes before release approval.
  const interpreter = await inspectInstallationPython({ executable: python, env, run })
  const matches = index.releases.filter((entry) => entry.platform === `${process.platform}-${process.arch}` && entry.python === interpreter.version)
  if (matches.length !== 1) throw new Error('No Node release is qualified for this Python/platform combination')
  const selected = matches[0]
  if (!exact(selected, ['platform', 'python', 'manifest', 'sha256']) || !/^[a-z0-9-]+\.json$/.test(selected.manifest)) throw new Error('Invalid bundled Node release reference')
  return readNodeInstallManifest(fileURLToPath(new URL(`./node-releases/${selected.manifest}`, import.meta.url)), selected.sha256)
}
