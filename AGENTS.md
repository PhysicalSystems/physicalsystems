# TinyEdge edge-client workspace

This is the canonical public source workspace for the TinyEdge edge client.

## Source boundary

- Keep only the npm facade, CLI, Pi extension, audited Pi compatibility
  runtime, public contracts, tests, release tooling, and documentation needed
  to audit the device-side client.
- Never copy or import hosted control-plane, database, scheduler, billing,
  rewards, production operations, fleet data, or optimizer-policy code.
- Treat `BOUNDARY.md` as the architectural rule. Use GitHub issues for public
  bugs and proposals, and never post private operational data there.

## Licenses and publication lock

- Preserve Apache-2.0 for the three TinyEdge-authored packages and MIT for the
  Pi compatibility runtime, including its upstream provenance and notices.
- Source availability and npm publication are separate transitions. Retain
  `NPM-RELEASE-PENDING.md` and `private: true` in all four npm packages.
- Remove the npm lock and four package private flags only in one separately
  protected release change after every control in `packages/cli/RELEASE.md`
  has current, independently reviewed evidence.
- Do not stage, publish, promote, or create an installer from an ordinary code
  change. Do not advertise macOS, Linux, a public installer, or a clean-user
  npm route until exact end-to-end evidence exists.

## Changes and validation

- Preserve concurrent work and commit only the files intentionally changed.
- Keep `package-lock.json` and `npm-shrinkwrap.json` byte-identical where the
  release checks require it.
- Pin release dependencies and GitHub Actions to immutable versions.
- For package or release changes, run `npm test`,
  `npm run check:release-packages`, and `git diff --check`.
- Follow `CONTRIBUTING.md`, including DCO sign-off. Never treat local Git
  history alone as release or production evidence.
