# Release checklist

## 0.2.3 patch candidate

Patch release candidate. Preparation does not publish the package or authorize
upgrading an existing installation.

### Operator changes

- Basic camera preview guidance directs the operator to `/workcell`, camera
  selection and Start preview without requiring commissioning (TIN-421).
- A valid camera image stays visible while its replacement is fetched and
  decoded. Image and exact-frame metadata swap together. Freshness expiry,
  observation expiry and clearing on Stop or identity/session changes remain
  enforced (TIN-422).
- Camera Stop is independent of assistant work and ordinary view requests.
  Requests are bounded; unconfirmed Stop retains the exact capture identity
  for retry and owned-session cleanup. Cancelling pending Start never guesses
  a camera session. The view distinguishes cancellation, stopping and an
  unconfirmed result, and rejects obsolete responses.
- Browser reconnection recovers after intermittent drops and detects silent
  connections. Exhausted retries expose Reconnect and terminal recovery
  guidance. Successful recovery clears obsolete connection errors without
  hiding unrelated action failures.
- Planning displays missing configuration, every reported question/gap and
  actual rejection reasons. Stale evidence is not generically described as a
  commissioning requirement. Busy requests and expired questions receive
  fixed, actionable errors while arbitrary internal errors remain redacted.

### Compatibility and qualification

This is a Harness-only update. The existing Physical Systems Node 0.2.1,
Runtime 0.2.0 and pinned Pi compatibility runtime are reused. Discovery,
planning and proposals do not authorize movement. Execution still requires an
exact configured invocation, explicit unexpired operator approval and verified
outcome evidence; uncertain outcomes are never retried as motion.

Regression coverage includes synthetic delayed/failed frames, Stop races,
session changes, stream recovery, planning blockers and request conflicts.
Browser controls were exercised in real headless Firefox with simulated
clients. Execution lifecycle and recovery were exercised only in simulation.
These results do not qualify physical hardware or a commissioned workcell.

The earlier controlled TIN-422 test passed headless UI blanking and exact-frame
metadata checks. **Optical/display flicker was not measured.** Do not interpret
the frame replacement fix as an optical-flicker qualification.

The Avahi timeout partial-results defect belongs to the separately owned Node
implementation and is not changed in this release. Protected native package
qualification and release approval remain required before publication.

## Package transition

The Harness now ships as the unscoped `physicalsystems` package and installs
the `physicalsystems` command. The first real release under that identity is
`physicalsystems@0.2.0`.

The public `tinyedge@0.1.3` (`latest`) and `tinyedge@0.1.5` (`preview`)
releases are immutable historical artifacts. This workflow never republishes
them or moves their tags. The frozen `@tinyedge/cli@0.1.3` and
`@tinyedge/pi@0.1.3` releases also remain untouched.

`@tinyedge/pi-runtime@0.84.2-tinyedge.1` remains the separately versioned,
audited MIT compatibility runtime. It is bundled into `physicalsystems` for a
deterministic one-package install, but ordinary Harness releases verify and
reuse its registry bytes rather than republishing it.

## Current release model

`.github/workflows/npm-release.yml` is the only real-code publication route.
It is manually dispatched from `main`, uses npm trusted publishing with GitHub
OIDC, and is protected by the `npm-release` environment.

### Source review versus release qualification

Ordinary `.github/workflows/cli.yml` PR/main checks build one source-review
candidate and reuse its hash-checked dependency closure for native source,
legal, SDK and credential tests. The established Windows x64/ARM64 and Linux
required-check names remain unchanged. These checks do not perform full fresh
local/global/npx installs, backend downloads or managed first-run acceptance.
A green source-review run is not installation or publication evidence.

The manually dispatched release below remains the only full installation
qualification and publication path. It builds from the exact `main` commit
and tests those same bytes once across the required npm 11/12 platform matrix.
PR artifacts are never promoted or used to satisfy its gates. This removes
overlapping installation qualification without weakening final release checks
or changing the protected environment, trusted publisher or registry tags.

See [one product, one release entry point](NPM-PRODUCT-BUNDLE.md) for the
component/repository boundaries and the separate offline preparation option.

The workflow:

First checks `release/product.json` against the package locks, reviewed backend
identities and its own explicit release/toolchain constants using
`node scripts/release.mjs check`. A mismatch fails before the expensive build.
Maintainers can run the same check locally with `npm run release -- check`.
The local plan is not registry or installation evidence and does not replace
any protected publishing check below.

Before building, checks the bundled managed-Node release index and raw manifest
hashes. An empty index, placeholder artifact URLs, or missing any of the six
approved Windows/Linux x64 Python 3.10–3.12 manifests blocks publication. This
metadata gate does not replace clean installation tests of the downloaded bytes.
The same hashes are rechecked from the actual installed npm artifact.

1. Uses `npm run release:prepare` to build `physicalsystems@0.2.3` once on
   Windows x64 with the reviewed JS dependency closure, exact backend manifests
   and tarball checksums. Wheel binaries are not included. The normal product
   archive must be at most 50 MiB (a project policy, not a claimed registry limit).
2. Verifies those same bytes on Windows x64, native Windows ARM64, Ubuntu
   22.04, and Ubuntu 24.04 with the pinned npm 11 release client and npm 12
   consumer behavior.
3. Requires downloadable Node metadata (an empty-index or offline-bundle package
   cannot pass), tests native x64 backend installation using real exact-URL
   downloads and verified reuse with no additional downloads,
   and exercises normal local, global, and isolated npm-exec installation,
   command shims, the bare Harness, the embedded client and Pi extension, and
   Ubuntu Secret Service integration.
4. Runs the exact tarball with Node.js 12.22.9 and npm 8.5.1, requires one
   actionable prerequisite failure, and proves that modern application modules
   were not parsed.
5. Enters the protected environment only after all platform checks pass and
   requires `NPM_RELEASE_POLICY_VERSION=v3-physicalsystems-preview`.
6. Verifies the inert namespace bootstrap, the already-published runtime, and
   that `physicalsystems@0.2.3` is not already public. This update requires the
   exact existing tags `bootstrap=0.0.0`, `latest=0.0.0`, and `preview=0.2.2`;
   unexpected tag changes block publication rather than being overwritten.
7. Publishes exactly one tarball:

   ```bash
   npm publish "./release-artifacts/physicalsystems-0.2.3.tgz" \
     --registry="https://registry.npmjs.org/" \
     --provenance --tag preview --access public
   ```

8. Confirms `bootstrap=0.0.0`, `latest=0.0.0`, and `preview=0.2.3`; compares
   registry integrity and shasum with the approved tarball; requires SLSA v1
   provenance; and runs `npm audit signatures`.

The workflow does not use a long-lived npm token, publish the runtime, change
`latest`, or contain a lifecycle publishing script. Local packing and tests
never publish or alter registry state.

### Linux first-run acceptance

The protected Linux jobs select CPython 3.10 on Ubuntu 22.04 and 3.12 on Ubuntu
24.04 and probe `venv`/`ensurepip`. After the separate command-shim and bare-CLI
dispatch checks, a source-only PTY wrapper invokes the freshly installed
package's real `runCli`, Harness, installer and supervisor. It starts with an
exclusively created config directory and removes inherited external-node,
executor, simulation and Python override settings from the test child. A private
`XDG_CONFIG_HOME` also isolates the Node's default discovery registry; the test
does not read the operator's existing workcell configuration.

For an approved Node release, this isolated test answers the exact software-only
first-run consent prompt once, permits up to ten minutes for installation, and
requires the selected manifest digest to match the packaged metadata. It then
checks authenticated discovery status (`mode: null`, no configurations or runs),
separate camera credentials and idle camera status, renders the Harness, sends
Ctrl+D and confirms that the owned Node listener closed. Pi currently calls
`process.exit` for interactive quit, so the PTY parent independently waits for
connection refusal on the exact owned loopback port after Harness exit/Node
stdin EOF; a timeout is not shutdown proof. It does not select a
camera, capture a frame, commission hardware or dispatch motion. No credentials
are included in acceptance markers.

An empty-index source candidate still exercises the interactive Harness but is
explicitly reported as **NO managed Node acceptance**; it cannot satisfy the
protected publication gate. Synthetic regression fixtures test the acceptance
logic without downloading wheels or opening hardware and are not release-byte
evidence. The consolidated release requires the corrected Node 0.2.1 descriptor
set with Runtime 0.2.0; fresh packaged managed-Node acceptance must pass before
this npm release can be published.

## Candidate preparation

Use pinned npm 11.19.0. Keep generated artifacts outside the source repository:

```bash
npm run release:prepare -- --output /absolute/new/product-output
npm --prefix packages/cli run release:verify -- /absolute/new/product-output/candidate --require-downloadable-node
```

The default preparation command never downloads Python wheels. It packs the
reviewed JavaScript closure and pinned backend manifests. The installed product
selects one OS/architecture/Python combination and downloads those exact artifacts
on first setup, after consent. Successful installation is reused on later launches;
an update may download a new complete selected wheel set. Python with
`venv`/`ensurepip` remains a prerequisite. Network failures or corrupted downloads
do not activate a partial installation or fall back to unreviewed packages.

An explicitly prepared offline artifact remains available for review or an
offline deployment, separately from the small npm publishing route:

```bash
npm run release:prepare -- --output /absolute/new/offline-output --offline --wheelhouse /absolute/reviewed/wheels
npm --prefix packages/cli run release:verify -- /absolute/new/offline-output/candidate --require-node-bundle
```

Omit `--wheelhouse` to let the offline-artifact builder fetch the complete pinned
wheel closure. `--metadata` and `--wheelhouse` are rejected unless `--offline` is
explicit. Offline candidates include backend notices/SBOM and are not eligible
for the normal npm publisher. None of these local commands publishes anything,
moves source between repositories or enables physical execution.

## One-time namespace bootstrap

npm trusted publishing can be configured only after the package exists. A
maintainer must therefore perform one narrowly reviewed, interactive bootstrap
before the first OIDC release:

1. Pack `scripts/npm-bootstrap/physicalsystems-0.0.0` with the pinned npm CLI.
2. Verify that the tarball contains only `LICENSE`, `README.md`, and
   `package.json`; its manifest must contain no command, code, dependencies,
   bundles, or lifecycle scripts.
3. Publish only this inert tarball with 2FA under the non-default `bootstrap`
   tag:

   ```bash
   npx --yes npm@11.19.0 publish PATH_TO_PHYSICALSYSTEMS_0.0.0_TARBALL \
     --tag bootstrap --access public --registry=https://registry.npmjs.org/
   ```

   npm creates an initial `latest=0.0.0` mapping for a brand-new package even
   when this command uses `--tag bootstrap`. This is expected and remains inert
   until a separately reviewed application release is manually promoted.

4. Record its registry SHA-512 integrity and SHA-1 shasum as the protected
   environment values `PHYSICALSYSTEMS_BOOTSTRAP_INTEGRITY` and
   `PHYSICALSYSTEMS_BOOTSTRAP_SHASUM`.
5. Configure the npm trusted publisher for package `physicalsystems`, GitHub
   organization `PhysicalSystems`, repository `physicalsystems`, workflow
   `npm-release.yml`, and environment `npm-release`, allowing `npm publish`.

The interactive exception is only for the inert namespace proof. It is not an
alternate route for application code and does not receive automatic npm
provenance.

The historical `@tinyedge/pi-runtime@0.0.0` namespace bootstrap remains
verified by the workflow using `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and
`PI_RUNTIME_BOOTSTRAP_SHASUM`.

## GitHub controls

- Limit the `npm-release` environment to the exact `main` branch.
- Disable administrator bypass and require a human reviewer.
- Store all four bootstrap integrity values on that environment.
- Set `NPM_RELEASE_POLICY_VERSION=v3-physicalsystems-preview` only after the
  `physicalsystems` trusted publisher has been verified.
- Keep the canonical source repository public for npm provenance.

## Canary and promotion

After publishing to `preview`, verify from clean Windows and Ubuntu desktop
environments:

```bash
npm view physicalsystems@0.2.3 version dist.integrity dist.shasum dist.attestations --json
npm view physicalsystems dist-tags --json
npx --yes physicalsystems@0.2.3 --version
npm install --global physicalsystems@0.2.3
physicalsystems
```

Also create an empty audit directory, install with
`npm install --ignore-scripts --no-audit --no-fund physicalsystems@0.2.3`, and
run `npm audit signatures`. Use a disposable account for optional cloud OAuth
or MCP canaries; package checks are not production-service evidence.

Only after the canary is accepted may a maintainer promote the exact bytes:

```bash
npm dist-tag add physicalsystems@0.2.3 latest
```

Promotion requires maintainer presence and npm 2FA. If the preview fails, do
not promote it; fix the problem and publish a new patch version. A rollback
moves only `latest` to the last validated `physicalsystems` version and leaves
`preview`, `bootstrap`, and all historical TinyEdge tags intact.
