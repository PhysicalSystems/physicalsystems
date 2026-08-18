#!/usr/bin/env node

import { safeErrorMessage } from '@tinyedge/cli'
import { runCli } from '@tinyedge/cli/run'

runCli().then((code) => {
  process.exitCode = code
}).catch((error) => {
  console.error(`TinyEdge: ${safeErrorMessage(error)}`)
  process.exitCode = 1
})
