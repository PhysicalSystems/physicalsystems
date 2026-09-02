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
currently contains only the reviewed inert `0.0.0` namespace bootstrap. The
functional `0.2.0` package is prepared in this repository but is not public
until this command returns `"0.2.0"`:

```bash
npm view physicalsystems@0.2.0 version --json
```

After the separately approved preview release, the one-shot command will be:

```bash
npx --yes physicalsystems@preview
```

Until then, run the application from source. Do not use the old
`tinyedge@preview` package as though it were the current Physical Systems
product.

## Run from source

Requirements:

- Node.js 22.19.0 or newer;
- Windows x64/ARM64, or Ubuntu 22.04/24.04 desktop x64;
- on Ubuntu, `secret-tool`, D-Bus, an unlocked Secret Service keyring and
  `xdg-open` for model-provider credentials and browser onboarding.

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

## Connect a local node

Hardware discovery requires the separate Python node on the same Linux host as
the equipment. In the current implementation its compatibility command is:

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

## Package contents

- `physicalsystems`: the local-first operator Harness and command.
- `@tinyedge/pi-runtime`: a frozen, separately versioned MIT compatibility
  runtime bundled for a deterministic terminal install.
- frozen `tinyedge@0.1.3`, `@tinyedge/cli@0.1.3` and
  `@tinyedge/pi@0.1.3` source records retained only for published-package
  compatibility and auditability.
- deterministic dependency, license, SBOM, package and release checks.

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
