# Upstream provenance

`@tinyedge/pi-runtime@0.84.2-tinyedge.1` is a compatibility package of the
published `@earendil-works/pi-coding-agent@0.84.2` artifact. TinyEdge does not
claim authorship of the upstream Pi payload.

## Audited input

- npm package: `@earendil-works/pi-coding-agent@0.84.2`
- npm tarball: <https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz>
- npm SHA-512 integrity: `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`
- npm SHA-1 shasum: `e4d4c1e769963c816959f5cea02a0a10ccc0495a`
- npm `gitHead`: `914cf1472e715297caa30db4b9535d534a9eb718`
- upstream tag: <https://github.com/earendil-works/pi/tree/v0.84.2>
- pinned source commit: <https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718>
- npm provenance endpoint: <https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-coding-agent@0.84.2>

The registry integrity and tag commit were independently checked before the
payload was imported. Every retained upstream artifact file except
`package.json`, `npm-shrinkwrap.json`, and the package-facing `README.md` is
byte-for-byte identical to the npm artifact. The original README is preserved
unchanged as `UPSTREAM_README.md` (SHA-256
`ce0f95c3d314dcacb5f2388b956880a86736ede3c383fd1f8e91bf9056aa134d`).
The non-runtime `examples` tree is deliberately excluded because it
contains an unrelated compiled Doom WASM example; it is not imported by the
SDK or Harness runtime.

## Compatibility-package changes

Changes are limited to package identity, dependency installation behavior,
non-runtime export contents, and verification metadata; retained runtime
JavaScript and declarations are not modified:

- rename the package to `@tinyedge/pi-runtime` and use version
  `0.84.2-tinyedge.1`;
- remove the `pi` executable declaration so this package cannot shadow a
  user's Pi or TinyEdge command;
- pin the five Pi workspace dependencies to exactly `0.84.2`;
- make `@mariozechner/clipboard@0.3.9` and
  `@silvia-odwyer/photon-node@0.3.4` optional peer dependencies instead of
  default-installed dependencies;
- replace source-build publish scripts, which are not part of the npm
  artifact, with the offline package verifier;
- remove upstream source-build/test dev dependencies because this package is
  an imported built artifact and its verifier uses only Node.js built-ins;
- derive `npm-shrinkwrap.json` mechanically from the verified upstream lock,
  removing only clipboard, clipboard-platform, and Photon nodes while keeping
  every retained version and registry artifact unchanged;
- add independently verified npm SHA-512 integrity fields to the six retained
  Pi workspace artifacts whose upstream lock omitted them;
- retain upstream source maps in the public source tree for auditability, but
  exclude them from the npm artifact because they are not required at runtime;
- exclude the non-runtime examples tree and its compiled WASM artifact;
- omit upstream documentation screenshots/mascot artwork and the optional
  `clankolas.png` announcement image because the npm artifact does not carry a
  self-contained license chain for those nonessential assets; they are absent
  from both this source export and the npm artifact (the component already
  falls back to text when the image is absent);
- replace the package-facing README with an accurate compatibility-runtime
  explanation while preserving the upstream README unchanged;
- point repository metadata at the compatibility-package source; and
- add this provenance record, the authoritative upstream MIT license, exact
  notices for retained vendored JavaScript, and the verifier.

The upstream runtime already treats both native capabilities as optional:
`dist/utils/clipboard-native.js` catches an unavailable clipboard module, and
`dist/utils/photon.js` returns `null` when Photon cannot be imported. The SDK
and text-first runtime therefore import without either peer installed.
Photon-dependent conversion and native-addon clipboard reads/image access stay
unavailable unless a consumer deliberately supplies the corresponding peer;
clipboard copy can still use Pi's OS/terminal fallbacks.

The upstream Pi payload is provided under the accompanying MIT license,
Copyright (c) 2025 Mario Zechner. Dependencies retain their own licenses.

## Retained vendored JavaScript

Pi's HTML-export runtime reads these files directly, so they remain in the
audited payload with their full licenses in `THIRD_PARTY_NOTICES.md`:

- Highlight.js 11.9.0, tag commit
  `15d3b627fa7c99cb98d7b6760a6fbdbfd519d1a0`, payload SHA-256
  `837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846`;
- marked 18.0.5, tag commit
  `4063c638cb621c09091d41b26f323ff074416bb9`, payload SHA-256
  `d5487edc7258b404bfa74c393d74a6393155f02517bd5e7e77cd64f8187f39a0`.

`dist/utils/ansi.js` also retains its complete inline MIT notice for portions
derived from `ansi-regex` and `strip-ansi`; that notice is duplicated in
`THIRD_PARTY_NOTICES.md` for package-level discovery.

The retained package contains no `.wasm`, `.node`, executable/shared-library,
or font files.
