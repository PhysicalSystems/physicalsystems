// Initial consolidation receipt checks. No sibling repositories, Git history,
// network, package installation or private Node source is needed to audit this.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const sourceImports = [
  { directory: 'packages/runtime', repository: 'https://github.com/PhysicalSystems/runtime.git', commit: '76b1ae3702d8c677940a8da040c80a676c92db17' },
  { directory: 'release/node', repository: 'https://github.com/PhysicalSystems/node-releases.git', commit: '06f7fbf0ef9e4e4c26593ab7125b5d3fa507c8fd' },
]
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')

function safePath(value) {
  assert.equal(typeof value, 'string', 'receipt path must be a string')
  assert.ok(value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.includes('\0'), 'invalid receipt path')
  assert.ok(value.split('/').every((part) => part && part !== '.' && part !== '..'), 'receipt path must be relative and contained')
  return value
}

function inventory(directory, prefix = '') {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    const absolute = path.join(directory, entry.name)
    assert.ok(!lstatSync(absolute).isSymbolicLink(), 'import must not contain links: ' + relative)
    if (entry.isDirectory()) result.push(...inventory(absolute, relative + '/'))
    else {
      assert.ok(entry.isFile(), 'import must contain only files: ' + relative)
      result.push(relative)
    }
  }
  return result.sort()
}

export function checkSourceImport(directory, expected) {
  const receiptPath = path.join(directory, 'SOURCE-IMPORT.json')
  assert.ok(!lstatSync(directory).isSymbolicLink() && !lstatSync(receiptPath).isSymbolicLink(), 'import root and receipt cannot be links')
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.source.repository, expected.repository)
  assert.equal(receipt.source.commit, expected.commit)
  assert.match(receipt.source.tree, /^[a-f0-9]{40}$/)
  assert.ok(Array.isArray(receipt.importedFiles) && receipt.importedFiles.length > 0)
  assert.ok(Array.isArray(receipt.excludedFiles))
  assert.ok(Array.isArray(receipt.deliberateChanges))
  const imported = new Map()
  const sourcePaths = new Set()
  for (const entry of receipt.importedFiles) {
    safePath(entry.path)
    const sourcePath = safePath(entry.sourcePath ?? entry.path)
    assert.ok(!imported.has(entry.path) && !sourcePaths.has(sourcePath), 'duplicate imported path')
    assert.match(entry.gitBlob, /^[a-f0-9]{40}$/)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0)
    imported.set(entry.path, entry)
    sourcePaths.add(sourcePath)
  }
  for (const entry of receipt.excludedFiles) {
    safePath(entry.path)
    assert.ok(!sourcePaths.has(entry.path), 'duplicate/excluded imported source path')
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), 'exclusion needs a reason')
    sourcePaths.add(entry.path)
  }
  const changes = new Set()
  for (const entry of receipt.deliberateChanges) {
    assert.ok(imported.has(entry.path) && !changes.has(entry.path), 'change must name one imported file')
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), 'adaptation needs a reason')
    changes.add(entry.path)
  }
  const added = new Set()
  for (const entry of receipt.addedFiles ?? []) {
    safePath(entry.path)
    assert.ok(!imported.has(entry.path) && !added.has(entry.path) && entry.path !== 'SOURCE-IMPORT.json', 'duplicate added path')
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), 'addition needs a reason')
    added.add(entry.path)
  }
  assert.deepEqual(inventory(directory), [...imported.keys(), ...added, 'SOURCE-IMPORT.json'].sort(), 'unexpected/missing import files; record deliberate source evolution, never artifacts')
  for (const entry of imported.values()) {
    if (changes.has(entry.path)) continue
    const bytes = readFileSync(path.join(directory, entry.path))
    assert.equal(bytes.length, entry.bytes, entry.path + ' differs from imported length')
    assert.equal(hash(bytes), entry.sha256, entry.path + ' differs from imported bytes')
    const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
    assert.equal(hash(blob, 'sha1'), entry.gitBlob, entry.path + ' differs from imported Git blob')
  }
  return { directory: expected.directory, repository: receipt.source.repository, commit: receipt.source.commit, files: imported.size, adaptations: changes.size }
}

export function checkSourceImports(sourceRoot = root) {
  return sourceImports.map((entry) => checkSourceImport(path.join(sourceRoot, entry.directory), entry))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkSourceImports(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
