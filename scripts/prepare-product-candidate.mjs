#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { assembleNodeBundle } from './assemble-node-bundle.mjs'

// One local preparation command, not an alternative publisher. The existing
// protected workflow remains the only authority to publish product bytes.
const args = process.argv.slice(2), values = {}
try {
  const flags = new Map([['--output', 'output'], ['--metadata', 'directory'], ['--wheelhouse', 'wheelhouse']])
  for (let i = 0; i < args.length; i += 2) {
    const key = flags.get(args[i])
    if (!key || values[key] || !args[i + 1] || !path.isAbsolute(args[i + 1])) throw new Error('Usage: npm run release:prepare -- --output ABSOLUTE_NEW_DIRECTORY [--metadata ABSOLUTE_DIRECTORY] [--wheelhouse ABSOLUTE_DIRECTORY]')
    values[key] = args[i + 1]
  }
  if (!values.output || !process.env.npm_execpath) throw new Error('Run release:prepare through pinned npm 11.19.0 with --output')
  if (execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim() !== '11.19.0') throw new Error('Candidate preparation requires pinned npm 11.19.0')
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
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
  const bundle = await assembleNodeBundle({ ...values, output: path.join(output, 'node-bundle') })
  await runNpm(['run', 'release:pack', '--', path.join(output, 'candidate'), '--node-bundle', bundle.output])
  console.log(`Product candidate ready at ${path.join(output, 'candidate')}; backend wheels ${bundle.bytes} bytes. Not published or platform-qualified.`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
