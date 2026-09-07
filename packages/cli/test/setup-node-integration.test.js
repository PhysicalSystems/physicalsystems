import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { createSetupRequirementsClient } from '../src/physical/setup-client.js'
import { createExecutionClient } from '../src/physical/execution-client.js'
import { createSetupInspector } from '../src/harness/setup-inspection.js'

// Explicit test-only source environment, with synthetic registry/providers.
// No driver, observation producer or installed configuration is opened here.
const python = process.env.PHYSICAL_SETUP_TEST_PYTHON
const nodeSource = process.env.PHYSICAL_SETUP_TEST_NODE_SOURCE
const helper = `
import json, os, sys, threading
from tinyedge_agent.physical_execution_fakes import create_simulation_context
from tinyedge_agent.physical_node_api import create_physical_node_server
context = create_simulation_context(sys.argv[1])
server = create_physical_node_server(None, registry=context.registry,
    execution_token=os.environ["PHYSICAL_NODE_EXECUTION_TOKEN"], setup_mode="simulation", port=0)
threading.Thread(target=server.serve_forever, daemon=True).start()
before = context.registry.store.load()
print(json.dumps({"origin": "http://127.0.0.1:" + str(server.server_address[1])}), flush=True)
try:
    for command in sys.stdin:
        if command.strip() != "metrics": break
        print(json.dumps({"commands": context.provider.command_count,
            "registryUnchanged": before == context.registry.store.load()}), flush=True)
finally:
    server.shutdown()
    server.server_close()
`

test('opt-in actual Node setup endpoint crosses the strict Harness contract without dispatch or configuration changes', {
  skip: !python || !nodeSource, timeout: 20000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'physical-setup-http-test-'))
  const token = randomBytes(32).toString('base64url')
  const child = spawn(python, ['-B', '-u', '-c', helper, directory], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [nodeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter), PHYSICAL_NODE_EXECUTION_TOKEN: token } })
  child.stderr.resume()
  t.after(async () => {
    child.stdin.end('\n')
    if (child.exitCode === null) {
      try { await once(child, 'exit', { signal: AbortSignal.timeout(5000) }) }
      catch { child.kill(); await once(child, 'exit').catch(() => {}) }
    }
    await rm(directory, { recursive: true, force: true })
  })
  const readLine = () => new Promise((resolve, reject) => {
    let buffer = ''
    const finish = (error, value) => {
      clearTimeout(timer); child.stdout.off('data', data); child.off('exit', ended); child.off('error', ended)
      if (error) reject(error); else resolve(value)
    }
    const ended = () => finish(Error('Synthetic setup helper ended before responding'))
    const data = chunk => {
      buffer += chunk.toString()
      if (buffer.length > 8192) return finish(Error('Synthetic helper response exceeded its bound'))
      if (buffer.includes('\n')) {
        try { finish(null, JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) }
        catch { finish(Error('Invalid synthetic helper response')) }
      }
    }
    const timer = setTimeout(() => finish(Error('Synthetic helper response timed out')), 5000)
    child.stdout.on('data', data); child.once('exit', ended); child.once('error', ended)
  })
  const { origin } = await readLine()
  const unauthorized = await fetch(`${origin}/v2/physical/setup/requirements`)
  assert.equal(unauthorized.status, 401)
  await unauthorized.body.cancel()
  const requirementsClient = createSetupRequirementsClient({ baseUrl: origin, token })
  const metadata = await requirementsClient.requirements()
  assert.equal(metadata.status, 'available')
  assert.equal(metadata.report.mode, 'simulation')
  assert.equal(metadata.report.inspectionOnly, true)
  assert.equal(metadata.report.physicalExecutionAuthorized, false)
  assert.ok(metadata.report.implementations.length > 0)
  const context = { generation: 0, snapshot: null, capabilityCatalog: null, routeReceipt: null }
  const inspector = createSetupInspector({ client: createExecutionClient({ baseUrl: origin, token }),
    requirementsClient, getContext: () => context })
  t.after(() => inspector.dispose())
  const result = await inspector.inspect({})
  assert.equal(result.implementationSetup.status, 'available')
  assert.equal(result.physicalReadiness, 'unverified')
  assert.equal(result.physicalExecutionAuthorized, false)
  const response = readLine()
  child.stdin.write('metrics\n')
  assert.deepEqual(await response, { commands: 0, registryUnchanged: true })
})
