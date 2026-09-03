import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readNodeInstallManifest, readInstallationFile } from './node-installation.js'

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
export const NODE_BUNDLE_PATH = 'node-bundle'

export async function bundleDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Node bundle needs an absolute directory')
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(await fs.realpath(directory)) !== normalized(directory)) {
    throw new Error('Node bundle directories must not use links or junctions')
  }
}

/** A bundle is product data, never an executable plug-in or a Python index.
 * Original installation manifests remain byte-identical, including provenance
 * URLs. The explicit wheelhouse makes those URLs unused at installation time.
 */
export async function readNodeBundle(directory) {
  await bundleDirectory(directory)
  const descriptor = JSON.parse((await readInstallationFile(path.join(directory, 'bundle.json'), 128 * 1024)).toString('utf8'))
  if (!exact(descriptor, ['contractVersion', 'releases']) || descriptor.contractVersion !== 'physicalsystems-node-bundle-v1'
    || !Array.isArray(descriptor.releases) || !descriptor.releases.length || descriptor.releases.length > 12) {
    throw new Error('Invalid bundled backend descriptor')
  }
  const selectors = new Set(), files = new Set(), releases = []
  await bundleDirectory(path.join(directory, 'manifests'))
  await bundleDirectory(path.join(directory, 'wheels'))
  for (const entry of descriptor.releases) {
    if (!exact(entry, ['platform', 'python', 'manifest', 'sha256']) || typeof entry.manifest !== 'string'
      || !/^[a-z0-9-]{1,123}\.json$/.test(entry.manifest) || files.has(entry.manifest)
      || selectors.has(`${entry.platform}:${entry.python}`)) throw new Error('Invalid or duplicate bundled backend selector')
    const release = await readNodeInstallManifest(path.join(directory, 'manifests', entry.manifest), entry.sha256)
    if (release.manifest.platform !== entry.platform || release.manifest.python !== entry.python) throw new Error('Bundled backend selector mismatch')
    selectors.add(`${entry.platform}:${entry.python}`); files.add(entry.manifest)
    releases.push({ ...release, wheelhouse: path.join(directory, 'wheels') })
  }
  return { descriptor, releases }
}

/** Build/packing check: every distinct wheel is present and hash checked;
 * extra payloads, links, and filename collisions are rejected, not packed.
 */
export async function verifyNodeBundle(directory) {
  const result = await readNodeBundle(directory)
  const wheels = new Map()
  for (const { manifest } of result.releases) {
    for (const artifact of manifest.artifacts) {
      const previous = wheels.get(artifact.filename)
      if (previous && (previous.sha256 !== artifact.sha256 || previous.bytes !== artifact.bytes)) throw new Error('Conflicting bundled wheel identity')
      wheels.set(artifact.filename, artifact)
    }
  }
  const allowed = new Map([
    [directory, ['bundle.json', 'manifests', 'wheels']],
    [path.join(directory, 'manifests'), result.descriptor.releases.map((entry) => entry.manifest)],
    [path.join(directory, 'wheels'), [...wheels.keys()]],
  ])
  for (const [folder, expected] of allowed) {
    if (JSON.stringify((await fs.readdir(folder)).sort()) !== JSON.stringify(expected.sort())) throw new Error('Unexpected or missing Node bundle payload')
  }
  let bytes = 0
  for (const artifact of wheels.values()) {
    bytes += artifact.bytes
    if (bytes > 512 * 1024 * 1024) throw new Error('Node bundle exceeds its size bound')
    const data = await readInstallationFile(path.join(directory, 'wheels', artifact.filename), artifact.bytes)
    if (data.length !== artifact.bytes || createHash('sha256').update(data).digest('hex') !== artifact.sha256) throw new Error('Bundled Node wheel checksum mismatch')
  }
  return { ...result, wheels: wheels.size, bytes }
}
