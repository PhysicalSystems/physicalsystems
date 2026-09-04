# Physical Systems public product workspace

This is the canonical public source workspace for the Physical Systems Harness,
public Python Runtime and reviewed Node release tooling (TIN-417).

## Source boundary

- Keep only the `physicalsystems` command/client/extension package, audited Pi
  compatibility runtime, frozen public-package source records, public
  contracts, tests, release tooling, and documentation needed to audit the
  device-side client. `packages/runtime` owns the reusable public execution
  kernel, contracts, fakes and conformance. `release/node` owns release-only
  validation of explicitly approved Node wheels, never private Node source.
- Keep Runtime independent of Node, Platform and Evaluation implementation.
  Preserve existing distribution/import names and versioned contract bytes.
  Read `packages/runtime/AGENTS.md` before Runtime changes. Record deliberate
  changes to imported files in each `SOURCE-IMPORT.json`; do not silently copy
  a sibling working tree or replace the recorded public source commit.
- Never copy or import hosted control-plane, database, scheduler, billing,
  rewards, production operations, fleet data, or optimizer-policy code.
- Treat `BOUNDARY.md` as the architectural rule. Use GitHub issues for public
  bugs and proposals, and never post private operational data there.

## Licenses and publication boundary

- Preserve Apache-2.0 for TinyEdge-authored code and MIT for the Pi
  compatibility runtime, including its upstream provenance and notices.
- Source availability and npm publication are separate transitions. TinyEdge
  policy authorizes one `physicalsystems` candidate for the protected release
  workflow; the root workspace and frozen 0.1.3 package records remain private.
  A human npm owner may retain interactive 2FA publication capability, but
  must not use it as an alternate release path.
- Preserve the manual, main-only, protected-environment OIDC release path in
  `packages/cli/RELEASE.md`, including explicit founder authorization for a
  solo release and required x64/ARM64 checks under both pinned npm 11 and npm
  12. Keep the complete reviewed JavaScript dependency closure bundled in the
  prebuilt `physicalsystems` tarball. Per the approved TIN-411 revision, include
  pinned Python manifests, not all-platform wheel binaries: managed setup
  downloads only the matching verified backend after software consent. Preserve
  explicit offline preparation as a separate, non-published review artifact.
  CI may direct-publish only the size-checked product tarball to `preview`;
  never add a lifecycle publish script, long-lived npm write token, CI
  `latest` promotion, runtime republish through npm, or undocumented release route.
- The Node publisher template is not an active workflow. Source consolidation
  does not complete PyPI Trusted Publisher cutover. Follow `release/README.md`;
  preserve historical publishers and assets until the replacement is verified.
- Do not stage, publish, promote, or create an installer from an ordinary code
  change. Do not advertise macOS, Linux, a public installer, or a clean-user
  npm route until exact end-to-end evidence exists.

## Changes and validation

- Preserve concurrent work and commit only the files intentionally changed.
- Keep `package-lock.json` and `npm-shrinkwrap.json` byte-identical where the
  release checks require it.
- Pin release dependencies and GitHub Actions to immutable versions.
- For package or release changes, run `npm test`,
  `npm run check:release-packages`, and `git diff --check`. For Python changes,
  run the independent Runtime and Node release test suites as described in
  `DEVELOPMENT.md`; no hardware or credentials are needed. Keep builds, virtual
  environments, pytest caches and bytecode outside the source inventory.
- Follow `CONTRIBUTING.md`, including DCO sign-off. Never treat local Git
  history alone as release or production evidence.
