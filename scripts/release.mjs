#!/usr/bin/env node
// Maintainer entry point. Planning and preparation never grant publication
// authority; only the protected GitHub workflows can publish.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleasePlan, readProductRelease } from './release-plan.mjs'
import { parsePreparationArguments, prepareProductCandidate } from './prepare-product-candidate.mjs'
import { createMigrationReport } from './release-migration.mjs'
import { parsePublishArguments, runPublishCoordinator } from './publish-coordinator.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const usage = 'Usage: npm run release -- plan | check | migration | prepare --output ABSOLUTE_NEW_DIRECTORY | verify-publishers/publish/publish-component/resume --output ABSOLUTE_RECEIPT_DIRECTORY [component candidate options]'

export function parseReleaseArguments(args) {
  const [action = 'plan', ...rest] = args
  if (['plan', 'check', 'migration'].includes(action) && rest.length === 0) return { action }
  if (['verify-publishers', 'publish', 'publish-component', 'resume'].includes(action)) {
    if (rest.length === 0) throw new Error(usage)
    parsePublishArguments(rest)
    return { action, args: rest }
  }
  if (action === 'prepare') {
    const values = parsePreparationArguments(rest)
    if (values.offline) throw new Error('Use the explicit release:prepare -- --offline review route for offline artifacts; they are not npm release candidates')
    return { action, values }
  }
  throw new Error(usage)
}

// Until the protected workflow is deliberately migrated, check its repeated
// constants cheaply so drift fails before dependency hydration or packaging.
export async function checkWorkflowReleaseConfiguration(sourceRoot = root) {
  const release = await readProductRelease(sourceRoot)
  const workflow = await fs.readFile(path.join(sourceRoot, '.github/workflows/npm-release.yml'), 'utf8')
  const expected = {
    RELEASE_VERSION: release.product.version,
    PI_RUNTIME_VERSION: release.components.piRuntime.version,
    NODE_VERSION: release.toolchain.node,
    NPM_VERSION: release.toolchain.npm,
    CONSUMER_NPM_VERSION: release.toolchain.consumerNpm,
  }
  for (const [name, version] of Object.entries(expected)) {
    const matches = [...workflow.matchAll(new RegExp(`^  ${name}: ([^\\r\\n]+)$`, 'gm'))]
    if (matches.length !== 1 || matches[0][1] !== version) {
      throw new Error(`Protected workflow ${name} differs from release/product.json; update and review the workflow before preparation`)
    }
  }
  const matrixPairs = [...workflow.matchAll(/npm-version: ([^\s]+)\r?\n\s+node-version: ([^\s]+)/g)]
    .map((match) => `${match[1]}:${match[2]}`).sort()
  const expectedPairs = Array.from({ length: 4 }, () => [
    `${release.toolchain.npm}:${release.toolchain.node}`,
    `${release.toolchain.consumerNpm}:${release.toolchain.consumerNode}`,
  ]).flat().sort()
  if (JSON.stringify(matrixPairs) !== JSON.stringify(expectedPairs)) throw new Error('Protected workflow consumer matrix differs from release/product.json')
  const tagMatches = [...workflow.matchAll(/\{ bootstrap: '([^']+)', latest: '([^']+)', preview: '([^']+)' \}/g)]
  if (tagMatches.length !== 1 || JSON.stringify(tagMatches[0].slice(1)) !== JSON.stringify([
    release.previousTags.bootstrap, release.previousTags.latest, release.previousTags.preview,
  ])) throw new Error('Protected workflow previous tags differ from release/product.json')
}

export async function runReleaseCommand(args, { sourceRoot = root, print = console.log, prepare = prepareProductCandidate } = {}) {
  const command = parseReleaseArguments(args)
  if (command.action === 'migration') {
    const report = createMigrationReport(sourceRoot)
    print(JSON.stringify(report, null, 2))
    return report
  }
  const plan = await createReleasePlan(sourceRoot)
  await checkWorkflowReleaseConfiguration(sourceRoot)
  if (['verify-publishers', 'publish', 'publish-component', 'resume'].includes(command.action)) {
    return runPublishCoordinator(command.action, command.args, { sourceRoot, print })
  }
  if (command.action === 'plan') {
    print(JSON.stringify(plan, null, 2))
  } else if (command.action === 'check') {
    print(`Release configuration verified for ${plan.product.name}@${plan.product.version}. Backend pins are locally consistent; registry availability, installation qualification and publication are not implied.`)
  } else {
    // No setup, wheel fetch or output-directory creation until cheap checks pass.
    await prepare(command.values)
  }
  return plan
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runReleaseCommand(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
