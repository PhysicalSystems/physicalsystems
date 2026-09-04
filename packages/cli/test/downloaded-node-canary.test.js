import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDownloadableNodePackage, createDownloadRecorder } from '../../../scripts/check-downloaded-node.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const source = path.resolve(import.meta.dirname, '../src/physical')

async function installedMetadata(t) {
  const base = await fs.realpath(tmpdir())
  const directory = await fs.mkdtemp(path.join(base, 'ps-download-test-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), base)
    assert.ok(path.basename(directory).startsWith('ps-download-test-'))
    assert.equal(await fs.realpath(directory), directory)
    await fs.rm(directory, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(directory, 'src/physical'), { recursive: true })
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'physicalsystems', version: '0.2.2' }))
  await fs.copyFile(path.join(source, 'node-releases.json'), path.join(directory, 'src/physical/node-releases.json'))
  await fs.cp(path.join(source, 'node-releases'), path.join(directory, 'src/physical/node-releases'), { recursive: true })
  return directory
}

test('downloadable verification reads all six pinned selectors from the installed package without fetching', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('metadata checks must not fetch'))
  const directory = await installedMetadata(t)
  const { metadata, index } = await checkDownloadableNodePackage(directory)
  assert.equal(metadata.version, '0.2.2')
  assert.deepEqual(index, { entries: 6, selectors: ['linux-x64:3.10', 'linux-x64:3.11', 'linux-x64:3.12',
    'win32-x64:3.10', 'win32-x64:3.11', 'win32-x64:3.12'] })
  const indexPath = path.join(directory, 'src/physical/node-releases.json')
  const copiedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  copiedIndex.releases.pop()
  await fs.writeFile(indexPath, JSON.stringify(copiedIndex))
  await assert.rejects(checkDownloadableNodePackage(directory), /all six approved/)
})

test('downloadable mode rejects embedded bundle declarations and undeclared bundle directories', async (t) => {
  const directory = await installedMetadata(t)
  const metadataPath = path.join(directory, 'package.json')
  for (const physicalsystemsNodeBundle of ['node-bundle', null, false]) {
    await fs.writeFile(metadataPath, JSON.stringify({ name: 'physicalsystems', physicalsystemsNodeBundle }))
    await assert.rejects(checkDownloadableNodePackage(directory), /must not declare an embedded/)
  }
  await fs.writeFile(metadataPath, JSON.stringify({ name: 'physicalsystems' }))
  await fs.mkdir(path.join(directory, 'node-bundle'))
  await assert.rejects(checkDownloadableNodePackage(directory), /must not contain an embedded/)
})

test('downloadable verification refuses altered installed manifest bytes', async (t) => {
  const directory = await installedMetadata(t)
  const index = JSON.parse(await fs.readFile(path.join(directory, 'src/physical/node-releases.json'), 'utf8'))
  const manifest = path.join(directory, 'src/physical/node-releases', index.releases[0].manifest)
  await fs.appendFile(manifest, '\n')
  await assert.rejects(checkDownloadableNodePackage(directory), /checksum mismatch/)
})

test('downloadable mode rejects wheels misplaced outside the usual backend directory', async (t) => {
  const directory = await installedMetadata(t)
  await fs.writeFile(path.join(directory, 'src/unexpected.WHL'), 'not an npm dependency')
  await assert.rejects(checkDownloadableNodePackage(directory), /must not embed Python wheels anywhere/)
})

const options = { redirect: 'error', credentials: 'omit' }
function toyArtifact(bytes = Buffer.from('toy-wheel')) {
  return { url: 'https://files.example.test/toy.whl', bytes: bytes.length, sha256: sha(bytes) }
}
async function consume(response) { for await (const chunk of response.body) assert.ok(chunk.length) }

test('download recorder measures exact streamed URL/count/bytes and rejects extra downloads', async () => {
  const bytes = Buffer.from('toy-wheel'), artifact = toyArtifact(bytes)
  let requests = 0
  const recorder = createDownloadRecorder([artifact], async (url, received) => {
    requests++
    assert.equal(url, artifact.url)
    assert.deepEqual(received, options)
    return new Response(bytes)
  })
  await consume(await recorder.fetchImpl(artifact.url, options))
  assert.deepEqual(recorder.records, [{ url: artifact.url, status: 200, bytes: bytes.length, sha256: sha(bytes) }])
  await assert.rejects(recorder.fetchImpl(artifact.url, options), /more than once/)
  await assert.rejects(recorder.fetchImpl('https://files.example.test/other-platform.whl', options), /outside the selected/)
  assert.equal(requests, 1)
})

test('download recorder fails closed on wrong bytes, hashes, redirected responses and credentials', async () => {
  const artifact = toyArtifact()
  for (const [bytes, message] of [[Buffer.from('short'), /wrong byte count/],
    [Buffer.from('toy-wheek'), /wrong SHA-256/], [Buffer.from('toy-wheel-extra'), /exceeded/]]) {
    const recorder = createDownloadRecorder([artifact], async () => new Response(bytes))
    await assert.rejects(consume(await recorder.fetchImpl(artifact.url, options)), message)
  }
  const redirected = createDownloadRecorder([artifact], async () => ({ ok: true, body: [], url: 'https://other.example.test/toy.whl' }))
  await assert.rejects(redirected.fetchImpl(artifact.url, options), /changed origin or path/)
  const noFetch = createDownloadRecorder([artifact], () => assert.fail('Invalid download options must fail before fetch'))
  await assert.rejects(noFetch.fetchImpl(artifact.url, { ...options, redirect: 'follow' }), /reject download redirects/)
  await assert.rejects(noFetch.fetchImpl(artifact.url, { ...options, credentials: 'include' }), /omit credentials/)
})

test('release verification flags select downloadable or offline mode exclusively', async () => {
  const checker = await fs.readFile(path.resolve(import.meta.dirname, '../scripts/check-release-packages.js'), 'utf8')
  const parsing = checker.slice(checker.indexOf('const [mode, directoryArgument,'), checker.indexOf('const npmVersion = runNpm'))
  assert.ok(parsing.includes('--require-downloadable-node'))
  const check = (args) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `function usage() { throw new Error('invalid flags') }; const path = await import('node:path');
     process.argv = ['node', 'checker', ...${JSON.stringify(args)}]; ${parsing}
     console.log(JSON.stringify({requireNodeBundle, requireDownloadableNode}));`], { encoding: 'utf8' })
  for (const [flag, result] of [['--require-downloadable-node', { requireNodeBundle: false, requireDownloadableNode: true }],
    ['--require-node-bundle', { requireNodeBundle: true, requireDownloadableNode: false }]]) {
    const accepted = check(['verify', 'candidate', flag])
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.deepEqual(JSON.parse(accepted.stdout), result)
  }
  for (const args of [['verify', 'candidate', '--require-node-bundle', '--require-downloadable-node'],
    ['pack', 'candidate', '--require-downloadable-node'], ['verify', 'candidate', '--require-downloadable-node', 'extra']]) {
    assert.notEqual(check(args).status, 0)
  }
})

test('the complete release checker loads its verification helpers before rejecting invalid arguments', () => {
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/check-release-packages.js'), 'invalid-mode'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Usage: check-release-packages/)
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
})
