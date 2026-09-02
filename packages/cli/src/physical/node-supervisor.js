import { spawn } from 'node:child_process'

import {
  createPhysicalNodeClient,
  DEFAULT_PHYSICAL_NODE_URL,
  normalizePhysicalNodeUrl,
  PHYSICAL_NODE_TIMEOUT,
  PHYSICAL_NODE_UNAVAILABLE,
} from './node-client.js'

const DEFAULT_EXECUTABLE = 'tinyedge-agent'
const DEFAULT_STARTUP_TIMEOUT_MS = 12_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_POLL_INTERVAL_MS = 150
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000
const MAX_DIAGNOSTIC_BYTES = 8 * 1024

export const PHYSICAL_NODE_EXECUTABLE_ENV = 'TINYEDGE_PHYSICAL_NODE_EXECUTABLE'

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum} ms`)
  }
  return value
}

function executableName(value) {
  const result = String(value ?? '').trim()
  if (!result || result.length > 4096 || result.includes('\0') || /[\r\n]/.test(result)) {
    throw new TypeError(`${PHYSICAL_NODE_EXECUTABLE_ENV} must name one executable`)
  }
  return result
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function diagnosticText(value, maximum = 800) {
  const result = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!result) return ''
  return result.length <= maximum ? result : `${result.slice(0, maximum)}…`
}

function errorDetail(error) {
  return diagnosticText(error instanceof Error ? error.message : error) || 'unknown failure'
}

function appendBounded(current, chunk) {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const combined = Buffer.concat([current, incoming])
  return combined.length <= MAX_DIAGNOSTIC_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_DIAGNOSTIC_BYTES)
}

function observeChild(child) {
  if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
    throw new TypeError('Physical node launcher returned an invalid child process')
  }
  const state = {
    error: null,
    exit: null,
    stderr: Buffer.alloc(0),
  }
  let settle
  state.completed = new Promise((resolve) => { settle = resolve })
  child.once('error', (error) => {
    state.error = error
    settle()
  })
  child.once('exit', (code, signal) => {
    state.exit = { code, signal }
    settle()
  })
  child.stdout?.on?.('data', () => {})
  child.stderr?.on?.('data', (chunk) => {
    state.stderr = appendBounded(state.stderr, chunk)
  })
  return state
}

function childIsRunning(child, state) {
  return state.error === null
    && state.exit === null
    && child.exitCode == null
    && child.signalCode == null
}

async function terminateChild(child, state, { sleepImpl, shutdownTimeoutMs }) {
  if (!childIsRunning(child, state)) return
  let signalled = false
  try {
    signalled = child.kill('SIGTERM')
  } catch {
    return
  }
  if (!signalled) return
  await Promise.race([state.completed, sleepImpl(shutdownTimeoutMs)])
  if (!childIsRunning(child, state)) return
  try {
    child.kill('SIGKILL')
  } catch {
    return
  }
  await Promise.race([state.completed, sleepImpl(shutdownTimeoutMs)])
}

function reusedNode(origin) {
  return Object.freeze({
    origin,
    started: false,
    async dispose() {},
  })
}

function ownedNode(origin, child, state, options) {
  let disposePromise
  const onProcessExit = () => {
    if (!childIsRunning(child, state)) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Process exit cannot wait or recover; the normal async path is below.
    }
  }
  options.processRef?.once?.('exit', onProcessExit)
  return Object.freeze({
    origin,
    started: true,
    dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          options.processRef?.removeListener?.('exit', onProcessExit)
          await terminateChild(child, state, options)
        })()
      }
      return disposePromise
    },
  })
}

function spawnedFailure(executable, origin, state, lastError) {
  if (state.error?.code === 'ENOENT') {
    return new Error(
      `No compatible Physical Systems node is running at ${origin}, and ${executable} was not found. `
      + `Install a separately distributed compatible tinyedge-agent in PATH or set `
      + `${PHYSICAL_NODE_EXECUTABLE_ENV} to its exact launcher. The public npm package does not `
      + 'contain the Agent, and the Harness did not install or change anything.',
    )
  }
  if (state.error) {
    return new Error(
      `Physical Systems node launcher ${executable} failed: ${errorDetail(state.error)}. `
      + `Set ${PHYSICAL_NODE_EXECUTABLE_ENV} to a working tinyedge-agent launcher.`,
    )
  }
  if (state.exit) {
    const status = state.exit.signal
      ? `signal ${state.exit.signal}`
      : `exit code ${state.exit.code}`
    const stderr = diagnosticText(state.stderr.toString('utf8'))
    return new Error(
      `Physical Systems node launcher ${executable} stopped with ${status}`
      + `${stderr ? `: ${stderr}` : '.'} Start a compatible node manually or configure `
      + `${PHYSICAL_NODE_EXECUTABLE_ENV}.`,
    )
  }
  return new Error(
    `Physical Systems node launched with ${executable} but did not become compatible at ${origin}: `
    + `${errorDetail(lastError)}. Start it manually or configure ${PHYSICAL_NODE_EXECUTABLE_ENV}.`,
  )
}

export async function inspectPhysicalNode({
  origin,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  createClientImpl = createPhysicalNodeClient,
} = {}) {
  const client = createClientImpl({ baseUrl: origin, fetchImpl, timeoutMs })
  await client.inspect()
  return client.origin
}

export async function ensurePhysicalNode({
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  inspectImpl = inspectPhysicalNode,
  createClientImpl = createPhysicalNodeClient,
  processRef = process,
  sleepImpl = delay,
  nowImpl = Date.now,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  boundedInteger(startupTimeoutMs, 'Physical node startup timeout', 100, 60_000)
  boundedInteger(requestTimeoutMs, 'Physical node request timeout', 100, 30_000)
  boundedInteger(pollIntervalMs, 'Physical node poll interval', 10, 5_000)
  boundedInteger(shutdownTimeoutMs, 'Physical node shutdown timeout', 100, 30_000)
  if (typeof inspectImpl !== 'function' || typeof spawnImpl !== 'function') {
    throw new TypeError('Physical node inspection and launch implementations are required')
  }
  if (typeof sleepImpl !== 'function' || typeof nowImpl !== 'function') {
    throw new TypeError('Physical node clock implementations are required')
  }

  const configuredOrigin = env?.TINYEDGE_PHYSICAL_NODE_URL
  const origin = normalizePhysicalNodeUrl(configuredOrigin || DEFAULT_PHYSICAL_NODE_URL)
  const inspect = (timeoutMs = requestTimeoutMs) => inspectImpl({
    origin,
    fetchImpl,
    timeoutMs,
    createClientImpl,
  })

  let initialError
  try {
    await inspect()
    return reusedNode(origin)
  } catch (error) {
    initialError = error
  }

  if (configuredOrigin) {
    throw new Error(
      `The configured Physical Systems node at ${origin} is not compatible or reachable: `
      + `${errorDetail(initialError)}. Start it, correct TINYEDGE_PHYSICAL_NODE_URL, or unset the override.`,
    )
  }
  if (initialError?.code !== PHYSICAL_NODE_UNAVAILABLE) {
    const occupied = initialError?.code === PHYSICAL_NODE_TIMEOUT
      ? 'did not answer with a compatible contract'
      : 'is not a compatible Physical Systems node'
    throw new Error(
      `A service at ${origin} ${occupied}: ${errorDetail(initialError)}. `
      + 'Stop that service or set TINYEDGE_PHYSICAL_NODE_URL to a compatible loopback node.',
    )
  }

  const executable = executableName(env?.[PHYSICAL_NODE_EXECUTABLE_ENV] || DEFAULT_EXECUTABLE)
  const port = new URL(origin).port || '80'
  let child
  try {
    child = spawnImpl(executable, ['serve-physical-node', '--port', port], {
      detached: false,
      env: { ...env, PYTHONUNBUFFERED: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(
      `Physical Systems node launcher ${executable} could not start: ${errorDetail(error)}. `
      + `Install a separately distributed compatible tinyedge-agent or set `
      + `${PHYSICAL_NODE_EXECUTABLE_ENV} to its exact launcher.`,
    )
  }

  const state = observeChild(child)
  const terminationOptions = { processRef, sleepImpl, shutdownTimeoutMs }
  const deadline = nowImpl() + startupTimeoutMs
  let lastError = initialError
  try {
    for (;;) {
      if (state.error) throw spawnedFailure(executable, origin, state, lastError)
      const remaining = deadline - nowImpl()
      if (remaining <= 0) break
      try {
        await inspect(Math.min(requestTimeoutMs, Math.max(100, remaining)))
        return childIsRunning(child, state)
          ? ownedNode(origin, child, state, terminationOptions)
          : reusedNode(origin)
      } catch (error) {
        lastError = error
        if (![PHYSICAL_NODE_UNAVAILABLE, PHYSICAL_NODE_TIMEOUT].includes(error?.code)) {
          throw new Error(
            `The launched service at ${origin} is not a compatible Physical Systems node: `
            + `${errorDetail(error)}.`,
          )
        }
      }
      if (state.error || state.exit) break
      await sleepImpl(Math.min(pollIntervalMs, Math.max(10, deadline - nowImpl())))
    }
    throw spawnedFailure(executable, origin, state, lastError)
  } catch (error) {
    await terminateChild(child, state, terminationOptions)
    throw error
  }
}
