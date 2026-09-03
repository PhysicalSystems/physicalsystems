import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const installer = readFileSync(new URL('../scripts/install-unreleased.ps1', import.meta.url), 'utf8')

test('the staged Windows bootstrap pins and verifies every downloaded runtime', () => {
  assert.match(installer, /Staging artifact for the unreleased 0\.1\.2 package set/)
  assert.match(installer, /\$TinyEdgeVersion = '0\.1\.2'/)
  assert.match(installer, /\$MinimumNodeVersion = \[Version\]'22\.19\.0'/)
  assert.match(installer, /\$NodeVersion = '24\.5\.0'/)
  assert.match(installer, /node-v\$NodeVersion-win-\$Architecture\.zip/)
  assert.match(installer, /& \$NodePath -p 'process\.arch'/)
  assert.match(installer, /rawArchitecture\.Trim\(\) -ne \$Architecture/)
  assert.match(installer, /Get-FileHash -LiteralPath \$downloadPath -Algorithm SHA256/)
  assert.match(installer, /checksum mismatch/)
  assert.match(installer, /npmPath install --global --prefix \$packagePrefix "tinyedge@\$TinyEdgeVersion"/)
  assert.match(installer, /\$portableHome = '%LOCALAPPDATA%\\TinyEdge'/)
  assert.doesNotMatch(installer, /WriteAllText\(\$shimPath, \$shim, \[Text\.Encoding\]::ASCII\)[\s\S]*\$escapedNodePath/)
  assert.match(installer, /& \$shimPath --version/)
  assert.match(installer, /This historical unreleased-source installer is Windows-only/)
  assert.match(installer, /npm view physicalsystems@0\.2\.1 version --json/)
  assert.match(installer, /npx --yes physicalsystems@0\.2\.1/)
  assert.doesNotMatch(installer, /Invoke-Expression|\biex\b/)
})
