# Desktop validation scope

Automated tests cover the shared Pi host, desktop catalog and IPC boundary,
local/SSH attachment with fakes, application ownership and reconnect races,
renderer lifecycle, and the scripted simulation's complete operator flow.
The actual pinned Pi SDK is exercised offline with inert physical clients.

The source app was also exercised in Electron 44.2.0 on Ubuntu through X11/
Xwayland with sandboxing and context isolation enabled. Its real renderer, main
process and utility host completed discovery, a conversation question, proposal,
exact preparation/approval, three scripted state transitions, receipt verification,
typed JPEG transport/decoding and Stop clearing/release. Ordinary window closure
passed the cleanup handshake, exited successfully and released the catalog lock.
No Node integration or arbitrary command was available to the renderer. This is
source-app evidence, not an installer or native Wayland qualification.

The browser tests include responsive light/dark layouts, empty onboarding,
project expansion without connection changes, conversation selection, scoped
requests, questions and cancellation, saved drafts, and host-loss projection.
Camera regressions preserve decoded-frame/metadata atomicity, expiry under slow
or failed reads, clearing on disconnect/session changes and independent bounded
Stop. Execution regressions retain exact configuration/run/approval bindings,
expiry and independent Stop. Simulation receipts and interrupted histories are
validated without dispatch to real equipment.
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
