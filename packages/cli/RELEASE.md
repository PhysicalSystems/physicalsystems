# Release checklist

Registry state at the time of this candidate: `tinyedge`, `@tinyedge/cli`, and
`@tinyedge/pi` publish `0.1.1` under both `latest` and `preview`. Version `0.1.2`
is not published, `@tinyedge/pi-runtime@0.84.2-tinyedge.1` is not published,
and there is no verified public `install.ps1` route.

Stage the Windows `0.1.2` candidate under the npm `preview` tag first. Do not
approve it for public access, promote it to `latest`, expose the staged
PowerShell bootstrap at a public route, or remove the package-level Windows
restriction until each applicable item below has independent evidence attached
to the release PR.

- Add Linux Secret Service and macOS Keychain credential-store adapters. The
  CLI must continue to fail closed when a native store is unavailable.
- Confirm npm publish access. The source-license cutover is complete: the three
  TinyEdge-authored `0.1.2` manifests use the approved Apache-2.0 bundle, and
  the compatibility runtime uses MIT with its exact upstream license,
  provenance, scoped notice, SBOM, and third-party notices. No staged manifest
  may be private or use `UNLICENSED`.
- Confirm the canonical source repository is public before dispatch and that
  the release commit is the reviewed public tree. npm trusted publishing uses
  that public source identity for automatic provenance; no alternate signing
  path is implemented. Do not describe GitHub artifact digests as npm
  provenance.
- Configure the protected GitHub environment and npm trust relationships
  described below; stage all four exact versions through OIDC and review them
  before approval.
- Install the packed/published compatibility runtime, facade, core, and
  existing-Pi artifacts on clean Windows x64 and arm64 environments. The clean
  dependency closure must omit the optional clipboard and Photon peers while
  still loading the Pi TUI console helper for the runner architecture. Only
  then generate the installer checksum and expose the staged bootstrap at
  `https://tinyedge.ai/install.ps1`.
- Update the dated release-status blocks in all packed READMEs with the exact
  published versions and evidence. After deployment, fetch the public installer
  and checksum, verify their bytes, and smoke-test every advertised route.
- Run OAuth, provider login, MCP discovery, browser approval, benchmark launch,
  and result comparison against a disposable staging account.
- Verify token revocation, approval expiry, crash-safe idempotent retry, and a
  failed multi-target launch without orphaned device work.
- Pin and review every Pi dependency update; keep built-in tools, ambient
  extensions, skills, prompts, themes, and context files disabled.
- Confirm the packaged tarball contains no credentials, local paths, sessions,
  fixtures, or source maps with private environment data.

Production deployment of the orchestration server, npm publication, and
GitHub push are intentionally separate release actions. Building or testing
this package must never perform any of them.

## Source-license and npm-publication approval

The manual release workflow recognizes two independent repository locks and
stops before its build job while either one exists. Both approved cutovers are
now complete and the files are absent:

- `LICENSE-PENDING.md` protected the source-license decision. Its approved
  cutover removed it while installing the Apache-2.0 bundle for the three
  TinyEdge-authored packages and preserving MIT for the Pi runtime. The
  workflow retains its guard so an unresolved lock cannot be published.
- `NPM-RELEASE-PENDING.md` protected package publication while the public repo,
  namespace bootstrap, package ownership, staged-publisher identity, hosted
  architecture evidence, and review controls were established. Its approved
  cutover removed it and the four release-package `private` flags together.
  The root workspace remains private.

Publishable manifests do not make an npm artifact public by themselves. The
workflow retains both guards so either lock can fail closed if reintroduced,
and executable checks reject a lock/manifest mismatch. The protected, manual
stage workflow is the only automated route authorized by TinyEdge policy; npm
still requires separate 2FA approval before staged bytes become public. An npm
owner technically retains interactive 2FA publication capability, but using it
for the real candidate would bypass the approved evidence and review path and
is prohibited by this release policy.

## One-time runtime package bootstrap

npm staged publishing [cannot create a brand-new package](https://docs.npmjs.com/staged-publishing/#prerequisites).
Before this workflow can stage the audited runtime, `@tinyedge/pi-runtime` must
exist on npm. This is a separate, one-time release action and requires explicit
human approval; neither this workflow nor any repository lifecycle script may
perform it.

1. Prepare a separately reviewed, minimal `@tinyedge/pi-runtime@0.0.0` tarball
   containing exactly `LICENSE`, `README.md`, and an inert `package.json`: MIT
   metadata, no executable code, binary, dependency, command, bundle, or
   lifecycle script, and exactly `publishConfig: { "access": "public" }`. Its
   README must say that it only bootstraps the package name for staged
   publishing; it is not the TinyEdge runtime.
2. Inspect the exact dry-run file list and digests, then have an authorized npm
   maintainer publish it interactively with 2FA under the `bootstrap` tag using
   `npx --yes npm@11.19.0 publish PATH_TO_TARBALL --tag bootstrap --access public --registry=https://registry.npmjs.org/`.
   Do not assign `preview`, and do not publish the real `0.84.2-tinyedge.1`
   payload in this step. npm assigns `latest` to the first public version of a
   new package and rejects removing the package's required initial `latest`
   mapping; until the real runtime is independently approved and promoted,
   require both `bootstrap` and `latest` to resolve only to these exact inert
   `0.0.0` bytes.
3. From an unauthenticated clean environment, independently verify against
   `https://registry.npmjs.org/` that the public package name exists, that
   `dist-tags.bootstrap` and `dist-tags.latest` both resolve to the reviewed
   inert `0.0.0` artifact, `dist-tags.preview` is absent, and that
   `@tinyedge/pi-runtime@0.84.2-tinyedge.1` still returns E404. Attach the
   reviewed tarball digest and registry evidence to the release approval. Set
   that exact registry SHA-512 integrity and SHA-1 shasum as the protected
   environment variables `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and
   `PI_RUNTIME_BOOTSTRAP_SHASUM`; the stage job downloads and re-inspects those
   exact bytes before it can publish anything.
   The immutable bootstrap README's pre-publication tag intent and npm's actual
   first-package tag behavior are recorded in the public
   [registry erratum](../../scripts/npm-bootstrap/REGISTRY-ERRATUM.md).
4. Only after the package exists, configure its GitHub Actions trusted
   publisher for stage-only access to this workflow. The interactive no-code
   bootstrap does not receive this workflow's automatic provenance. Automatic
   provenance applies later to the real staged candidate built from the public
   repository.

## Protected staged-release workflow

`.github/workflows/npm-release.yml` is a manual, main-branch-only release
workflow. It never invokes direct publication, never changes `latest`, and does
not contain or consume a long-lived npm token. It performs the following fixed
sequence for `0.1.2`:

1. Pack `@tinyedge/pi-runtime@0.84.2-tinyedge.1`, the core, the existing-Pi
   add-on, and the facade exactly once on Windows x64, in that dependency order,
   and record each SHA-256 checksum in `release-manifest.json`. The runtime is a
   reviewed MIT compatibility package of Pi `0.84.2`; its provenance pins
   upstream commit `914cf1472e715297caa30db4b9535d534a9eb718`. Its tarball and
   shrinkwrap must contain no clipboard or Photon dependency, and the runtime
   tarball itself must contain no native, WASM, font, image, or example payload.
   The reviewed Pi TUI dependency still supplies its architecture-specific
   Windows console helper. The CLI tarball must carry the reviewed
   `npm-shrinkwrap.json` that
   exactly matches the development lock.
   The `tinyedge` facade is the only package allowed to expose the `tinyedge`
   bin; the scoped core must remain bin-free so npm cannot select a competing
   shim.
2. Upload that candidate as a GitHub Actions artifact, then download and verify
   the same bytes on clean GitHub-hosted Windows x64 and arm64 runners. Each
   runner installs all four local tarballs with normal lifecycle behavior. The
   local runtime tarball is an explicit file dependency, so verification never
   assumes the new runtime is already in the npm registry. Each runner proves
   clipboard, Photon, and the superseded Pi host package were not installed,
   loads the architecture's native console helper, and executes npm's generated
   local and isolated global `tinyedge` command shims.
3. After both verifications pass, enter the protected `npm-release` environment
   on an Ubuntu GitHub-hosted runner with `id-token: write`. Before installing
   the staging client or using OIDC, require the environment-scoped
   `NPM_RELEASE_POLICY_VERSION=v1` sentinel, require the dispatch event to be
   public, and recheck live GitHub API visibility immediately before staging.
4. Recheck every tarball checksum and inspect the actual packed manifests and
   legal files. Fail unless the runtime is the exact reviewed MIT fork and the
   three TinyEdge-authored packages carry the approved Apache-2.0 bundle.
   Local packing and pull-request x64/arm64 checks remain available while this
   manual release workflow stays blocked on unresolved publication policy.
5. With npm `11.19.0`, first prove the no-code runtime bootstrap exists under
   both `dist-tags.bootstrap` and the initial `dist-tags.latest`, then prove that
   `dist-tags.preview` is absent and neither the real runtime candidate nor
   any `0.1.2` package is publicly visible. Only then call
   `npm stage publish --tag preview` in dependency order:
   `@tinyedge/pi-runtime`, `@tinyedge/cli`, `@tinyedge/pi`, and finally
   `tinyedge`, always with explicit `--provenance` so attestation failure is
   fatal. Every registry read, bootstrap download, and stage command is pinned
   to `https://registry.npmjs.org/`, while every packed manifest must have
   exactly `publishConfig: { access: "public" }`; scoped registry/auth redirects
   are rejected before npm receives OIDC authority.
6. Upload the candidate digest, architecture evidence, registry preflight, and
   staging logs. A maintainer must still inspect and approve each stage with 2FA
   before any package becomes public.

Before the first dispatch, configure external controls that cannot be stored in
this repository:

- Create a GitHub environment named `npm-release`, restrict deployments to
  `main`, add required reviewers, and prevent self-review where available. Only
  after independently verifying those controls, set the environment-scoped
  variable `NPM_RELEASE_POLICY_VERSION` to `v1`. Never define that sentinel as
  an organization- or repository-level variable. GitHub expressions can fall
  back to broader variables, so the reviewer must live-verify that no broader
  variable exists and that the value is attached to the protected environment;
  an unset value fails the staging preflight.
- In the same protected environment, set `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and
  `PI_RUNTIME_BOOTSTRAP_SHASUM` to the independently reviewed public 0.0.0
  bootstrap artifact. The workflow requires an exact digest match, inert
  metadata, and the three-file payload; unset or stale values fail closed.
- Confirm the source repository is public before dispatch so npm trusted
  publishing can generate automatic provenance for the real staged candidates.
  This workflow has no private-repository override and no fallback signing
  path. Do not claim this provenance for the earlier interactive no-code
  bootstrap.
- Confirm `EXPORT-PROVENANCE.destination.status` and its executable boundary
  assertion identify the canonical public snapshot. Any non-public or stale
  status must keep the main-branch release guard blocked.
- On each of `@tinyedge/pi-runtime`, `@tinyedge/cli`, `@tinyedge/pi`, and
  `tinyedge` at npmjs.com,
  configure the GitHub Actions trusted publisher for organization `TinyEdgeAI`,
  repository `tinyedge-edge`, workflow filename `npm-release.yml`, and
  environment `npm-release`. Allow **only** `npm stage publish`; do not allow
  direct publication. The runtime trusted publisher can be configured only
  after the separately approved bootstrap makes that package name exist.
- Require 2FA and disallow traditional publishing tokens for every package.
  The workflow relies solely on the short-lived GitHub OIDC identity.

npm reserves one name/version index across both staged and published packages.
Consequently, each staging command fails instead of replacing an existing
published or staged exact version (`0.84.2-tinyedge.1` for the runtime and
`0.1.2` for the other packages). Trusted-publisher tokens cannot list or inspect
other stages, so the environment reviewer must also inspect npm's **Staged
Packages** view before authorizing the job. If a later package collides after an
earlier one was newly staged, reject the new partial stage with 2FA before
retrying; the workflow deliberately cannot remove or approve stages.

After a successful workflow, use an authenticated maintainer session to run
`npm stage list`, `npm stage view`, and `npm stage download` (or use the npmjs.com
Staged Packages view). Compare the downloaded tarballs with the workflow
manifest and complete the live canaries above. Approve and publicly verify with
2FA strictly in dependency order: the exact runtime first, then the CLI, then
the Pi add-on and facade. Do not approve a dependent package while its exact
dependency is still staged. Promotion from `preview` to `latest` remains a
later, separately reviewed action after the exact public artifacts pass
clean-install checks.
