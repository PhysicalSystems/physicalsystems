import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const READ_AGENT_SKILL_TOOL = 'read_agent_skill'

const PACKAGE_ROOT = fileURLToPath(new URL('./skills/', import.meta.url))
const PACKAGE_FILES = Object.freeze(['SKILL.md', 'physicalsystems.binding.json'])
const MAX_PACKAGE_FILE_BYTES = 16 * 1024
const PACKAGES = Object.freeze([
  Object.freeze({
    id: 'inspect-workcell',
    description: 'Inspect connected hardware, guide operator camera preview through /workcell, and explain observed candidates, adapter availability, commissioning gaps, and physical capability readiness without moving hardware.',
    capabilities: Object.freeze([]),
    skillHash: 'ae163bf628e38d233183f0a409ddbc03040543221ed6e97bc6bfe4662bc564cc',
    bindingHash: 'b5ed7dff14e9d1808dfe1d43734274c6c9faeacd3b1024f3b6f952a707a0d4f8',
  }),
  Object.freeze({
    id: 'transfer-container',
    description: "Prepare a container transfer by inspecting the workcell, clarifying the operator's intent, and requesting a typed physical capability route preview with current node evidence.",
    capabilities: Object.freeze(['transfer-container']),
    skillHash: 'bd34f7005b8a7064529ad8bd12ce6a96e0aa59354f1b415f19ba0a277db74140',
    bindingHash: 'd800b6b2ad058a9c674cd33147f27ac91a3e77c22918389f6d50db604138f4c2',
  }),
])

export const CURATED_AGENT_SKILL_IDS = Object.freeze(PACKAGES.map(({ id }) => id))

function fail(reason) {
  throw new Error(`Bundled Agent Skill rejected: ${reason}`)
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalize = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function checkedDirectory(directory, expectedEntries) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !samePath(realpathSync(directory), directory)) fail('redirected package directory')
  const entries = readdirSync(directory).sort()
  if (JSON.stringify(entries) !== JSON.stringify([...expectedEntries].sort())) {
    fail('unexpected package entries')
  }
}

function readPinnedFile(filePath, expectedHash) {
  const initial = lstatSync(filePath)
  if (!initial.isFile() || initial.isSymbolicLink()
    || !samePath(realpathSync(filePath), filePath)) fail('redirected package file')
  // O_NOFOLLOW is available on Unix. The lstat/realpath and descriptor checks
  // also reject redirected files on Windows; no user-provided path is accepted.
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino
      || opened.size > MAX_PACKAGE_FILE_BYTES) fail('invalid package file')
    const buffer = Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const received = readSync(fd, buffer, length, buffer.length - length, null)
      if (!received) break
      length += received
    }
    if (length > MAX_PACKAGE_FILE_BYTES || length !== opened.size) fail('invalid package size')
    const contents = buffer.subarray(0, length)
    if (createHash('sha256').update(contents).digest('hex') !== expectedHash) {
      fail('package integrity mismatch')
    }
    return contents.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readPackage(root, entry) {
  checkedDirectory(root, CURATED_AGENT_SKILL_IDS)
  const directory = path.join(root, entry.id)
  checkedDirectory(directory, PACKAGE_FILES)
  const instructions = readPinnedFile(path.join(directory, 'SKILL.md'), entry.skillHash)
  const rawBinding = readPinnedFile(path.join(directory, 'physicalsystems.binding.json'), entry.bindingHash)
  const binding = JSON.parse(rawBinding)
  if (JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(['capabilities', 'schemaVersion', 'skill'])
    || binding.schemaVersion !== 1 || binding.skill !== entry.id
    || JSON.stringify(binding.capabilities) !== JSON.stringify(entry.capabilities)) {
    fail('invalid portable binding')
  }
  return { directory, instructions, binding }
}

/**
 * Load exactly the reviewed built-ins using Pi's standard SKILL.md parser.
 * packageRoot/parser injection is for local tests, never operator configuration.
 * No user/project search, Pi resource registration, scripts, or tool grants.
 */
export function loadCuratedAgentSkills({ loadSkillsFromDir, packageRoot = PACKAGE_ROOT } = {}) {
  if (typeof loadSkillsFromDir !== 'function') fail('reviewed Pi skill parser unavailable')
  const root = path.resolve(packageRoot)
  const summaries = []
  const seen = new Set()
  for (const entry of PACKAGES) {
    const checked = readPackage(root, entry)
    const result = loadSkillsFromDir({ dir: checked.directory, source: 'path' })
    if (!Array.isArray(result?.skills) || result.skills.length !== 1
      || !Array.isArray(result?.diagnostics) || result.diagnostics.length) {
      fail('invalid or duplicate Agent Skill metadata')
    }
    const parsed = result.skills[0]
    if (seen.has(parsed?.name)) fail('duplicate Agent Skill id')
    if (parsed?.name !== entry.id || parsed.description !== entry.description
      || parsed.disableModelInvocation === true
      || !samePath(parsed.filePath, path.join(checked.directory, 'SKILL.md'))
      || !samePath(parsed.baseDir, checked.directory)) fail('Agent Skill metadata mismatch')
    // Pi parses from disk. Recheck its fixed, validated directory immediately
    // afterward; all model-visible content comes from verified package bytes.
    readPackage(root, entry)
    seen.add(parsed.name)
    summaries.push(Object.freeze({ skillId: parsed.name, description: parsed.description }))
  }

  return Object.freeze({
    summaries: Object.freeze(summaries),
    prompt() {
      return [
        'Reviewed Agent Skills (instruction packages, not hardware capabilities):',
        `When a task matches, call ${READ_AGENT_SKILL_TOOL} with its exact skillId to read its instructions.`,
        ...summaries.map(({ skillId, description }) => `- ${skillId}: ${description}`),
        'An Agent Skill is SKILL.md guidance. A physical capability is a typed operation; a capability implementation is a controller or policy.',
        'Reading a package grants no tools, permissions, readiness, physical evidence, or execution authority.',
        'Portable bindings describe relevance only; query the local node for actual capability availability and exact IDs.',
        'Arbitrary local skills, file reads, scripts, and shell commands are disabled. Use only the granted tools.',
      ].join('\n')
    },
    read(skillId) {
      const entry = PACKAGES.find(({ id }) => id === skillId)
      if (!entry) fail('unknown Agent Skill id')
      const { instructions, binding } = readPackage(root, entry)
      return {
        kind: 'agent-skill-instructions',
        source: 'bundled-reviewed-package',
        skillId: entry.id,
        description: entry.description,
        binding,
        instructions,
        permissionsGranted: [],
        physicalExecutionAuthorized: false,
      }
    },
  })
}

export function createReadAgentSkillTool({ registry, defineTool = (definition) => definition }) {
  return defineTool({
    name: READ_AGENT_SKILL_TOOL,
    label: 'Read Agent Skill',
    description: 'Read one reviewed, bundled Agent Skill instruction package by exact ID. No arbitrary paths or files; never grants tools, device readiness, or execution authority.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['skillId'],
      properties: { skillId: { type: 'string', enum: [...CURATED_AGENT_SKILL_IDS] } },
    },
    async execute(_toolCallId, params) {
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).length !== 1 || !Object.hasOwn(params, 'skillId')
        || typeof params.skillId !== 'string') fail('expected only an exact skillId')
      const payload = registry.read(params.skillId)
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        details: { displaySummary: `Read Agent Skill: ${payload.skillId}` },
      }
    },
  })
}
