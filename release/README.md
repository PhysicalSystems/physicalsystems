# One public release workspace, one private Node

`physicalsystems` owns the Harness, public Runtime and reviewed Node release
tooling. The private `node` repository owns the hardware host and private
implementations. These are separate packages, not separate publishing repos:
a Harness-only change reuses the existing Python releases.

| Component | Source/tooling here | Protected workflow | Environment |
| --- | --- | --- | --- |
| npm `physicalsystems` | `packages/cli` | `npm-release.yml` | `npm-release` |
| PyPI `tinyedge-runtime` | `packages/runtime`, `release/runtime` | `runtime-release.yml` | `runtime-pypi` |
| PyPI `physicalsystems-node` | `release/node` (reviewed export only) | `node-release.yml` | `physical-node-pypi` |

The Pi compatibility package is frozen. Runtime imports no private Node code.
Keep each `SOURCE-IMPORT.json`: it records historical public source bytes and
explicit adaptations, not a claim that adapted files are still unchanged.

## Normal product release

For a product-only version bump, start on a clean release branch:

```sh
npm run release -- version NEW_MAJOR.MINOR.PATCH
```

This updates product metadata, both locks, workflow constants, versioned checks
and documentation references, then regenerates SBOMs and export provenance.
It retains backend pins and sets the expected previous preview to the current
product version. Review the diff and write the release notes, run the checks,
and merge the release PR. Preparation restores the original files if generation
fails. It does not publish or change registry tags.

```sh
npm run release -- check
npm run release -- publish --output ABSOLUTE_NEW_RECEIPT_DIRECTORY --watch
```

Run from a clean reviewed checkout of current `main`, using the pinned Node/npm
toolchain, Python 3.10+ (`python` on Windows, `python3` on Linux) and authenticated
`gh`. Python's standard library parses bounded evidence archives in memory without
extracting paths; no additional package installation is needed. The coordinator verifies product pins, checks
the official registries, reuses unchanged versions, and dispatches the protected
npm workflow. Existing versions are never overwritten. The complete native npm
installation matrix and human approval remain mandatory for a new product.
`plan`, `check`, `migration` and `prepare --output ABSOLUTE_NEW_DIRECTORY` remain
read-only/preparation routes with no publication authority.

With `--watch`, the command follows the saved receipt every 30 seconds and prints
status changes and the GitHub approval link until final evidence verification.
Human approval remains in GitHub. Ctrl+C stops watching; it does not cancel the
workflow. Without `--watch`, the command returns after dispatch. To continue:

```sh
npm run release -- resume --output ABSOLUTE_RECEIPT_DIRECTORY
npm run release -- watch --output ABSOLUTE_RECEIPT_DIRECTORY
```

The receipt records source SHA, product plan digest, UUID, exact run IDs and
proofs. Dispatch intent is saved before the network request. An uncertain
response is recovered by finding that UUID, never by repeating a dispatch.
Every workflow receives the expected source SHA, rejecting a racing main update.
`resume` checks current-attempt jobs and publisher receipts, not just a green
top-level status (which could hide skipped jobs). It never approves a deployment.
It downloads evidence by exact artifact ID, verifies the archive digest, and
compares the receipt with any previous evidence instead of trusting cached files.
Watch stops on errors or after 240 checks; it never retries a failed dispatch or
upload. Restart watch with the same receipt directory after inspection.

Native qualification runs local install, isolated npm exec and global install
concurrently in separate fresh caches and trees. All three must finish
successfully before their installed content is inspected; failures are reported
after all children exit so cleanup cannot race an installer. Phase durations
are printed in the job logs. Qualification caches remain empty at the start.
Build jobs cache npm downloads using both shrinkwrap files as cache inputs;
preparation still installs and verifies the reviewed dependency tree. The
optional `prepare --dependency-cache ABSOLUTE_DIRECTORY` selects an external
download cache for local preparation too.

## When a Python component actually changes

There are two review phases because final registry download URLs do not exist
until a new backend is published. Do not fabricate those URLs to make a single
source revision appear releasable.

1. Review the versioned Runtime source or minimal private Node export, and stage
   the exact approved candidate assets in this repository. Follow
   [Runtime](runtime/README.md) or [Node](node/README.md) artifact contracts.
2. Publish that component via the same maintainer entry point:

   ```sh
   npm run release -- publish-component --component runtime --runtime-candidate RELEASE_ID --runtime-metadata-sha256 SHA256 --output ABSOLUTE_NEW_RECEIPT_DIRECTORY
   npm run release -- publish-component --component node --node-candidate RELEASE_ID --node-metadata-sha256 SHA256 --output ABSOLUTE_NEW_RECEIPT_DIRECTORY
   ```

   Run only changed components, Runtime before a Node which depends on it.
   The component command binds its readback to the approved capsule, independently
   of the old npm manifests. It does not edit pins or launch npm publication.
3. Adopt/review the generated real download manifests and immutable hashes in
   `release/product.json` and the CLI manifests; update the npm version. Then run
   the normal product command. Unchanged backends are reused without another
   build, publisher approval or upload.

New Runtime candidates use `runtime-v<VERSION>-candidate`; Node candidates use
`physicalsystems-node-v<VERSION>-candidate`. Generic product tags do not trigger
Python publication. The coordinator never exports private source, stages assets,
bumps versions, promotes `latest`, supplies a write token or bypasses review.

## Verify the publisher migration without a needless software version

The reviewed workflows support `operation=verify-published` by default. Start
both independent component checks together:

```sh
npm run release -- verify-publishers --node-candidate RELEASE_ID --node-metadata-sha256 SHA256 --output ABSOLUTE_NEW_RECEIPT_DIRECTORY
```

Runtime uses its existing product wheel pin; Node uses an exact public two-asset
copy of the approved candidate. Both install the real pinned wheel across
Linux/Windows x64 and Python 3.10/3.11/3.12. After human approval, a shared probe
performs the real GitHub OIDC to PyPI token exchange and discards the token.
The workflow then verifies public bytes and retains safe evidence. It does
not rebuild or upload the already-published package.

An accepted exchange proves that PyPI accepted that workflow identity, but its
response does not identify authorized projects or confirm that the configured
PyPI environment was nonempty. The account owner must also verify the two
entries on the existing projects' publishing pages (not pending projects):

- [Runtime publishing](https://pypi.org/manage/project/tinyedge-runtime/settings/publishing/):
  owner `PhysicalSystems`, repository `physicalsystems`, workflow `runtime-release.yml`,
  environment `runtime-pypi`.
- [Node publishing](https://pypi.org/manage/project/physicalsystems-node/settings/publishing/):
  owner `PhysicalSystems`, repository `physicalsystems`, workflow `node-release.yml`,
  environment `physical-node-pypi`.

Both GitHub environments require a named human reviewer, exact `main` branch
policy and disabled admin bypass. Node additionally requires repository variable
`PHYSICAL_NODE_PUBLISH_POLICY=v1-minimal-node-preview`. No source test needs OIDC.

## Cutover evidence and recovery

`migration` reports checked-in workflow readiness, not live configuration or
retirement. Completion requires owner configuration evidence, actual six-target
proofs and token exchange receipts from each replacement, exact anonymous public
readback, and a verified disabled state for the historical Runtime `release.yml`
and Node `publish.yml` workflows. Then remove the obsolete PyPI publisher entries.
Keep historical repositories, tags, assets and download URLs. No repository
deletion, archive or visibility change is implied by disabling its uploader.

Do not retry an uncertain upload or enable `skip-existing`: inspect public
readback and the original run. A failed upload remains a failed job even if
readback proves the bytes exist; that does not identify who uploaded them.
For an interrupted local coordinator, a leftover `coordinator.lock` or
`coordinator.next.json` blocks automatic recovery. Confirm no coordinator is
running, preserve both files, reconcile the saved intent with GitHub's UUID/run
record, then repair only that receipt directory. Never blindly delete the lock
and start another publication. A missing run in the bounded lookup also requires
inspection; absence is not retry permission.

Workflow artifacts expire after 90 days. Preserve their safe receipts and
digests in the release evidence archive before expiration; missing/expired
evidence must not be reported as a newly verified successful migration.
