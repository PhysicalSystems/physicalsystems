import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DPAPI_PROCESS_TIMEOUT_MS = 30_000
const SECRET_SERVICE_PROCESS_TIMEOUT_MS = 15_000
const SECRET_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024
const SECRET_VALUE_MAX_BYTES = 1024 * 1024
const SECRET_TOOL_VALUE_MAX_BYTES = 8 * 1024 - 1
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SECRET_TOOL_ATTRIBUTES = Object.freeze([
  'application',
  'ai.tinyedge.cli',
  'credential',
])

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
        Object.defineProperty(error, 'tinyedgeStderrPresent', {
          configurable: true,
          value: Buffer.byteLength(stderr || '') > 0,
        })
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
    {
      input: stdin,
      windowsHide: true,
      maxBuffer: SECRET_PROCESS_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: DPAPI_PROCESS_TIMEOUT_MS,
    },
  )
  return String(stdout).trim()
}

function requireSecretName(name) {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
    throw new TypeError('TinyEdge secret name is invalid')
  }
  return name
}

function requireSecretValue(value, maximumBytes = SECRET_VALUE_MAX_BYTES) {
  const normalized = String(value)
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    throw new TypeError('TinyEdge secret value is empty or too large')
  }
  return normalized
}

function secretToolAttributes(name) {
  return [...SECRET_TOOL_ATTRIBUTES, requireSecretName(name)]
}

function unavailableSecretServiceError() {
  const error = new Error(
    'Linux Secret Service credential storage is unavailable. '
    + 'Install secret-tool and unlock a Secret Service keyring for this desktop session.',
  )
  error.code = 'TINYEDGE_SECRET_SERVICE_UNAVAILABLE'
  return error
}

async function secretTool(
  args,
  { input = '', missingIsNull = false, run = execFileWithInput } = {},
) {
  try {
    const { stdout } = await run('secret-tool', args, {
      encoding: 'utf8',
      input,
      maxBuffer: SECRET_PROCESS_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: SECRET_SERVICE_PROCESS_TIMEOUT_MS,
      windowsHide: true,
    })
    return String(stdout)
  } catch (error) {
    // `secret-tool lookup` and `clear` use status 1 with no diagnostic when no
    // item matches. Other status-1 failures (for example a locked/unavailable
    // service) carry a diagnostic and must not masquerade as an empty store.
    if (
      missingIsNull
      && error?.code === 1
      && error?.tinyedgeStderrPresent === false
    ) return null
    throw unavailableSecretServiceError()
  }
}

/**
 * Windows-native encrypted secret storage. The ciphertext may be copied or
 * backed up, but Windows DPAPI only decrypts it for the user who created it.
 */
export function createWindowsDpapiSecretStore({ configDir, run = execFileWithInput }) {
  const directory = path.join(configDir, 'secrets')
  const fileFor = (name) => path.join(directory, `${requireSecretName(name)}.dpapi`)
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
      const encoded = Buffer.from(requireSecretValue(value), 'utf8').toString('base64')
      const protectedValue = await powershell(DPAPI_PROTECT, encoded, run)
      await writeFile(fileFor(name), `${protectedValue}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    async delete(name) {
      await rm(fileFor(name), { force: true })
    },
  })
}

/**
 * Linux desktop credential storage through the Secret Service command-line
 * client. Stable, non-secret attributes identify each TinyEdge item. The
 * credential itself is written only to the child process's standard input.
 */
export function createLinuxSecretServiceSecretStore({ run = execFileWithInput } = {}) {
  return Object.freeze({
    kind: 'linux-secret-service',
    async read(name) {
      const stdout = await secretTool(
        ['lookup', ...secretToolAttributes(name)],
        { missingIsNull: true, run },
      )
      if (stdout === null) return null
      return stdout
    },
    async write(name, value) {
      await secretTool(
        [
          'store',
          '--label=Physical Systems credential',
          ...secretToolAttributes(name),
        ],
        { input: requireSecretValue(value, SECRET_TOOL_VALUE_MAX_BYTES), run },
      )
    },
    async delete(name) {
      await secretTool(
        ['clear', ...secretToolAttributes(name)],
        { missingIsNull: true, run },
      )
    },
  })
}

export function createNativeSecretStore({ configDir, platform = process.platform, run } = {}) {
  if (platform === 'win32') return createWindowsDpapiSecretStore({ configDir, run })
  if (platform === 'linux') return createLinuxSecretServiceSecretStore({ run })
  throw new Error(
    `Secure TinyEdge credential storage is not configured for ${platform}. `
    + 'Use Windows DPAPI, Linux Secret Service, or provide a native secret-store adapter.',
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
