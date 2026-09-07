// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyElectronArtifactNotices } from '../scripts/dependency-evidence.mjs';

test('installed Electron notice evidence rejects changed, missing and incomplete artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ps-desktop-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'node_modules/electron/dist');
  await mkdir(dir, { recursive: true });
  const notices = [];
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const bytes = Buffer.from(`Synthetic notice: ${name}`);
    await writeFile(path.join(dir, name), bytes);
    notices.push({ sourceFile: `electron/dist/${name}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await verifyElectronArtifactNotices(root, notices);
  await assert.rejects(verifyElectronArtifactNotices(root, notices.slice(0, 1)), /both expected files/);
  await writeFile(path.join(dir, 'LICENSE'), 'X'.repeat(notices[0].bytes));
  await assert.rejects(verifyElectronArtifactNotices(root, notices), /content hash changed/);
  await rm(path.join(dir, 'LICENSE'));
  await assert.rejects(verifyElectronArtifactNotices(root, notices), { code: 'ENOENT' });
});
