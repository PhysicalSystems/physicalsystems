# Dependency and SBOM policy

The Physical Systems npm release candidate is dependency-locked and reviewed offline.
The executable inventory lives in `scripts/legal/reviewed-inventory.mjs`; the
generated CycloneDX 1.6 documents are:

- `SBOM.cdx.json`
- `packages/pi-runtime/SBOM.cdx.json`
- `packages/cli/SBOM.cdx.json`

Run `npm run generate:sbom` only when intentionally regenerating those files,
then review the diff. `npm run check:legal` reproduces all three documents without
network access and rejects any drift.

## Current default-install closure

The Pi compatibility runtime has 127 locked dependency artifacts. The
`physicalsystems` package adds the runtime itself for 128 locked dependency records.
Every installed record has an exact version, registry URL, SRI integrity, and
one of these reviewed license identifiers:

`physicalsystems` physically bundles this complete reviewed closure. This is a
correctness boundary, not an optimization: npm 12 ignores a dependency
package's shrinkwrap, so relying on the shrinkwrap alone can resolve a
different graph. Release verification installs only the packed `physicalsystems`
tarball in offline mode with empty caches under npm 11.19.0 and npm 12.0.2 on
Windows x64, Windows ARM64, and Ubuntu 22.04/24.04 desktop x64, then compares every
installed name/version identity with the reviewed lock.

| License | Runtime artifacts |
| --- | ---: |
| MIT | 57 |
| Apache-2.0 | 44 |
| BSD-3-Clause | 13 |
| ISC | 7 |
| BlueOak-1.0.0 | 5 |
| 0BSD | 1 |

The SBOM also records four reviewed vendored components and the exact hashes
of the two macOS and two Windows native console helpers distributed by
`@earendil-works/pi-tui@0.84.2`.

`@mariozechner/clipboard@0.3.9` and
`@silvia-odwyer/photon-node@0.3.4` are optional peers. They are recorded as
excluded metadata, are not dependency edges, and must remain absent from the
default install. TinyEdge does not currently distribute or claim support for
their native or WASM payloads.

## Legal-review status

The current automation proves the locked graph, declared license identifiers,
SRI metadata, reviewed vendored-file hashes, native-helper hashes, optional
peer exclusion, and operative legal-file bytes. A complete artifact rescan
found named top-level legal files (including accepted suffix variants) in 116
of the 128 `physicalsystems` dependency records.

Twelve exact artifacts lack a named LICENSE, LICENCE, COPYING, or NOTICE file.
Their version-, URL-, integrity-, license-, evidence-, limitation-, and
owner-approved dispositions are bound into every applicable SBOM and the
byte-exact third-party notice bundle. `data-uri-to-buffer@4.0.1` is one of the
twelve but carries its complete MIT text in its shipped README, leaving eleven
exact artifacts without complete artifact legal text. `ignore@7.0.5` is not an
exception: its artifact contains a 1,095-byte `LICENSE-MIT` whose SHA-256 is
`9c94db23dc4b1e9aaee5d195668b916afc71efed54af226b66cf0ccc4389c1c0`.
Any status, URL, SRI, license, or evidence drift fails closed.

The Clipboard native/Rust chain and Photon WASM/native chain remain excluded
until separately audited; neither is a default install edge.

The weakest record, `xml-naming@0.1.0`, has no npm `gitHead`, tag, release, or
attestation and was published before its matching public commit. Its four-file
tarball nevertheless maps byte-for-byte to that immutable commit and reproduced
exactly with the recorded toolchain. The SBOM preserves both the evidence and
the limitation. Approval applies only to its exact URL and SRI and does not
claim that the candidate source commit originated the publication.

The operative root Apache-2.0 license grants the source license. Physical Systems policy
authorizes the one publishable `physicalsystems` candidate through the protected,
main-only direct OIDC workflow to `preview`. An npm owner may technically
retain interactive 2FA publication capability, but that path is outside the
approved procedure for application code; the reviewed inert namespace
bootstrap is the sole exception. SBOM presence does not independently authorize
publication, promotion, or a repository-visibility change.
