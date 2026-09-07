# Desktop validation scope

Automated tests cover the shared Pi host, desktop catalog and IPC boundary,
local/SSH attachment with fakes, application ownership and reconnect races,
renderer lifecycle, and the scripted simulation's complete operator flow.
The actual pinned Pi SDK is exercised offline with inert physical clients.

On 2026-09-06, the source app was exercised in Electron 44.2.0 on Ubuntu through X11/
Xwayland with sandboxing and context isolation enabled. Its real renderer, main
process and utility host completed discovery, a conversation question, proposal,
exact preparation/approval, three scripted state transitions, receipt verification,
typed JPEG transport/decoding and Stop clearing/release. Ordinary window closure
passed the cleanup handshake, exited successfully and released the catalog lock.
No Node integration or arbitrary command was available to the renderer. This is
source-app evidence, not an installer or native Wayland qualification.

The repeatable native test is opt-in:

```sh
PHYSICALSYSTEMS_DESKTOP_NATIVE_TESTS=1 node --test packages/desktop/test/native-electron.test.js
```

It requires the already installed pinned Electron and an existing Linux X11
desktop session with its display authorization. It creates isolated app data,
uses only the scripted simulation and synthetic preview, and checks ordinary
window shutdown and owned-process cleanup. The optional absolute
`PHYSICALSYSTEMS_DESKTOP_NATIVE_EVIDENCE` directory must be outside the repository.
It records source startup timing and point samples of Electron process working
sets; those are neither live-model streaming benchmarks nor peak-memory figures.
The 2026-09-07 session has no graphical display, so repeating this native test
on the follow-up changes is blocked. The earlier native result does not qualify
the current revision by itself.

The browser tests include responsive light/dark layouts, empty onboarding,
project expansion without connection changes, conversation selection, scoped
requests, questions and cancellation, saved drafts, and host-loss projection.
Camera regressions preserve decoded-frame/metadata atomicity, expiry under slow
or failed reads, clearing on disconnect/session changes and independent bounded
Stop. Execution regressions retain exact configuration/run/approval bindings,
expiry and independent Stop. Simulation receipts and interrupted histories are
validated without dispatch to real equipment.
Run ownership regressions additionally select completed history while another
invocation remains unresolved. Quit, disconnect and session changes must stay
blocked, and the global Stop must target that exact owner without replacing
the selected history or receipt. Incomplete run lists and unconfirmed Stops
must retain ownership.
Browser viewport checks cover 500, 736, 1024 and 1440 pixels; Firefox's minimum
window width prevented a native 360-pixel check. The app-backed browser test
uses the actual catalog, coordinator, shared controllers and simulation host.

No live camera, robot, commissioning or executor configuration is accessed by
these tests. Synthetic preview and headless UI checks do not measure optical or
display flicker. A successful simulation is not a physical execution result.

Release qualification still requires:

- An authorized live local and SSH Node assessment, including authentication,
  provider sign-in, transport recovery and confirmed hardware release.
- Optical/display flicker measurement on an approved camera/display setup.
- Target-platform installer, sandbox, signing and uninstall qualification.
- A shipped-binary dependency/license inventory and desktop update policy.

There is no desktop publishing workflow, installer or automatic updater in this
change. Existing product-package checks do not qualify those future artifacts.
