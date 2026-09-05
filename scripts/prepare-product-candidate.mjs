#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { assembleNodeBundle } from './assemble-node-bundle.mjs'
import { checkBundledNodeReleaseIndex } from './check-node-release-index.mjs'
import { createReleasePlan, readProductRelease } from './release-plan.mjs'
import { createHash } from 'node:crypto'

// One local preparation command, not an alternative publisher. The existing
// protected workflow remains the only authority to publish product bytes.
export function parsePreparationArguments(args) {
  const values = {}
  const flags = new Map([['--output', 'output'], ['--metadata', 'directory'], ['--wheelhouse', 'wheelhouse'], ['--dependency-cache', 'dependencyCache']])
  const usage = 'Usage: npm run release:prepare -- --output ABSOLUTE_NEW_DIRECTORY [--offline [--metadata ABSOLUTE_DIRECTORY] [--wheelhouse ABSOLUTE_DIRECTORY]]'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline' && !values.offline) { values.offline = true; continue }
    const key = flags.get(args[i])
    if (!key || values[key] || !args[i + 1] || !path.isAbsolute(args[i + 1])) throw new Error(usage)
    values[key] = args[++i]
  }
  if (!values.output) throw new Error(usage)
  if (!values.offline && (values.directory || values.wheelhouse)) throw new Error('--metadata and --wheelhouse require explicit --offline preparation')
  return values
}

export async function prepareProductCandidate(values) {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
  const release = await readProductRelease(sourceRoot)
  if (!values.output || !process.env.npm_execpath) throw new Error(`Run release:prepare through pinned npm ${release.toolchain.npm} with --output`)
  if (execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim() !== release.toolchain.npm) throw new Error(`Candidate preparation requires pinned npm ${release.toolchain.npm}`)
  const plan = values.offline ? null : await createReleasePlan(sourceRoot)
  // The default product carries the reviewed selection metadata, not wheels
  // for every supported machine. No backend downloads happen while packing it.
  await checkBundledNodeReleaseIndex(values.directory, values.offline ? {} : { expectedRelease: release.components.node.version })
  const parent = await fs.realpath(path.dirname(values.output))
  const relative = path.relative(sourceRoot, parent)
  if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..') throw new Error('Product artifacts must stay outside the source repository')
  const output = path.join(parent, path.basename(values.output))
  const dependencyCache = values.dependencyCache || path.join(output, 'pi-cache')
  if (values.dependencyCache) {
    const cacheParent = await fs.realpath(path.dirname(dependencyCache))
    const relativeCache = path.relative(sourceRoot, cacheParent)
    if (!path.isAbsolute(relativeCache) && relativeCache.split(path.sep)[0] !== '..') throw new Error('Build dependency cache must stay outside source')
    try {
      if ((await fs.lstat(dependencyCache)).isSymbolicLink()) throw new Error('Build dependency cache cannot be a link')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await fs.mkdir(output)
  const runNpm = async (arguments_) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, '--prefix', path.join(sourceRoot, 'packages/cli'), ...arguments_], { stdio: 'inherit', shell: false, windowsHide: true })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    if (code !== 0) throw new Error('Product candidate preparation failed; no publication was attempted')
  }
  let dependencyTree
  try { dependencyTree = await fs.lstat(path.join(sourceRoot, 'packages/cli/node_modules')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!dependencyTree) await runNpm(['run', 'bootstrap:pi-runtime', '--', '--cache', dependencyCache, '--install-cli'])
  if (values.offline) {
    const bundle = await assembleNodeBundle({ ...values, output: path.join(output, 'node-bundle') })
    await runNpm(['run', 'release:pack', '--', path.join(output, 'candidate'), '--node-bundle', bundle.output])
    console.log(`Offline review candidate ready at ${path.join(output, 'candidate')}; backend wheels ${bundle.bytes} bytes. Not eligible for the small npm publication route.`)
  } else {
    await runNpm(['run', 'release:pack', '--', path.join(output, 'candidate')])
    const manifestBytes = await fs.readFile(path.join(output, 'candidate', 'release-manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    if (manifest.version !== plan.product.version) throw new Error('Prepared candidate version differs from the release plan')
    if (JSON.stringify(await createReleasePlan(sourceRoot)) !== JSON.stringify(plan)) throw new Error('Release inputs changed during preparation; discard this unqualified candidate')
    await fs.writeFile(path.join(output, 'preparation-receipt.json'), `${JSON.stringify({
      contractVersion: 'physicalsystems-preparation-receipt-v1',
      plan,
      candidateManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      candidateManifest: manifest,
      publicationAuthorized: false,
      installationQualified: false,
    }, null, 2)}\n`, { flag: 'wx' })
    console.log(`Product candidate ready at ${path.join(output, 'candidate')}; pinned backend metadata included, matching wheels downloaded on first setup. Not published or platform-qualified.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareProductCandidate(parsePreparationArguments(process.argv.slice(2))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
