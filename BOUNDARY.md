# Public product / private Node and service boundary

This repository is the canonical public source for the Physical Systems
operator Harness and public Python Runtime. The private Node repository owns
hardware-host implementation. These remain separate modules/distributions,
not separate public source repositories. Hosted services and production data
remain outside this repository.

## Public source

- The `physicalsystems` npm package: command, local credentials, Harness,
  compatibility client commands, stable client contracts and the reviewed
  dependency closure required for deterministic npm 11/npm 12 installs.
- The frozen MIT Pi terminal compatibility runtime used by the text-first
  Harness, with optional native Clipboard and image-processing peers absent by
  default.
- Tests, packaging checks, security expectations and reproducible release CI
  needed to audit what runs on an operator's computer.
- `packages/runtime`: the already-public Apache-2.0 execution kernel, versioned
  contracts, adapter protocols, deterministic strategies, fakes and conformance.
  Its `tinyedge-runtime` distribution and `tinyedge_runtime` imports are not
  renamed. It imports no private Node, Platform or Evaluation implementation.
- `release/node`: already-public release verifier, tests, notice and historical
  template, used by the consolidated protected Node workflow. It accepts an explicitly reviewed wheel plus metadata;
  it does not build or contain the private Node implementation.
- `release/runtime` and the shared publisher verifier: component-only publication
  of reviewed public Runtime artifacts and protected OIDC verification. They do
  not add a long-lived credential or copy private source. The root maintainer
  coordinator dispatches these reviewed workflows; it cannot approve deployments.
- Each imported module has a `SOURCE-IMPORT.json` recording the exact public
  commit and original blob/byte hashes, excluded files and deliberate changes.
  The import inventory is checked without access to private repositories.
- `release/product.json` and its local preparation/check coordinator: reviewed
  public component metadata only, not private source, build assets or another
  publishing authority. New backend exports retain their separate review gate.

## Systems outside this repository

- The Python local Node, concrete hardware adapters, supervision, artifact trust
  and execution-host implementation. Moving the public kernel here does not
  authorize copying those private implementations.
- Account and multi-tenant control-plane implementation.
- Fleet scheduling, work claiming, approvals, relay coordination and artifact
  control.
- Billing, pricing, marketplace logic and production fleet data.
- Learned optimization, calibration and promotion policy, compatibility and
  performance databases, and premium optimizers.
- Production deployment topology, credentials, raw telemetry, customer models,
  camera streams, ROS captures and operational evidence.

The public client may consume versioned local-node contracts and optional
hosted-service contracts. It must not import private server modules or
reproduce private orchestration or optimization implementation. Public
extension points may host separately licensed providers without moving their
implementation across this boundary.

The TIN-411 product carries exact reviewed Node/Runtime download manifests.
Managed setup selects only the matching OS/architecture/Python wheel set,
verifies its hashes and sizes, and installs it into a private environment after
software consent. This changes distribution, not source ownership or hardware
authority. Large model weights and all-platform wheel bundles stay outside the
default npm archive. A 50 MiB product archive policy is checked before publishing;
it is a project limit, not a claimed npm registry limit.

The explicit `release:prepare -- --offline` review path may assemble the previously reviewed Node/Runtime
wheel closure into an npm candidate outside this source tree. It may copy only
the exact manifest-identified distribution files, including their licenses;
it must not copy private source directories or relabel Node as Apache-2.0.
That offline candidate carries a backend notice and a hash-addressed backend
SBOM; it is not eligible for the small npm publication route. This does not by
itself authorize publication or change the protected workflow,
or remove the private-source export review for new backend distributions.

Python source and publisher tooling are not added to the npm archive; only
the existing matching-platform manifests are included. Shared source ownership
does not mean rebuilding or republishing unchanged backend distributions.

Publishing source does not publish an npm package and does not relicense
third-party code. Project-authored client code uses Apache-2.0. The frozen Pi
compatibility runtime remains MIT, and every dependency retains its own
license. Licenses, notices, trademark policy, SBOMs and third-party evidence
are part of the public audit surface.

The protected workflow may publish one OIDC-authenticated `physicalsystems`
candidate to `preview` from `main` after environment approval. It cannot change
`latest` or republish the compatibility runtime. Promotion remains a separate
maintainer action with npm 2FA. The reviewed inert
`physicalsystems@0.0.0` publication was the one-time namespace bootstrap, not
an application release. Changes to this boundary require public review and
must not be bundled with an unrelated feature.
