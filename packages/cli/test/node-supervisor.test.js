import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startNodeSupervisor } from '../src/harness/node-supervisor.js'

const tokenName = 'PHYSICAL_NODE_EXECUTION_TOKEN'
const configuration = fileURLToPath(new URL('../package.json', import.meta.url))
const simulationEnv = () => ({ PHYSICAL_NODE_EXECUTABLE: process.execPath, PHYSICAL_NODE_EXECUTION_MODE: 'simulation', PHYSICAL_NODE_EXECUTION_DATA: path.join(tmpdir(), 'supervisor-test-data'), [tokenName]: 'parent-not-shared', physical_node_execution_token: 'other-casing', PATH: process.env.PATH || '' })
function fixture({ record = {}, autoExit = true, ready = true, exitEarly = false, authError = false, mode = 'simulation' } = {}) {
  const child = new EventEmitter()
  child.pid = 12077; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  child.kill = () => { assert.fail('Supervisor must not blindly kill a possibly physical controller') }
  child.unref = () => { record.unref = true }
  child.stdin.on('data', (value) => { record.shutdown = String(value) })
  child.stdin.on('finish', () => { if (autoExit) setImmediate(() => child.emit('exit', 0)) })
  return {
    record, child,
    spawnImpl(executable, args, options) {
      Object.assign(record, { executable, args, options })
      setImmediate(() => {
        if (exitEarly) return child.emit('exit', 1)
        if (ready) child.stdout.write(`PHYSICAL_NODE_READY ${JSON.stringify(typeof ready === 'object' ? ready : { contractVersion: 'physicalsystems-node-ready-v1', pid: child.pid, url: 'http://127.0.0.1:39127' })}\n`)
      })
      return child
    },
    createExecutionClientImpl(options) {
      record.client = options
      return { async status() { if (authError) throw new Error('private auth diagnostic'); return { mode, availability: mode ? 'available' : 'unavailable' } } }
    },
  }
}

test('supervisor absent is inert and never probes an external node or installs dependencies', async () => {
  assert.equal(await startNodeSupervisor({ env: {}, spawnImpl() { assert.fail('must not spawn') } }), null)
})

test('explicit simulation launches one owned child with private per-session auth and graceful shutdown', async () => {
  const env = simulationEnv(), original = { ...env }, fake = fixture()
  const host = await startNodeSupervisor({ env, ...fake, shutdownMs: 200 })
  assert.deepEqual(env, original)
  assert.equal(fake.record.options.shell, false)
  assert.equal(fake.record.options.windowsHide, true)
  assert.deepEqual(fake.record.args, ['serve-physical-node', '--supervised-stdio', '--port', '0', '--execution-data', env.PHYSICAL_NODE_EXECUTION_DATA, '--execution-simulation'])
  assert.equal(fake.record.options.env.physical_node_execution_token, undefined)
  assert.match(fake.record.options.env[tokenName], /^[\w-]{43}$/)
  assert.notEqual(fake.record.options.env[tokenName], env[tokenName])
  assert.equal(fake.record.client.token, fake.record.options.env[tokenName])
  assert.equal(host.environment.TINYEDGE_PHYSICAL_NODE_URL, 'http://127.0.0.1:39127')
  assert.equal(host.environment[tokenName], fake.record.client.token)
  assert.equal(fake.record.args.join(' ').includes(fake.record.client.token), false)
  await host.dispose(); await host.dispose()
  assert.deepEqual(JSON.parse(fake.record.shutdown), { command: 'shutdown' })
  assert.equal(fake.record.unref, true)
})

test('explicit physical child receives only the selected configuration/registry and never a preview flag', async () => {
  const env = { ...simulationEnv(), PHYSICAL_NODE_EXECUTION_MODE: 'physical', PHYSICAL_NODE_EXECUTION_CONFIG: configuration, PHYSICAL_NODE_REGISTRY: path.join(tmpdir(), 'supervisor-registry.json') }
  const fake = fixture({ mode: 'physical' })
  const host = await startNodeSupervisor({ env, ...fake, shutdownMs: 200 })
  assert.ok(fake.record.args.includes('--execution-config'))
  assert.ok(fake.record.args.includes(configuration))
  assert.ok(fake.record.args.includes('--physical-registry'))
  assert.equal(fake.record.args.some((item) => /camera|replay|approve/.test(item)), false)
  await host.dispose()
})

test('managed discovery starts the real empty Node, not simulated hardware or an executor', async () => {
  const env = { ...simulationEnv(), PHYSICAL_NODE_EXECUTION_MODE: 'discovery' }, fake = fixture({ mode: null })
  const host = await startNodeSupervisor({ env, ...fake, shutdownMs: 200 })
  assert.equal(fake.record.args.some((arg) => ['--execution-simulation', '--execution-config', '--physical-registry'].includes(arg)), false)
  assert.ok(fake.record.args.includes('--camera-preview'))
  assert.match(host.environment.PHYSICAL_NODE_CAMERA_TOKEN, /^[\w-]{43}$/)
  assert.notEqual(host.environment.PHYSICAL_NODE_CAMERA_TOKEN, host.environment.PHYSICAL_NODE_EXECUTION_TOKEN)
  assert.equal(fake.record.args.join(' ').includes(host.environment.PHYSICAL_NODE_CAMERA_TOKEN), false)
  await host.dispose()
  await assert.rejects(startNodeSupervisor({ env, ...fixture({ mode: 'simulation' }), shutdownMs: 200 }), /not authenticated/)
})

test('relative paths, missing explicit fields, mode mixing and unknown modes reject before spawn', async () => {
  const cases = [
    { PHYSICAL_NODE_EXECUTABLE: 'node' }, { PHYSICAL_NODE_EXECUTION_DATA: 'relative/data' },
    { PHYSICAL_NODE_EXECUTION_MODE: 'other' }, { PHYSICAL_NODE_EXECUTION_CONFIG: configuration },
    { PHYSICAL_NODE_EXECUTION_MODE: 'physical', PHYSICAL_NODE_EXECUTION_CONFIG: configuration },
  ]
  for (const change of cases) await assert.rejects(startNodeSupervisor({ env: { ...simulationEnv(), ...change }, spawnImpl() { assert.fail('must not spawn') } }))
})

test('invalid PID/origin, extra readiness fields and failed private auth cannot attach to another listener', async () => {
  const good = { contractVersion: 'physicalsystems-node-ready-v1', pid: 12077, url: 'http://127.0.0.1:39127' }
  for (const bad of [{ ...good, pid: 0 }, { ...good, pid: Number.MAX_SAFE_INTEGER + 1 }, { ...good, url: 'http://example.com:39127' }, { ...good, url: 'http://127.0.0.1:39127/other' }, { ...good, approved: true }]) {
    const fake = fixture({ ready: bad })
    await assert.rejects(startNodeSupervisor({ env: simulationEnv(), ...fake, shutdownMs: 200 }), /not authenticated/)
    assert.equal(fake.record.client, undefined)
    assert.ok(fake.record.shutdown)
  }
  const fake = fixture({ authError: true })
  await assert.rejects(startNodeSupervisor({ env: simulationEnv(), ...fake, shutdownMs: 200 }), (error) => {
    assert.match(error.message, /not authenticated/)
    assert.equal(error.message.includes('private auth diagnostic'), false)
    return true
  })
})

test('trusted entrypoint launcher and runtime may have different PIDs; only owned stdin is used for shutdown', async () => {
  const fake = fixture({ ready: { contractVersion: 'physicalsystems-node-ready-v1', pid: 99123, url: 'http://127.0.0.1:39127' } })
  const host = await startNodeSupervisor({ env: simulationEnv(), ...fake, shutdownMs: 200 })
  assert.equal(fake.record.client.token, fake.record.options.env[tokenName])
  await host.dispose()
  assert.deepEqual(JSON.parse(fake.record.shutdown), { command: 'shutdown' })
})

test('startup timeout/early child exit fail closed without automatic restart', async () => {
  for (const options of [{ ready: false }, { exitEarly: true }]) {
    const fake = fixture(options)
    await assert.rejects(startNodeSupervisor({ env: simulationEnv(), ...fake, startupMs: 15, shutdownMs: 200 }), /not authenticated/)
    assert.equal(fake.record.client, undefined)
  }
})

test('wrong execution mode is rejected; unavailable authenticated metadata is not invented readiness', async () => {
  await assert.rejects(startNodeSupervisor({ env: simulationEnv(), ...fixture({ mode: 'physical' }), shutdownMs: 200 }), /not authenticated/)
  const host = await startNodeSupervisor({ env: simulationEnv(), ...fixture({ mode: null }), shutdownMs: 200 })
  await host.dispose()
})

test('unconfirmed shutdown is bounded and reported without force kill or replacement', async () => {
  const fake = fixture({ autoExit: false })
  const host = await startNodeSupervisor({ env: simulationEnv(), ...fake, shutdownMs: 20 })
  await assert.rejects(host.dispose(), /shutdown is unconfirmed/)
  assert.equal(fake.record.unref, true)
})
