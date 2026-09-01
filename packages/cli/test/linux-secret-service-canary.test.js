import assert from 'node:assert/strict'
import test from 'node:test'

import { createLinuxSecretServiceSecretStore } from '../src/auth/secret-store.js'

const enabled = process.env.TINYEDGE_LINUX_SECRET_SERVICE_CANARY === '1'

test('Linux Secret Service performs a real write, read, and delete round trip', {
  skip: enabled ? false : 'set TINYEDGE_LINUX_SECRET_SERVICE_CANARY=1 inside an unlocked Secret Service session',
}, async () => {
  assert.equal(process.platform, 'linux')
  const store = createLinuxSecretServiceSecretStore()
  const name = `tinyedge-canary-${process.pid}`
  const value = `ephemeral-canary-${process.pid}`

  try {
    await store.delete(name)
    await store.write(name, value)
    assert.equal(await store.read(name) === value, true)
  } finally {
    await store.delete(name)
  }
  assert.equal(await store.read(name), null)
})
