import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { bundledNodeRelease, installManagedNode, readNodeInstallManifest, selectedNodeRelease, selectManagedNode } from '../physical/node-installation.js'

export function parseSetupNodeArgs(args) {
  const result = { yes: false }
  const flags = new Map([['--manifest', 'manifestPath'], ['--sha256', 'sha256'], ['--wheelhouse', 'wheelhouse'], ['--python', 'python']])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--yes' && !result.yes) { result.yes = true; continue }
    const key = flags.get(arg)
    if (!key || result[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unexpected setup-node argument: ${arg}`)
    result[key] = args[++index]
  }
  if (Boolean(result.manifestPath) !== Boolean(result.sha256) || (result.wheelhouse && !result.manifestPath)) throw new Error('A local release needs --manifest and --sha256 together; --wheelhouse requires that explicit release')
  return result
}

export async function approveNodeSetup({ release, bytes, previousRelease }, { yes = false, input = process.stdin, output = process.stdout } = {}) {
  if (yes) return true
  if (!input.isTTY || !output.isTTY) throw new Error('Node setup requires operator consent. Run physicalsystems setup-node --yes to explicitly approve a non-interactive software installation.')
  const prompt = createInterface({ input, output })
  try {
    const action = previousRelease ? `Update Physical Systems Node ${previousRelease} to ${release}` : `Install Physical Systems Node ${release}`
    const answer = await prompt.question(`${action} (${Math.ceil(bytes / 1024 / 1024)} MB) in a private Python environment? This sets up software; it does not enable robot movement. [y/N] `)
    return /^y(?:es)?$/i.test(answer.trim())
  } finally { prompt.close() }
}

export async function setupNodeCommand({ config, io = console, env = process.env, input, output, yes = false,
  manifestPath, sha256, wheelhouse, python, install = installManagedNode, loadBundled = bundledNodeRelease, authorize } = {}) {
  const release = manifestPath ? await readNodeInstallManifest(manifestPath, sha256) : await loadBundled({ python, env })
  if (!release) throw new Error('This candidate has no approved downloadable Node release yet. Use an explicit reviewed manifest and checksum for local verification; nothing was installed.')
  const result = await install({ ...release, configDir: config.configDir, env, python, ...(wheelhouse ? { wheelhouse } : {}),
    authorize: authorize || ((details) => approveNodeSetup(details, { yes, input, output })), onProgress: (message) => io.log(message) })
  await selectManagedNode(config.configDir, result.digest)
  io.log(`Physical Systems Node ${result.release} ${result.reused ? 'verified' : 'installed'}. Start physicalsystems to discover connected hardware; execution still requires commissioning.`)
  return result
}

export async function managedNodeEnvironment({ config, env = process.env, io = console, input, output,
  loadSelected = selectedNodeRelease, loadBundled = bundledNodeRelease, install = installManagedNode, authorize } = {}) {
  // Explicit host/external-node choices always win; no installation side effect.
  if (env.PHYSICAL_NODE_EXECUTABLE || env.TINYEDGE_PHYSICAL_NODE_URL) return env
  if (env.PHYSICAL_NODE_EXECUTION_CONFIG || env.PHYSICAL_NODE_REGISTRY || env.PHYSICAL_NODE_EXECUTION_MODE) throw new Error('Select an explicit PHYSICAL_NODE_EXECUTABLE for a configured executor or simulation. Automatic managed startup is discovery-only.')
  const selected = await loadSelected(config.configDir)
  const consent = authorize || ((details) => approveNodeSetup(details, { input, output }))
  const onProgress = (message) => io.log(message)
  let result, python
  if (selected) {
    // Verify the selected environment before considering a replacement. A bad
    // receipt, missing executable or failed probe must not become a repair or
    // an implicit upgrade; retain the original selection for diagnosis.
    result = await install({ ...selected, configDir: config.configDir, env, onProgress,
      authorize() { throw new Error('The selected Node installation is damaged; automatic repair is not allowed') } })
    if (!result.reused) throw new Error('The selected Node installation could not be verified')
    python = path.join(path.dirname(result.executable), process.platform === 'win32' ? 'python.exe' : 'python')
  }
  // Match the verified environment's Python when updating, rather than an
  // unrelated system default that may have changed since the first install.
  const bundled = await loadBundled({ env, ...(python ? { python } : {}) })
  // This is the only reviewed automatic update transition. Same-version
  // custom selections are intentional; older product bundles never downgrade.
  const upgrade = selected?.manifest.release === '0.2.0' && bundled?.manifest.release === '0.2.1'
  if (!selected && !bundled) return env // Development candidate: do not manufacture a release.
  if (upgrade) {
    const approved = await consent({ release: bundled.manifest.release, previousRelease: selected.manifest.release,
      bytes: bundled.manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0) })
    if (approved !== true) throw new Error('Node update was not approved; discovery was not started and the previous installation remains selected')
  }
  if (!selected || upgrade) {
    // Even an already-installed newer environment requires update consent
    // before selection changes. Failed setup never falls back to the old Node.
    result = await install({ ...bundled, configDir: config.configDir, env, python, onProgress,
      authorize: upgrade ? async () => true : consent })
    await selectManagedNode(config.configDir, result.digest)
  }
  // The installed console launcher is not Python -I. Do not let a developer's
  // PYTHONPATH/PYTHONHOME replace the verified distribution at managed startup.
  // Explicit external executables above remain an operator-owned environment.
  const managedEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^PYTHON/i.test(name) && name.toUpperCase() !== 'VIRTUAL_ENV'))
  return { ...managedEnv, PYTHONNOUSERSITE: '1', PHYSICAL_NODE_EXECUTABLE: result.executable, PHYSICAL_NODE_EXECUTION_MODE: 'discovery',
    PHYSICAL_NODE_EXECUTION_DATA: path.join(config.configDir, 'physical-node-data') }
}
