// SPDX-License-Identifier: Apache-2.0
// Development evidence only; this is not an installer or release approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyElectronArtifactNotices } from './dependency-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const dependencies = Object.entries(lock.packages).filter(([relative]) => relative).sort(([a], [b]) => a.localeCompare(b));
const auditFile = path.join(root, 'DEPENDENCY-AUDIT.json');
const blockers = [
  { component: '@electron-internal/extract-zip@1.0.5', role: 'development-installation-tooling',
    issue: 'No named license file ships in the npm artifact. Redistribution of this tooling or its native binaries requires complete copyright/license evidence and review of the embedded dependency closure. The desktop application does not import it; a future candidate must demonstrate whether it is excluded.',
    sourceCommit: 'b83e459fd04c53b0a1c8438a6792df8f64be47fc', sourceRepository: 'https://github.com/electron/extract-zip' },
  { component: 'electron@44.2.0', role: 'desktop-runtime',
    issue: 'The installed Linux x64 artifact notices are hash-recorded, not a complete qualified installer inventory. Review the exact candidate binary/native notices and platform distribution before creating any installer.' },
];
if (process.argv.includes('--write')) {
  const components = [];
  await mkdir(path.join(root, 'licenses/npm'), { recursive: true });
  for (const [relative, entry] of dependencies) {
    assert.match(relative, /^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
    const installed = path.join(root, relative);
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, entry.version);
    const named = (await readdir(installed)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name)).sort();
    const licenses = [];
    for (const name of named) {
      const bytes = await readFile(path.join(installed, name));
      const output = `licenses/npm/${manifest.name.replaceAll('/', '__').replace('@', '')}-${manifest.version}-${name}`;
      await writeFile(path.join(root, output), bytes);
      licenses.push({ sourceFile: name, collectedFile: output, bytes: bytes.length, sha256: hash(bytes) });
    }
    components.push({ name: manifest.name, version: entry.version, license: entry.license, resolved: entry.resolved, integrity: entry.integrity,
      licenseEvidence: licenses.length ? 'named-files-collected' : 'missing-named-license-file', licenses });
  }
  const electronArtifactNotices = [];
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const bytes = await readFile(path.join(root, 'node_modules/electron/dist', name));
    electronArtifactNotices.push({ sourceFile: `electron/dist/${name}`, bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(auditFile, `${JSON.stringify({ schemaVersion: 1, scope: 'private-desktop-development-tooling', redistributionApproved: false,
    components, electronArtifactNotices, blockers }, null, 2)}\n`);
}
const audit = JSON.parse(await readFile(auditFile, 'utf8'));
assert.equal(audit.redistributionApproved, false);
assert.deepEqual(audit.blockers, blockers, 'Dependency roles and remaining redistribution findings must match the reviewed scope');
assert.deepEqual(audit.components.map(({ name, version, license, resolved, integrity }) => ({ name, version, license, resolved, integrity })),
  dependencies.map(([relative, { version, license, resolved, integrity }]) => ({ name: relative.replace(/^node_modules\//, ''), version, license, resolved, integrity })));
for (const component of audit.components) {
  for (const license of component.licenses) {
    assert.match(license.collectedFile, /^licenses\/npm\/[a-zA-Z0-9_.-]+$/);
    const bytes = await readFile(path.join(root, license.collectedFile));
    assert.equal(bytes.length, license.bytes); assert.equal(hash(bytes), license.sha256);
  }
}
console.log(`Verified ${audit.components.length} pinned desktop development dependencies and collected license files; redistribution remains unapproved.`);
if (process.argv.includes('--check-installed') || process.argv.includes('--write')) {
  await verifyElectronArtifactNotices(root, audit.electronArtifactNotices);
  console.log('Verified both recorded notice hashes against the installed Electron artifact. This is not a shipped-binary inventory or installer approval.');
}
