# Legal review tooling

This directory contains the approved canonical legal inputs and deterministic
SBOM tooling for the public edge-client source. The operative repository
license is the root `LICENSE`; canonical inputs under `templates/` are used to
enforce its exact bytes and the package notice bundle.

The source-license cutover is complete:

- the root workspace plus `@tinyedge/cli`, `tinyedge`, and `@tinyedge/pi` use
  Apache-2.0;
- `@tinyedge/pi-runtime` remains MIT with a separately scoped NOTICE;
- twelve exact missing-named-file records have explicit approved dispositions;
- `ignore@7.0.5` is independently bound to its artifact-contained
  `LICENSE-MIT`; and
- `NPM-RELEASE-PENDING.md` plus all four `private: true` package flags remain.

Commands:

```powershell
npm run generate:sbom # intentional regeneration; review every diff
npm run check:legal   # deterministic offline verification
```

`npm run check:legal` fails on canonical or live legal-file byte drift,
exception/evidence drift, graph drift, or generated SBOM drift. It does not
stage, publish, change repository visibility, or remove the npm release lock.
