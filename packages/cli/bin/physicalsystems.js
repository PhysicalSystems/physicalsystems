#!/usr/bin/env node

const minimumNodeVersion = [22, 19, 0]
const currentNodeVersion = process.versions.node.split('.').map(Number)
const nodeIsSupported = currentNodeVersion[0] > minimumNodeVersion[0]
  || (currentNodeVersion[0] === minimumNodeVersion[0]
    && currentNodeVersion[1] >= minimumNodeVersion[1])

if (!nodeIsSupported) {
  console.error(
    `Physical Systems requires Node.js 22.19.0 or newer (detected ${process.versions.node}). `
      + 'Upgrade Node.js and run the command again.',
  )
  process.exitCode = 1
} else {
  Promise.all([
    import('../src/index.js'),
    import('../src/cli.js'),
  ]).then(([{ safeErrorMessage }, { runCli }]) => {
    return runCli().then((code) => {
      process.exitCode = code
    }).catch((error) => {
      console.error(`Physical Systems: ${safeErrorMessage(error)}`)
      process.exitCode = 1
    })
  }).catch(() => {
    console.error('Physical Systems failed to start. Reinstall the package and try again.')
    process.exitCode = 1
  })
}
