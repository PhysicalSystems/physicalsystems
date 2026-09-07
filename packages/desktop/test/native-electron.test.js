// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const enabled = process.env.PHYSICALSYSTEMS_DESKTOP_NATIVE_TESTS === '1'
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const repositoryDir = path.resolve(packageDir, '../..')

async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function unusedLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function connectInspector(url) {
  assert.equal(new URL(url).hostname, '127.0.0.1', 'The test inspector must remain on loopback')
  const socket = new WebSocket(url)
  const requests = new Map()
  let nextId = 0
  const rejectAll = () => {
    for (const request of requests.values()) request.reject(new Error('The owned test inspector closed'))
    requests.clear()
  }
  socket.addEventListener('close', rejectAll)
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = requests.get(message.id)
    if (!request) return
    requests.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  try {
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    }), 5_000, 'Inspector connection')
  } catch (error) { socket.close(); throw error }
  const rpc = async (method, params = {}) => {
    const id = ++nextId
    try {
      return await bounded(new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }), 12_000, method)
    } finally { requests.delete(id) }
  }
  return {
    rpc,
    async evaluate(expression) {
      const response = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(`Inspector evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
      return response.result.value
    },
    close() { rejectAll(); socket.close() },
  }
}

// Linux process identities include the kernel start time, so cleanup cannot
// mistake a subsequently reused PID for a process belonging to this test.
async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { pid, parentPid: Number(fields[1]), state: fields[0], startTime: fields[19] }
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error }
}

async function rememberDescendants(rootPid, owned) {
  const expected = owned.get(rootPid)
  const root = await processIdentity(rootPid)
  if (!expected || root?.startTime !== expected.startTime) return
  const identities = (await Promise.all((await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map((entry) => processIdentity(Number(entry))))).filter(Boolean)
  let changed = true
  const selected = new Set([rootPid])
  while (changed) {
    changed = false
    for (const identity of identities) {
      if (!selected.has(identity.pid) && selected.has(identity.parentPid)) { selected.add(identity.pid); changed = true }
    }
  }
  for (const identity of identities) if (selected.has(identity.pid)) owned.set(identity.pid, identity)
}

async function survivingProcesses(owned) {
  return (await Promise.all([...owned.values()].map(async (identity) => {
    const current = await processIdentity(identity.pid)
    return current?.startTime === identity.startTime ? current : null
  }))).filter(Boolean)
}

test('native sandboxed Electron completes the scripted simulation journey and ordinary cleanup', {
  skip: !enabled ? 'Set PHYSICALSYSTEMS_DESKTOP_NATIVE_TESTS=1 for opt-in native qualification'
    : process.platform !== 'linux' ? 'This native qualification currently covers Linux with X11' : false,
  timeout: 150_000,
}, async (t) => {
  assert.ok(process.env.DISPLAY, 'Native qualification requires an existing graphical X11 session. Inherit DISPLAY and its XAUTHORITY; do not disable the Electron sandbox or install a display server for this test.')
  // Resolve only after opt-in: the ordinary test suite needs no Electron install.
  const electron = createRequire(import.meta.url)('electron')
  const evidenceDir = process.env.PHYSICALSYSTEMS_DESKTOP_NATIVE_EVIDENCE
  if (evidenceDir) {
    assert.ok(path.isAbsolute(evidenceDir), 'Native evidence requires an absolute output directory')
    const relative = path.relative(repositoryDir, path.resolve(evidenceDir))
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Keep local native evidence outside the repository')
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'physicalsystems-desktop-native-'))
  const testEnvironment = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key]) testEnvironment[key] = process.env[key]
  }
  // Preserve only the display connection, never ambient Node/model credentials,
  // Electron switches, NODE_OPTIONS or a user's application configuration.
  for (const [key, child] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data' })) {
    testEnvironment[key] = path.join(dataDir, child)
    await mkdir(testEnvironment[key], { recursive: true, mode: 0o700 })
  }
  const [rendererPort, mainPort] = await Promise.all([unusedLoopbackPort(), unusedLoopbackPort()])
  const argumentsForApp = [packageDir, `--data-dir=${dataDir}`, `--remote-debugging-port=${rendererPort}`,
    '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${mainPort}`, '--ozone-platform=x11']
  const startedAt = performance.now()
  const child = spawn(electron, argumentsForApp, { env: testEnvironment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let diagnosticLog = '', exitResult, spawnError, renderer, main, cleanClose = false
  const owned = new Map()
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { diagnosticLog = (diagnosticLog + chunk).slice(-8_000) })
  child.on('error', (error) => { spawnError = error })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult) }))
  t.after(async () => {
    renderer?.close(); main?.close()
    if (!cleanClose && child.pid) {
      // Failure cleanup is restricted to this detached, simulation-only process
      // group. Successful qualification must use the real window close handler.
      await rememberDescendants(child.pid, owned)
      const root = await processIdentity(child.pid)
      if (root && root.startTime === owned.get(child.pid)?.startTime) {
        try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      await bounded(exited, 3_000, 'Owned simulation process cleanup').catch(() => {})
      const remaining = (await survivingProcesses(owned)).filter((item) => item.state !== 'Z')
      for (const item of remaining) {
        const identity = await processIdentity(item.pid)
        if (identity?.startTime === item.startTime) { try { process.kill(item.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
      }
    }
    await rm(dataDir, { recursive: true, force: true })
  })
  const initialProcess = child.pid ? await processIdentity(child.pid) : null
  if (initialProcess) owned.set(child.pid, initialProcess)
  async function until(condition, label, timeoutMs = 15_000) {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError
      if (exitResult && !cleanClose) throw new Error(`Electron exited before ${label}: ${JSON.stringify(exitResult)}\n${diagnosticLog}`)
      const result = await condition()
      if (result) return result
      await sleep(75)
    }
    throw new Error(`${label} did not arrive within ${timeoutMs} ms\n${diagnosticLog}`)
  }
  async function inspectorTarget(port, predicate) {
    return until(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })
        return response.ok && (await response.json()).find(predicate)
      } catch { return false }
    }, 'Owned Electron inspector target', 25_000)
  }
  renderer = await connectInspector((await inspectorTarget(rendererPort, (target) => target.url === 'physicalsystems://desktop/index.html')).webSocketDebuggerUrl)
  main = await connectInspector((await inspectorTarget(mainPort, (target) => target.type === 'node')).webSocketDebuggerUrl)
  const js = (expression) => renderer.evaluate(expression)
  const state = () => js('window.physicalSystems.snapshot()')
  const click = (selector) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw new Error('Required control is unavailable');element.click();return true})()`)
  const set = (selector, value) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  const electronExpression = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')"
  await until(() => js('document.querySelector("#transcript")?.textContent.includes("Your physical workspace.")'), 'Empty onboarding')
  const initial = await state()
  const startupMs = Math.round(performance.now() - startedAt)
  assert.deepEqual(initial.projects, [])
  assert.equal(await js('typeof process'), 'undefined')
  assert.equal(await js('typeof require'), 'undefined')
  assert.equal(await js('window.physicalSystems.command("shell.exec",{}).then(()=>false,()=>true)'), true)
  const sandbox = await main.evaluate(`(()=>{const e=${electronExpression};const p=e.BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,version:process.versions.electron,disabledByCommandLine:process.argv.includes('--no-sandbox')}})()`)
  assert.equal(sandbox.sandbox, true)
  assert.equal(sandbox.contextIsolation, true)
  assert.equal(sandbox.nodeIntegration, false)
  assert.equal(sandbox.webSecurity, true)
  assert.equal(sandbox.disabledByCommandLine, false)
  async function metrics(stage) {
    const processes = await main.evaluate(`${electronExpression}.app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,name:p.name??null,workingSetKiB:p.memory.workingSetSize,privateKiB:p.memory.privateBytes??null,sandboxed:p.sandboxed??null}))`)
    await rememberDescendants(child.pid, owned)
    assert.ok(processes.some((entry) => entry.type === 'Browser'))
    assert.ok(processes.some((entry) => entry.type === 'Tab'))
    assert.ok(processes.some((entry) => entry.type === 'Utility' && entry.name === 'Physical Systems Harness'), 'The owned Harness utility process is included in the measurement')
    const workingSetKiB = processes.reduce((sum, entry) => sum + entry.workingSetKiB, 0)
    assert.ok(Number.isFinite(workingSetKiB) && workingSetKiB > 0)
    return { stage, elapsedMs: Math.round(performance.now() - startedAt), processCount: processes.length, aggregateWorkingSetKiB: workingSetKiB, processes }
  }
  const idleMetrics = await metrics('empty workspace idle')
  await click('#new-project'); await set('#field-name', 'Native qualification simulation'); await set('#field-type', 'simulation'); await click('#dialog .primary')
  await until(() => js('document.querySelector("#connection-summary").textContent.includes("connected") && !document.querySelector("#dialog").open'), 'Explicit simulation connection')
  const selected = await state()
  assert.equal(selected.projects.length, 1)
  assert.equal(selected.projects[0].connection.kind, 'simulation')
  assert.equal(selected.workcell.workflow.snapshot.discovery.devices.length, 3)
  await set('#message', 'Plan a tray transfer'); await click('#send-message')
  await until(() => js('!document.querySelector("#question").hidden'), 'Scripted planning question')
  assert.equal((await state()).workcell.execution.run, null)
  await click('#question button')
  await until(() => js('document.querySelector("#transcript").textContent.includes("Simulation proposal:")'), 'Scripted capability proposal')
  await click('.proposal-card .primary'); await click('#execution-refresh')
  await until(() => js('[...document.querySelector("#configuration-select").options].some(option=>option.value==="simulation-table")'), 'Simulation configuration')
  await set('#configuration-select', 'simulation-table'); await click('#run-prepare')
  await until(() => js('!document.querySelector("#run-confirmation").hidden'), 'Separate run approval boundary')
  const prepared = (await state()).workcell.execution.run
  assert.equal(prepared.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(prepared.mode, 'simulation')
  assert.equal(await js('document.querySelector("#run-approve").disabled'), true)
  await click('#run-confirm'); await click('#run-approve')
  await until(async () => (await state()).workcell.execution.run.phase === 'VERIFIED_SUCCESS', 'Verified scripted run')
  await click('#run-receipt')
  await until(() => js('document.querySelector("#run-details").textContent.includes("Verified stored receipt integrity")'), 'Verified stored receipt')
  const completed = await state()
  assert.equal(completed.workcell.execution.receipt.verification.verified, 'met')
  assert.equal(completed.workcell.execution.run.physicalExecutionAuthorized, false)
  assert.match(completed.workcell.execution.run.outcome.reason, /no hardware was operated/)
  const simulationMetrics = await metrics('simulation after verified receipt')
  if (evidenceDir) await writeFile(path.join(evidenceDir, 'native-simulation-receipt.png'), Buffer.from((await renderer.rpc('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

  // This explicitly named generated JPEG fixture never enumerates or opens a
  // physical camera. It verifies native typed-byte IPC and renderer decoding.
  await click('[data-tab="devices"]'); await set('#camera-select', 'camera-synthetic-preview'); await click('#camera-start')
  await until(() => js('!document.querySelector("#preview").hidden && document.querySelector("#preview").naturalWidth===1'), 'Synthetic JPEG decoding')
  assert.match(await js('document.querySelector("#frame-kind").textContent'), /SYNTHETIC TEST FRAME/)
  const frame = await js(`(async()=>{for(let attempt=0;attempt<8;attempt++){const s=await window.physicalSystems.snapshot();try{const f=await window.physicalSystems.command('workcell.camera.frame',{projectId:s.activeProjectId,conversationId:s.activeConversationId,connectionGeneration:s.connectionGeneration,frameId:s.workcell.camera.previewFrameId});return {typed:f.bytes instanceof Uint8Array,size:f.bytes.length,contentType:f.contentType}}catch(error){if(attempt===7)throw error}}})()`)
  assert.equal(frame.typed, true)
  assert.ok(frame.size > 0)
  assert.equal(frame.contentType, 'image/jpeg')
  assert.equal((await state()).activeCaptures.length, 1)
  await click('#camera-stop')
  await until(async () => { const current = await state(); return current.workcell.camera.status.phase === 'stopped' && current.activeCaptures.length === 0 }, 'Confirmed synthetic Stop')
  assert.equal(await js('document.querySelector("#preview").hidden && !document.querySelector("#preview").hasAttribute("src")'), true)

  await renderer.rpc('Page.reload')
  await until(() => js('document.querySelector("#transcript")?.textContent.includes("Simulation proposal:")'), 'Renderer reload preserves conversation')
  assert.equal((await state()).activeCaptures.length, 0, 'Reload does not restart the stopped synthetic preview')
  const catalog = JSON.parse(await readFile(path.join(dataDir, 'catalog.json'), 'utf8'))
  assert.equal(catalog.connections.length, 1)
  assert.equal(catalog.connections[0].type, 'simulation')
  assert.equal(catalog.connections[0].credentialRef, undefined)
  assert.equal(catalog.conversations.length, 1)
  await rememberDescendants(child.pid, owned)
  // Scheduling ordinary BrowserWindow.close allows the inspector response to
  // finish before main's real cleanup handler closes the host and the app.
  await main.evaluate(`(()=>{const e=${electronExpression};setTimeout(()=>e.BrowserWindow.getAllWindows()[0].close(),25);return true})()`)
  main.close(); renderer.close()
  const exit = await bounded(exited, 20_000, 'Ordinary Electron window cleanup')
  assert.deepEqual(exit, { code: 0, signal: null })
  for (const lock of ['catalog.lock', 'shell/SingletonLock', 'shell/SingletonSocket', 'shell/SingletonCookie']) {
    await assert.rejects(lstat(path.join(dataDir, lock)), { code: 'ENOENT' }, `${lock} must be removed by ordinary close`)
  }
  const cleanupDeadline = performance.now() + 5_000
  let remaining
  do { remaining = await survivingProcesses(owned); if (!remaining.some((item) => item.state !== 'Z')) break; await sleep(75) } while (performance.now() < cleanupDeadline)
  assert.deepEqual(remaining.filter((item) => item.state !== 'Z'), [], 'No owned Electron or utility process remains running after ordinary close')
  cleanClose = true
  const result = {
    status: 'PASS', scope: 'Native Linux Electron main, sandboxed renderer, utility host, catalog and scripted simulation. No live model, SSH, Node, hardware or optical/display flicker measurement.',
    startup: { elapsedMs: startupMs, definition: 'Source Electron spawn to rendered empty onboarding and responsive application bridge; one sample, not an installer or cold-cache benchmark.' },
    memory: { unit: 'KiB', definition: 'Sum of Electron app.getAppMetrics working sets; shared pages may be counted more than once. Point samples, not peak memory or live model streaming.', samples: [idleMetrics, simulationMetrics] },
    sandbox, checks: ['empty onboarding', 'renderer isolation', 'unknown IPC denied', 'simulation discovery', 'question and answer', 'capability proposal', 'explicit approval boundary', 'verified receipt', 'native synthetic JPEG IPC and decode', 'Stop clears image and releases synthetic capture', 'renderer reload preserves conversation', 'ordinary window close releases catalog lock and owned running processes'],
    syntheticFrame: frame, cleanup: { exitCode: exit.code, catalogLockReleased: true, singletonLocksReleased: true, ownedRunningProcessesRemaining: 0, unreapedZombieProcessCount: remaining.length },
  }
  if (evidenceDir) await writeFile(path.join(evidenceDir, 'native-qualification.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  t.diagnostic(JSON.stringify({ startupMs, idleWorkingSetKiB: idleMetrics.aggregateWorkingSetKiB, simulationWorkingSetKiB: simulationMetrics.aggregateWorkingSetKiB, cleanClose: true, unreapedZombieProcessCount: remaining.length }))
})
