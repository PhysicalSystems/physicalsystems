// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyElectronArtifactNotices(root, notices) {
  assert.deepEqual(notices.map(({ sourceFile }) => sourceFile), [
    'electron/dist/LICENSE', 'electron/dist/LICENSES.chromium.html',
  ], 'The recorded Electron notice inventory must contain both expected files');
  for (const notice of notices) {
    const bytes = await readFile(path.join(root, 'node_modules', notice.sourceFile));
    assert.equal(bytes.length, notice.bytes, `${notice.sourceFile}: byte count changed`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), notice.sha256,
      `${notice.sourceFile}: content hash changed`);
  }
}
