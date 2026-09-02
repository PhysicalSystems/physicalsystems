# Release checklist

## Package transition

The Harness now ships as the unscoped `physicalsystems` package and installs
the `physicalsystems` command. The first real release under that identity is
`physicalsystems@0.2.0`.

The public `tinyedge@0.1.3` (`latest`) and `tinyedge@0.1.5` (`preview`)
releases are immutable historical artifacts. This workflow never republishes
them or moves their tags. The frozen `@tinyedge/cli@0.1.3` and
`@tinyedge/pi@0.1.3` releases also remain untouched.

`@tinyedge/pi-runtime@0.84.2-tinyedge.1` remains the separately versioned,
audited MIT compatibility runtime. It is bundled into `physicalsystems` for a
deterministic one-package install, but ordinary Harness releases verify and
reuse its registry bytes rather than republishing it.

## Current release model

`.github/workflows/npm-release.yml` is the only real-code publication route.
It is manually dispatched from `main`, uses npm trusted publishing with GitHub
OIDC, and is protected by the `npm-release` environment.

The workflow:

1. Builds `physicalsystems@0.2.0` once on Windows x64 and records exact
   tarball checksums.
2. Verifies those same bytes on Windows x64, native Windows ARM64, Ubuntu
   22.04, and Ubuntu 24.04 with the pinned npm 11 release client and npm 12
   consumer behavior.
3. Exercises normal local, global, and isolated npm-exec installation,
   command shims, the bare Harness, the embedded client and Pi extension, and
   Ubuntu Secret Service integration.
4. Enters the protected environment only after all platform checks pass and
   requires `NPM_RELEASE_POLICY_VERSION=v3-physicalsystems-preview`.
5. Verifies the inert namespace bootstrap, the already-published runtime, and
   that `physicalsystems@0.2.0` is not already public.
6. Publishes exactly one tarball:

   ```bash
   npm publish "./release-artifacts/physicalsystems-0.2.0.tgz" \
     --registry="https://registry.npmjs.org/" \
     --provenance --tag preview --access public
   ```

7. Confirms `bootstrap=0.0.0`, `latest=0.0.0`, and `preview=0.2.0`; compares
   registry integrity and shasum with the approved tarball; requires SLSA v1
   provenance; and runs `npm audit signatures`.

The workflow does not use a long-lived npm token, publish the runtime, change
`latest`, or contain a lifecycle publishing script. Local packing and tests
never publish or alter registry state.

## One-time namespace bootstrap

npm trusted publishing can be configured only after the package exists. A
maintainer must therefore perform one narrowly reviewed, interactive bootstrap
before the first OIDC release:

1. Pack `scripts/npm-bootstrap/physicalsystems-0.0.0` with the pinned npm CLI.
2. Verify that the tarball contains only `LICENSE`, `README.md`, and
   `package.json`; its manifest must contain no command, code, dependencies,
   bundles, or lifecycle scripts.
3. Publish only this inert tarball with 2FA under the non-default `bootstrap`
   tag:

   ```bash
   npx --yes npm@11.19.0 publish PATH_TO_PHYSICALSYSTEMS_0.0.0_TARBALL \
     --tag bootstrap --access public --registry=https://registry.npmjs.org/
   ```

   npm creates an initial `latest=0.0.0` mapping for a brand-new package even
   when this command uses `--tag bootstrap`. This is expected and remains inert
   until the separately reviewed `0.2.0` release is manually promoted.

4. Record its registry SHA-512 integrity and SHA-1 shasum as the protected
   environment values `PHYSICALSYSTEMS_BOOTSTRAP_INTEGRITY` and
   `PHYSICALSYSTEMS_BOOTSTRAP_SHASUM`.
5. Configure the npm trusted publisher for package `physicalsystems`, GitHub
   organization `PhysicalSystems`, repository `physicalsystems`, workflow
   `npm-release.yml`, and environment `npm-release`, allowing `npm publish`.

The interactive exception is only for the inert namespace proof. It is not an
alternate route for application code and does not receive automatic npm
provenance.

The historical `@tinyedge/pi-runtime@0.0.0` namespace bootstrap remains
verified by the workflow using `PI_RUNTIME_BOOTSTRAP_INTEGRITY` and
`PI_RUNTIME_BOOTSTRAP_SHASUM`.

## GitHub controls

- Limit the `npm-release` environment to the exact `main` branch.
- Disable administrator bypass and require a human reviewer.
- Store all four bootstrap integrity values on that environment.
- Set `NPM_RELEASE_POLICY_VERSION=v3-physicalsystems-preview` only after the
  `physicalsystems` trusted publisher has been verified.
- Keep the canonical source repository public for npm provenance.

## Canary and promotion

After publishing to `preview`, verify from clean Windows and Ubuntu desktop
environments:

```bash
npm view physicalsystems@0.2.0 version dist.integrity dist.shasum dist.attestations --json
npm view physicalsystems dist-tags --json
npx --yes physicalsystems@0.2.0 --version
npm install --global physicalsystems@0.2.0
physicalsystems
```

Also create an empty audit directory, install with
`npm install --ignore-scripts --no-audit --no-fund physicalsystems@0.2.0`, and
run `npm audit signatures`. Use a disposable account for optional cloud OAuth
or MCP canaries; package checks are not production-service evidence.

Only after the canary is accepted may a maintainer promote the exact bytes:

```bash
npm dist-tag add physicalsystems@0.2.0 latest
```

Promotion requires maintainer presence and npm 2FA. If the preview fails, do
not promote it; fix the problem and publish a new patch version. A rollback
moves only `latest` to the last validated `physicalsystems` version and leaves
`preview`, `bootstrap`, and all historical TinyEdge tags intact.
