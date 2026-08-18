# Open edge / proprietary intelligence boundary

TinyEdge uses an open-edge, proprietary-cloud architecture. This repository is
the canonical public source for the device-side edge client.

## Public source

- The `tinyedge` npm facade.
- The TinyEdge CLI and its local credential, OAuth, MCP, and Harness boundaries.
- The Pi extension and stable client/plugin contracts.
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
authorizes staging through the manual, main-only workflow, protected
`npm-release` environment, and stage-only npm trusted publishers; public
availability still requires npm 2FA approval. An npm owner may technically
retain interactive publication capability, but that is not an approved release
route. Changes to this boundary require public review and must not be bundled
with an unrelated feature or release.
