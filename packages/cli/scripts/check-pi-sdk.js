import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = await import('@tinyedge/pi-runtime')

for (const [name, value] of [
  ['createAgentSession', sdk.createAgentSession],
  ['createAgentSessionFromServices', sdk.createAgentSessionFromServices],
  ['createAgentSessionRuntime', sdk.createAgentSessionRuntime],
  ['createAgentSessionServices', sdk.createAgentSessionServices],
  ['defineTool', sdk.defineTool],
  ['DefaultResourceLoader', sdk.DefaultResourceLoader],
  ['InteractiveMode', sdk.InteractiveMode],
  ['ModelRuntime', sdk.ModelRuntime],
  ['ModelRuntime.create', sdk.ModelRuntime?.create],
  ['SessionManager', sdk.SessionManager],
  ['SessionManager.create', sdk.SessionManager?.create],
  ['SettingsManager', sdk.SettingsManager],
]) {
  if (typeof value !== 'function') throw new Error(`Official Pi SDK does not expose callable ${name}`)
}

const piDistDir = path.dirname(fileURLToPath(import.meta.resolve('@tinyedge/pi-runtime')))
const [interactiveMode, modelRuntime, packageManager, toolsManager, versionCheck] = await Promise.all([
  'modes/interactive/interactive-mode.js',
  'core/model-runtime.js',
  'core/package-manager.js',
  'utils/tools-manager.js',
  'utils/version-check.js',
].map((relativePath) => readFile(path.join(piDistDir, relativePath), 'utf8')))

assert.match(
  toolsManager,
  /export async function ensureTool[\s\S]{0,600}if \(isOfflineModeEnabled\(\)\)[\s\S]{0,300}skipping download/,
  'Official Pi offline mode must prevent managed-tool downloads',
)
assert.match(
  interactiveMode,
  /async run\(\)[\s\S]{0,250}if \(!process\.env\.PI_OFFLINE\)[\s\S]{0,400}refreshModelCatalogs/,
  'Official Pi offline mode must prevent startup catalog refreshes',
)
assert.match(
  interactiveMode,
  /async checkForPackageUpdates\(\)[\s\S]{0,150}if \(process\.env\.PI_OFFLINE\)/,
  'Official Pi offline mode must prevent startup package checks',
)
assert.match(
  interactiveMode,
  /reportInstallTelemetry\(version\)[\s\S]{0,150}if \(process\.env\.PI_OFFLINE\)/,
  'Official Pi offline mode must prevent install telemetry',
)
assert.match(
  interactiveMode,
  /async checkTmuxKeyboardSetup\(\)[\s\S]{0,150}if \(!process\.env\.TMUX\)/,
  'Official Pi must skip its tmux subprocess when TMUX is absent',
)
assert.match(
  versionCheck,
  /checkForNewPiVersion\(currentVersion\)[\s\S]{0,150}PI_SKIP_VERSION_CHECK/,
  'Official Pi must honor its startup version-check opt-out',
)
assert.match(
  packageManager,
  /function isOfflineModeEnabled\(\)[\s\S]{0,150}process\.env\.PI_OFFLINE/,
  'Official Pi package management must honor offline mode',
)
assert.match(
  modelRuntime,
  /process\.env\.PI_OFFLINE === undefined/,
  'Official Pi model runtime must derive catalog-network startup state from offline mode',
)

console.log('TinyEdge Pi runtime SDK and offline-startup contracts are available.')
