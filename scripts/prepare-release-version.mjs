import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'

// Explicit product-only inventory. Backend descriptors, compatibility runtime
// sources and historical release records are never searched and rewritten.
export const versionFiles = [
  '.github/workflows/cli.yml', '.github/workflows/npm-release.yml',
  'README.md', 'SECURITY.md', 'SUPPORT.md', 'packages/cli/README.md', 'packages/cli/RELEASE.md',
  'packages/cli/scripts/check-release-packages.js', 'packages/cli/scripts/install-unreleased.ps1',
  'packages/cli/test/downloaded-node-canary.test.js', 'packages/cli/test/installer.test.js',
  'packages/cli/test/pi-runtime-bootstrap.test.js', 'scripts/legal/reviewed-inventory.mjs',
  'test/legal-bundle.test.mjs', 'test/npm-release-workflow.test.mjs',
  'test/publish-coordinator.test.mjs', 'test/release-coordinator.test.mjs', 'test/release-plan.test.mjs',
]
const jsonFiles = ['release/product.json', 'packages/cli/package.json',
  'packages/cli/package-lock.json', 'packages/cli/npm-shrinkwrap.json']
const generatedFiles = ['SBOM.cdx.json', 'packages/cli/SBOM.cdx.json',
  'packages/pi-runtime/SBOM.cdx.json', 'EXPORT-PROVENANCE.json']
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (value) => createHash('sha256').update(value).digest('hex')

export function requireNewVersion(current, next) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  assert.match(next, stable, 'Use a stable major.minor.patch product version')
  const before = current.split('.').map(BigInt), after = next.split('.').map(BigInt)
  const first = after.findIndex((value, index) => value !== before[index])
  assert.ok(first >= 0 && after[first] > before[first], 'New product version must increase')
}

export async function planVersionUpdate(sourceRoot, next) {
  const originals = new Map()
  for (const file of [...jsonFiles, ...versionFiles, ...generatedFiles]) {
    const target = path.join(sourceRoot, file)
    assert.ok(!(await fs.lstat(target)).isSymbolicLink(), `Refusing linked release input: ${file}`)
    originals.set(file, await fs.readFile(target, 'utf8'))
  }
  const release = JSON.parse(originals.get('release/product.json'))
  const current = release.product.version, previous = release.previousTags.preview
  requireNewVersion(current, next)
  const updates = new Map()
  release.product.version = next
  release.previousTags.preview = current
  updates.set('release/product.json', serialize(release))
  for (const file of jsonFiles.slice(1)) {
    const value = JSON.parse(originals.get(file))
    assert.equal(value.name, 'physicalsystems')
    assert.equal(value.version, current, `${file} version drift`)
    value.version = next
    if (value.packages) {
      assert.equal(value.packages[''].version, current)
      value.packages[''].version = next
    }
    updates.set(file, serialize(value))
  }
  assert.equal(originals.get(jsonFiles[2]), originals.get(jsonFiles[3]), 'Lock and shrinkwrap must be byte-identical')
  const oldHash = digest(originals.get(jsonFiles[3]))
  const newHash = digest(updates.get(jsonFiles[3]))
  // A dot may introduce a filename extension or punctuation; only a following
  // numeric component extends the version and must remain untouched.
  const pattern = new RegExp(`(?<![\\d.])${current.replaceAll('.', '\\.')}(?!\\d|\\.\\d)`, 'g')
  for (const file of versionFiles) {
    let value = originals.get(file).replace(pattern, next)
      .replaceAll(current.replaceAll('.', '\\.'), next.replaceAll('.', '\\.'))
    if (file === '.github/workflows/npm-release.yml') {
      value = value.replace(`preview: '${previous}'`, `preview: '${current}'`)
        .replace(`existing ${previous} preview`, `existing ${current} preview`)
    }
    if (file === 'packages/cli/RELEASE.md') value = value.replace(`preview=${previous}`, `preview=${current}`)
    if (file === 'scripts/legal/reviewed-inventory.mjs') {
      assert.ok(value.includes(oldHash), 'Reviewed shrinkwrap hash drift')
      value = value.replace(oldHash, newHash)
    }
    updates.set(file, value)
  }
  return { current, next, originals, updates }
}

export async function prepareReleaseVersion(sourceRoot, next, { print = console.log } = {}) {
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), '', 'Version preparation requires a clean checkout; commit or preserve current work first')
  const plan = await planVersionUpdate(sourceRoot, next)
  const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: sourceRoot, stdio: 'pipe' })
  try {
    for (const [file, value] of plan.updates) await fs.writeFile(path.join(sourceRoot, file), value)
    // Fresh processes reload the updated reviewed inventory and version pins.
    run('scripts/legal/sbom.mjs', ['--write'])
    run('scripts/release.mjs', ['check'])
    run('scripts/refresh-public-provenance.mjs')
  } catch (error) {
    for (const [file, value] of plan.originals) await fs.writeFile(path.join(sourceRoot, file), value)
    throw new Error(`Version preparation failed; restored original release files. ${error.stderr?.toString() || error.message}`, { cause: error })
  }
  print(`Prepared ${plan.current} -> ${next}; previous preview=${plan.current}. Review the diff and release notes, run tests, and submit a release PR.`)
  return { current: plan.current, next }
}
