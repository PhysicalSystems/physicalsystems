import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

function execFileWithInput(executable, args, { input = '', ...options } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }

    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        settle(reject, error)
        return
      }
      settle(resolve, { stdout, stderr })
    })

    child.stdin.once('error', (error) => {
      if (settled || error?.code === 'EPIPE') return
      child.kill()
      settle(reject, error)
    })
    // PowerShell's ReadToEnd() only returns after the pipe receives EOF.
    child.stdin.end(input)
  })
}

const DPAPI_PROTECT = String.raw`
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`

const DPAPI_UNPROTECT = String.raw`
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`

async function powershell(script, stdin, run = execFileWithInput) {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { input: stdin, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10_000 },
  )
  return String(stdout).trim()
}

/**
 * Windows-native encrypted secret storage. The ciphertext may be copied or
 * backed up, but Windows DPAPI only decrypts it for the user who created it.
 */
export function createWindowsDpapiSecretStore({ configDir, run = execFileWithInput }) {
  const directory = path.join(configDir, 'secrets')
  const fileFor = (name) => path.join(directory, `${name}.dpapi`)
  return Object.freeze({
    kind: 'windows-dpapi',
    async read(name) {
      let protectedValue
      try {
        protectedValue = (await readFile(fileFor(name), 'utf8')).trim()
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      const plain = await powershell(DPAPI_UNPROTECT, protectedValue, run)
      return Buffer.from(plain, 'base64').toString('utf8')
    },
    async write(name, value) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const encoded = Buffer.from(String(value), 'utf8').toString('base64')
      const protectedValue = await powershell(DPAPI_PROTECT, encoded, run)
      await writeFile(fileFor(name), `${protectedValue}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    async delete(name) {
      await rm(fileFor(name), { force: true })
    },
  })
}

export function createNativeSecretStore({ configDir, platform = process.platform, run } = {}) {
  if (platform === 'win32') return createWindowsDpapiSecretStore({ configDir, run })
  throw new Error(
    `Secure TinyEdge credential storage is not configured for ${platform}. `
    + 'Use Windows DPAPI or provide a native secret-store adapter.',
  )
}

export function createMemorySecretStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return Object.freeze({
    kind: 'memory',
    async read(name) { return values.get(name) ?? null },
    async write(name, value) { values.set(name, String(value)) },
    async delete(name) { values.delete(name) },
  })
}
