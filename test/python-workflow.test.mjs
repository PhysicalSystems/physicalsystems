import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/python.yml', import.meta.url), 'utf8').replace(/\r\n?/g, '\n')

function job(text, name) {
  const match = text.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, `Missing ${name} job`)
  return match[1]
}

function assertSourceOnly(text) {
  assert.match(text, /^on:\n  pull_request:\n  push:\n    branches: \[main\]/m)
  assert.match(text, /^permissions:\n  contents: read\n/m)
  assert.doesNotMatch(text, /^\s*(?:needs|environment|id-token):/m)
  assert.doesNotMatch(text, /pull_request_target:|workflow_run:|workflow_call:|workflow_dispatch:|secrets\.|contents: write|actions: write/)
  assert.doesNotMatch(text, /gh-action-pypi-publish|upload-artifact|download-artifact|twine\s+upload|npm\s+publish|release\.py['" ]|--require-downloadable-node/)
  for (const match of text.matchAll(/^\s*- uses: (.+)$/gm)) {
    assert.match(match[1], /^actions\/(?:checkout|setup-python|setup-node)@[a-f0-9]{40}(?: #.*)?$/)
  }
  assert.equal((text.match(/uses: actions\/checkout@/g) || []).length, 3)
  assert.equal((text.match(/persist-credentials: false/g) || []).length, 3)
  assert.match(text, /PYTHONDONTWRITEBYTECODE: '1'/)
  assert.match(job(text, 'workflow-contract'), /node --test test\/python-workflow\.test\.mjs test\/source-imports\.test\.mjs test\/release-migration\.test\.mjs/)
}

function assertRuntime(text) {
  const runtime = job(text, 'runtime')
  assert.deepEqual([...runtime.matchAll(/- os: ([^\n]+)\n\s+python: '([^']+)'/g)].map((match) => match.slice(1)), [
    ['ubuntu-22.04', '3.10'], ['ubuntu-22.04', '3.11'], ['ubuntu-22.04', '3.12'],
    ['ubuntu-22.04', '3.13'], ['windows-2022', '3.12'],
  ])
  assert.match(runtime, /source = Path\(os\.environ\['GITHUB_WORKSPACE'\]\) \/ 'packages\/runtime'/)
  assert.match(runtime, /temporary = Path\(os\.environ\['RUNNER_TEMP'\]\)\.resolve\(strict=True\)/)
  assert.match(runtime, /destination = temporary \/ 'physicalsystems-runtime-source'/)
  assert.match(runtime, /if destination\.exists\(\) or destination\.is_symlink\(\):/)
  assert.match(runtime, /shutil\.copytree\(source, destination\)/)
  assert.equal((runtime.match(/working-directory: \$\{\{ runner\.temp \}\}\/physicalsystems-runtime-source/g) || []).length, 5)
  assert.match(runtime, /pip --isolated install --upgrade "pip>=25,<27"/)
  assert.match(runtime, /pip --isolated install "\.\[dev\]"/)
  assert.match(runtime, /python -B -m pip --isolated check/)
  assert.match(runtime, /python -B -m pytest -p no:cacheprovider/)
  assert.match(runtime, /output = Path\(os\.environ\['RUNNER_TEMP'\]\)\.resolve\(strict=True\) \/ 'physicalsystems-runtime-dist'/)
  assert.match(runtime, /if output\.exists\(\) or output\.is_symlink\(\):/)
  assert.match(runtime, /'build', '--outdir', str\(output\)\], check=True/)
  assert.match(runtime, /len\(wheels\) != 1 or len\(sdists\) != 1/)
  assert.match(runtime, /'twine', 'check', \*map\(str, wheels \+ sdists\)\], check=True/)
}

function assertNodeTooling(text) {
  const node = job(text, 'node-release-tooling')
  assert.match(node, /os: \[ubuntu-22\.04, windows-2022\]/)
  assert.match(node, /python-version: '3\.12'/)
  assert.match(node, /--index-url https:\/\/pypi\.org\/simple packaging==26\.3 pytest==8\.4\.2/)
  assert.match(node, /working-directory: release\/node/)
  assert.match(node, /python -B -m pytest -q -p no:cacheprovider tests/)
}

test('Python source jobs remain independent, read-only and separate from publishing', () => {
  assertSourceOnly(workflow)
})

test('Runtime retains its four Linux Python versions, adds Windows and confines builds to runner temp', () => {
  assertRuntime(workflow)
})

test('Node release verifier tests retain the reviewed two-platform dependency contract', () => {
  assertNodeTooling(workflow)
})

test('source-only guards reject publication authority and dependency coupling', () => {
  for (const line of ['    needs: candidate', '    environment: pypi', '    id-token: write', '    run: python scripts/release.py stage']) {
    assert.throws(() => assertSourceOnly(workflow.replace('  runtime:\n', `  runtime:\n${line}\n`)))
  }
})

test('regressions reject lost Runtime coverage, in-checkout output and enabled pytest caches', () => {
  for (const [from, to] of [["python: '3.13'", "python: '3.14'"],
    ["/ 'physicalsystems-runtime-dist'", "/ 'dist'"],
    ['python -B -m pytest -p no:cacheprovider', 'python -B -m pytest']]) {
    assert.throws(() => assertRuntime(workflow.replace(from, to)))
  }
  assert.throws(() => assertNodeTooling(workflow.replace('packaging==26.3', 'packaging>=26.3')))
})
