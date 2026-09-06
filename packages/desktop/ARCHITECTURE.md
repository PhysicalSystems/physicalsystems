# Desktop architecture

The desktop reuses the existing Pi session and Physical Systems tool ceiling.
The shared `createHarnessRuntime` now initializes both the terminal and embedded
host; this avoids a second agent engine or a separate hardware command path.
The desktop host adds persisted sessions, sanitized transcript events, prompt
deduplication, cancellation, model selection and a direct Workcell subscription.

```text
Electron renderer (sandboxed, no Node, no network or credentials)
    │ allowlisted typed IPC and sanitized snapshots
Electron main (local assets, native window, validated sender)
    │ bounded utility-process requests / snapshot events
Desktop application host (catalog, sessions, credential references, ownership)
    ├── Pi Harness host ── existing Workcell / execution controllers
    │                        └── existing versioned Node clients
    ├── local or strict SSH attachment ── existing authorized Node
    └── scripted simulation host ── public-contract in-memory clients
```

The renderer uses plain JavaScript and the existing view-state helpers and
Workcell controls. Reusing these preserves the tested freshness, atomic frame
swap and exact approval behavior. Adopting assistant-ui would require adapting
the Pi event/state lifecycle and the same device controls into React; it does
not remove that work in this first implementation. This is an integration choice,
not a measured performance comparison.

The renderer cannot execute shell commands, open a live camera through browser
permissions, read credential files, navigate to remote content, or authorize an
arbitrary IPC command. All dynamic transcript text is inserted as text. Frame
bytes arrive through the existing camera controller and a bounded IPC path;
the image and exact frame metadata become visible together after decoding.

The main process serves an exact asset allowlist under a privileged local
scheme. Its renderer has sandboxing, context isolation and web security enabled;
Node integration, webviews, new windows, renderer permissions and remote
requests are disabled. The native browser can open only the current provider
sign-in destination validated by the host. The utility process keeps Node
tokens and Pi credentials out of renderer state.

Connection status, discovery, capability readiness and execution authority are
separate facts. Periodic authenticated health checks cannot refresh routing or
retire a reviewed proposal. Each physical command is bound to its owning
project and connection generation, with the original controller's camera/run
identity and digest checks still enforced. A late health check cannot resurrect
a disconnected project. A second project cannot create another owner for an
already attached Node identity.

The simulator is an explicit example host, not private Node code. It validates
public routes, run states, approvals and receipts through existing contracts.
Its tiny virtual tray/gripper model helps exercise the operator workflow; it
provides no evidence of collision avoidance, robot kinematics, actuator stopping
or physical qualification.

This package is excluded from npm publication. Electron is a pinned development
dependency in its own lockfile; the published CLI closure and component versions
remain unchanged. Any future installer needs an explicit source/dependency
review, Electron/Chromium third-party notices and exact artifact qualification.
