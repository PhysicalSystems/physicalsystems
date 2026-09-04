#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { assembleNodeBundle } from './assemble-node-bundle.mjs'
import { checkBundledNodeReleaseIndex } from './check-node-release-index.mjs'

// One local preparation command, not an alternative publisher. The existing
// protected workflow remains the only authority to publish product bytes.
export function parsePreparationArguments(args) {
  const values = {}
  const flags = new Map([['--output', 'output'], ['--metadata', 'directory'], ['--wheelhouse', 'wheelhouse']])
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
  if (!values.output || !process.env.npm_execpath) throw new Error('Run release:prepare through pinned npm 11.19.0 with --output')
  if (execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim() !== '11.19.0') throw new Error('Candidate preparation requires pinned npm 11.19.0')
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
  // The default product carries the reviewed selection metadata, not wheels
  // for every supported machine. No backend downloads happen while packing it.
  await checkBundledNodeReleaseIndex(values.directory, values.offline ? {} : { expectedRelease: '0.2.1' })
  const parent = await fs.realpath(path.dirname(values.output))
  const relative = path.relative(sourceRoot, parent)
  if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..') throw new Error('Product artifacts must stay outside the source repository')
  const output = path.join(parent, path.basename(values.output))
  await fs.mkdir(output)
  const runNpm = async (arguments_) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, '--prefix', path.join(sourceRoot, 'packages/cli'), ...arguments_], { stdio: 'inherit', shell: false, windowsHide: true })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    if (code !== 0) throw new Error('Product candidate preparation failed; no publication was attempted')
  }
  let dependencyTree
  try { dependencyTree = await fs.lstat(path.join(sourceRoot, 'packages/cli/node_modules')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!dependencyTree) await runNpm(['run', 'bootstrap:pi-runtime', '--', '--cache', path.join(output, 'pi-cache'), '--install-cli'])
  if (values.offline) {
    const bundle = await assembleNodeBundle({ ...values, output: path.join(output, 'node-bundle') })
    await runNpm(['run', 'release:pack', '--', path.join(output, 'candidate'), '--node-bundle', bundle.output])
    console.log(`Offline review candidate ready at ${path.join(output, 'candidate')}; backend wheels ${bundle.bytes} bytes. Not eligible for the small npm publication route.`)
  } else {
    await runNpm(['run', 'release:pack', '--', path.join(output, 'candidate')])
    console.log(`Product candidate ready at ${path.join(output, 'candidate')}; pinned backend metadata included, matching wheels downloaded on first setup. Not published or platform-qualified.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareProductCandidate(parsePreparationArguments(process.argv.slice(2))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
