# Run TinyEdge from source

This workflow runs the reviewed client directly from the public source as an
alternative to the published npm release. It does not change npm's `latest` or
`preview` tags and does not replace a public-registry release canary.

## Requirements

- Windows x64, Windows ARM64, or Ubuntu 22.04/24.04 desktop x64.
- Node.js 22.19.0 or newer.
- Git.
- On Ubuntu: `secret-tool`, D-Bus, an unlocked Secret Service keyring, and
  `xdg-open` in the desktop session.
- A supported model-provider credential for conversational Harness use. A
  TinyEdge account is required only for the separate cloud commands.

## Clone and verify

```powershell
git clone https://github.com/PhysicalSystems/tinyedge-edge.git
cd tinyedge-edge
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache "$env:TEMP\tinyedge-pi-runtime-cache" --install-cli
npm test
npm run doctor
```

On Ubuntu desktop, install the native helpers and use a POSIX cache path:

```bash
sudo apt-get update
sudo apt-get install --yes libsecret-tools dbus-x11 gnome-keyring xdg-utils
git clone https://github.com/PhysicalSystems/tinyedge-edge.git
cd tinyedge-edge
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache /tmp/tinyedge-pi-runtime-cache --install-cli
npm test
npm run doctor
```

The pinned bootstrap packs the local audited Pi compatibility runtime twice,
verifies byte identity against the CLI lock, seeds an isolated npm cache, and
installs the CLI from the checked-out runtime instead of consuming registry
runtime bytes. It does not stage or publish any package.

`doctor` checks Node.js and the optional cloud credential/OAuth/MCP route. Its
TinyEdge-login warning does not block the local-first Physical Systems Harness.

## Launch

```powershell
npm start
```

The first interactive Harness launch checks the local Physical Systems node and
can guide model-provider onboarding. It does not open TinyEdge account OAuth.
The explicit cloud and provider commands remain separately available:

```powershell
node packages/cli/src/cli.js login
node packages/cli/src/cli.js provider list
node packages/cli/src/cli.js provider login PROVIDER
node packages/cli/src/cli.js
```

Physical discovery requires the separate `tinyedge-agent
serve-physical-node` process on the same host. This npm package consumes its
loopback JSON API; it does not install Python, hardware adapters, or the node
service. Without that process the Harness remains open and reports the node as
unavailable instead of inventing devices.

On the Ubuntu equipment host, the enrollment-free discovery node starts with:

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

The Harness consumes `GET /v2/physical/candidates`, then probes the versioned
v1 state route. Candidate discovery is read-only; a v1 `409` keeps planning
blocked, while a valid commissioned state supplies the binding used by the v1
intent route.

The npm client owns the `physicalsystems` command; Python benchmark tooling uses
`tinydevice`. For the published npm release, prefer `npx --yes physicalsystems` to
avoid ambiguity with an unrelated executable on `PATH`. To inspect every
PowerShell match, run:

```powershell
Get-Command -All physicalsystems
```

Use `npm start` when you intend to run the checked-out source. Use
`npx --yes physicalsystems` when you intend to run the current public npm release.

Do not copy credentials into an issue, terminal transcript, or chat. Windows
uses the current user's DPAPI boundary; Ubuntu uses the unlocked Secret Service
keyring and has no plaintext fallback.

## What this proves

This proves that the reviewed source can install and launch on that computer.
It does not by itself prove the current public npm bytes, a global command
installation, production OAuth completion, provider quota, workload execution,
or platform support beyond the machine actually tested. Record source and
release evidence separately.
