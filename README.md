# TinyEdge Edge

TinyEdge Edge is the public device-side source for the Windows TinyEdge
command-line client, npm facade, Pi extension, and audited text-first Pi
compatibility runtime. It does not contain the TinyEdge hosted control plane,
scheduler, billing system, fleet data, production operations, or private
optimization intelligence.

## Current status

The source is available under the licenses in this repository. TinyEdge-authored
client code uses Apache License 2.0; the Pi compatibility runtime remains MIT.
Version `0.1.2` is **not published to npm**. `NPM-RELEASE-PENDING.md` blocks the
release workflow before it can build, stage, or publish, and `private: true` in
all four package manifests independently refuses npm publication.

The currently published `tinyedge@0.1.1` prints CLI help when invoked without a
subcommand. It does not launch the native Harness in this repository. Until the
exact `0.1.2` artifacts pass staged release and clean-machine validation,
`npx tinyedge` is not the native out-of-box experience described here.

Source availability and npm publication are separate transitions. Local
validation may use `npm pack`; it does not publish anything.

## Command ownership

The npm client owns the product-level `tinyedge` command. TinyEdge's Python
benchmark tooling uses `tinydevice`, so the two entry points do not compete for
the same executable name. Once a reviewed version is published, prefer
`npx tinyedge` to avoid ambiguity with an unrelated executable already on
`PATH`. In PowerShell, diagnose every matching command with:

```powershell
Get-Command -All tinyedge
```

While `0.1.2` remains unpublished, use the source workflow below instead of
treating the registry's legacy `0.1.1` command as the current Harness.

## What is included

- `tinyedge`: the command facade intended to own the `tinyedge` executable.
- `@tinyedge/cli`: OAuth, credential, MCP, provider, and Harness client logic.
- `@tinyedge/pi`: TinyEdge tools for an existing Pi installation.
- `@tinyedge/pi-runtime`: the audited MIT Pi compatibility runtime used by the
  text-first Harness.
- Deterministic package, legal, dependency, SBOM, and release checks.

The supported source-development targets are Windows x64 and native Windows
ARM64 with Node.js 22.19.0 or newer. The credential store currently relies on
Windows DPAPI. macOS and Linux support are separate work and must not be
inferred from npm availability.

## Develop and validate

On Windows, clone this repository and run:

```powershell
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache "$env:TEMP\tinyedge-pi-runtime-cache" --install-cli
npm test
npx --yes npm@11.19.0 run check:release-packages
npm start
```

The bootstrap packs the local audited runtime, verifies its identity, seeds an
isolated cache, and installs the CLI without relying on the unpublished runtime
version in the npm registry. These commands do not stage, publish, deploy, or
change GitHub or npm settings. See [DEVELOPMENT.md](DEVELOPMENT.md) for the
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

Package publication remains blocked until the no-code runtime namespace
bootstrap, protected GitHub release environment, independent review, npm 2FA
and trusted publishing, empty staging slots, hosted Windows x64/ARM64 checks,
and clean-user live canaries all have current evidence. The detailed fail-closed
procedure is in [packages/cli/RELEASE.md](packages/cli/RELEASE.md).
