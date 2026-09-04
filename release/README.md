# One public product workspace, one private Node

`physicalsystems` owns the Harness, public Runtime and reviewed Node release
tooling. The private `node` repository owns the hardware host and private
implementations. Source ownership is consolidated; package lifecycles remain
separate so a Harness change need not rebuild and republish Python dependencies.

## One maintainer entry point

```sh
npm run release -- plan
npm run release -- check
npm run release -- migration
npm run release -- prepare --output ABSOLUTE_NEW_ARTIFACT_DIRECTORY
```

`plan`/`check` verify the current product pins; `prepare` produces a review
candidate. `migration` checks the public-source import receipts and reports
publisher cutover separately. None uploads, changes permissions, retires a
repository or authorizes physical execution. Ordinary source contributions
do not require running the complete installed-package release matrix.

## What moved

| Component | Source of truth here | Identity preserved |
| --- | --- | --- |
| Operator Harness | `packages/cli` | npm `physicalsystems` |
| Public execution kernel | `packages/runtime` | PyPI `tinyedge-runtime`, import `tinyedge_runtime` |
| Reviewed Node export verifier | `release/node` | PyPI `physicalsystems-node`; private Node source stays outside this repository |

Each imported module records its original public commit, file hashes and
deliberate migration changes in `SOURCE-IMPORT.json`. Runtime source, schemas,
fixtures and tests are imported unchanged. Keep that origin record when
evolving the module; declare additions/adaptations explicitly. The existing
Pi compatibility runtime is a different, frozen MIT package.

## Publisher cutover is not yet complete

Existing Runtime and Node publishing configurations remain in their historical
repositories. This source change does not activate another uploader or claim
that a PyPI trust configuration has moved. The Node workflow is a disabled
template outside `.github/workflows`; its six native install proofs, exact
capsule hash, human approval and public readback checks are retained for review.

The proposed replacement identities are recorded in `migration.json`:

| Distribution | Repository | Workflow filename | Environment |
| --- | --- | --- | --- |
| `tinyedge-runtime` | `PhysicalSystems/physicalsystems` | `runtime-release.yml` | `runtime-pypi` |
| `physicalsystems-node` | `PhysicalSystems/physicalsystems` | `node-release.yml` | `physical-node-pypi` |

Cutover requires owner-configured PyPI publishers and GitHub environment
protections, reviewed component-scoped workflow triggers, an explicitly
authorized new candidate, exact artifact qualification and public readback.
Runtime's old generic `v<version>` release trigger must not be copied into
the product tag namespace. Do not activate the Node template just by copying
it; its deliberate disabled guards and migration tests must change in the
same reviewed cutover. Never configure an alternative token-based upload.

Changed components progress in dependency order: Runtime if changed, then
Node if changed, then the npm product. Reuse unchanged published hashes. A
source build at version `0.2.0` is not the already-published Runtime wheel and
must not replace its pinned hash. Changed-backend publishing is not automated
by the current local preparation command.

After an uncertain upload, read back the exact version/hash; do not retry
upload or skip existing files automatically. Record publisher and artifact
evidence before disabling the legacy route. Keep historical repositories,
release tags, assets and existing PyPI/npm downloads available through the
migration and rollback window. No repository is deleted or made public by
this consolidation.
