import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

const openStores = new Set()
const MAX_BYTES = 2 * 1024 * 1024

/** Refuse symlinked storage components, including a substituted parent. */
function assertDirectory(directory) {
  const absolute = resolve(directory)
  let current = parse(absolute).root
  for (const component of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Experiment storage must use real directories, without symbolic links')
  }
}

function assertRegular(file) {
  let stat
  try { stat = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Experiment storage contains an unsupported file')
  return true
}

/** Session IDs never become paths. Store contains metadata and scalar results only. */
export function createExperimentStore({ storageDir, sessionId }) {
  if (typeof storageDir !== 'string' || !storageDir.trim()) throw new TypeError('A private experiment storage directory is required')
  const directory = resolve(storageDir)
  assertDirectory(directory)
  const basename = createHash('sha256').update(sessionId).digest('hex')
  const file = join(directory, `${basename}.json`)
  const lock = join(directory, `${basename}.lock`)
  if (openStores.has(file)) throw new Error('This conversation already owns an experiment controller')
  let lockFd
  try { lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    assertRegular(lock)
    let owner
    try { owner = JSON.parse(readFileSync(lock, 'utf8')) } catch { throw new Error('Experiment storage lock is unreadable; preserve it for inspection') }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Experiment storage lock is invalid; preserve it for inspection')
    try { process.kill(owner.pid, 0); throw new Error('Another process owns this conversation’s experiments') }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure }
    unlinkSync(lock)
    lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
  }
  const ownerToken = randomUUID()
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: ownerToken }), 'utf8')
  closeSync(lockFd)
  openStores.add(file)
  let released = false
  const release = () => {
    if (released) return
    released = true
    openStores.delete(file)
    assertDirectory(directory)
    if (assertRegular(lock) && JSON.parse(readFileSync(lock, 'utf8')).token === ownerToken) unlinkSync(lock)
  }
  const read = () => {
    assertDirectory(directory)
    if (!assertRegular(file)) return null
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try { return JSON.parse(readFileSync(fd, 'utf8')) } finally { closeSync(fd) }
  }
  const write = (state) => {
    if (released) throw new Error('Experiment storage is closed')
    assertDirectory(directory)
    assertRegular(file)
    const text = JSON.stringify(state)
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Experiment evidence storage is full; start a new conversation')
    const temporary = join(directory, `.${basename}.${randomUUID()}.tmp`)
    let fd
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      assertDirectory(dirname(file))
      assertRegular(file)
      renameSync(temporary, file)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return { read, write, release }
}
