# Run TinyEdge from source

This workflow runs the reviewed client directly from the public source as an
alternative to the published npm release. It does not change npm's `latest` or
`preview` tags and does not replace a public-registry release canary.

## Requirements

- Windows x64 or Windows ARM64.
- Node.js 22.19.0 or newer.
- Git.
- A TinyEdge account and a supported model-provider credential for
  authenticated use.

## Clone and verify

```powershell
git clone https://github.com/PhysicalSystems/tinyedge-edge.git
cd tinyedge-edge
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache "$env:TEMP\tinyedge-pi-runtime-cache" --install-cli
npm test
npm run doctor
```

The pinned bootstrap packs the local audited Pi compatibility runtime twice,
verifies byte identity against the CLI lock, seeds an isolated npm cache, and
installs the CLI from the checked-out runtime instead of consuming registry
runtime bytes. It does not stage or publish any package.

`doctor` should confirm Node.js, Windows DPAPI, OAuth discovery, and MCP
discovery. An absent TinyEdge login is a warning during this first check.

## Launch

```powershell
npm start
```

The first interactive launch can guide TinyEdge authorization and model
provider onboarding. The explicit commands are also available:

```powershell
node packages/cli/src/cli.js login
node packages/cli/src/cli.js provider list
node packages/cli/src/cli.js provider login PROVIDER
node packages/cli/src/cli.js
```

The npm client owns the `tinyedge` command; Python benchmark tooling uses
`tinydevice`. For the published npm release, prefer `npx --yes tinyedge` to
avoid ambiguity with an unrelated executable on `PATH`. To inspect every
PowerShell match, run:

```powershell
Get-Command -All tinyedge
```

Use `npm start` when you intend to run the checked-out source. Use
`npx --yes tinyedge` when you intend to run the current public npm release.

Do not copy credentials into an issue, terminal transcript, or chat. Windows
secrets are stored inside the current user's DPAPI boundary.

## What this proves

This proves that the reviewed source can install and launch on that computer.
It does not by itself prove the current public npm bytes, a global command
installation, production OAuth completion, provider quota, workload execution,
or Windows support beyond the machine actually tested. Record source and
release evidence separately.
