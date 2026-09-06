# Desktop development dependency evidence

The Physical Systems desktop client source uses Apache-2.0 under the repository
license. It consumes the existing audited MIT Pi compatibility runtime through
the Harness; those upstream payloads and notices remain unchanged.

Electron 44.2.0 is an exactly pinned development dependency. Its 13-package npm
installation closure is recorded in `package-lock.json` and
`DEPENDENCY-AUDIT.json`. Named license files available in those npm artifacts
are preserved verbatim under `licenses/npm`. Check the collected evidence with:

```sh
node packages/desktop/scripts/audit-dependencies.mjs --check
```

After installing this exact local development dependency closure, a maintainer
can regenerate the records with `--write`. This does not build, publish or
approve an installer.

The `@electron-internal/extract-zip@1.0.5` artifact has no named license file.
Its package and upstream README declare BSD-2-Clause. Complete copyright and
license evidence, including its native Rust dependency closure, remains a
redistribution review item; this file does not grant an exception.

The installed Electron Linux x64 artifact includes `LICENSE` and
`LICENSES.chromium.html`; their exact bytes are hash-recorded in the audit.
They remain in the development installation. A future distributable requires
its own exact binary inventory, complete notices and reviewed release route.
The root product SBOM describes the existing npm product and is not a desktop
installer SBOM. No desktop redistribution is approved by this evidence.
