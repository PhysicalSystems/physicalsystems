# `tinyedge`

A desktop-source preview of the Pi-powered terminal client for TinyEdge's
remote orchestration boundary. Here, “Pi” names the reviewed terminal runtime;
it is not a claim of Raspberry Pi hardware support. Starting with `0.1.4`, this
one package contains the client library, Pi extension, and user-facing command shim.
Ordinary Harness releases no longer require matching `@tinyedge/cli` and
`@tinyedge/pi` publications.

Version `0.1.5` expands the desktop package boundary from Windows to Ubuntu
22.04 and 24.04 desktop x64. The Ubuntu route uses the session's native Secret Service keyring
and requires `secret-tool`, D-Bus, an unlocked desktop keyring, and `xdg-open`.
Headless Linux, Raspberry Pi, other Linux distributions and architectures, and
macOS remain outside the qualified support boundary.

Source-code availability is not registry evidence. Before using the commands
below, require `npm view tinyedge@0.1.5 version --json` to return
`"0.1.5"`.

Run the exact `0.1.5` package without installing a persistent command:

```bash
npx tinyedge@0.1.5
```

`npx` may cache package files, but it does not add a global `tinyedge` command.
For a persistent command in new terminals, install the exact package globally:

```bash
npm install --global tinyedge@0.1.5
tinyedge
```

Unversioned commands follow npm's current dist-tags and are not evidence for a
specific release. Version `0.1.4` was the Windows-only one-package preview. The
`0.1.3` release used separate `tinyedge`,
`@tinyedge/cli`, and `@tinyedge/pi` artifacts; those immutable versions remain
available for compatibility but are not part of the `0.1.5` release graph.
Historical package checks did not validate production OAuth, login, or live
MCP execution.

The chat command depends on the exact MIT-licensed
`@tinyedge/pi-runtime@0.84.2-tinyedge.1` compatibility package derived from
the reviewed Pi 0.84.2 artifact. The complete locked closure is bundled inside
`tinyedge` so npm 11 and npm 12 install the same reviewed bytes from the one
user-facing package. Its text-first default install excludes the optional
native clipboard and Photon/WASM image-processing peers. Every Pi built-in tool
is disabled. Ambient extensions, context files, skills, templates, and themes
are disabled too. The standalone Harness can call only its local discovery and
intent-planning tools. The separate cloud commands retain their fixed TinyEdge
MCP allowlist selected from scopes explicitly granted at login.
Run- and task-specific tools accept only exact IDs returned by discovery in the
same chat. It cannot access a shell, filesystem, SSH, or credentials. Every
consequential operation remains subject to TinyEdge's immutable plan,
idempotency, cost hold, and browser-approval boundary.

## Harness behavior

Bare `tinyedge` opens the native Pi terminal interface as a local-first Physical
Systems Harness. It checks the loopback Physical Systems node and shows only
device candidates that node actually observed. It does not connect a TinyEdge
account, open TinyEdge OAuth, or populate a cloud device-family table.
Model-provider onboarding remains separate and happens through Pi's `/login`.

The explicit commands below remain available for scripting, diagnostics, and
credential administration.

### Physical Systems workflow

The standalone Harness contains the local Physical Systems workflow. It
connects only to a loopback Physical Systems node (default
`http://127.0.0.1:8876`) and renders actual evidence as:

```text
Discover → Intent → Plan → Commission → Run → Verify
```

On startup the client first requests the enrollment-free
`GET /v2/physical/candidates` endpoint.
It distinguishes detected, adapter-available, setup-required, commissioned,
and ready devices. Only observed candidates are rendered; configured but absent
demo devices are not shown. Older nodes that do not implement candidate
discovery can still serve the enrollment-bound state endpoint, but the Harness
filters that response to physically detected devices. Because a commissioned
node also exposes candidate discovery, the Harness checks the v1 state endpoint
after v2 discovery and uses its enrolled snapshot and binding when available.
A documented `409` means the node is candidate-only. It does not invent an
object, motion, or workflow. The operator can describe an outcome in the normal
Pi editor, or use `/physical <outcome>` for the same bounded local flow without
a model. In candidate-only mode the Harness records that intent and explicitly
blocks planning until the observed devices have been selected and commissioned;
it never submits a candidate snapshot digest to the enrollment-bound v1 intent
route. Once the node has a commissioned configuration, the Harness refreshes
discovery, binds the request to that exact evidence, and shows the grounded
plan, question, or commissioning gap returned by the node. When the intent is
grounded but the physical setup still needs
learning or validation, the Harness can prepare a commissioning draft bound to
the exact interpretation digest, gap, device, and operation evidence returned
by the node. The current node contract does not say whether a gap should be
resolved by teaching, installing, importing, or qualifying a skill, and it does
not provide safe time or trial bounds. The Harness therefore does not infer a
method or budget. Those choices require a future versioned commissioning-plan
contract from the local node.

This source increment has no motion endpoint. `Run` and `Verify` remain locked,
and the commissioning draft is non-authorizing: neither the model nor
`/physical` can select a method, set movement bounds, open the robot, start
exploration, or authorize movement.
The separate Python `tinyedge-agent serve-physical-node` process owns local
camera and device discovery; port `8876` is a JSON API, not a second Harness UI,
and the process must run on the same host.

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

`TINYEDGE_PHYSICAL_NODE_URL` may override the origin, but non-loopback
origins and plaintext LAN connections are rejected.

## Commands

```text
tinyedge         Open the native Pi-powered Physical Systems Harness
tinyedge login   Authorize read-only access through TinyEdge OAuth + PKCE
tinyedge login --allow-write  Explicitly request write access
tinyedge login --allow-run    Explicitly request workload-run access
tinyedge provider list        Show supported model providers and auth methods
tinyedge provider login ID    Connect a model provider using OAuth or API key
tinyedge provider logout ID   Remove that provider credential
tinyedge models [--provider ID]  List authenticated provider models
tinyedge chat [--model PROVIDER/MODEL] [PROMPT]
tinyedge whoami  Verify the saved connection without exposing credentials
tinyedge doctor  Check Node, OAuth discovery, saved auth, and MCP reachability
tinyedge logout  Revoke the saved OAuth grants and remove local credentials
```

The default service is `https://tinyedge.ai`. For local tests only, set
`TINYEDGE_BASE_URL` to an HTTP loopback origin such as `http://127.0.0.1:3000`.
Remote plaintext HTTP origins are rejected.

On Windows, OAuth and model-provider credentials are encrypted with DPAPI for
the current Windows user. Only ciphertext is stored beneath
`%APPDATA%/TinyEdge/cli/secrets`; secret plaintext is never placed in process
arguments or printed.

On Ubuntu desktop, credentials are stored through `secret-tool` directly,
without a shell, and secret values are sent only over standard input. The
client fails closed when the helper, Secret Service, or an unlocked keyring is
unavailable; there is no plaintext fallback or headless file-store fallback.

TinyEdge OAuth authorizes access to the TinyEdge MCP service. Pi model-provider
authentication is separate and is managed by the provider commands above.
`tinyedge chat` refuses to start without TinyEdge read scope. Write and run
tools appear only after a deliberate `login --allow-write` or
`login --allow-run`; the server still requires exact browser approval for
consequential work.

The native Harness preserves Pi's editor, model picker, action rendering,
session UI, and token/cost footer. Direct shell commands, built-in Pi tools, ambient extensions,
skills, templates, themes, and context files remain disabled in the standalone
TinyEdge Harness. Authoritative state and evidence stay in TinyEdge rather
than Pi's local session.

During the standalone Harness lifecycle, TinyEdge also enables Pi's official
offline-startup mode and suppresses its ambient tmux probe. That prevents Pi
from downloading helper tools, refreshing remote catalogs, checking package or
Pi versions, sending install telemetry, or spawning a tmux subprocess. It does
not disable inference through the model deliberately selected for the session.

## Release and validation boundaries

- Package metadata accepts Windows and Linux. Release qualification covers
  Windows x64, native Windows ARM64, and Ubuntu 22.04/24.04 desktop x64; it does not imply
  support for headless Linux, Raspberry Pi, other Linux targets, or macOS.
- Ubuntu qualification uses the exact packed artifact for normal local,
  global, and npm-exec installs, native Secret Service storage, and an
  interactive pseudo-terminal Harness render/input/exit smoke test. The npm
  package does not yet install or supervise the separate Python physical node.
- Packed-artifact, native-binding, and command-shim checks do not validate
  production OAuth, provider onboarding, MCP execution, or browser approval.
  Those paths require separate canaries with disposable accounts.
- Release evidence must identify the exact artifacts and accepted provenance;
  a GitHub artifact checksum is not npm provenance.

## Development

```bash
npm test
npm run check
npm run pack:check
```

Tests use local fixtures and injected `fetch` implementations. They never call
TinyEdge production or use real credentials, so they do not constitute live
OAuth or provider validation.
