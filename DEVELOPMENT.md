# Run Physical Systems from source

Use this workflow to test the source on `main` or a release candidate before
its protected npm publication. It runs the reviewed application directly and
does not publish or change npm dist-tags.

## Requirements

- Windows x64/ARM64, or Ubuntu 22.04/24.04 desktop x64.
- Node.js 22.19.0 or newer.
- Git.
- On Ubuntu: `secret-tool`, D-Bus, an unlocked Secret Service keyring and
  `xdg-open` when model-provider onboarding is used.

### Persistent Node.js on Ubuntu

Ubuntu may still provide Node.js 12 as `/usr/bin/node`. A temporary `PATH`
change affects only one terminal. Install the required Node version per user
and make it the default for new Bash terminals:

```bash
git clone https://github.com/nvm-sh/nvm.git "$HOME/.nvm" && \
git -C "$HOME/.nvm" checkout --detach b6cf55f6adf3b953d0e5e00a4049444e300e3af8 && \
test "$(git -C "$HOME/.nvm" rev-parse HEAD)" = \
  b6cf55f6adf3b953d0e5e00a4049444e300e3af8 && \
printf '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' \
  >> "$HOME/.bashrc" && \
export NVM_DIR="$HOME/.nvm" && \
. "$NVM_DIR/nvm.sh" && \
nvm install 22.19.0 && \
nvm alias default 22.19.0 && \
node --version
```

Open a new terminal and require `node --version` to report `v22.19.0` or newer
before launching Physical Systems. This user-scoped setup leaves
`/usr/bin/node` unchanged.

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
Node supervision. Its release index pins reviewed Node 0.2.1 / Runtime 0.2.0
wheels for Windows/Linux x64 with CPython 3.10–3.12. First launch asks for software
consent, downloads only the matching verified wheel set, and installs into a
private environment. Later launches reuse it without those downloads. No manual
pip installation or second terminal is needed on this managed path. Maintainers
can also use an explicitly reviewed local manifest, SHA-256 and wheelhouse via
`setup-node` for offline setup; see the
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

## CI and releases

PR and main-branch CI share one source-review candidate across four native
platform jobs. They check source, licenses, dependencies, platform credentials,
SDK compatibility and workflow regressions without repeating the full fresh
installation matrix. The checks keep their established names for branch
protection, but their summaries explicitly identify source-only evidence.

Full local/global/npx installs, actual matching backend downloads and reuse,
and Linux managed first-run acceptance run in the manually dispatched npm
release. That workflow tests the final package before human approval and
publishes the same bytes. Source checks alone cannot qualify a release.
See [the coordinated product flow](packages/cli/NPM-PRODUCT-BUNDLE.md).
