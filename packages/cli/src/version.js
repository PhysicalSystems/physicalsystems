import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readPackageVersion() {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Physical Systems package.json is missing a version')
  }
  return manifest.version
}

export const VERSION = readPackageVersion()
export const versionLabel = `Physical Systems v${VERSION}`
