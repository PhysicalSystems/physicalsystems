import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, tick, view } from './fixtures/workcell-browser.js'

const streamReads = (ui) => ui.reads.filter((request) => request.path === '/api/events').length
async function exhaust(ui) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(streamReads(ui), attempt)
    await ui.disconnect()
    if (attempt < 4) await ui.advance(attempt * 1000)
  }
}

test('validated SSE recovery resets consecutive failures across repeated brief disconnects', async (t) => {
  const ui = await view(t)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await ui.push(ui.state())
    await ui.disconnect()
    assert.equal(ui.elements.get('connection-state').textContent, 'Harness disconnected')
    await ui.advance(1000)
    assert.equal(streamReads(ui), attempt + 2, 'each recovered stream receives a fresh retry budget')
  }
  await ui.push(ui.state())
  assert.equal(ui.elements.get('connection-state').textContent, 'Connected to Harness')
  assert.equal(ui.elements.get('notice').hidden, true, 'recovery removes the obsolete disconnection notice')
})

test('successful state reads without a validated SSE event exhaust bounded retries and explain recovery', async (t) => {
  const ui = await view(t)
  await exhaust(ui)
  await ui.advance(60000)
  assert.equal(streamReads(ui), 4, 'successful /api/state responses cannot reset a failing SSE connection')
  const reconnect = ui.elements.get('reconnect')
  assert.ok(reconnect, 'an explicit reconnect control is available after exhaustion')
  assert.equal(reconnect.hidden, false)
  assert.equal(reconnect.disabled, false)
  assert.match(ui.elements.get('notice').textContent, /Reconnect/)
  assert.match(ui.elements.get('notice').textContent, /\/workcell/)
})

test('invalid SSE states cannot reset the consecutive failure budget', async (t) => {
  const ui = await view(t)
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await ui.pushEvent({ ...ui.state(), physicalExecutionAuthorized: true })
    if (attempt < 4) await ui.advance(attempt * 1000)
  }
  await ui.advance(10000)
  assert.equal(streamReads(ui), 4)
  assert.equal(ui.elements.get('connection-state').textContent, 'Harness disconnected')
  assert.match(ui.elements.get('notice').textContent, /\/workcell/)
})

test('recovery clears only the connection notice and preserves an unrelated action failure', async (t) => {
  const ui = await view(t)
  void ui.elements.get('refresh').onclick()
  await tick()
  ui.actions.at(-1).resolve(Response.json({ error: 'Discovery refresh could not finish' }, { status: 503 }))
  await tick(); await tick()
  assert.match(ui.elements.get('notice').textContent, /Discovery refresh could not finish/)
  await ui.disconnect()
  assert.match(ui.elements.get('notice').textContent, /Discovery refresh could not finish/)
  assert.match(ui.elements.get('notice').textContent, /Harness connection ended/)
  await ui.advance(1000)
  assert.match(ui.elements.get('notice').textContent, /Harness connection ended/, 'a state read alone is not stream recovery')
  await ui.push(ui.state())
  assert.equal(ui.elements.get('notice').textContent, 'Discovery refresh could not finish')
  assert.equal(ui.elements.get('notice').hidden, false)
})

test('explicit reconnect starts one loop despite repeated clicks and reuses only the in-memory authorization', async (t) => {
  const ui = await view(t)
  await exhaust(ui)
  const reconnect = ui.elements.get('reconnect')
  assert.ok(reconnect, 'reconnect control exists')
  reconnect.onclick(); reconnect.onclick()
  await tick(); await tick()
  assert.equal(streamReads(ui), 5)
  assert.equal(reconnect.hidden, true)
  assert.equal(reconnect.disabled, true)
  await ui.push(ui.state())
  await ui.advance(10000)
  assert.equal(streamReads(ui), 5)
  assert.equal(ui.streams.filter((entry) => !entry.closed).length, 1)
  assert.equal(ui.location.hash, '', 'reconnecting never restores the consumed credential to the URL')
})

test('pagehide cancels a pending backoff and prevents manual or automatic stream restart', async (t) => {
  const ui = await view(t)
  await ui.disconnect()
  await ui.close()
  await ui.advance(10000)
  ui.elements.get('reconnect')?.onclick()
  await tick(); await tick()
  assert.equal(streamReads(ui), 1)
  assert.equal(ui.streams.filter((entry) => !entry.closed).length, 0)
})

test('a reloaded view without its fragment cannot reconnect and directs the operator to /workcell', async (t) => {
  const ui = await view(t, { hash: '' })
  assert.equal(ui.reads.length, 0)
  assert.equal(ui.elements.get('connection-state').textContent, 'Session link required')
  assert.match(ui.elements.get('notice').textContent, /Run \/workcell/)
  ui.elements.get('reconnect')?.onclick()
  await tick(); await tick()
  assert.equal(ui.reads.length, 0)
})

for (const stalled of ['state headers', 'state body', 'event headers']) {
  test(`startup watchdog bounds stalled ${stalled} and ignores the expired attempt's late response`, async (t) => {
    const pending = deferred()
    let held = null
    const ui = await view(t, { readResponse(request) {
      if (held || request.path !== (stalled === 'event headers' ? '/api/events' : '/api/state')) return
      held = request
      return stalled === 'state body' ? { ok: true, json: () => pending.promise } : pending.promise
    } })
    await ui.advance(6499)
    assert.equal(held.options.signal.aborted, false)
    await ui.advance(1)
    assert.equal(held.options.signal.aborted, true, 'the exact stuck attempt is aborted at its startup deadline')
    assert.match(ui.elements.get('notice').textContent, /timed out/)
    await ui.advance(1000)
    await ui.push(ui.state())
    const attempts = ui.reads.length
    pending.resolve(stalled === 'state body' ? ui.state() : Response.json(ui.state()))
    await tick(); await tick()
    assert.equal(ui.reads.length, attempts, 'a late timeout loser cannot open another stream')
    assert.equal(ui.streams.filter((entry) => !entry.closed).length, 1)
    assert.equal(ui.elements.get('notice').hidden, true)
  })
}

test('heartbeats cannot extend startup before the first validated state', async (t) => {
  const ui = await view(t)
  await ui.advance(3000)
  await ui.pushRaw(': heartbeat\n\n')
  await ui.advance(3500)
  assert.equal(ui.streams[0].signal.aborted, true)
  assert.match(ui.elements.get('notice').textContent, /timed out/)
})

test('validated state and heartbeats renew a bounded idle deadline, then silence triggers recovery', async (t) => {
  const ui = await view(t)
  await ui.push(ui.state())
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await ui.advance(44000)
    assert.equal(ui.streams[0].signal.aborted, false)
    await ui.pushRaw(': heartbeat\n\n')
  }
  await ui.advance(44999)
  assert.equal(ui.streams[0].signal.aborted, false)
  await ui.advance(1)
  assert.equal(ui.streams[0].signal.aborted, true)
  assert.match(ui.elements.get('notice').textContent, /timed out/)
  await ui.advance(1000)
  await ui.push(ui.state())
  assert.equal(streamReads(ui), 2)
  assert.equal(ui.elements.get('connection-state').textContent, 'Connected to Harness')
})

test('four startup timeouts exhaust retries rather than leaving an indefinitely hung view', async (t) => {
  const held = []
  const ui = await view(t, { readResponse(request) {
    held.push(request)
    return deferred().promise
  } })
  await ui.advance(32000)
  assert.equal(held.length, 4)
  assert.equal(held.every((request) => request.options.signal.aborted), true)
  assert.equal(ui.elements.get('reconnect').hidden, false)
  assert.match(ui.elements.get('notice').textContent, /\/workcell/)
  assert.equal(ui.pendingTimers().filter((timer) => !timer.interval).length, 0)
})

test('watchdog cleanup on pagehide cancels a hung read and leaves no retry deadline', async (t) => {
  const ui = await view(t, { readResponse() { return deferred().promise } })
  await ui.advance(1000)
  await ui.close()
  assert.equal(ui.reads[0].options.signal.aborted, true)
  assert.equal(ui.pendingTimers().filter((timer) => !timer.interval).length, 0)
  await ui.advance(100000)
  assert.equal(ui.reads.length, 1)
})

test('an old attempt deadline cannot abort a newer validated stream', async (t) => {
  const ui = await view(t)
  await ui.disconnect()
  await ui.advance(1000)
  await ui.push(ui.state())
  await ui.advance(6000)
  assert.equal(streamReads(ui), 2)
  assert.equal(ui.streams[1].signal.aborted, false)
  assert.equal(ui.elements.get('notice').hidden, true)
})
