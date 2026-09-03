import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { NODE_BUNDLE_PATH, verifyNodeBundle } from '../src/physical/node-bundle.js'

/** Stage only npm's explicit source list and dependency closure outside Git.
 * Private source, tests, sessions and build caches are not copied. Exact wheels
 * retain their internal notices; the adjacent notice clarifies mixed licensing.
 */
export async function stageNodeBundle(packageDirectory, bundle) {
  const verified = await verifyNodeBundle(bundle)
  const metadata = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  // Match fs.promises.realpath used by bundle validation. On Windows the
  // legacy sync implementation preserves SUBST drive aliases, while native
  // realpath resolves their backing path. Stage at that canonical path rather
  // than relaxing the bundle's strict directory/link checks.
  const base = realpathSync.native(tmpdir()), directory = mkdtempSync(path.join(base, 'ps-bundle-'))
  const dispose = () => {
    if (path.dirname(directory) !== base || !path.basename(directory).startsWith('ps-bundle-') || realpathSync.native(directory) !== directory) throw new Error('Unexpected package staging directory')
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    for (const relative of new Set([...metadata.files, 'node_modules'])) {
      if (!/^[A-Za-z0-9_.-]+$/.test(relative) || relative === '.' || relative === '..' || relative === NODE_BUNDLE_PATH) throw new Error('Unexpected package file list for bundle staging')
      const source = path.join(packageDirectory, relative)
      if (!existsSync(source)) throw new Error(`Missing reviewed package input: ${relative}`)
      cpSync(source, path.join(directory, relative), { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
    cpSync(bundle, path.join(directory, NODE_BUNDLE_PATH), { recursive: true, dereference: false, errorOnExist: true, force: false })
    await verifyNodeBundle(path.join(directory, NODE_BUNDLE_PATH))
    metadata.physicalsystemsNodeBundle = NODE_BUNDLE_PATH
    metadata.files.push(NODE_BUNDLE_PATH, 'BACKEND-NOTICE.txt', 'BACKEND-SBOM.cdx.json')
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
    writeFileSync(path.join(directory, 'BACKEND-NOTICE.txt'), [
      'Physical Systems bundled backend',
      '',
      'The Harness source is Apache-2.0. That license does not relicense the bundled backend.',
      'physicalsystems-node is a separately licensed proprietary evaluation preview.',
      'tinyedge-runtime is Apache-2.0. NumPy, OpenCV and their bundled libraries retain',
      'their respective licenses and notices inside each unchanged wheel.',
      'Read the wheel metadata and licenses before redistribution or production use.',
      '',
      'This product includes Python packages, not a Python interpreter or every device driver.',
      'Installation requires supported CPython with venv/ensurepip and does not authorize motion.',
      '',
    ].join('\n'), { flag: 'wx' })
    const artifacts = new Map(verified.releases.flatMap(({ manifest }) => manifest.artifacts).map((item) => [item.sha256, item]))
    writeFileSync(path.join(directory, 'BACKEND-SBOM.cdx.json'), JSON.stringify({
      bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      components: [...artifacts.values()].sort((a, b) => a.filename.localeCompare(b.filename, 'en')).map((item) => ({
        type: 'library', 'bom-ref': `sha256:${item.sha256}`, name: item.name, version: item.version,
        hashes: [{ alg: 'SHA-256', content: item.sha256 }],
        licenses: [{ license: { name: item.name === 'physicalsystems-node' ? 'Proprietary evaluation preview — see wheel license' : 'See licenses and third-party notices inside the unchanged wheel' } }],
        externalReferences: [{ type: 'distribution', url: item.url }],
        properties: [{ name: 'physicalsystems:wheel', value: item.filename }],
      })),
    }, null, 2) + '\n', { flag: 'wx' })
    return { directory, dispose }
  } catch (error) { dispose(); throw error }
}
