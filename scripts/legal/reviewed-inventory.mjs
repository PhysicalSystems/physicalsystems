/**
 * Reviewed inputs that do not live in npm-shrinkwrap.json.
 *
 * Updating an entry is a legal/security review action. The SBOM generator
 * deliberately has no network fallback: a lockfile, vendored file, optional
 * peer, or native helper that drifts must be reviewed and pinned here first.
 */

export const ALLOWED_LICENSE_IDS = Object.freeze([
  '0BSD',
  'Apache-2.0',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
])

export const APACHE_2_TEMPLATE = Object.freeze({
  path: 'scripts/legal/templates/Apache-2.0.txt',
  sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  status: 'approved-canonical-source',
})

export const NOTICE_TEMPLATE = Object.freeze({
  path: 'scripts/legal/templates/NOTICE.txt',
  sha256: '9b07008e533851eb661dd9c125d5e1712c5131afbade67ce458df93a946042af',
  status: 'approved-canonical-source',
})

export const PI_RUNTIME_NOTICE_TEMPLATE = Object.freeze({
  path: 'scripts/legal/templates/NOTICE.pi-runtime.txt',
  sha256: 'f0fc17213f64b760bea9287d68dba430b84396f4150e450eb86f29281d7883e9',
  status: 'approved-canonical-source',
})

export const THIRD_PARTY_NOTICES_TEMPLATE = Object.freeze({
  path: 'scripts/legal/templates/THIRD_PARTY_NOTICES.md',
  sha256: '228d08065306ad2388f90520a0bb9bf5dd6198f1ffc5d4504446f2c6f4f960c3',
  status: 'approved-canonical-source',
})

export const TRADEMARK_POLICY_TEMPLATE = Object.freeze({
  path: 'scripts/legal/templates/TRADEMARKS.md',
  sha256: '1b4f9a5bd714e31b61d0465bbfe2e46a211e7e9a2843cc04e62e7229b1c9bd04',
  status: 'approved-canonical-source',
})

export const PI_RUNTIME_LICENSE = Object.freeze({
  path: 'packages/pi-runtime/LICENSE',
  sha256: '4f6a1985796db5225e3b1e59972bd47e07a27a0748427cb3d3c8fbf39f9311f0',
  status: 'reviewed-upstream-mit',
})

export const ARTIFACT_LICENSE_FILE_EVIDENCE = Object.freeze([
  Object.freeze({
    name: 'ignore',
    version: '7.0.5',
    resolved: 'https://registry.npmjs.org/ignore/-/ignore-7.0.5.tgz',
    integrity: 'sha512-Hs59xBNfUIunMFgWAbGX5cq6893IbWg4KnrjbYwX3tx0ztorVgTDA6B2sxf8ejHJ4wz8BqGUMYlnzNBer5NvGg==',
    declaredLicense: 'MIT',
    artifactLegalFile: 'LICENSE-MIT',
    artifactLegalFileSize: 1095,
    artifactLegalFileSha256: '9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0',
    attribution: 'Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors',
    status: 'verified-artifact-contained',
  }),
])

export const EXCLUDED_PI_HOST_PEER = Object.freeze({
  name: '@earendil-works/pi-coding-agent',
  version: '0.84.2',
  licenseIds: Object.freeze(['MIT']),
  resolved: 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz',
  integrity: 'sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==',
  reason: 'Existing-Pi host is an optional peer and is not installed by the TinyEdge Pi add-on; a user-provided host has its own separately disclosed dependency closure.',
})

const approvedMissingLegalFileOverride = (record) => Object.freeze({
  ...record,
  missingArtifactLegalFiles: Object.freeze(['LICENSE', 'NOTICE', 'COPYING']),
  status: 'approved',
})

/**
 * Exact SRI-verified npm artifacts whose tarballs contain no top-level file
 * named LICENSE, NOTICE, or COPYING (including suffix variants). The owner
 * approved these twelve exact records with their documented limitations for
 * the source-license cutover. Approval does not carry to any future bytes.
 */
export const MISSING_LICENSE_FILE_OVERRIDES = Object.freeze([
  approvedMissingLegalFileOverride({
    name: '@aws-sdk/credential-provider-http',
    version: '3.972.39',
    resolved: 'https://registry.npmjs.org/@aws-sdk/credential-provider-http/-/credential-provider-http-3.972.39.tgz',
    integrity: 'sha512-pIgTpisWyWg7X1bUbzSjuUYosYTD0Ghz2M0hkSTmb3a6i3qV3uU+NYJPI/E2XSC0HcsZh5rsLPzeXrkb2DS0Cg==',
    declaredLicense: 'Apache-2.0',
    sourceRepository: 'https://github.com/aws/aws-sdk-js-v3',
    sourceDirectory: 'packages-internal/credential-provider-http',
    sourceCommit: null,
    evidence: 'Exact SRI-verified artifact package.json declares Apache-2.0; npm metadata supplies no gitHead; artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'Artifact-declaration-only: npm supplies no gitHead or exact source commit.',
    approvedDisposition: 'accepted-exact-sri-artifact-declaration-only',
    overrideRequirement: 'Pin name, version, resolved URL, SRI, and Apache-2.0 declaration. Supply canonical Apache-2.0 text. Record that provenance is artifact-declaration-only.',
  }),
  approvedMissingLegalFileOverride({
    name: '@aws-sdk/credential-provider-login',
    version: '3.972.41',
    resolved: 'https://registry.npmjs.org/@aws-sdk/credential-provider-login/-/credential-provider-login-3.972.41.tgz',
    integrity: 'sha512-0LBitxXiAiaE5nlFPfpNIww/8FRY/I7WIndWsc9GmNFOM7cE1wNpVNQEGEk9Outg5l8xl+3vybxFyUy4l9q/LQ==',
    declaredLicense: 'Apache-2.0',
    sourceRepository: 'https://github.com/aws/aws-sdk-js-v3',
    sourceDirectory: 'packages-internal/credential-provider-login',
    sourceCommit: null,
    evidence: 'Exact SRI-verified artifact package.json declares Apache-2.0; npm metadata supplies no gitHead; artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'Artifact-declaration-only: npm supplies no gitHead or exact source commit.',
    approvedDisposition: 'accepted-exact-sri-artifact-declaration-only',
    overrideRequirement: 'Pin name, version, resolved URL, SRI, and Apache-2.0 declaration. Supply canonical Apache-2.0 text. Record that provenance is artifact-declaration-only.',
  }),
  approvedMissingLegalFileOverride({
    name: '@aws-sdk/nested-clients',
    version: '3.997.9',
    resolved: 'https://registry.npmjs.org/@aws-sdk/nested-clients/-/nested-clients-3.997.9.tgz',
    integrity: 'sha512-jPR3rnmRI4hWYyzfmTGBr7NblMp8QYYeflHXba1H6+7CGrWVqWKQzaXFQ4qbExqPRsXN3T3L3JxFhr6aouXUGQ==',
    declaredLicense: 'Apache-2.0',
    sourceRepository: 'https://github.com/aws/aws-sdk-js-v3',
    sourceDirectory: 'packages/nested-clients',
    sourceCommit: null,
    evidence: 'Exact SRI-verified artifact package.json declares Apache-2.0; npm metadata supplies no gitHead; artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'Artifact-declaration-only: npm supplies no gitHead or exact source commit.',
    approvedDisposition: 'accepted-exact-sri-artifact-declaration-only',
    overrideRequirement: 'Pin name, version, resolved URL, SRI, and Apache-2.0 declaration. Supply canonical Apache-2.0 text. Record that provenance is artifact-declaration-only.',
  }),
  ...[
    ['@earendil-works/pi-agent-core', 'packages/agent', 'sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA=='],
    ['@earendil-works/pi-ai', 'packages/ai', 'sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig=='],
    ['@earendil-works/pi-client', 'packages/client', 'sha512-/RFSPhD/bZbpOp1oJj+UneSUFSgZhWxzcSENUY+8+8xhoBrWXMYI2t77XNx4Yf+c8YK2qTHquForhNcelYpXvg=='],
    ['@earendil-works/pi-protocol', 'packages/protocol', 'sha512-jbBh03fkeckWEroHpcZBr4w5/Ibat8WwdXFlXHivYQImrQNFtLpDeL0t1cku4hmK0q3pceIRQHkw4fwbM4YILQ=='],
    ['@earendil-works/pi-telemetry', 'packages/telemetry', 'sha512-wg5caea7uIv1BHRBm2Y116RvFG4oSAiP5qk9tA2463PDGIr4K8M1Ceyyg5DOpF/shUUl0gk826yQJAeAcHYB9g=='],
    ['@earendil-works/pi-tui', 'packages/tui', 'sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg=='],
  ].map(([name, sourceDirectory, integrity]) => approvedMissingLegalFileOverride({
    name,
    version: '0.84.2',
    resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf('/') + 1)}-0.84.2.tgz`,
    integrity,
    declaredLicense: 'MIT',
    sourceRepository: 'https://github.com/earendil-works/pi',
    sourceDirectory,
    sourceCommit: '914cf1472e715297caa30db4b9535d534a9eb718',
    licenseEvidenceUrl: 'https://raw.githubusercontent.com/earendil-works/pi/914cf1472e715297caa30db4b9535d534a9eb718/LICENSE',
    licenseEvidenceSha256: '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48',
    attribution: 'Copyright (c) 2025 Mario Zechner',
    evidence: 'Exact SRI and audited Pi source commit identify a root MIT license, while the leaf npm artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'The leaf artifact omits its legal file; the approved exception relies on the exact SRI and audited Pi release source commit.',
    approvedDisposition: 'accepted-exact-sri-and-reviewed-source-license',
    ...(name === '@earendil-works/pi-tui'
      ? { additionalRequirement: 'Inventory and hash its four embedded native binaries separately in the SBOM.' }
      : {}),
  })),
  approvedMissingLegalFileOverride({
    name: '@nodable/entities',
    version: '2.1.0',
    resolved: 'https://registry.npmjs.org/@nodable/entities/-/entities-2.1.0.tgz',
    integrity: 'sha512-nyT7T3nbMyBI/lvr6L5TyWbFJAI9FTgVRakNoBqCD+PmID8DzFrrNdLLtHMwMszOtqZa8PAOV24ZqDnQrhQINA==',
    declaredLicense: 'MIT',
    sourceRepository: 'https://github.com/nodable/val-parsers',
    sourceCommit: 'f1c61a65e7b967c17b13822ef71e91bd25f17ce2',
    licenseEvidenceUrl: 'https://raw.githubusercontent.com/nodable/val-parsers/f1c61a65e7b967c17b13822ef71e91bd25f17ce2/LICENSE',
    licenseEvidenceSha256: '750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40',
    attribution: 'Copyright (c) 2026 Nodable',
    evidence: 'Exact SRI and npm gitHead bind the artifact to the reviewed source license, while the artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'The npm artifact omits its legal file; the approved exception relies on exact SRI and gitHead-bound source evidence.',
    approvedDisposition: 'accepted-exact-sri-and-githead-source-license',
  }),
  approvedMissingLegalFileOverride({
    name: 'data-uri-to-buffer',
    version: '4.0.1',
    resolved: 'https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz',
    integrity: 'sha512-0R9ikRb668HB7QDxT1vkpuUBtqc53YyAwMwGeUFKRojY/NWKvdZ+9UYtRfGmhqNbRkTSVpMbmyhXipFFv2cb/A==',
    declaredLicense: 'MIT',
    sourceRepository: 'https://github.com/TooTallNate/node-data-uri-to-buffer',
    sourceCommit: '85cd8c854aefbf1bb636789d80364cfac8ea1583',
    licenseEvidenceUrl: 'https://raw.githubusercontent.com/TooTallNate/node-data-uri-to-buffer/85cd8c854aefbf1bb636789d80364cfac8ea1583/README.md',
    licenseEvidenceSha256: 'a7cc4332acfa1f9b6530e01aac77fefe74f2efa32579215fddaa473013f9a25c',
    licenseEvidenceSection: 'License',
    attribution: 'Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>',
    evidence: 'Exact SRI and npm gitHead bind the artifact to the reviewed README License section, while the artifact contains no LICENSE, NOTICE, or COPYING file.',
    provenanceLimitation: 'The complete MIT text is in the artifact README rather than a standalone named legal file; the source binding relies on exact SRI and gitHead evidence.',
    approvedDisposition: 'accepted-exact-sri-artifact-readme-license',
  }),
  approvedMissingLegalFileOverride({
    name: 'xml-naming',
    version: '0.1.0',
    resolved: 'https://registry.npmjs.org/xml-naming/-/xml-naming-0.1.0.tgz',
    integrity: 'sha512-k8KO9hrMyNk6tUWqUfkTEZbezRRpONVOzUTnc97VnCvyj6Tf9lyUR9EDAIeiVLv56jsMcoXEwjW8Kv5yPY52lw==',
    artifactSize: 5296,
    artifactSha1: '8ab7106c5b8d23caa2fabac1cadf17136379fbd8',
    artifactSha256: '19347cbcba429e9f240427ce4e5998efe30a47cb9131b5673fc2f0441f7f4f57',
    npmSignatureKeyId: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    declaredLicense: 'MIT',
    sourceRepository: 'https://github.com/NaturalIntelligence/xml-naming',
    sourceCommit: null,
    candidateSourceCommit: 'c0afc395948730bed124859d7fc7cccabe0aac8a',
    candidateSourceTree: '9fcc44b7a4f91491253abb0f04e42ab7ac9c9b96',
    candidateCommitDate: '2026-05-08T08:31:21Z',
    registryPublishDate: '2026-05-08T06:20:54.228Z',
    licenseEvidenceUrl: 'https://raw.githubusercontent.com/NaturalIntelligence/xml-naming/c0afc395948730bed124859d7fc7cccabe0aac8a/LICENSE',
    licenseEvidenceSha256: '8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07',
    sourceLicenseFileSha256: '1099276bd000593846eef6e62ff71f1faf659625765cf8009d2a647f2714ed8b',
    attribution: 'Copyright (c) 2026 Natural Intelligence',
    evidence: 'The registry-signed, SRI-verified four-file artifact maps byte-for-byte to the immutable candidate commit and reproduces exactly with official Node 22.14.0 plus npm 11.11.0; package.json and README declare MIT and the source tree carries the Natural Intelligence MIT notice.',
    provenanceLimitation: 'UNATTESTED SOURCE BINDING: npm supplies no gitHead or attestation, there is no tag/release, and registry publication preceded the unsigned candidate commit by about 2 hours 10 minutes. Exact byte mapping and reproducibility do not prove the source commit originated the publication.',
    provenanceStrength: 'reproducible-exact-bytes-unattested',
    reproduciblePackToolchain: 'Node 22.14.0 (official distribution) + npm 11.11.0',
    reproduciblePackResult: 'candidate commit export with LICENSE omitted reproduced the registry tgz byte-for-byte',
    shippedFileCount: 4,
    shippedFilesSha256: Object.freeze({
      'README.md': 'fbb211d0da0ae219c4f7a91c6be497c126fa0c30707181c2e509c25f9471fc5b',
      'package.json': 'b69775b228da8fb7f25c98f309bab65a3a27444a2fd6b96f6793ece74be1acdc',
      'src/index.d.ts': '68eda263d66e01c28bb2a5dd84784ade8d7bf2a7a6f2ee6e7b7fb0251840e2cf',
      'src/index.js': 'ebdaa8d1ac41dbb15c842b0dcb091adb9c13e4a76f33b1537fcddfafb674cf11',
    }),
    approvedDisposition: 'accepted-exact-sri-reproducible-byte-map-without-source-attestation',
    overrideRequirement: 'Owner approval must name this exact URL and SRI, preserve the Natural Intelligence MIT notice, and acknowledge the publish-before-commit/no-gitHead/no-attestation limitation. Reject any byte drift.',
  }),
])

export const TARGETS = Object.freeze({
  'pi-runtime': Object.freeze({
    key: 'pi-runtime',
    shrinkwrapPath: 'packages/pi-runtime/npm-shrinkwrap.json',
    outputPath: 'packages/pi-runtime/SBOM.cdx.json',
    shrinkwrapSha256: 'dede15b51ca4af8d1685cfe228e1d9fea224227a7bd04d92a72e55eb732b19c6',
    rootName: '@tinyedge/pi-runtime',
    rootVersion: '0.84.2-tinyedge.1',
    rootLicense: 'MIT',
    dependencyNodeCount: 127,
    runtimePackagePath: '',
  }),
  cli: Object.freeze({
    key: 'cli',
    shrinkwrapPath: 'packages/cli/npm-shrinkwrap.json',
    outputPath: 'packages/cli/SBOM.cdx.json',
    shrinkwrapSha256: '900c79f53e5e318691012a8875b8b5d0d57a8731737c7dd4c52f408b89114ee7',
    rootName: '@tinyedge/cli',
    rootVersion: '0.1.3',
    // Source and package-manifest approval are complete; public availability
    // remains gated by the protected stage-only release workflow and npm 2FA.
    rootLicense: 'Apache-2.0',
    dependencyNodeCount: 128,
    runtimePackagePath: 'node_modules/@tinyedge/pi-runtime',
  }),
})

export const WRAPPER_TARGETS = Object.freeze({
  npx: Object.freeze({
    key: 'npx',
    packageJsonPath: 'packages/npx/package.json',
    outputPath: 'packages/npx/SBOM.cdx.json',
    rootName: 'tinyedge',
    rootVersion: '0.1.3',
    rootLicense: 'Apache-2.0',
    cliVersion: '0.1.3',
  }),
  pi: Object.freeze({
    key: 'pi',
    packageJsonPath: 'packages/pi/package.json',
    outputPath: 'packages/pi/SBOM.cdx.json',
    rootName: '@tinyedge/pi',
    rootVersion: '0.1.3',
    rootLicense: 'Apache-2.0',
    cliVersion: '0.1.3',
    excludedOptionalPeer: EXCLUDED_PI_HOST_PEER,
  }),
})

export const WORKSPACE_TARGET = Object.freeze({
  key: 'workspace',
  packageJsonPath: 'package.json',
  outputPath: 'SBOM.cdx.json',
  rootName: 'tinyedge-edge-workspace',
  rootVersion: '0.0.0',
  rootLicense: 'Apache-2.0',
  packageRoots: Object.freeze([
    Object.freeze({ name: 'tinyedge', version: '0.1.3', license: 'Apache-2.0', packageJsonPath: 'packages/npx/package.json' }),
    Object.freeze({ name: '@tinyedge/pi', version: '0.1.3', license: 'Apache-2.0', packageJsonPath: 'packages/pi/package.json' }),
    Object.freeze({ name: '@tinyedge/cli', version: '0.1.3', license: 'Apache-2.0', packageJsonPath: 'packages/cli/package.json' }),
    Object.freeze({ name: '@tinyedge/pi-runtime', version: '0.84.2-tinyedge.1', license: 'MIT', packageJsonPath: 'packages/pi-runtime/package.json' }),
  ]),
})

export const SBOM_TARGET_KEYS = Object.freeze([
  ...Object.keys(TARGETS),
  ...Object.keys(WRAPPER_TARGETS),
  WORKSPACE_TARGET.key,
])

export const PI_TUI_ARTIFACT = Object.freeze({
  packagePath: 'node_modules/@earendil-works/pi-tui',
  name: '@earendil-works/pi-tui',
  version: '0.84.2',
  licenseIds: Object.freeze(['MIT']),
  resolved: 'https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.2.tgz',
  integrity: 'sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg==',
})

export const PI_TUI_NATIVE_FILES = Object.freeze([
  Object.freeze({
    name: 'darwin-modifiers.node',
    version: '0.84.2',
    archivePath: 'package/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
    os: 'darwin',
    arch: 'arm64',
    size: 50200,
    sha256: '7657cd6bd999227b5c8ed17a4c78eb50fa414835295636fddef6ec1567623a07',
  }),
  Object.freeze({
    name: 'darwin-modifiers.node',
    version: '0.84.2',
    archivePath: 'package/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node',
    os: 'darwin',
    arch: 'x64',
    size: 12776,
    sha256: '0e51e550acf559bf33bdbbdf047f69168b64694f46d27cb4195928b26be0ca0b',
  }),
  Object.freeze({
    name: 'win32-console-mode.node',
    version: '0.84.2',
    archivePath: 'package/native/win32/prebuilds/win32-arm64/win32-console-mode.node',
    os: 'win32',
    arch: 'arm64',
    size: 4096,
    sha256: '5bc2f926c6a663df6c8b70d3387cab72a9387172e27eb598e93b490d96a5074e',
  }),
  Object.freeze({
    name: 'win32-console-mode.node',
    version: '0.84.2',
    archivePath: 'package/native/win32/prebuilds/win32-x64/win32-console-mode.node',
    os: 'win32',
    arch: 'x64',
    size: 4608,
    sha256: 'e40df72050ed02d451dee887b2e2a7408d7de27c5f483af8c489801bb3ae098d',
  }),
])

const PI_SOURCE_COMMIT = '914cf1472e715297caa30db4b9535d534a9eb718'

export const VENDORED_COMPONENTS = Object.freeze([
  Object.freeze({
    key: 'ansi-regex',
    name: 'ansi-regex',
    version: `pi-snapshot-${PI_SOURCE_COMMIT}`,
    purlType: 'generic',
    licenseIds: Object.freeze(['MIT']),
    retainedPath: 'packages/pi-runtime/dist/utils/ansi.js',
    resolved: `https://github.com/earendil-works/pi/blob/${PI_SOURCE_COMMIT}/packages/coding-agent/src/utils/ansi.ts`,
    sha256: '20e9caeb257d1b2bb362adc9caf1bf5c22cccdbcecb43793faece6daff15f19b',
    note: 'Portions are derived from ansi-regex; upstream did not identify an npm release, so the exact Pi source snapshot is the version.',
  }),
  Object.freeze({
    key: 'strip-ansi',
    name: 'strip-ansi',
    version: `pi-snapshot-${PI_SOURCE_COMMIT}`,
    purlType: 'generic',
    licenseIds: Object.freeze(['MIT']),
    retainedPath: 'packages/pi-runtime/dist/utils/ansi.js',
    resolved: `https://github.com/earendil-works/pi/blob/${PI_SOURCE_COMMIT}/packages/coding-agent/src/utils/ansi.ts`,
    sha256: '20e9caeb257d1b2bb362adc9caf1bf5c22cccdbcecb43793faece6daff15f19b',
    note: 'Portions are derived from strip-ansi; upstream did not identify an npm release, so the exact Pi source snapshot is the version.',
  }),
  Object.freeze({
    key: 'highlight.js',
    name: 'highlight.js',
    version: '11.9.0',
    purlType: 'npm',
    purlQualifier: 'repository_url=https://github.com/highlightjs/highlight.js',
    licenseIds: Object.freeze(['BSD-3-Clause']),
    retainedPath: 'packages/pi-runtime/dist/core/export-html/vendor/highlight.min.js',
    resolved: 'https://github.com/highlightjs/highlight.js/tree/15d3b627fa7c99cb98d7b6760a6fbdbfd519d1a0',
    sha256: '837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846',
    note: 'Vendored HTML-export payload; distinct from the installed highlight.js@10.7.3 dependency.',
  }),
  Object.freeze({
    key: 'marked',
    name: 'marked',
    version: '18.0.5',
    purlType: 'npm',
    purlQualifier: 'repository_url=https://github.com/markedjs/marked',
    licenseIds: Object.freeze(['MIT', 'BSD-3-Clause']),
    licenseExpression: 'MIT AND BSD-3-Clause',
    retainedPath: 'packages/pi-runtime/dist/core/export-html/vendor/marked.min.js',
    resolved: 'https://github.com/markedjs/marked/tree/4063c638cb621c09091d41b26f323ff074416bb9',
    sha256: 'd5487edc7258b404bfa74c393d74a6393155f02517bd5e7e77cd64f8187f39a0',
    note: 'Vendored HTML-export payload containing Marked (MIT) and Markdown portions (BSD-3-Clause).',
  }),
])

export const EXCLUDED_OPTIONAL_PEERS = Object.freeze([
  Object.freeze({
    name: '@mariozechner/clipboard',
    version: '0.3.9',
    licenseIds: Object.freeze(['MIT']),
    resolved: 'https://registry.npmjs.org/@mariozechner/clipboard/-/clipboard-0.3.9.tgz',
    integrity: 'sha512-ABnA53mdfkGZwOFUdZNv2S0CWGO/EIuPj8Vv9xmBFmSYg/qFc7ihO6q5FcQjvoE67kZpWkEc4AhD6B/os04yuA==',
    reason: 'Optional peer intentionally excluded from the default dependency graph; consumers must opt in separately.',
  }),
  Object.freeze({
    name: '@silvia-odwyer/photon-node',
    version: '0.3.4',
    licenseIds: Object.freeze(['Apache-2.0']),
    resolved: 'https://registry.npmjs.org/@silvia-odwyer/photon-node/-/photon-node-0.3.4.tgz',
    integrity: 'sha512-bnly4BKB3KDTFxrUIcgCLbaeVVS8lrAkri1pEzskpmxu9MdfGQTy8b8EgcD83ywD3RPMsIulY8xJH5Awa+t9fA==',
    reason: 'Optional peer intentionally excluded from the default dependency graph; consumers must opt in separately.',
    reviewedPayload: Object.freeze({
      path: 'package/photon_rs_bg.wasm',
      size: 1881634,
      sha256: '10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c',
    }),
  }),
])
