import { spawn } from 'node:child_process'

import { isLoopbackUrl } from '../config.js'

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
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

  const child = spawnImpl(command, args, {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref?.()
}
