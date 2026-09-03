import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('Windows ESM SUBST imports canonicalize only the default product root, not supplied paths or bundle junctions', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async (t) => {
  const base = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(path.join(base, 'ps-esm-alias-'))
  t.after(async () => {
    assert.equal(path.dirname(root), base)
    assert.ok(path.basename(root).startsWith('ps-esm-alias-'))
    assert.equal(await fs.realpath(root), root)
    await fs.rm(root, { recursive: true, force: true })
  })
  const product = path.join(root, 'product')
  const moduleDirectory = path.join(product, 'src/physical')
  const bundle = path.join(product, 'node-bundle')
  await fs.mkdir(moduleDirectory, { recursive: true })
  await fs.mkdir(path.join(bundle, 'manifests'), { recursive: true })
  await fs.mkdir(path.join(bundle, 'wheels'))
  for (const name of ['node-installation.js', 'node-bundle.js']) {
    await fs.copyFile(fileURLToPath(new URL(`../src/physical/${name}`, import.meta.url)), path.join(moduleDirectory, name))
  }
  await fs.writeFile(path.join(product, 'package.json'), JSON.stringify({ type: 'module', physicalsystemsNodeBundle: 'node-bundle' }))
  const sha = (value) => createHash('sha256').update(value).digest('hex')
  const artifacts = ['physicalsystems-node', 'tinyedge-runtime'].map((name) => {
    const version = name === 'physicalsystems-node' ? '0.2.1' : '0.2.0'
    const filename = `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`
    return { name, version, filename, sha256: sha(name), bytes: Buffer.byteLength(name), url: `https://files.example.test/${filename}` }
  })
  for (const artifact of artifacts) await fs.writeFile(path.join(bundle, 'wheels', artifact.filename), artifact.name)
  const manifest = { contractVersion: 'physicalsystems-node-install-v1', release: '0.2.1', distribution: 'physicalsystems-node',
    runtimeVersion: '0.2.0', platform: `${process.platform}-${process.arch}`, python: '3.12', artifacts }
  const manifestBytes = JSON.stringify(manifest)
  await fs.writeFile(path.join(bundle, 'manifests/release.json'), manifestBytes)
  await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({ contractVersion: 'physicalsystems-node-bundle-v1',
    releases: [{ platform: manifest.platform, python: manifest.python, manifest: 'release.json', sha256: sha(manifestBytes) }] }))

  let drive
  const mappings = execFileSync('subst', [], { encoding: 'utf8' }).toUpperCase()
  for (const letter of 'QPONM') {
    if (mappings.includes(`${letter}:\\:`)) continue
    try { await fs.lstat(`${letter}:\\`) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      drive = `${letter}:`; break
    }
  }
  assert.ok(drive, 'A free drive letter is required for the product ESM alias regression')
  execFileSync('subst', [drive, root])
  try {
    const code = `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [alias, native] = process.argv.slice(1);
      assert.notEqual(alias, await fs.realpath(alias));
      const moduleUrl = pathToFileURL(path.join(alias, 'src/physical/node-installation.js'));
      const { bundledNodeRelease } = await import(moduleUrl);
      const options = { env: {}, run: async () => JSON.stringify({ version: '3.12', implementation: 'CPython', executable: path.join(native, 'not-run-python.exe') }) };
      const loaded = await bundledNodeRelease(options);
      assert.equal(loaded.manifest.release, '0.2.1');
      assert.equal(loaded.wheelhouse, path.join(native, 'node-bundle/wheels'));
      assert.equal((await bundledNodeRelease({ ...options, packageDirectory: native })).digest, loaded.digest);
      await assert.rejects(bundledNodeRelease({ ...options, packageDirectory: alias }), /links or junctions/);
      for (const relative of ['node-bundle', 'node-bundle/manifests', 'node-bundle/wheels']) {
        const original = path.join(native, relative), displaced = original + '-original';
        await fs.rename(original, displaced);
        let linked = false;
        try {
          await fs.symlink(displaced, original, 'junction'); linked = true;
          await assert.rejects(bundledNodeRelease(options), /links or junctions/);
        } finally {
          if (linked) await fs.unlink(original);
          await fs.rename(displaced, original);
        }
      }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, path.join(`${drive}\\`, 'product'), product], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  } finally {
    // Remove only the mapping this test created; never touch a changed drive.
    const expected = `${drive}\\: => ${root}`.toLowerCase()
    assert.ok(execFileSync('subst', [], { encoding: 'utf8' }).trim().split(/\r?\n/).some((line) => line.trim().toLowerCase() === expected))
    execFileSync('subst', [drive, '/D'])
    await assert.rejects(fs.lstat(`${drive}\\`), { code: 'ENOENT' })
  }
})
