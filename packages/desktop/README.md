# Physical Systems desktop development

This is a working source development app built on the existing Pi Harness and
Workcell controllers. It is a private `0.0.0` package, separate from the published
`physicalsystems` command. There is no installer or automatic update route.

## Run from source

Use Node.js 22.19.0 or newer and the repository's pinned npm 11.19.0 preparation
route. From the repository root:

```sh
npx --yes npm@11.19.0 --prefix packages/cli run bootstrap:pi-runtime -- --cache /tmp/physicalsystems-runtime-cache --install-cli
npx --yes npm@11.19.0 --prefix packages/desktop ci
npm run desktop:dev -- --data-dir "$HOME/.local/share/physicalsystems-desktop-development"
```

The Electron dependency is pinned to 44.2.0. This source command requires a
graphical desktop and Electron's sandbox support. Do not disable the sandbox to
work around a startup problem. The optional `--data-dir` must be absolute; its
default is the operating system's app-data directory under
`PhysicalSystems/desktop-development`.

The tested Ubuntu graphical route uses X11/Xwayland. From a terminal in that
desktop session, append `--ozone-platform=x11` if necessary. Native Wayland and
headless Electron are not qualified by this change.

Start with **New project → Simulation**. The Simulation guide is scripted and
uses synthetic devices; it is not an AI model, physics simulation or hardware
qualification. Send “Plan a tray transfer”, answer the destination question,
review the proposal, and open **Run**. Preparation creates an exact waiting run.
Checking its approval box and approving advances a virtual tray/gripper state,
then produces a synthetic receipt. Preview opens only a generated 1 × 1 image
after explicit Start. Stop and receipt checks use the existing controllers.

## Workspace layout

- **Left:** projects with a folder icon, muted computer label and right-aligned
  connection dot. Clicking the project row expands its conversations. Clicking
  a conversation opens its saved history. A project status popover shows the
  authenticated connection and fresh detected-device count; clicking that count
  restores the project's last conversation and opens Devices.
- **Center:** one persistent conversation, streamed assistant replies, questions,
  answers, cancellation and a proposed capability. Conversation titles describe
  the discussion; the proposal names a capability. Each approved invocation is a
  separate run with its own digest, status and receipt.
- **Right:** a compact Devices panel with Setup and Run tabs. It becomes a drawer
  on smaller screens. Active capture/run controls remain visible across project
  navigation. Camera Stop stays independent of an assistant response or an
  ordinary pending action.

## Existing local or SSH Node

Creating a real project saves its profile without starting a connection. For a
local Node, use its loopback HTTP origin. For SSH, provide the computer, user,
remote Node port and optional absolute key/known-hosts paths. The system SSH
client uses strict existing host trust, key/agent authentication, a loopback-only
forward and no remote commands. It does not install, start or upgrade Node.

Save the Node's camera authorization token and, when applicable, its separate
execution token through the project's Settings. They stay in the native
credential store under a namespace specific to this desktop data directory.
There is no plaintext credential fallback. Provider sign-in and model selection
are in **Model & app settings**, using the same reviewed Pi provider runtime.
Provider sign-in URLs open in the system browser only after an explicit click;
the renderer cannot supply an arbitrary URL to open.

**Connect** checks both Node discovery identity and authenticated camera status;
it does not start capture. A green dot requires a recent successful check.
Detected does not mean commissioned or ready to move. “In use” currently counts
the capture reported by this controller; it is not a fleet utilization metric.
Node names are used as the current public identity claim, not cryptographic
device identities. The app pins the first authenticated name and conservatively
allows only one owner per responding name/endpoint. Distinct Nodes with the same
name must be given distinct identities through their supported setup process.

**Reconnect when the app opens** is an explicit saved preference for the active
project. Only the saved active project reconnects on launch; other projects stay
offline. Reattachment checks the same connection again; it never replays messages,
opens previews or dispatches runs. Intermittent status failures clear current
connection claims. After the first failed check, four automatic retries use
increasing delays of 4, 8, 16 and 30 seconds. Success clears the connection notice;
exhaustion leaves the project offline with an explicit **Connect** recovery path.
The original capture/run owner remains available for Stop throughout recovery.
SSH transport loss requires **Connect** to recreate only the same forward, while
retaining that controller. Identity changes remain blocked. A failed Stop or
tunnel cleanup retains ownership and offers retry rather than claiming completion.

## Persistence and recovery

The catalog stores project/connection metadata, conversation references, titles
and drafts. Session files live only under the desktop-owned
`harness/harness-sessions` directory. The existing CLI configuration, provider
credentials and installed services are not migrated or modified. Raw camera
frames are never persisted by this app.

The catalog uses a process lock, validation, atomic replacement and a backup.
An existing or invalid catalog is never reset automatically. After a crash,
inspect `catalog.lock` and confirm its recorded process has ended before moving
that lock aside. Preserve the catalog, backup and session files. A host crash
clears live claims and offers relaunch; historical run phases remain historical,
and uncertain physical outcomes still require operator inspection.

This development version keeps one active conversation controller per project.
Changing conversations is blocked while that controller owns an unresolved run
or capture. Changing projects retains its controls. Cancelling the assistant
does not stop equipment. Quit and disconnect refuse to discard owned resources
until their stop or outcome is confirmed. A timed-out request is not permission
to repeat an action; inspect the same operation first.

## Architecture and validation

See [ARCHITECTURE.md](ARCHITECTURE.md) for the process boundaries and
[VALIDATION.md](VALIDATION.md) for the tested scope and qualification gaps.

```sh
npm run test:desktop
PHYSICALSYSTEMS_DESKTOP_BROWSER_TESTS=1 npm run test:desktop
PHYSICALSYSTEMS_DESKTOP_NATIVE_TESTS=1 node --test packages/desktop/test/native-electron.test.js
npm test
npx --yes npm@11.19.0 run check:release-packages
```

The opt-in browser tests require Firefox and geckodriver. They use isolated
profiles and synthetic/application fixtures, never a live Node or model. Keep
screenshots, logs and temporary app data outside the source tree; the optional
`PHYSICALSYSTEMS_DESKTOP_BROWSER_EVIDENCE` variable selects an evidence directory.
The native opt-in requires the installed pinned Electron and an existing X11
desktop session. It uses isolated scripted simulation and synthetic preview.
It inherits the existing display and desktop session bus, uses native mouse
events within the test app, and never installs a missing Electron binary.
See [validation scope](VALIDATION.md) for evidence output and qualification gaps.

Before distribution, the desktop still needs a separately reviewed installer,
dependency/license inventory for the shipped Electron binaries, signing,
platform qualification and an update/recovery policy. Existing npm release
checks validate the existing CLI artifact, not a desktop installer.
The checked [dependency audit](DEPENDENCY-AUDIT.json) records the current missing
license-file evidence for `@electron-internal/extract-zip` and the remaining
native dependency review; redistribution is explicitly unapproved.
