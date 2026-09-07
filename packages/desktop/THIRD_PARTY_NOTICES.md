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
can verify the recorded Linux x64 Electron notice hashes against the installed
artifact with `--check-installed`, or regenerate the records with `--write`.
The default `--check` needs no installed Electron and verifies the lockfile and
collected npm evidence only. These commands do not build, publish or approve an
installer.

The `@electron-internal/extract-zip@1.0.5` artifact has no named license file.
Its package and [pinned upstream README](https://github.com/electron/extract-zip/blob/b83e459fd04c53b0a1c8438a6792df8f64be47fc/README.md)
declare BSD-2-Clause. This is development installation tooling; the desktop
application does not import it. Redistribution of its npm artifact or native
binaries requires complete copyright/license evidence and review of the actual
embedded dependency closure. Cargo lock entries alone do not establish which
dependencies ship in each target binary. A future candidate must demonstrate
whether this tooling is excluded and inventory all shipped Electron/application
binaries and notices. This file does not grant an exception or assert that the
tooling must ship in an end-user application.

The installed Electron Linux x64 artifact includes `LICENSE` and
`LICENSES.chromium.html`; their exact bytes are hash-recorded in the audit.
They remain in the development installation. A future distributable requires
its own exact binary inventory, complete notices and reviewed release route.
The root product SBOM describes the existing npm product and is not a desktop
installer SBOM. No desktop redistribution is approved by this evidence.
