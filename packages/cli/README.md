# `@tinyedge/cli`

A Windows preview of the Pi-powered terminal client for TinyEdge's remote
orchestration boundary. This scoped core is an importable library; the
`tinyedge` facade is the sole owner of the user-facing command shim.

Source-code availability is not registry evidence. Before using the commands
below, require `npm view tinyedge@0.1.2 version --json` to return
`"0.1.2"`.

Run the exact `0.1.2` facade without installing a persistent command:

```powershell
npx tinyedge@0.1.2
```

`npx` may cache package files, but it does not add a global `tinyedge` command.
For a persistent command in new terminals, install the exact facade globally:

```powershell
npm install --global tinyedge@0.1.2
tinyedge
```

Unversioned commands follow npm's current dist-tags and are not evidence for a
specific release. Historical release evidence captured 2026-08-17 confirmed
that bare `0.1.1` prints help instead of opening the native Harness; that audit
did not exercise its production login or chat paths.

The chat command depends on the exact MIT-licensed
`@tinyedge/pi-runtime@0.84.2-tinyedge.1` compatibility package derived from
the reviewed Pi 0.84.2 artifact. Its text-first default install excludes the
optional native clipboard and Photon/WASM image-processing peers. Every Pi
built-in tool is disabled. Ambient extensions, context files, skills,
templates, and themes are disabled too. Pi can call only a fixed TinyEdge MCP
allowlist selected from the scopes explicitly granted at login.
Run- and task-specific tools accept only exact IDs returned by discovery in the
same chat. It cannot access a shell, filesystem, SSH, or credentials. Every
consequential operation remains subject to TinyEdge's immutable plan,
idempotency, cost hold, and browser-approval boundary.

## Harness behavior

Bare `tinyedge` opens the native Pi terminal interface with a TinyEdge header,
the devices paired to the signed-in account, and only the reviewed TinyEdge
MCP tools. If the terminal is not connected yet, authorization opens from
inside the Harness. Model-provider onboarding also happens in the Harness.
The terminal stays open after either flow completes.

The explicit commands below remain available for scripting, diagnostics, and
credential administration.

## Commands

```text
tinyedge         Open the native Pi-powered TinyEdge Harness
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
arguments or printed. The preview deliberately fails closed on Linux and macOS
until native Secret Service and Keychain adapters are implemented.

TinyEdge OAuth authorizes access to the TinyEdge MCP service. Pi model-provider
authentication is separate and is managed by the provider commands above.
`tinyedge chat` refuses to start without TinyEdge read scope. Write and run
tools appear only after a deliberate `login --allow-write` or
`login --allow-run`; the server still requires exact browser approval for
consequential work.

The native Harness preserves Pi's editor, model picker, action rendering,
session UI, and token/cost footer. `/tinyedge-devices` refreshes the account's
device inventory. Direct shell commands, built-in Pi tools, ambient extensions,
skills, templates, themes, and context files remain disabled in the standalone
TinyEdge Harness. Authoritative state and evidence stay in TinyEdge rather
than Pi's local session.

During the standalone Harness lifecycle, TinyEdge also enables Pi's official
offline-startup mode and suppresses its ambient tmux probe. That prevents Pi
from downloading helper tools, refreshing remote catalogs, checking package or
Pi versions, sending install telemetry, or spawning a tmux subprocess. It does
not disable inference through the model deliberately selected for the session.

## Release and validation boundaries

- This package remains Windows-only until native Secret Service and macOS
  Keychain credential adapters exist.
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
