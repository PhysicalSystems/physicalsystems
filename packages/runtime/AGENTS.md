# Physical Systems Runtime package contributor instructions

This directory (`packages/runtime` in `PhysicalSystems/physicalsystems`) owns
the public execution kernel, versioned runtime
contracts, adapter protocols, deterministic strategy engines, primitive runtime
telemetry, test fakes and conformance fixtures.

It must not import implementation from Node, Platform or Evaluation. Host
authentication, artifact materialization, concrete device drivers, daemon
supervision and fleet communication belong to the private Node repository.
Campaign design, scientific evaluation, statistics and evidence sealing belong
to Evaluation. Preserve the published `tinyedge-runtime` distribution,
`tinyedge_runtime` imports, command names and versioned wire contracts.

`SOURCE-IMPORT.json` records the exact public source import and deliberate
documentation changes. Root product workflows own CI and release coordination;
historical standalone Runtime workflows were not imported. No private Node
source or publishing credentials belong in this package.

## Before changing code

- Read the relevant TIN issue and use `lienert/tin-<n>-<slug>` branches.
- Inspect Git status and preserve unrelated changes.
- Treat contract strings, canonical bytes and golden hashes as versioned API.
- Additive fields require a new contract version because v1 rejects unknown
  keys by design.

## Verification

- Run `python -m pytest` for every change.
- Run `python -m build` and `python -m twine check` for packaging changes using
  an external copy/output directory; keep build output, caches and artifacts
  outside the product source repository.
- Runtime code must remain device-free and must not require network,
  credentials, model weights or private evidence for its tests.
- Do not publish packages or create physical/device evidence without explicit
  release authorization.
