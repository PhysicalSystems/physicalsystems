# Physical Systems Node releases

Modified for TIN-417: this directory imports the reviewed public tooling from
`PhysicalSystems/node-releases` commit
`06f7fbf0ef9e4e4c26593ab7125b5d3fa507c8fd`. [SOURCE-IMPORT.json](SOURCE-IMPORT.json)
records the exact original blobs, exclusions and deliberate adaptations.

## Migration status: publishing is not active here

The consolidated publisher exists only as
[workflows/node-release.yml.template](workflows/node-release.yml.template),
outside GitHub's active workflow directory. Its verification and upload jobs
also have literal `false` guards. This import does not upload assets, change a
Trusted Publisher, approve an environment, republish an existing version, or
disable the old repository's publisher. Root Python CI tests synthetic fixtures
only; it is not six-platform installation qualification or publication evidence.

Activation is a separate owner-verified cutover: verify the new repository's
protected environment and PyPI Trusted Publisher for `node-release.yml`, prevent
overlapping old/new upload authority, review the migration record, and only then
review moving the template to `.github/workflows/node-release.yml` and removing
its literal guards. Update the migration-only regression at that transition.
The verifier already refuses the old repository and `publish.yml` identity;
do not invoke its `verify`/`stage` operations against the historical publisher.
Existing published wheels, download URLs, release assets and historical evidence
remain unchanged; reusing their pins does not require another backend upload.

This directory contains **release tooling only**. It does not contain
the private managed Node repository, source archives, credentials, hardware
configuration, or private CI reports. It does not build Node from source.

The separately downloadable `physicalsystems-node` preview contains 26
explicitly selected physical-host Python modules plus a minimal initializer.
Python wheels contain readable source; this is a licensing/distribution
boundary, not source-code concealment. The wheel remains proprietary under
its included [preview notice](policy/node-preview-notice.txt). The release
tooling in this directory is Apache-2.0, under [LICENSE](LICENSE); that license
does not relicense the Node wheel or its dependencies. Runtime, NumPy and
OpenCV remain separate distributions under their own licenses.

## Promotion boundary after separately reviewed activation

The following is the preserved protocol for a future new Node release, not an
instruction to publish during consolidation. The future repository identity is
`PhysicalSystems/physicalsystems`; the workflow identity is `node-release.yml`.

1. An authorized operator verifies the private main candidate, its package
   allowlist and complete private test evidence locally. The private exporter
   emits only the approved wheel and canonical `release.json`. Neither the
   private exporter nor its source/evidence is uploaded here.
2. The operator publishes a **candidate prerelease targeting `main`** here,
   tagged `physicalsystems-node-v0.2.1-candidate`, with exactly those two assets,
   and reviews the raw SHA-256 of `release.json`. The candidate must have
   `draft=false`, `prerelease=true`, and a valid publication timestamp.
   GitHub asset metadata must expose matching SHA-256 and size. Assets are not
   committed to Git. Only bytes approved for the public distribution may be
   staged: the candidate assets, Actions logs and artifacts are publicly readable.
   This makes the candidate downloadable before PyPI promotion; it does not
   claim that public install checks have passed or PyPI publication has occurred.
   Draft releases are not accepted because their push-restricted visibility is
   incompatible with this workflow's read-only token. No write permission or
   personal access token is granted to work around that restriction.
3. Manually dispatch `node-release.yml` on this repository's current `main`, passing
   `candidate_release_id` and `release_metadata_sha256`. The workflow reads only
   this repository and anonymous official PyPI endpoints. It has no private
   repository credential or access requirement.
4. The exact pinned wheel and dependencies pass six fresh isolated installs:
   Ubuntu 22.04 and Windows 2022, each with CPython 3.10, 3.11 and 3.12. Fetching
   happens in a separate authenticated step; installed code receives no
   repository or publishing credential. Tests check installation identity,
   Runtime/NumPy/OpenCV imports and a tiny in-memory image conversion. They do
   not discover devices, import camera/motion code, capture, or move hardware.
5. The `physical-node-pypi` environment requires a named human reviewer and
   exact custom branch policy `main` (type `branch`), with admin bypass disabled.
   Repository variable `PHYSICAL_NODE_PUBLISH_POLICY` must equal
   `v1-minimal-node-preview`. A founder may dispatch and personally approve;
   automated approval is not implemented. No step modifies these settings.
6. After human approval, the workflow rechecks current main, exact candidate
   asset bytes, all six same-run/current-attempt successful job receipts, and
   every dependency's public unyanked hash/URL. OIDC publishes **one prebuilt
   minimal wheel**, not an sdist, Runtime wheel, private report or source archive.
   Configure the PyPI Trusted Publisher separately for this repository,
   `node-release.yml`, and environment `physical-node-pypi` before dispatch.
7. Anonymous PyPI readback must match the exact uploaded bytes. Only then are
   six genuine `physicalsystems-node-install-v1` manifests emitted as public
   Actions artifacts. Only readback is retried for brief registry propagation;
   upload is never retried or silently skipped. Review a failed upload/readback
   before deciding what to do next.

Before invoking PyPA, the workflow copies and revalidates the approved stage
into a separate `RUNNER_TEMP/readback-input` snapshot. PyPA may add its expected
`.publish.attestation` sidecar to the upload directory; readback uses the
untouched snapshot instead. Both pre-upload and readback validation retain the
same strict exact-file checks. A readback failure reports only the verifier's
bounded, sanitized refusal—not its raw stderr or traceback. If upload succeeded
but readback failed, do not rerun publication: independently verify the published
wheel and recover manifests through the read-only `readback` operation using
the exact approved local capsule/wheel stage.

If any prerequisite is absent, promotion fails closed. A GitHub candidate or a
successful test run is not evidence that a package is published to PyPI. Installing this
experimental preview never authorizes physical execution or certifies safety.
Failed GitHub reads report only a fixed endpoint class and an HTTP status when
available; raw response bodies, stderr, URLs and credentials are never logged.

## Capsule v1

Canonical JSON uses sorted keys, compact separators, ASCII escapes, finite
values, UTF-8 and **no trailing newline**. Unknown or duplicate fields fail.

```text
contractVersion = "physicalsystems-node-release-capsule-v1"
distribution = "physicalsystems-node"
version = "0.2.1"
runtimeVersion = "0.2.0"
sourceManifestSha256 = SHA256(canonical embedded package source manifest)
wheel = {filename, sha256, bytes}
targets = [{platform, python, publicDependencies: [{name, version, filename,
                                                  sha256, bytes, url}]}]
```

There must be exactly six unique targets (`linux-x64`/`win32-x64` ×
`3.10`/`3.11`/`3.12`) and exactly three dependency records per target:
`tinyedge-runtime==0.2.0`, `numpy==1.26.4`, and
`opencv-python-headless==4.10.0.84`. Wheels must be compatible with their target;
URLs must be exact credential-free `files.pythonhosted.org` URLs. Runtime's
approved wheel SHA is pinned in the verifier; a rebuild with another hash does
not satisfy this gate. Metadata contains no private commit/run/repository URLs,
raw reports, signatures of invented authority, local paths, or Node URL
placeholder. The source-manifest fingerprint identifies only included files.

The capsule itself is not an installer manifest. Public install manifests are
created only after the real Node PyPI URL is verified. The trust chain is the
operator's explicit metadata pin, inspected wheel contents, fresh public CI,
human-protected promotion and final exact public readback. This repository does
not claim independently to have observed the private CI proof.

## Node 0.2.1 patch preparation

The current verifier accepts only `physicalsystems-node==0.2.1`, while Runtime
remains the exact approved `tinyedge-runtime==0.2.0` release. These versions are
independent: the Node capsule, installed identity and final install manifests
must all report Node `0.2.1` and Runtime `0.2.0`. Updating this tooling does not
publish either package, accept an unreviewed Runtime update, or promote an npm
channel. The same six native-install targets and human-protected OIDC gate apply.

Published Node `0.2.0`, its candidate tag/assets and historical evidence remain
immutable. Stage a new `physicalsystems-node-v0.2.1-candidate` only after its
separate source/allowlist review; never overwrite the old candidate or reuse its
proofs. Historical `0.2.0` readback uses the reviewed tooling revision for that
release, not the current `0.2.1` verifier.

## Local regression tests

Run from the consolidated repository root, with the test dependencies in a
separate environment and temporary evidence outside the source checkout:

```sh
python -m pip install packaging==26.3 pytest==8.4.2
python -B -m pytest -q -p no:cacheprovider release/node/tests
```

These tests use synthetic in-memory package fixtures and mocked registries;
they do not publish, require credentials, discover devices or open hardware.
Generated wheelhouses/venvs and private evidence belong outside source control.
Windows install probes use a short temporary path and reject environment roots
over 126 characters to leave margin for native wheel DLL paths. `pip check`
alone cannot establish that a native module will load.
