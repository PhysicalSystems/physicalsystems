import { spawn } from 'node:child_process'

// Settle every child before returning (including failures), so callers may
// safely remove their isolated installation directories in finally blocks.
export async function runConcurrentChecks(checks, { print = console.log } = {}) {
  const results = await Promise.all(checks.map(({ command, args, cwd, env, phase, timeout }) => new Promise((resolve) => {
    const started = Date.now()
    print(`Starting ${phase} (timeout ${timeout} ms)`)
    let stdout = '', stderr = '', error, size = 0
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, timeout })
    const capture = (which, chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > 64 * 1024 * 1024) {
        error = new Error(`${phase} exceeded output limit`)
        child.kill()
      } else if (which === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => capture('stdout', chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => capture('stderr', chunk))
    child.on('error', (cause) => { error = cause })
    child.on('close', (code, signal) => {
      const elapsed = Date.now() - started
      print(`${!error && code === 0 ? 'Completed' : 'Failed'} ${phase} in ${elapsed} ms`)
      resolve({ phase, stdout: stdout.trim(), error: error || (code !== 0
        ? new Error(`${phase} exited with ${code}${signal ? ` (${signal})` : ''}: ${stderr.trim()}`) : null) })
    })
  })))
  const failures = results.filter((result) => result.error)
  if (failures.length) throw new AggregateError(failures.map((result) => result.error), failures.map((result) => `${result.phase}: ${result.error.message}`).join('\n'))
  return results.map((result) => result.stdout)
}
