# One npm product, modular internals (TIN-407)

This is the 0.2.1 review candidate, not a statement that the bundled product has
been published. Both PR verification and the protected publishing workflow now
prepare one complete product. Existing published 0.2.0 bytes remain unchanged.

## User experience

The proposed npm artifact contains the Harness, its audited Pi dependency
closure, and a `node-bundle/` containing the exact Python wheel closure for
each supported selector. First launch asks for software-installation consent,
creates an isolated user environment, installs the matching included wheels
without any Python registry access, and starts discovery-only Node supervision.

The user does not clone a repository, run pip, or start a second terminal.
Supported CPython with venv/ensurepip is still required. This is not a bundled
Python interpreter and does not install arbitrary hardware drivers. Windows
ARM64 Harness support does not imply an ARM64 backend wheel set exists.

## One preparation command

Use pinned npm 11.19.0 (the command bootstraps the reviewed JS dependency tree
if it is absent; an existing tree is validated during packing):

```text
npm run release:prepare -- --output ABSOLUTE_NEW_ARTIFACT_DIRECTORY
```

`--wheelhouse ABSOLUTE_REVIEWED_WHEEL_DIRECTORY` makes preparation offline
with respect to Python packages, too. `--metadata ABSOLUTE_DIRECTORY` accepts
a reviewed `node-releases.json` and its `node-releases/` manifests. This means
a future reviewed Node/Runtime wheel need not first be published on PyPI to
be included in a local candidate. Production uses the exact reviewed descriptor
set in source; the consolidated release requires Node 0.2.1 and Runtime 0.2.0.
Preparing new backend source, qualification and license/export review are not
performed or bypassed by this command.

Preparation assembles the deduplicated wheel set, verifies SHA-256 and sizes,
stages the npm payload outside the repository, and packs the product once.
It leaves a candidate tarball, release manifest, and the frozen Pi runtime
tarball used only for audit. Only `physicalsystems` is the product being
installed/published; the extra Pi audit tarball is not another user install.
All wheels remain immutable and keep their internal notices. A separate
backend SBOM lists every included wheel and its hash. Nothing is published.

For an already assembled bundle, the lower-level equivalent is:

```text
npm --prefix packages/cli run release:pack -- ABSOLUTE_CANDIDATE_DIRECTORY --node-bundle ABSOLUTE_BUNDLE_DIRECTORY
npm --prefix packages/cli run release:verify -- ABSOLUTE_CANDIDATE_DIRECTORY --require-node-bundle
```

## What got leaner

PR CI previously bootstrapped four dependency trees and packed five candidate
sets (one per platform check, then an extra upload). It now bootstraps and
packs once. Every platform downloads the same candidate, verifies its source
commit and checksum, reuses its bundled JS dependencies for source tests, and
runs the existing local/global/npm-exec install checks. Native x64 jobs also
install the backend from the installed npm package with a throwing network
fetch hook and verify environment reuse. Linux additionally exercises the real
first-run interactive Harness and managed Node lifecycle. The four established
platform contexts and platform-specific unit/credential checks remain.
Superseded PR runs cancel; publication runs never cancel this way.

Protected main-only OIDC publication, npm 11/12 compatibility coverage and
human approval remain unchanged. PR artifacts are not automatically trusted
for publishing; the protected release still builds its own candidate. Removing
that final duplication requires a separately reviewed same-commit promotion
contract, not merely accepting any successful PR artifact.

## Trade-offs and remaining release work

- One all-platform artifact downloads more bytes up front. The current six
  selectors share ten distinct wheels, approximately 190 MB before the rest
  of the product. No claim of a faster consumer download is made.
- npm source licensing remains separate from Node's proprietary preview
  license. Publishing the bundle requires approval of that distribution mix.
- Default/source `release:pack` remains available for non-product development
  checks. PR and protected-release workflows use `release:prepare` and require
  the included backend during verification; a plain package cannot satisfy them.
- Bundled mode fails closed if declared files are missing, linked, changed,
  or incompatible. It does not silently fetch a replacement or use latest.
- Managed 0.2.0 environments are verified before a consented 0.2.1 update.
  Failed or declined updates do not start the old backend or change its selection.
  Same-version custom selections and explicit external executors remain intact;
  damaged environments are not repaired automatically. There is no general
  migration engine, automatic downgrade, or bundled interpreter.
- Robot execution, camera access and physical qualification are not implied
  by an installation test.
