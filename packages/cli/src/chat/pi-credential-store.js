import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import lockfile from 'proper-lockfile'

import { createNativeSecretStore } from '../auth/secret-store.js'

const SECRET_NAME = 'pi-provider-credentials'
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 30_000

function abortReason(signal) {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function raceWithAbortSignal(operation, signal) {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then((value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}

async function acquireCredentialLock(target, signal) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_STALE_MS
  for (;;) {
    signal?.throwIfAborted()
    let compromised
    try {
      const release = await lockfile.lock(target, {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 3,
        onCompromised(error) { compromised = error },
      })
      if (signal?.aborted) {
        await release()
        signal.throwIfAborted()
      }
      return {
        assertOwned() {
          if (compromised) throw compromised
        },
        release,
      }
    } catch (error) {
      const remainingMs = deadline - Date.now()
      if (error?.code !== 'ELOCKED' || remainingMs <= 0) throw error
      const delayMs = Math.min(LOCK_RETRY_MS, remainingMs)
      if (signal) await sleep(delayMs, undefined, { signal })
      else await sleep(delayMs)
    }
  }
}

function parseCredentials(value) {
  if (value === null) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored Pi provider credentials are invalid')
  }
  return parsed
}

export function createPiCredentialStore({ configDir, secretStore } = {}) {
  const secrets = secretStore || createNativeSecretStore({ configDir })
  const lockTarget = secrets.kind === 'memory'
    ? null
    : path.join(configDir, 'secrets', `${SECRET_NAME}.store`)
  let queue = Promise.resolve()

  const coordinated = async (fn, options = {}) => {
    options.signal?.throwIfAborted()
    if (!lockTarget) return fn(options.signal, () => {})

    const lock = await acquireCredentialLock(lockTarget, options.signal)
    let failure
    try {
      lock.assertOwned()
      const value = await fn(options.signal, lock.assertOwned)
      lock.assertOwned()
      return value
    } catch (error) {
      failure = error
      throw error
    } finally {
      try {
        await lock.release()
      } catch (error) {
        if (!failure) throw error
      }
    }
  }

  const locked = (fn, options) => {
    const operation = queue.then(
      () => coordinated(fn, options),
      () => coordinated(fn, options),
    )
    queue = operation.catch(() => {})
    return raceWithAbortSignal(operation, options?.signal)
  }

  const requireProviderId = (providerId) => {
    if (!PROVIDER_ID.test(String(providerId || ''))) throw new TypeError('Invalid provider ID')
    return providerId
  }

  return Object.freeze({
    async read(providerId, options) {
      requireProviderId(providerId)
      return locked(async (signal, assertOwned) => {
        signal?.throwIfAborted()
        const values = parseCredentials(await secrets.read(SECRET_NAME))
        signal?.throwIfAborted()
        assertOwned()
        return values[providerId]
      }, options)
    },
    async list(options) {
      return locked(async (signal, assertOwned) => {
        signal?.throwIfAborted()
        const values = parseCredentials(await secrets.read(SECRET_NAME))
        signal?.throwIfAborted()
        assertOwned()
        return Object.freeze(Object.entries(values).map(([providerId, credential]) => Object.freeze({
          providerId,
          type: credential?.type,
        })))
      }, options)
    },
    async modify(providerId, fn, options) {
      requireProviderId(providerId)
      return locked(async (signal, assertOwned) => {
        signal?.throwIfAborted()
        const values = parseCredentials(await secrets.read(SECRET_NAME))
        // A provider callback may wait on interactive input indefinitely. Race
        // that untrusted wait inside the critical section so cancellation can
        // release the cross-process lock; the checks below discard any result
        // the callback produces after cancellation.
        const callback = Promise.resolve().then(() => fn(values[providerId]))
        const next = await raceWithAbortSignal(callback, signal)
        signal?.throwIfAborted()
        assertOwned()
        if (next !== undefined) {
          values[providerId] = next
          await secrets.write(SECRET_NAME, JSON.stringify(values))
          assertOwned()
          signal?.throwIfAborted()
        }
        return values[providerId]
      }, options)
    },
    async delete(providerId, options) {
      requireProviderId(providerId)
      return locked(async (signal, assertOwned) => {
        signal?.throwIfAborted()
        const values = parseCredentials(await secrets.read(SECRET_NAME))
        delete values[providerId]
        signal?.throwIfAborted()
        assertOwned()
        if (Object.keys(values).length) await secrets.write(SECRET_NAME, JSON.stringify(values))
        else await secrets.delete(SECRET_NAME)
        assertOwned()
        signal?.throwIfAborted()
      }, options)
    },
  })
}
