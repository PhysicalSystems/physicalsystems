import { spawn } from 'node:child_process'

import { isLoopbackUrl } from '../config.js'

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn, env = process.env } = {}) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackUrl(parsed))) {
    throw new TypeError('Refusing to open an insecure authorization URL')
  }

  let command
  let args
  if (platform === 'win32') {
    command = 'rundll32.exe'
    args = ['url.dll,FileProtocolHandler', parsed.toString()]
  } else if (platform === 'darwin') {
    command = 'open'
    args = [parsed.toString()]
  } else {
    command = 'xdg-open'
    args = [parsed.toString()]
  }

  // Hardware credentials belong only to Node and the trusted Harness server.
  // Preserve the desktop environment without handing this credential to the
  // opener or a browser it starts. Windows environment keys ignore casing.
  const browserEnv = Object.fromEntries(Object.entries(env)
    .filter(([name]) => !['PHYSICAL_NODE_CAMERA_TOKEN', 'PHYSICAL_NODE_EXECUTION_TOKEN', 'PHYSICAL_NODE_EXECUTABLE',
      'PHYSICAL_NODE_EXECUTION_CONFIG', 'PHYSICAL_NODE_EXECUTION_DATA', 'PHYSICAL_NODE_REGISTRY', 'PHYSICAL_NODE_EXECUTION_MODE'].includes(name.toUpperCase())))
  const child = spawnImpl(command, args, {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
    env: browserEnv,
  })
  child.unref?.()
}
