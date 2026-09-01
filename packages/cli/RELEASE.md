# Release checklist

## Released state before 0.1.5

`tinyedge@0.1.3`, `@tinyedge/cli@0.1.3`, and `@tinyedge/pi@0.1.3`
are immutable public releases. `tinyedge@0.1.3` remains under `latest`, while
the Windows-only one-package `tinyedge@0.1.4` release is under `preview`.
`@tinyedge/pi-runtime@0.84.2-tinyedge.1` is also public under those tags, while
its inert namespace proof remains at `bootstrap=0.0.0`. Those releases used npm
staged publishing and separate 2FA approval for each package.

Starting with `0.1.4`, the complete client, Pi extension, and command shim ship
inside one `tinyedge` artifact. The old scoped CLI and existing-Pi package
remain installable at `0.1.3` but are frozen. The audited runtime remains a
separately versioned component with its own release cadence; ordinary Harness
releases verify its exact public bytes, bundle it into `tinyedge`, and never
republish it.

Version `0.1.5` adds Ubuntu 22.04/24.04 desktop x64 after normal packed local, global, and
npm-exec installs; native Secret Service storage; and interactive Harness
render/input/exit evidence pass. There is still no verified public
`install.ps1` route. Headless Linux, Raspberry Pi, other Linux targets, and
macOS remain unsupported.

## Current release model

The repository `tinyedge-edge` has one automated publication route:
`.github/workflows/npm-release.yml`. It is manual, main-only, tokenless, and
protected by the GitHub `npm-release` environment.

The workflow:

1. Refuses to run while `LICENSE-PENDING.md` or
   `NPM-RELEASE-PENDING.md` exists. An unresolved source tree must use `UNLICENSED`
   and cannot produce a publishable artifact.
2. Packs `@tinyedge/pi-runtime@0.84.2-tinyedge.1` and `tinyedge@0.1.5`
   exactly once on Windows x64. The runtime is verification-only; the
   `tinyedge` tarball carries the command, source, exports, complete reviewed
   dependency closure, `npm-shrinkwrap.json`, legal bundle, and SBOM. Bundling
   is required because npm 12 no longer applies a dependency package's
   shrinkwrap during consumer installation.
3. Downloads those same bytes on hosted Windows x64, native Windows ARM64, and
   Ubuntu 22.04/24.04 desktop x64. Each route verifies normal-lifecycle local, isolated
   global, and npm-exec installs with npm 11.19.0 and npm 12.0.2. Every install uses only the `tinyedge`
   tarball, an empty cache, and offline mode; it then checks the exact reviewed
   dependency identities, npm command shims, bare Harness dispatch path, Pi
   extension, and the platform terminal path. Ubuntu also proves a real
   Secret Service round trip and interactive pseudo-terminal render/input/exit.
4. Enters the protected environment only after every Windows and Ubuntu
   verification job passes.
   It requires `NPM_RELEASE_POLICY_VERSION=v2-direct-preview`, confirms the
   source repository is public, verifies the environment's live required
   reviewer and exact `main` branch policy through the GitHub API, rechecks the
   manifest and tarball digests, and compares every packed legal file with the
   reviewed source.
5. Proves `latest=tinyedge@0.1.3`, `preview=tinyedge@0.1.4`, and
   `tinyedge@0.1.5` is not public, then proves the packed runtime is
   byte-identical to the existing registry artifact. It then runs exactly:

   ```bash
   npm publish "./release-artifacts/tinyedge-0.1.5.tgz" \
     --registry="https://registry.npmjs.org/" \
     --provenance --tag preview --access public
   ```

6. Rechecks that `preview=0.1.5` and `latest=0.1.3`, compares registry
   integrity and shasum with the approved tarball, requires SLSA v1 provenance
   metadata, and runs npm's cryptographic signature audit.

The protected GitHub environment is the single pre-publication approval gate.
The package becomes public on `preview` when this command succeeds. CI never
uses `latest`, never publishes the compatibility runtime, and never uses a
long-lived npm token or lifecycle publish script.

Local packing and pull-request Windows/Ubuntu checks remain available while the
manual release workflow stays blocked on unresolved publication policy.
Building or testing never publishes, deploys, pushes, or changes a dist-tag.

## External controls required before dispatch

These controls cannot be committed to the repository:

- On npmjs.com, configure the `tinyedge` trusted publisher for organization
  `PhysicalSystems`, repository `tinyedge-edge`, workflow `npm-release.yml`, and
  environment `npm-release`. Allow **`npm publish`**. The workflow contains no
  `npm stage publish` command.
- Remove the obsolete trusted-publisher grants for `@tinyedge/cli`,
  `@tinyedge/pi`, and `@tinyedge/pi-runtime`. Remove any old `tinyedge` grant
  that authorizes `npm stage publish`; only the workflow/environment binding
  above may retain direct publication authority.
- Keep package publishing access at “Require two-factor authentication and
  disallow tokens.” OIDC remains tokenless; manual tag promotion still requires
  maintainer presence and 2FA.
- In GitHub, select only the exact deployment branch `main` for the
  `npm-release` environment, disable administrator bypass, and add the founder
  as required reviewer. The workflow checks these live settings before
  requesting npm authority. When a second trusted maintainer exists, prevent
  self-review.
- Only after verifying those npm and GitHub settings, set the
  environment-scoped `NPM_RELEASE_POLICY_VERSION` to `v2-direct-preview`.
  Never define that sentinel at repository or organization scope. An unset or
  old value fails closed before npm receives OIDC authority.
- Retain the independently reviewed environment values
  `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and `PI_RUNTIME_BOOTSTRAP_SHASUM`.
- Confirm the canonical source repository is public before dispatch.
  Automatic provenance applies to the real candidate built from the public
  repository. A GitHub artifact digest is not npm provenance.

## Canary and promotion

After direct publication to `preview`, verify registry metadata, signature,
attestation, and exact version:

```powershell
npm view tinyedge@0.1.5 version dist.integrity dist.shasum dist.attestations --json
npm view tinyedge dist-tags --json
$audit = Join-Path $env:TEMP "tinyedge-0.1.5-signature-audit"
New-Item -ItemType Directory -Force $audit | Out-Null
Push-Location $audit
npm init --yes | Out-Null
npm install --ignore-scripts --no-audit --no-fund tinyedge@0.1.5
npm audit signatures
Pop-Location
npm install --global tinyedge@preview
tinyedge --version
tinyedge doctor
```

On Ubuntu desktop, first require Node.js 22.19.0 or newer plus `secret-tool`,
D-Bus, an unlocked Secret Service keyring, and `xdg-open`, then run:

```bash
npm view tinyedge@0.1.5 version dist.integrity dist.shasum dist.attestations --json
npx --yes tinyedge@0.1.5 --version
npm install --global tinyedge@0.1.5
tinyedge
```

Use a disposable account to test production OAuth, provider login, MCP
discovery, browser approval, revocation, Harness startup, and a real read-only
request. Confirm the clean dependency tree excludes Clipboard and Photon.
Attach the canary and workflow evidence to the release issue.

Promotion changes only the tag; it never rebuilds:

```powershell
npm dist-tag add tinyedge@0.1.5 latest
```

Verify `npm view tinyedge dist-tags --json`, then test a clean unversioned
global install. If the canary fails before promotion, leave `latest` untouched
and publish a new patch version. If a promoted release needs rollback, restore exposure in reverse order
by moving only `tinyedge` back to the last validated version:

```powershell
npm dist-tag add tinyedge@0.1.3 latest
```

Leave `preview` and the runtime's `bootstrap` tag untouched as release evidence.

## Historical one-time runtime package bootstrap

npm staged publishing
[cannot create a brand-new package](https://docs.npmjs.com/staged-publishing/#prerequisites).
The inert bootstrap below was completed before the first audited runtime
release. It is historical evidence and must not be recreated.

1. A separately reviewed, minimal `@tinyedge/pi-runtime@0.0.0` tarball contained
   exactly `LICENSE`, `README.md`, and an inert `package.json`: MIT metadata,
   no executable code, binary, dependency, command, bundle, or lifecycle
   script.
2. An authorized maintainer inspected it and was required to publish it interactively with 2FA under the `bootstrap` tag:

   `npx --yes npm@11.19.0 publish PATH_TO_TARBALL --tag bootstrap --access public --registry=https://registry.npmjs.org/`

3. From an unauthenticated clean environment, the maintainer verified the exact
   bytes and required both `bootstrap` and `latest` to resolve only to these
   exact inert `0.0.0` bytes until the real runtime was independently
   published. The registry's first-version tag behavior is recorded in
   [REGISTRY-ERRATUM.md](../../scripts/npm-bootstrap/REGISTRY-ERRATUM.md).
4. The exact SHA-512 integrity and SHA-1 shasum were stored as
   `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and `PI_RUNTIME_BOOTSTRAP_SHASUM`. The
   workflow still downloads and re-inspects those bytes before publication.
5. The interactive bootstrap does not receive this workflow's automatic
   provenance. Automatic provenance applies to the real candidate built from
   the public repository.
