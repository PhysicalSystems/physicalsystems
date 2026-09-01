# TinyEdge Edge

TinyEdge Edge is the public device-side source for the desktop TinyEdge
command-line client, embedded Pi extension, and audited text-first Pi
compatibility runtime. It does not contain the TinyEdge hosted control plane,
scheduler, billing system, fleet data, production operations, or private
optimization intelligence.

## Current status

The source is available under the licenses in this repository. TinyEdge-authored
client code uses Apache License 2.0; the Pi compatibility runtime remains MIT.
Version `0.1.3` remains published to npm under `latest`. Before the `0.1.5`
release workflow runs, the Windows-only one-package `0.1.4` release remains on
`preview`; a successful workflow moves only `preview` to `0.1.5`. The published artifacts passed native
Windows x64 and ARM64 verification, npm signature and provenance checks, and a
clean public registry canary. On Windows with Node.js 22.19.0 or newer, install
and launch the current stable Harness with:

```powershell
npm install --global tinyedge
tinyedge
```

`npx --yes tinyedge@latest` remains a one-shot alternative; it does not install
a persistent command. The older `0.1.1` release remains public as historical
registry evidence but is not the current Harness.

The Windows-only `0.1.4` preview consolidated the command, client, and Pi
extension into the single `tinyedge` artifact. The source tree is preparing
`0.1.5`, which qualifies that same one-package Harness for Ubuntu 22.04 and
24.04 desktop x64.
The immutable
`@tinyedge/cli@0.1.3` and `@tinyedge/pi@0.1.3` releases remain available for
compatibility but are no longer ordinary release artifacts.

## Command ownership

The npm client owns the product-level `tinyedge` command. TinyEdge's Python
benchmark tooling uses `tinydevice`, so the two entry points do not compete for
the same executable name. In PowerShell, diagnose an unrelated executable or
stale global installation on `PATH` with:

```powershell
Get-Command -All tinyedge
```

## What is included

- `tinyedge`: the command, OAuth, credential, MCP, provider, Harness, and Pi
  extension logic in one package.
- `@tinyedge/pi-runtime`: the separately versioned audited MIT Pi compatibility
  runtime, bundled into `tinyedge` so the one-package install retains the
  reviewed graph under npm 11 and npm 12.
- Frozen `0.1.3` facade and existing-Pi source records for compatibility.
- Deterministic package, legal, dependency, SBOM, and release checks.

The `0.1.5` release target and current source-development targets are Windows x64, native
Windows ARM64, and Ubuntu 22.04/24.04 desktop x64 with Node.js 22.19.0 or newer. Windows
uses DPAPI; Ubuntu uses `secret-tool` with an unlocked Secret Service keyring.
Headless Linux, Raspberry Pi, other Linux targets, and macOS remain outside the
qualified package boundary.

## Develop and validate

Clone this repository on a supported desktop and run:

```bash
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache /tmp/tinyedge-pi-runtime-cache --install-cli
npm test
npx --yes npm@11.19.0 run check:release-packages
npm start
```

On Windows, replace the cache path with
`$env:TEMP\tinyedge-pi-runtime-cache` in PowerShell.

The bootstrap packs the local audited runtime, verifies its identity, seeds an
isolated cache, and installs the CLI from the checked-out source instead of
consuming registry runtime bytes. These commands do not stage, publish, deploy,
or change GitHub or npm settings. See [DEVELOPMENT.md](DEVELOPMENT.md) for the
complete source workflow.

## Source and legal boundary

TinyEdge uses an open-edge, proprietary-cloud architecture. The public client
may consume stable service contracts and signed plans, but private orchestration,
fleet policy, quantization and runtime selection intelligence, billing, and
production data stay outside this repository. See [BOUNDARY.md](BOUNDARY.md).

`npm run check:legal` verifies deterministic CycloneDX SBOMs, exact dependency
graphs and integrities, vendored payloads, Pi TUI native helpers, approved legal
evidence, and the default exclusion of Clipboard and Photon. Twelve exact
artifacts lack a named legal file; one carries full MIT text in its README,
while `ignore@7.0.5` carries `LICENSE-MIT`. See [DEPENDENCIES.md](DEPENDENCIES.md),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and the package-level notices
and SBOMs.

The files under `scripts/legal/templates/` are canonical executable review
inputs. Automation requires the live licenses, notices, third-party bundle, and
trademark policy to match the reviewed templates byte-for-byte.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) and sign off every commit under the
[Developer Certificate of Origin](DCO). Report security issues privately using
[SECURITY.md](SECURITY.md); use [SUPPORT.md](SUPPORT.md) for the correct public
or private support route.

## npm release gate

The `0.1.3` packages were published through npm staged publishing. Starting
with `0.1.4`, the protected workflow directly publishes one OIDC-authenticated
`tinyedge` artifact to `preview` after the `npm-release` environment approval.
It never changes `latest`, republishes the audited runtime, or uses a long-lived
npm token. Canary-approved promotion remains a separate maintainer action in
[packages/cli/RELEASE.md](packages/cli/RELEASE.md).
