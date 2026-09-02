# Legal review tooling

This directory contains the approved canonical legal inputs and deterministic
SBOM tooling for the public Physical Systems Harness source. The operative repository
license is the root `LICENSE`; canonical inputs under `templates/` are used to
enforce its exact bytes and the package notice bundle.

The source-license cutover is complete:

- the root workspace and active `tinyedge` package use Apache-2.0; frozen
  `0.1.3` source records retain their original Apache-2.0 evidence;
- `@tinyedge/pi-runtime` remains MIT with a separately scoped NOTICE;
- twelve exact missing-named-file records have explicit approved dispositions;
- `ignore@7.0.5` is independently bound to its artifact-contained
  `LICENSE-MIT`; and
- the root workspace remains private, while TinyEdge policy authorizes one
  `tinyedge` candidate for protected direct OIDC publication to `preview`.
  Human npm-owner capability is not an approved alternate release route.

Commands:

```powershell
npm run generate:sbom # intentional regeneration; review every diff
npm run check:legal   # deterministic offline verification
```

`npm run check:legal` fails on canonical or live legal-file byte drift,
exception/evidence drift, graph drift, generated SBOM drift, or a mismatch
between the publication-lock state and package manifests. It does not
publish, change repository visibility, or alter npm trust settings.
