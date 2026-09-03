import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { createExecutionClient } from '../physical/execution-client.js'

const PREFIX = 'PHYSICAL_NODE_READY '
const TOKEN_NAME = 'PHYSICAL_NODE_EXECUTION_TOKEN'
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function absolute(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)
    || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')))) throw new Error(`${label} must be an explicit absolute local path`)
  return value
}

/** Explicit operator opt-in only. This starts one installed executable; it
 * never installs dependencies, selects hardware, restarts or dispatches a run.
 */
export async function startNodeSupervisor({ env = process.env, spawnImpl = spawn, createExecutionClientImpl = createExecutionClient,
  startupMs = 20000, shutdownMs = 8000 } = {}) {
  const executable = env.PHYSICAL_NODE_EXECUTABLE
  if (!executable) return null // Existing external-node behavior is unchanged.
  absolute(executable, 'PHYSICAL_NODE_EXECUTABLE')
  try {
    if (!statSync(executable).isFile()) throw new Error()
    accessSync(executable, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  } catch { throw new Error('PHYSICAL_NODE_EXECUTABLE must identify an accessible installed executable') }
  const mode = env.PHYSICAL_NODE_EXECUTION_MODE || 'physical'
  if (!['simulation', 'physical', 'discovery'].includes(mode)) throw new Error('PHYSICAL_NODE_EXECUTION_MODE must be physical, simulation or discovery')
  const data = absolute(env.PHYSICAL_NODE_EXECUTION_DATA, 'PHYSICAL_NODE_EXECUTION_DATA')
  const args = ['serve-physical-node', '--supervised-stdio', '--port', '0', '--execution-data', data]
  if (mode !== 'physical') {
    if (env.PHYSICAL_NODE_EXECUTION_CONFIG || env.PHYSICAL_NODE_REGISTRY) throw new Error('Discovery/simulation cannot include physical configuration or registry paths')
    if (mode === 'simulation') args.push('--execution-simulation')
    else args.push('--camera-preview') // Broker is lazy: operator selects and opens the camera later.
  } else {
    const config = absolute(env.PHYSICAL_NODE_EXECUTION_CONFIG, 'PHYSICAL_NODE_EXECUTION_CONFIG')
    try { if (!statSync(config).isFile()) throw new Error() }
    catch { throw new Error('PHYSICAL_NODE_EXECUTION_CONFIG must identify a local configuration file') }
    args.push('--execution-config', config, '--physical-registry', absolute(env.PHYSICAL_NODE_REGISTRY, 'PHYSICAL_NODE_REGISTRY'))
  }
  const token = randomBytes(32).toString('base64url')
  const childEnvironment = Object.fromEntries(Object.entries(env).filter(([name]) => ![TOKEN_NAME, 'PHYSICAL_NODE_CAMERA_TOKEN'].includes(name.toUpperCase())))
  childEnvironment[TOKEN_NAME] = token
  if (mode === 'discovery') {
    let cameraToken
    do { cameraToken = randomBytes(32).toString('base64url') } while (cameraToken === token)
    childEnvironment.PHYSICAL_NODE_CAMERA_TOKEN = cameraToken
  }
  let child
  try { child = spawnImpl(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment }) }
  catch { throw new Error('The configured local Node could not be started') }
  let exited = false, closing = null, startupTimer, rejectReady, buffer = '', outputBytes = 0
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject
    startupTimer = setTimeout(() => reject(new Error('Local Node readiness timed out')), startupMs)
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 65536) return reject(new Error('Local Node startup output exceeded its bound'))
      buffer += chunk.toString('utf8')
      if (buffer.length > 16384) return reject(new Error('Local Node readiness line exceeded its bound'))
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1)
        if (!line.startsWith(PREFIX)) continue
        try {
          const message = JSON.parse(line.slice(PREFIX.length))
          if (JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(['contractVersion', 'pid', 'url'])
            || message.contractVersion !== 'physicalsystems-node-ready-v1' || !Number.isSafeInteger(message.pid)
            || message.pid <= 0) throw new Error()
          const url = new URL(message.url)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1
            || url.username || url.password || url.pathname !== '/' || url.search || url.hash || message.url !== url.origin) throw new Error()
          resolve(url.origin)
        } catch { reject(new Error('Local Node did not provide an exact owned readiness record')) }
      }
    })
  })
  child.stderr.resume() // Native/provider diagnostics never enter model/browser logs.
  child.stdin.on('error', () => {})
  child.on('error', () => rejectReady(new Error('The configured local Node could not be started')))
  child.once('exit', () => { exited = true; rejectReady(new Error('The configured local Node exited before readiness')) })
  async function dispose() {
    if (closing) return closing
    closing = (async () => {
      clearTimeout(startupTimer)
      if (!exited) {
        try { child.stdin.end(`${JSON.stringify({ command: 'shutdown' })}\n`) } catch { /* EOF is also a shutdown request. */ }
        const deadline = Date.now() + shutdownMs
        while (!exited && Date.now() < deadline) await wait(Math.min(50, Math.max(1, deadline - Date.now())))
      }
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref?.()
      if (!exited) throw new Error('Local Node shutdown is unconfirmed. Do not start another controller; use the physical stop procedure and inspect the existing Node.')
    })()
    return closing
  }
  try {
    const origin = await ready
    clearTimeout(startupTimer)
    // The owned stdout plus fresh secret proves this is the launched Node, not
    // another listener. A Windows entrypoint launcher can have a different PID
    // than Python; never signal a PID from this record. Status is read-only.
    const status = await createExecutionClientImpl({ baseUrl: origin, token }).status()
    if (exited || (mode === 'discovery' ? status.mode !== null : status.mode !== null && status.mode !== mode)) throw new Error('Local Node mode does not match the operator selection')
    const environment = Object.freeze({ ...childEnvironment, TINYEDGE_PHYSICAL_NODE_URL: origin })
    return Object.freeze({ environment, dispose })
  } catch {
    try { await dispose() } catch { throw new Error('Local Node startup failed and shutdown is unconfirmed. Do not start another controller; inspect the existing Node.') }
    throw new Error('Local Node startup was not authenticated. Check the explicitly installed executable and local configuration; no automatic restart was attempted.')
  }
}
