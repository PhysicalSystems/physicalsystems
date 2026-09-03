import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionPromptGate } from '../src/harness/session-prompt-gate.js'

const { AgentSession } = await import(new URL('./core/agent-session.js', import.meta.resolve('@tinyedge/pi-runtime')))
const { Agent } = await import('@earendil-works/pi-agent-core')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

test('shared prompt gate reserves synchronously, preserves receiver and options, and never queues concurrent input', async (t) => {
  const pending = deferred()
  const calls = []
  const session = { prompt(...args) { calls.push({ receiver: this, args }); return pending.promise } }
  const original = session.prompt
  const gate = installSessionPromptGate(session)
  t.after(() => gate.restore())
  const options = { expandPromptTemplates: false, source: 'interactive' }
  const first = session.prompt('First intent', options)
  assert.equal(gate.isBusy(), true)
  await assert.rejects(session.prompt('Second intent'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  await assert.rejects(session.prompt('Follow-up', { streamingBehavior: 'followUp' }), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  await assert.rejects(session.prompt('Steer', { streamingBehavior: 'steer' }), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  assert.throws(() => gate.restore(), /request is pending/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].receiver, session)
  assert.deepEqual(calls[0].args, ['First intent', options])
  pending.resolve('finished')
  assert.equal(await first, 'finished')
  assert.equal(gate.isBusy(), false)
  gate.restore()
  assert.equal(session.prompt, original)
})

test('prompt failures release the gate for an explicit retry, including synchronous host errors', async (t) => {
  let attempts = 0
  const session = { prompt() {
    attempts += 1
    if (attempts === 1) throw new Error('Synchronous preflight failure')
    if (attempts === 2) return Promise.reject(new Error('Asynchronous auth failure'))
    return Promise.resolve('success')
  } }
  const gate = installSessionPromptGate(session)
  t.after(() => gate.restore())
  await assert.rejects(session.prompt('First'), /Synchronous preflight/)
  assert.equal(gate.isBusy(), false)
  await assert.rejects(session.prompt('Second'), /Asynchronous auth/)
  assert.equal(gate.isBusy(), false)
  assert.equal(await session.prompt('Third'), 'success')
  assert.equal(attempts, 3)
})

test('each recreated session receives one independent gate and restoration preserves inherited bindings', async (t) => {
  const prototype = { async prompt(text) { return text } }
  const first = Object.create(prototype)
  const second = Object.create(prototype)
  const firstGate = installSessionPromptGate(first)
  const secondGate = installSessionPromptGate(second)
  t.after(() => { firstGate.restore(); secondGate.restore() })
  const captured = first.prompt
  assert.equal(installSessionPromptGate(first), firstGate)
  assert.notEqual(secondGate, firstGate)
  assert.deepEqual(await Promise.all([first.prompt('First session'), second.prompt('Second session')]), ['First session', 'Second session'])
  firstGate.restore()
  assert.equal(Object.hasOwn(first, 'prompt'), false)
  assert.equal(first.prompt, prototype.prompt)
  await assert.rejects(captured('Stale binding'), /no longer current/)
  assert.equal(await second.prompt('Still current'), 'Still current')
})

test('restoration does not overwrite a newer host binding or mutate a frozen Pi payload', (t) => {
  const session = { async prompt() {} }
  const gate = installSessionPromptGate(session)
  t.after(() => gate.restore())
  const newer = async () => 'other host binding'
  session.prompt = newer
  assert.throws(() => installSessionPromptGate(session), /replaced unexpectedly/)
  gate.restore()
  assert.equal(session.prompt, newer)
  assert.throws(() => installSessionPromptGate({}), /prompt-capable/)
  assert.throws(() => installSessionPromptGate(Object.freeze({ async prompt() {} })), TypeError)
})

test('actual Pi preflight is serialized across terminal and browser before authentication and before_agent_start', async (t) => {
  const auth = []
  const started = []
  const events = []
  const execution = deferred()
  const agent = new Agent({
    initialState: { model: { provider: 'test', id: 'model' } },
    streamFn() { throw new Error('This offline test must never invoke inference') },
  })
  // Use the real core prompt/lifecycle guard, with only physical execution and
  // authentication held by local promises. No provider or hardware is called.
  agent.runPromptMessages = async () => agent.runWithLifecycle(async () => execution.promise)
  const session = Object.create(AgentSession.prototype)
  Object.assign(session, {
    agent, _isAgentRunActive: false, _eventListeners: [], _pendingNextTurnMessages: [],
    _baseSystemPrompt: 'Test', _baseSystemPromptOptions: {},
    _flushPendingBashMessages() {}, _findLastAssistantMessage() { return undefined },
    async _handlePostAgentRun() { return false },
    _modelRuntime: {
      hasConfiguredAuth: () => false,
      checkAuth: () => new Promise((resolve) => auth.push(resolve)),
    },
    _extensionRunner: {
      hasHandlers: () => false,
      async emitBeforeAgentStart(prompt) { started.push(prompt) },
      async emit(event) { events.push(event.type) },
    },
  })
  const original = session.prompt
  const gate = installSessionPromptGate(session)
  t.after(() => gate.restore())
  const terminal = session.prompt('Terminal intent', { expandPromptTemplates: false })
  assert.equal(session.isIdle, true, 'Pi does not mark its session busy until after asynchronous preflight')
  await assert.rejects(session.prompt('Browser intent', { expandPromptTemplates: false }), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  assert.equal(auth.length, 1, 'the competing prompt never enters the real SDK authentication phase')
  assert.deepEqual(started, [])
  auth[0]('test-auth')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['Terminal intent'])
  assert.equal(agent.state.isStreaming, true)
  assert.equal(session.isIdle, false)
  await assert.rejects(session.prompt('Another browser intent'), { code: 'ERR_HARNESS_PROMPT_BUSY' })
  assert.deepEqual(events, [], 'rejected competition cannot emit an erroneous agent_settled event')
  execution.resolve()
  await terminal
  assert.deepEqual(events, ['agent_settled'])
  assert.equal(session.isIdle, true)
  assert.equal(agent.state.isStreaming, false)
  assert.equal(gate.isBusy(), false)
  gate.restore()
  assert.equal(session.prompt, original)
})
