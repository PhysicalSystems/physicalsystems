# Physical Systems

Physical Systems is a local Harness for turning an operator's intent into a
grounded, checked workflow for real equipment. The npm application provides the
operator interface. A separate local node discovers hardware, exposes device
capabilities and state, and will ultimately own execution beside the machines.

```text
operator intent
      |
      v
Physical Systems Harness (this repository)
      |
      v  loopback API
local Physical Systems node
      |
      v  adapters
cameras, robots, instruments and compute devices
```

The Raspberry Pi is one possible deployment target, not the product identity.
The Harness is intended to run on the desktop or workstation from which the
physical setup is commissioned, while the local node stays close to the
equipment.

## What the current version does

The Harness presents the workflow:

```text
Discover -> Intent -> Plan -> Commission -> Run -> Verify
```

Today it can:

- ask the local node for devices it actually observed;
- distinguish detected hardware from installed adapters and commissioned
  capabilities;
- accept a natural-language outcome from the operator;
- bind planning to the latest observed state;
- show missing adapters, configuration and skills before execution; and
- keep `Run` and `Verify` locked when no authorized executor exists.

It does not infer devices from a fixed enrollment file, install arbitrary
hardware drivers, or move a robot merely because an operator entered a prompt.
The current npm source has no motion endpoint. Commissioning and controlled
execution are the next contract boundary, not hidden demo behavior.

## Installation status

The npm name [`physicalsystems`](https://www.npmjs.com/package/physicalsystems)
publishes reviewed application builds on the `preview` tag. Resolve the tag
before launch rather than assuming which immutable version it currently names:

```bash
npm view physicalsystems@preview version --json
```

The one-shot preview command is:

```bash
npx --yes physicalsystems@preview
```

`physicalsystems@0.2.0` was the first application release. Version `0.2.1`
added a fail-fast prerequisite check for older Node.js versions and pinned,
reviewed backend manifests in a small npm artifact. Version `0.2.2` added a
compact workflow status and separated observed discovery metadata from
unassessed driver, capture and calibration evidence. Version `0.2.3` retains
the backend pins and improves basic camera preview guidance, frame replacement,
Stop handling, browser recovery and planning explanations. See the
[0.2.3 release notes](packages/cli/RELEASE.md#023-patch-candidate). First launch asks
for software setup consent, downloads only the wheel set matching the computer's
OS, architecture and Python version, checks its exact hashes and sizes, and
installs it in an isolated user environment, without a Git
clone, manual pip command or second terminal. Supported system Python with
`venv`/`ensurepip` is still required; arbitrary hardware drivers are not included.
The existing managed 0.2.0 backend requires consent to update to 0.2.1.
First setup needs internet access; later launches reuse the verified environment
without downloading those wheels again. This is not an arbitrary dependency
search or an automatic device-driver installer. Explicit offline preparation is
documented in [the release guide](packages/cli/RELEASE.md#candidate-preparation).
Its protected release
publishes to `preview` and then independently verifies the public registry;
require the `npm view` check above to succeed before launch. Do not use the old
`tinyedge@preview` package as though it were the current Physical Systems product.

## Run from source

Requirements:

- Node.js 22.19.0 or newer;
- Windows x64/ARM64, or Ubuntu 22.04/24.04 desktop x64;
- on Ubuntu, `secret-tool`, D-Bus, an unlocked Secret Service keyring and
  `xdg-open` for model-provider credentials and browser onboarding.

On Ubuntu, check `node --version` in the same terminal before using `npx`.
Older npm versions may only warn about an unsupported engine; the Physical
Systems launcher exits before loading the application and points to the
persistent Node setup in [DEVELOPMENT.md](DEVELOPMENT.md).

```bash
git clone https://github.com/PhysicalSystems/physicalsystems.git
cd physicalsystems
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache /tmp/physicalsystems-runtime-cache --install-cli
npm start
```

On Windows PowerShell, use
`$env:TEMP\physicalsystems-runtime-cache` for the cache path. See
[DEVELOPMENT.md](DEVELOPMENT.md) for validation and platform-specific setup.

The source bootstrap installs the reviewed terminal compatibility runtime from
this checkout. It does not publish packages, install Python, install device
drivers, or install the local Physical Systems node.

## Connect a development or separately managed node

The published product starts its included Node after first-run setup. Source
developers and operators with a separately managed equipment host can instead
run the Python Node themselves. Its compatibility command is:

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

The Harness connects only to its loopback API at `http://127.0.0.1:8876` by
default. If no node is running, the application remains usable for explanation
but reports discovery as unavailable. If hardware is present without a matching
adapter, it reports the observed device and the adapter gap separately.

The Python command retains its historical name until the node package completes
its own repository and distribution migration. That name is an implementation
detail, not a second product or an account requirement.

## Source ownership

The installed product is developed in two source repositories:

| Repository | Owns |
| --- | --- |
| Public `physicalsystems` | Harness (`packages/cli`), public Python Runtime (`packages/runtime`), shared release coordination and Node release-only verification (`release/node`) |
| Private `node` | Hardware host, concrete adapters, supervision and private implementation |

The Runtime remains an independent Python library used by Node; it is not a
second server. The npm command still installs only the verified backend matching
the user's computer. Consolidating source does not add Python source, wheels or
private Node implementation to the npm archive.

The imported public source commits and intentional adaptations are recorded in
each module's `SOURCE-IMPORT.json`. Old `runtime` and `node-releases` repositories,
release assets and package names remain available during publisher cutover.
See [release coordination and migration status](release/README.md).

## Package contents

- `physicalsystems`: the local-first operator Harness and command.
- `@tinyedge/pi-runtime`: a frozen, separately versioned MIT compatibility
  runtime bundled for a deterministic terminal install.
- frozen `tinyedge@0.1.3`, `@tinyedge/cli@0.1.3` and
  `@tinyedge/pi@0.1.3` source records retained only for published-package
  compatibility and auditability.
- deterministic dependency, license, SBOM, package and release checks.
- public `tinyedge-runtime` Python source in `packages/runtime`, licensed
  separately from the frozen Pi compatibility runtime; it is not bundled into
  the npm package by this source migration.

The historical `tinyedge` names above are immutable npm identities. They do not
mean that a TinyEdge account, cloud connection or device-family enrollment is
required for the local Physical Systems workflow.

## Security and authority boundary

Discovery is read-only. Intent does not authorize motion. A physical operation
must be grounded in observed state, an installed adapter and a commissioned
skill, and future execution must remain inside explicit local limits with
recorded results. Non-loopback plaintext node connections are rejected.

This public repository contains the local client and its release evidence. It
does not contain a hosted control plane, fleet data, billing, production
credentials, private optimization systems or customer telemetry. See
[BOUNDARY.md](BOUNDARY.md), [SECURITY.md](SECURITY.md) and
[SUPPORT.md](SUPPORT.md).

## Develop and validate

```bash
npm test
npx --yes npm@11.19.0 run check:release-packages
git diff --check
```

These checks do not publish or promote an npm package. Publication is restricted
to the protected, main-only OIDC workflow described in
[packages/cli/RELEASE.md](packages/cli/RELEASE.md). The workflow publishes only
`physicalsystems` to `preview`; changing `latest` remains a separate maintainer
decision.

TinyEdge-authored client code is licensed under Apache License 2.0. The frozen
Pi compatibility runtime remains under MIT with its upstream notices. See
[DEPENDENCIES.md](DEPENDENCIES.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [CONTRIBUTING.md](CONTRIBUTING.md).
