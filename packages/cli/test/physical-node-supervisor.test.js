import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  ensurePhysicalNode,
  inspectPhysicalNode,
  PHYSICAL_NODE_EXECUTABLE_ENV,
} from '../src/physical/node-supervisor.js'
import {
  PHYSICAL_NODE_UNAVAILABLE,
} from '../src/physical/node-client.js'

function unavailable(message = 'not listening') {
  const error = new Error(message)
  error.code = PHYSICAL_NODE_UNAVAILABLE
  return error
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    queueMicrotask(() => child.finish(null, signal))
    return true
  }
  child.finish = (code, signal = null) => {
    if (child.exitCode != null || child.signalCode != null) return
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
  }
  return child
}

test('physical node inspector validates through the existing client boundary', async () => {
  let options
  let inspected = false
  const origin = await inspectPhysicalNode({
    origin: 'http://127.0.0.1:8876',
    fetchImpl: async () => {},
    timeoutMs: 321,
    createClientImpl(value) {
      options = value
      return {
        origin: 'http://127.0.0.1:8876',
        async inspect() { inspected = true },
      }
    },
  })
  assert.equal(origin, 'http://127.0.0.1:8876')
  assert.equal(inspected, true)
  assert.equal(options.baseUrl, 'http://127.0.0.1:8876')
  assert.equal(options.timeoutMs, 321)
})

test('supervisor reuses a compatible default node without launching or terminating it', async () => {
  let spawnCalls = 0
  const node = await ensurePhysicalNode({
    env: {},
    inspectImpl: async ({ origin }) => {
      assert.equal(origin, 'http://127.0.0.1:8876')
    },
    spawnImpl() { spawnCalls += 1 },
  })
  assert.equal(node.origin, 'http://127.0.0.1:8876')
  assert.equal(node.started, false)
  await node.dispose()
  assert.equal(spawnCalls, 0)
})

test('explicit node override is validated and never replaced with a child', async () => {
  let spawned = false
  await assert.rejects(ensurePhysicalNode({
    env: { TINYEDGE_PHYSICAL_NODE_URL: 'http://localhost:9000' },
    inspectImpl: async () => { throw unavailable() },
    spawnImpl() { spawned = true },
  }), /configured Physical Systems node.*correct TINYEDGE_PHYSICAL_NODE_URL/)
  assert.equal(spawned, false)
})

test('an incompatible service on the default port is not replaced', async () => {
  let spawned = false
  await assert.rejects(ensurePhysicalNode({
    env: {},
    inspectImpl: async () => { throw new Error('wrong contract') },
    spawnImpl() { spawned = true },
  }), /not a compatible Physical Systems node.*Stop that service/)
  assert.equal(spawned, false)
})

test('supervisor launches a configured Agent without a shell and owns only that child', async () => {
  const child = fakeChild()
  const processRef = new EventEmitter()
  let inspection = 0
  let launch
  const executable = '/opt/physical systems/bin/tinyedge-agent'
  const node = await ensurePhysicalNode({
    env: {
      [PHYSICAL_NODE_EXECUTABLE_ENV]: executable,
      PATH: '/usr/bin',
    },
    processRef,
    inspectImpl: async () => {
      inspection += 1
      if (inspection === 1) throw unavailable()
    },
    spawnImpl(command, args, options) {
      launch = { command, args, options }
      return child
    },
  })

  assert.equal(node.started, true)
  assert.equal(launch.command, executable)
  assert.deepEqual(launch.args, ['serve-physical-node', '--port', '8876'])
  assert.equal(launch.options.shell, false)
  assert.equal(launch.options.detached, false)
  assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(launch.options.env.PYTHONUNBUFFERED, '1')
  assert.equal(processRef.listenerCount('exit'), 1)

  await node.dispose()
  await node.dispose()
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(processRef.listenerCount('exit'), 0)
})

test('a node started concurrently is reused when this supervisor child already exited', async () => {
  const child = fakeChild()
  let inspection = 0
  const node = await ensurePhysicalNode({
    env: {},
    inspectImpl: async () => {
      inspection += 1
      if (inspection === 1) throw unavailable()
    },
    spawnImpl() {
      queueMicrotask(() => child.finish(1))
      return child
    },
  })
  assert.equal(node.started, false)
  await node.dispose()
  assert.deepEqual(child.signals, [])
})

test('missing Agent launcher names the separate distribution boundary without installing anything', async () => {
  const child = fakeChild()
  let inspection = 0
  await assert.rejects(ensurePhysicalNode({
    env: {},
    inspectImpl: async () => {
      inspection += 1
      throw unavailable()
    },
    spawnImpl() {
      queueMicrotask(() => {
        const error = new Error('spawn tinyedge-agent ENOENT')
        error.code = 'ENOENT'
        child.emit('error', error)
      })
      return child
    },
  }), /tinyedge-agent was not found.*public npm package does not contain the Agent.*did not install or change anything/)
  assert.ok(inspection >= 1)
  assert.deepEqual(child.signals, [])
})

test('an incompatible response after launch terminates the child and cannot reach the Harness', async () => {
  const child = fakeChild()
  let inspection = 0
  await assert.rejects(ensurePhysicalNode({
    env: {},
    inspectImpl: async () => {
      inspection += 1
      if (inspection === 1) throw unavailable()
      throw new Error('wrong contract after launch')
    },
    spawnImpl: () => child,
  }), /launched service.*not a compatible Physical Systems node/)
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('shutdown escalates only its stubborn child after the bounded grace period', async () => {
  const child = fakeChild()
  child.kill = (signal) => {
    child.signals.push(signal)
    if (signal === 'SIGKILL') queueMicrotask(() => child.finish(null, signal))
    return true
  }
  let inspection = 0
  let waits = 0
  const node = await ensurePhysicalNode({
    env: {},
    shutdownTimeoutMs: 100,
    sleepImpl: async () => { waits += 1 },
    inspectImpl: async () => {
      inspection += 1
      if (inspection === 1) throw unavailable()
    },
    spawnImpl: () => child,
  })

  await node.dispose()
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(waits, 2)
})

test('startup timeout terminates the child created by this supervisor', async () => {
  const child = fakeChild()
  let now = 0
  await assert.rejects(ensurePhysicalNode({
    env: {},
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    pollIntervalMs: 10,
    shutdownTimeoutMs: 100,
    nowImpl: () => now,
    sleepImpl: async (milliseconds) => { now += milliseconds },
    inspectImpl: async () => { throw unavailable() },
    spawnImpl: () => child,
  }), /did not become compatible/)
  assert.deepEqual(child.signals, ['SIGTERM'])
})
