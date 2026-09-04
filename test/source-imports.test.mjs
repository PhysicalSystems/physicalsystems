import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSourceImport, checkSourceImports } from '../scripts/check-source-imports.mjs'

const expected = { repository: 'https://github.com/example/public.git', commit: 'a'.repeat(40) }
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
function fixture(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ps-import-'))
  try {
    const bytes = Buffer.from('public kernel\n')
    mkdirSync(path.join(directory, 'src'))
    writeFileSync(path.join(directory, 'src/kernel.py'), bytes)
    const receipt = { schemaVersion: 1, source: { ...expected, tree: 'b'.repeat(40) },
      importedFiles: [{ path: 'src/kernel.py', bytes: bytes.length, sha256: sha(bytes), gitBlob: sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1') }],
      deliberateChanges: [], excludedFiles: [], addedFiles: [] }
    const save = () => writeFileSync(path.join(directory, 'SOURCE-IMPORT.json'), JSON.stringify(receipt))
    save()
    body({ directory, receipt, save })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('checked-in public imports are complete and unchanged except declared adaptations', () => {
  const imports = checkSourceImports()
  assert.equal(imports.length, 2)
  assert.deepEqual(imports.map((entry) => entry.directory), ['packages/runtime', 'release/node'])
})

test('checks both public source byte hash and Git blob without a sibling checkout', () => fixture(({ directory, receipt, save }) => {
  assert.equal(checkSourceImport(directory, expected).files, 1)
  receipt.importedFiles[0].gitBlob = 'c'.repeat(40)
  save()
  assert.throws(() => checkSourceImport(directory, expected), /Git blob/)
}))

test('rejects undeclared source changes, added private code and build artifacts', () => fixture(({ directory }) => {
  writeFileSync(path.join(directory, 'unexpected.whl'), 'artifact')
  assert.throws(() => checkSourceImport(directory, expected), /unexpected\/missing/)
  rmSync(path.join(directory, 'unexpected.whl'))
  writeFileSync(path.join(directory, 'src/kernel.py'), 'different kernel\n')
  assert.throws(() => checkSourceImport(directory, expected), /differs from imported/)
}))

test('declarations need contained unique paths and a review reason', () => fixture(({ directory, receipt, save }) => {
  receipt.deliberateChanges.push({ path: 'missing.py', reason: 'migration' })
  save()
  assert.throws(() => checkSourceImport(directory, expected), /change must name/)
  receipt.deliberateChanges = []
  receipt.importedFiles[0].path = '../outside.py'
  save()
  assert.throws(() => checkSourceImport(directory, expected), /contained/)
}))

test('explicit adaptation records preserve origin but do not claim unchanged bytes', () => fixture(({ directory, receipt, save }) => {
  writeFileSync(path.join(directory, 'src/kernel.py'), 'adapted kernel\n')
  receipt.deliberateChanges.push({ path: 'src/kernel.py', reason: 'Explicitly reviewed example migration' })
  save()
  assert.equal(checkSourceImport(directory, expected).adaptations, 1)
}))
