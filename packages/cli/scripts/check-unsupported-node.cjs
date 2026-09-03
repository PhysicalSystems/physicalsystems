#!/usr/bin/env node

'use strict'

const assert = require('assert').strict
const { spawnSync } = require('child_process')
const path = require('path')

const launcher = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../bin/physicalsystems.js')

const result = spawnSync(process.execPath, [launcher], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { NO_COLOR: '1' }),
  timeout: 30_000,
})

assert.ifError(result.error)
assert.equal(result.signal, null)
assert.equal(result.status, 1)
assert.equal(result.stdout, '')
assert.equal(
  result.stderr,
  `Physical Systems requires Node.js 22.19.0 or newer (detected ${process.versions.node}). Upgrade Node.js and run the command again.\n`,
)
assert.doesNotMatch(result.stderr, /SyntaxError|src[\\/]auth[\\/]redact\.js/)
