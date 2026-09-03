#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundledNodeReleaseIndex } from './check-node-release-index.mjs'
import { downloadWheel, readNodeInstallManifest } from '../packages/cli/src/physical/node-installation.js'
import { verifyNodeBundle } from '../packages/cli/src/physical/node-bundle.js'

const root = fileURLToPath(new URL('../', import.meta.url))
export const sourceDirectory = path.join(root, 'packages/cli/src/physical')

// Consume the already reviewed wheel closure. This neither builds private
// source nor publishes anything. A complete local wheelhouse avoids PyPI even
// at build time; otherwise exact pinned URLs are fetched once by the builder.
export async function assembleNodeBundle({ output, directory = sourceDirectory, wheelhouse, fetchImpl = fetch } = {}) {
  if (!output || !path.isAbsolute(output)) throw new Error('Provide an absolute, new bundle output directory outside the source repository')
  const realParent = await fs.realpath(path.dirname(output))
  const relative = path.relative(root, realParent)
  if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..') throw new Error('Node bundle artifacts must stay outside the source repository')
  output = path.join(realParent, path.basename(output))
  await checkBundledNodeReleaseIndex(directory)
  const index = JSON.parse(await fs.readFile(path.join(directory, 'node-releases.json'), 'utf8'))
  const releases = await Promise.all(index.releases.map(async (entry) => ({ entry,
    ...await readNodeInstallManifest(path.join(directory, 'node-releases', entry.manifest), entry.sha256) })))
  const wheels = new Map()
  for (const { manifest } of releases) {
    for (const item of manifest.artifacts) {
      const previous = wheels.get(item.filename)
      if (previous && (previous.sha256 !== item.sha256 || previous.bytes !== item.bytes)) throw new Error('Conflicting bundled wheel identity')
      wheels.set(item.filename, item)
    }
  }
  if ([...wheels.values()].reduce((sum, item) => sum + item.bytes, 0) > 512 * 1024 * 1024) throw new Error('Node bundle exceeds its size bound')
  // Exclusive directory creation: never overwrite another build/candidate.
  await fs.mkdir(output)
  await fs.mkdir(path.join(output, 'manifests'))
  await fs.mkdir(path.join(output, 'wheels'))
  for (const { entry, manifestBytes } of releases) await fs.writeFile(path.join(output, 'manifests', entry.manifest), manifestBytes, { flag: 'wx' })
  for (const artifact of wheels.values()) await downloadWheel(artifact, path.join(output, 'wheels', artifact.filename), { wheelhouse, fetchImpl })
  // Written last. Interrupted bundles have no descriptor and cannot be used.
  await fs.writeFile(path.join(output, 'bundle.json'), JSON.stringify({ contractVersion: 'physicalsystems-node-bundle-v1', releases: index.releases }, null, 2) + '\n', { flag: 'wx' })
  const result = await verifyNodeBundle(output)
  return { output, selectors: index.releases.length, wheels: result.wheels, bytes: result.bytes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {}, flags = new Map([['--output', 'output'], ['--metadata', 'directory'], ['--wheelhouse', 'wheelhouse']])
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 2) {
      const key = flags.get(args[i])
      if (!key || values[key] || !args[i + 1] || !path.isAbsolute(args[i + 1])) throw new Error('Usage: assemble-node-bundle.mjs --output ABSOLUTE_NEW_DIRECTORY [--metadata ABSOLUTE_DIRECTORY] [--wheelhouse ABSOLUTE_DIRECTORY]')
      values[key] = args[i + 1]
    }
    console.log(JSON.stringify(await assembleNodeBundle(values)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
