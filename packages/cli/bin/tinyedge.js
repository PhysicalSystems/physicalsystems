#!/usr/bin/env node

import { safeErrorMessage } from '../src/index.js'
import { runCli } from '../src/cli.js'

runCli().then((code) => {
  process.exitCode = code
}).catch((error) => {
  console.error(`TinyEdge: ${safeErrorMessage(error)}`)
  process.exitCode = 1
})
