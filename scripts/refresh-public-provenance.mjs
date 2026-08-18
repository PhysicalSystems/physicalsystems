#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const provenancePath = path.join(root, 'EXPORT-PROVENANCE.json')
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'release-artifacts',
  'verification-evidence',
])

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(absolute, files)
    else files.push(absolute)
  }
  return files
}

const relativePath = (absolute) => path.relative(root, absolute).replaceAll('\\', '/')
const payloadFiles = collectFiles(root)
  .filter((absolute) => relativePath(absolute) !== 'EXPORT-PROVENANCE.json')
  .sort((left, right) => {
    const leftPath = relativePath(left)
    const rightPath = relativePath(right)
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
const payloadIndex = payloadFiles.map((absolute) => {
  const raw = readFileSync(absolute)
  const canonical = raw.includes(0)
    ? raw
    : Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
  return `${createHash('sha256').update(canonical).digest('hex')}  ${relativePath(absolute)}\n`
}).join('')

const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
provenance.candidatePayload.fileCount = payloadFiles.length
provenance.candidatePayload.sha256 = createHash('sha256')
  .update(payloadIndex, 'utf8')
  .digest('hex')
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)

console.log(JSON.stringify(provenance.candidatePayload, null, 2))
