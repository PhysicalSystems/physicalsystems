const gates = new WeakMap()

function busyError() {
  const error = new Error('The Harness is already handling a request. Wait for it to finish or interrupt it in the terminal before submitting another request.')
  error.code = 'ERR_HARNESS_PROMPT_BUSY'
  return error
}

/**
 * Reserve the one Pi session before prompt preflight can await authentication.
 * Pi's streaming flag is set after preflight; checking it at either UI is too
 * late to prevent competing terminal/browser requests from entering that phase.
 * This host policy rejects concurrent prompts rather than creating a second
 * planner, expanding tools, or silently queuing future physical instructions.
 */
export function installSessionPromptGate(session) {
  if (!session || typeof session.prompt !== 'function') throw new TypeError('A prompt-capable Pi session is required')
  const existing = gates.get(session)
  if (existing) {
    if (session.prompt !== existing.prompt) throw new Error('The guarded session prompt was replaced unexpectedly')
    return existing.handle
  }

  const original = session.prompt
  const descriptor = Object.getOwnPropertyDescriptor(session, 'prompt')
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('The session prompt must be a method')
  let pending = false
  let active = true

  function guardedPrompt(...args) {
    if (!active) return Promise.reject(new Error('This Harness prompt binding is no longer current'))
    if (pending) return Promise.reject(busyError())
    // Acquire synchronously, before invoking any part of the underlying async
    // method. All callers, including Pi's terminal and extension API, share it.
    pending = true
    return (async () => {
      try { return await Reflect.apply(original, session, args) }
      finally { pending = false }
    })()
  }

  const handle = Object.freeze({
    isBusy: () => pending,
    restore() {
      if (!active) return
      if (pending) throw new Error('Cannot restore a session prompt while its request is pending')
      active = false
      // Do not overwrite a later host binding during cleanup.
      if (session.prompt === guardedPrompt) {
        if (descriptor) Object.defineProperty(session, 'prompt', descriptor)
        else delete session.prompt
      }
      gates.delete(session)
    },
  })
  Object.defineProperty(session, 'prompt', descriptor
    ? { ...descriptor, value: guardedPrompt }
    : { configurable: true, enumerable: false, writable: true, value: guardedPrompt })
  gates.set(session, { prompt: guardedPrompt, handle })
  return handle
}
