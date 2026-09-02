# Open edge / proprietary intelligence boundary

TinyEdge uses an open-edge, proprietary-cloud architecture. This repository is
the canonical public source for the device-side edge client.

## Public source

- The `physicalsystems` npm package: command, local credential, OAuth, MCP, Harness,
  Pi extension, stable client/plugin contracts, and the bundled reviewed
  dependency closure required for deterministic npm 11/npm 12 installs.
- The audited MIT Pi compatibility runtime used by the text-first Harness,
  with optional native Clipboard and image-processing peers absent by default.
- Tests, packaging checks, security expectations, and reproducible release CI
  needed to audit what runs on a user's device.

## Proprietary systems outside this repository

- Account and multi-tenant control-plane implementation.
- Fleet scheduling, work claiming, approvals, relay coordination, and artifact
  control.
- Billing, rewards, pricing, marketplace logic, and production fleet data.
- Learned runtime selection, quantization policy, calibration and promotion
  thresholds, compatibility and performance databases, and premium optimizers.
- Production deployment topology, credentials, raw telemetry, customer models,
  camera streams, ROS captures, and operational evidence.

The public client may consume signed plans and stable service contracts. It
must not import private server modules or reproduce private orchestration or
optimization implementation. Public extension points may host separately
licensed proprietary providers without moving their implementation across this
boundary.

Publishing source does not publish an npm package and does not relicense
third-party code. TinyEdge-authored client code uses Apache-2.0, the Pi
compatibility runtime remains MIT, and every dependency retains its own
license. The self-contained licenses, notices, trademark policy, SBOMs, and
third-party evidence are part of the public audit surface.

Package manifests being publishable does not publish them. TinyEdge policy
authorizes direct OIDC publication of the one `physicalsystems` candidate to
`preview` through the manual, main-only workflow and protected `npm-release`
environment. CI cannot change `latest` or republish the compatibility runtime;
promotion remains a separate maintainer action with npm 2FA. An npm owner may
technically retain interactive publication capability, but that is not an
approved release route for application code. The only exception is the
reviewed, inert `physicalsystems@0.0.0` namespace bootstrap required before the
first trusted-publisher release. Changes to this boundary require public review and
must not be bundled with an unrelated feature or release.
