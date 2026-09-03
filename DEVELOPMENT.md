# Run Physical Systems from source

Use this workflow while the functional `physicalsystems@0.2.0` package is not
yet available from npm. It runs the reviewed application directly from the
public source and does not publish or change npm dist-tags.

## Requirements

- Windows x64/ARM64, or Ubuntu 22.04/24.04 desktop x64.
- Node.js 22.19.0 or newer.
- Git.
- On Ubuntu: `secret-tool`, D-Bus, an unlocked Secret Service keyring and
  `xdg-open` when model-provider onboarding is used.

## Clone and launch

Windows PowerShell:

```powershell
git clone https://github.com/PhysicalSystems/physicalsystems.git
cd physicalsystems
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache "$env:TEMP\physicalsystems-runtime-cache" --install-cli
npm start
```

Ubuntu desktop:

```bash
sudo apt-get update
sudo apt-get install --yes libsecret-tools dbus-x11 gnome-keyring xdg-utils
git clone https://github.com/PhysicalSystems/physicalsystems.git
cd physicalsystems
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache /tmp/physicalsystems-runtime-cache --install-cli
npm start
```

The bootstrap packs and verifies the frozen terminal compatibility runtime from
this checkout before installing the CLI locally. It does not install Python,
device drivers or the local node, and it never publishes a package.

## Connect hardware discovery

The Harness is the operator application. Hardware access belongs to the
separate local node running beside the equipment. Its current compatibility
command is:

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

Start the node in one terminal and `npm start` in another. The Harness uses
`GET /v2/physical/candidates` to show only hardware the node observed, then uses
the versioned state and intent routes when a commissioned configuration exists.
A candidate can be physically detected while its adapter remains unavailable;
those are deliberately separate facts.

Port `8876` is a loopback JSON API, not another user interface. Non-loopback
plaintext node origins are rejected. This is the manual/external-node path.

The source candidate also implements managed first-run installation and owned
Node supervision. Its downloadable release index intentionally remains empty
until separately distributed, exact Node/Runtime wheels pass release review.
Maintainers can exercise this path using an explicitly reviewed local manifest,
SHA-256 and wheelhouse via `setup-node`; see the
[managed setup contract](packages/cli/README.md#managed-first-run-setup-release-candidate).
Managed launch selects an ephemeral loopback port and starts discovery only.
It never opens a camera or configures an executor automatically.

## Provider and compatibility commands

The default Harness can guide model-provider onboarding without requiring a
product account. Diagnostic provider commands remain available:

```bash
node packages/cli/src/cli.js provider list
node packages/cli/src/cli.js provider login PROVIDER
node packages/cli/src/cli.js doctor
```

Historical cloud commands remain in the compatibility client but are separate
from local Physical Systems discovery and commissioning.

## Validate a change

```bash
npm test
npx --yes npm@11.19.0 run check:release-packages
git diff --check
```

These checks use local fixtures. They do not prove live hardware operation,
provider quota, production services or registry publication. Record source,
clean-machine package and physical-device evidence separately.
