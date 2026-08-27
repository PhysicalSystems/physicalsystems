# Contributing to TinyEdge Edge

Thanks for helping improve the TinyEdge edge client. This repository contains
the public device-side client and release tooling. Read [BOUNDARY.md](BOUNDARY.md)
before proposing a change; hosted control-plane, scheduling, billing, fleet,
and optimization-policy implementations are intentionally out of scope.

## Before opening a pull request

- Search existing GitHub issues and pull requests. For a large feature or a
  boundary change, open an issue before investing in an implementation.
- Never include credentials, access tokens, customer or fleet data, private
  service code, local user paths, session transcripts, or model artifacts.
- Preserve Apache-2.0 for TinyEdge-authored code and MIT plus upstream notices
  for the Pi compatibility runtime. Do not edit hash-verified upstream runtime
  payloads directly without a separately reviewed provenance update.
- Keep the client Windows-only unless the change includes a native credential
  store, packaging support, and clean-machine evidence for another platform.
- Do not add or change package publication permissions, trusted-publisher
  identity, registry settings, release workflow authority, or release tags as
  part of an ordinary contribution.

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](DCO),
Version 1.1. A sign-off certifies that you have the right to submit the work
under the licenses that apply to the files you changed. Add it with:

```text
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Name <email>` trailer. Use an identity you are
comfortable recording permanently in the public Git history. Pull requests
with missing sign-offs may be asked to amend their commits.

## Validate locally

Use Windows x64 or Windows ARM64 and Node.js 22.19.0 or newer:

```powershell
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache "$env:TEMP\tinyedge-pi-runtime-cache" --install-cli
npm test
npx --yes npm@11.19.0 run check:release-packages
git diff --check
```

The bootstrap installs the reviewed compatibility runtime from local source
without consuming the published registry bytes. It does not publish a package.

## Pull request expectations

Keep a pull request focused and explain user-visible behavior, security and
license impact, and the evidence you collected. Add or update tests for changed
behavior. Dependency, legal, release, and source-boundary changes require
especially careful review. Maintainers may decline changes that move private
service intelligence into the public client or weaken a fail-closed release
gate.
