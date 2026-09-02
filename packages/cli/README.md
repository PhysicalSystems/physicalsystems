# `physicalsystems`

The `physicalsystems` command opens the local-first operator Harness for real
equipment. It discovers observed hardware through a separate local node,
captures the operator's intended outcome, and exposes the gaps that must be
commissioned before an operation can run.

The package is designed for Windows x64/ARM64 and Ubuntu 22.04/24.04 desktop
x64 with Node.js 22.19.0 or newer. Headless Linux, Raspberry Pi, other Linux
targets and macOS have not yet passed the package qualification boundary.

## Install version 0.2.0

Registry tags can change. Require the following check to succeed before
treating `0.2.0` as a published application:

```bash
npm view physicalsystems@0.2.0 version --json
```

Run that exact version without a persistent installation:

```bash
npx physicalsystems@0.2.0
```

`npx` runs an isolated package command; it does not create a global or
persistent `physicalsystems` installation.

Or install an exact persistent command:

```bash
npm install --global physicalsystems@0.2.0
physicalsystems
```

The immutable `tinyedge@0.1.3` and `tinyedge@0.1.5` releases are historical
product identities. They are not part of the `physicalsystems@0.2.0` package
graph and are not recommended for a new Physical Systems installation.

For source development, follow the repository's
[DEVELOPMENT.md](../../DEVELOPMENT.md).

## Physical workflow

The Harness renders:

```text
Discover -> Intent -> Plan -> Commission -> Run -> Verify
```

It connects to the local node at `http://127.0.0.1:8876` and first requests
`GET /v2/physical/candidates`. Only observed candidates are shown. Detection,
adapter availability, configuration and commissioned readiness are represented
separately so the UI does not claim that a device works merely because its USB
identity or network endpoint was found.

An operator can describe an outcome in the normal editor or use:

```text
/physical <outcome>
```

When a commissioned state exists, intent planning is bound to that exact state
evidence. In candidate-only mode the outcome is retained, but planning remains
blocked until the selected devices have the necessary adapters, configuration
and commissioned capabilities.

The current release has no motion endpoint. A commissioning draft does not
authorize teaching, exploration or robot movement. `Run` and `Verify` stay
locked until a future versioned executor contract provides explicit limits and
result evidence.

## Local node

The Python node must run on the equipment host. Its current compatibility
command is:

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

The npm package does not install Python, drivers, adapters or the node service.
`TINYEDGE_PHYSICAL_NODE_URL` can override the origin for development, but
non-loopback or plaintext LAN connections are rejected. The environment
variable and Python executable retain historical names until their own package
migration is complete.

## Commands

```text
physicalsystems                  Open the Physical Systems Harness
physicalsystems provider list    List model-provider authentication options
physicalsystems provider login ID
physicalsystems provider logout ID
physicalsystems models [--provider ID]
physicalsystems doctor           Check the local installation
```

Historical cloud login, identity and MCP commands remain available for clients
that already depend on them, but they are not required by the local physical
workflow and are not presented as its product architecture.

On Windows, model-provider credentials use DPAPI for the current user. On
Ubuntu desktop, they use `secret-tool` and the unlocked Secret Service keyring.
There is no plaintext fallback.

## Included compatibility runtime

The package bundles the exact MIT-licensed
`@tinyedge/pi-runtime@0.84.2-tinyedge.1` terminal compatibility artifact. The
historical package name is immutable. Built-in shell and filesystem tools,
ambient extensions, context files, skills, templates and themes are disabled
inside the standalone Harness. The physical workflow receives only its bounded
local discovery and intent tools.

## Development

```bash
npm test
npm run check
npm run pack:check
```

Tests use fixtures and injected requests. They do not call production services,
operate hardware or publish packages. These package checks do not validate live
OAuth, provider onboarding or production hardware execution; those require
separate canaries with disposable credentials and controlled equipment.
