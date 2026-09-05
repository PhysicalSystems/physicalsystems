# `physicalsystems`

The `physicalsystems` command opens the local-first operator Harness for real
equipment. It discovers observed hardware through a separate local node,
captures the operator's intended outcome, and exposes the gaps that must be
commissioned before an operation can run.

The package is designed for Windows x64/ARM64 and Ubuntu 22.04/24.04 desktop
x64 with Node.js 22.19.0 or newer. Headless Linux, Raspberry Pi, other Linux
targets and macOS have not yet passed the package qualification boundary.

## Install version 0.2.2

Registry tags can change. Require the following check to succeed before
treating `0.2.2` as a published application:

```bash
npm view physicalsystems@0.2.2 version --json
```

Run that exact version without a persistent installation:

```bash
npx physicalsystems@0.2.2
```

`npx` runs an isolated package command; it does not create a global or
persistent `physicalsystems` installation.

Or install an exact persistent command:

```bash
npm install --global physicalsystems@0.2.2
physicalsystems
```

The immutable `tinyedge@0.1.3` and `tinyedge@0.1.5` releases are historical
product identities. They are not part of the `physicalsystems@0.2.2` package
graph and are not recommended for a new Physical Systems installation.

The package requires Node.js 22.19.0 or newer. On an older runtime, npm may
print an `EBADENGINE` warning and continue; the command then exits immediately
with the detected and required versions before loading application code. Follow
the repository's Ubuntu setup instructions, open a new terminal, and retry.

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

The default discovered-device mode has no configured executor. A commissioning
draft does not authorize teaching, exploration or robot movement. `Run` and
`Verify` remain locked until a separate commissioned executor supplies the
versioned lifecycle, explicit limits and result evidence described below.

### Version 0.2.2 terminal and discovery improvements

Version 0.2.2 keeps the persistent workflow summary compact below the input,
so the conversation and editor remain together. `/physical-details` shows the
complete current device inventory, planning/commissioning details and route
evidence in the conversation. It reads the retained snapshot without opening
hardware or refreshing discovery; use `/physical` when a fresh check is needed.

Candidate discovery names devices using their reported labels while retaining
exact IDs for operations. An available adapter or advertised `capture-frame`
operation is not proof of a successful camera capture or healthy driver.
Commissioning alone does not prove calibration validity: those assessments
remain unassessed in candidate-only discovery, and calibration requirements
come from the selected capability/implementation. Node-reported readiness is
not execution permission.

### Agent Skills and capability route previews

These names describe different layers:

- **Agent Skill:** a portable `SKILL.md` instruction package for the assistant.
- **Physical capability:** a typed operation registered on the equipment node.
- **Capability implementation:** a commissioned controller or policy that could
  provide that operation, subject to current evidence and local policy.

The source candidate bundles exactly two Agent Skills: `inspect-workcell` and
`transfer-container`. The Harness uses the reviewed Pi parser for their standard
metadata and advertises them in the assistant prompt. `read_agent_skill` reads
only a named built-in package; it accepts no file path. Package hashes, exact
contents, and non-redirected paths are checked at startup and when read.
Ambient user/project skills and generic filesystem/shell access remain disabled.
A package cannot register tools, grant permissions, establish device readiness,
or supply physical observations. Portable bindings contain capability references,
not workcell IDs, calibration, safety limits, or implementation choices.

For a requested transfer, the assistant can inspect the current physical
capability catalog using `inspect_physical_capabilities`, clarify missing typed
inputs, and call `preview_physical_capability` with the exact current identifiers
and snapshot digests. The node, not the assistant, supplies qualification,
observation and policy evidence to Runtime. The resulting route receipt explains
the selected capability implementation or why none qualifies. Changed or unknown
evidence must not become a success claim; stale responses are invalidated.

Route receipts always retain `physicalExecutionAuthorized: false`. Selection
does not dispatch anything. The separate operator run channel below requires
an available Node-owned executor, an exact local configuration and a fresh
approval for one invocation. The assistant has no approval or execution tool.

The Python routing library and equipment host remain separate components of
the product. Bundling their approved distributions does not establish hardware
readiness: packaged Agent Skills neither provide trusted observations nor
commission controller supervision.

The node routing extra expects `tinyedge-runtime==0.2.0`, separate from the npm
Pi compatibility runtime. The local node's route bridge also requires a trusted
live observation/supervision producer; the default CLI setup has no such producer
and must report that limitation. The npm/Pi cache does not provide it. Synthetic
cross-repository tests prove contract integration only, not a live end-to-end
robot demo or hardware qualification. No NVIDIA skill catalog is copied or
automatically installed.

## Local node

### Bundled workcell view (source candidate)

Inside the running Harness, enter `/workcell`. This explicitly opens a protected
loopback browser view from the **same npm package and same Pi session**. There is
no second assistant, website deployment, account login, or frontend installation.
The terminal remains the place for model/provider setup and session management.
Default startup does not open a browser or a camera.

One shared submission gate covers terminal and browser input, including model
authentication/preflight. While a request is pending, additional prompts,
steering and follow-ups are rejected rather than silently queued. Wait for the
request to finish or interrupt it in the terminal before submitting again.

The view presents only detected devices, accepts a physical outcome through the
existing agent tools, shows that agent's questions and reply, and displays the
node's capability implementation proposal. Operator run controls remain locked
unless the matching execution service and exact configuration are available.
Agent Skills are instructions; route selection is not authorization to execute.

Camera preview requires the matching TIN-403 Node API, the optional OpenCV
adapter, and Node's `serve-physical-node --camera-preview` flag. The trusted
supervisor must give Node and the Harness the same random URL-safe
`PHYSICAL_NODE_CAMERA_TOKEN` (32–256 characters). It remains server-side and is
not passed to the browser, model, URLs, or transcripts. This source slice does
not open a camera automatically. The managed discovery supervisor enables
the preview interface only with a separate private camera credential; the
operator still chooses the detected camera and starts each preview.

Refresh discovery, select an observed camera, and click **Start preview**. The
request is bound to that camera's exact candidate digest; another camera is
never silently substituted. **Stop preview** stops only the selected capture
session and is not a robot emergency stop. Capture started by this Harness is
also stopped best-effort when its session shuts down; closing a browser tab
alone does not stop it. Reopen the authorized view with `/workcell` after a page
reload or session change; its ephemeral browser token is intentionally not
stored. Keep the local session link private.

Stop preview remains available while the assistant or an ordinary view request
is busy, and can use the last known capture identity during a stream outage.
Stopping a pending Start cancels that request; if capture has already begun,
the Harness stops the exact session returned by Node. A cleared image does not
prove the camera was released. If Stop is unconfirmed, retry Stop preview or
reopen `/workcell` to inspect its status. The Harness retains captures it owns
for cleanup until Node confirms they stopped; another Start remains blocked
while a Stop outcome is unresolved.

The view retries brief connection failures automatically. After four consecutive
attempts without a valid streamed state, it shows **Reconnect** and instructions
to reopen with `/workcell`. A recovered stream clears its connection warning;
unrelated action errors remain visible. Reconnecting reuses the authorization
held only in the current page and never starts a camera or retries an action.
Connection startup times out after 6.5 seconds without a valid streamed state.
After connection, 45 seconds without a state update or heartbeat triggers the
same bounded recovery path; camera frames still expire on their own shorter
freshness deadline.

Frames have exact identity and digest links. Stale, disconnected or malformed
frames are hidden. The current CLI preview is **uncalibrated**: it does not detect
a cup, establish that a workspace is clear, publish routing evidence, or enable
motion. An exact-frame calibrated observation can be displayed when a future
trusted producer supplies it, but is still not execution permission.

Local tests use explicitly synthetic frames and scripted agent responses.
They establish transport/UI behavior, not live Ubuntu camera qualification or
a successful physical transfer. The npm registry release is a separate gate.

### Operator invocation lifecycle (TIN-405 source candidate)

The same `/workcell` view includes a **Physical run** panel. A capability is the
typed operation; its implementation is the controller or policy. A local
configuration resolves that implementation to this commissioned setup. A
PhysicalRun is one invocation with pinned inputs and configuration snapshots,
not a controller instance: a deployed controller may serve many separate runs.
There is no separate package/binding management UI.

The trusted supervisor must configure a separate random URL-safe
`PHYSICAL_NODE_EXECUTION_TOKEN` (32–256 characters) on Node and Harness. Like the
camera credential, it remains in server closures, is removed from browser-opener
environments case-insensitively, and is never a model tool argument, browser
credential, URL or transcript field. No driver installation or executor
activation happens automatically.

1. Ask the shared agent for a capability proposal. A successful current route
   and an available matching local configuration are required.
2. Select that configuration and **Prepare invocation**. Node stores the exact
   inputs and immutable snapshot references; preparing is not dispatching.
3. Review mode, full run/configuration/implementation digests and approval expiry.
   Check the explicit confirmation and approve this one invocation. New or
   expired state clears or disables approval. Assistant `ask_choice` answers
   cannot perform this approval.
4. Observe the actual phase and event history. `RUNNING` is not verified success.
   Only Node's `VERIFIED_SUCCESS` outcome is shown as verified; simulation is
   prominently labelled and never proves hardware movement or physical success.
5. **Request stop** remains separate from pending requests and failed status
   reads. An unconfirmed stop requires the physical stop procedure. For
   `OUTCOME_UNKNOWN`, **Check uncertain outcome** asks Node to reconcile stored
   and independent evidence; it never repeats the invocation. **Verify receipt**
   checks stored run and snapshot integrity, then separately fetches the exact
   pinned shared-configuration and outcome-evidence snapshots. It grants no
   new execution authority. Missing or tampered references fail verification.

The receipt view projects only bounded historical check results and known
numerical measurements; it does not expose raw configuration, local paths,
images or provider diagnostics. Geometry is reported in pixels, image brightness
in HSV value (not lux), and color-detector scores are not calibrated
probabilities. Preparation and verification are shown separately, labelled by
the recorded invocation time and simulation/physical mode. A stored `met`
check is not current readiness and does not prove the camera or equipment has
remained in place. No illustrative thresholds are invented by the client.

Geometry, current observations, image quality and real detector scores belong
to the commissioned Node readiness checks. Matching calibration hashes or a
visible camera image do not establish those conditions. Missing, stale or bad
evidence keeps preparation/approval blocked; this UI invents no fixed
millimetre, light-level or confidence thresholds.

All execution API metadata retains `physicalExecutionAuthorized: false`;
approval is a bounded Node-owned transition, not a reusable boolean permission.
The Node owns durable history, resource exclusion, journaling and supervision.
Closing a browser or Harness does not implicitly retry, resume or stop that
controller. Runs survive the view; refresh the history to inspect them. Local
tests use fake run services and do not qualify a live SO-101 installation.

With a matching development Node and the shared execution credential already
configured, `tinyedge-agent serve-physical-node --execution-simulation --port
8876` starts the explicit simulation backend. It uses synthetic discovery and
observations and rejects mixing real camera/workcell options. `--execution-data`
can select a local durable data directory outside the source checkout; otherwise
Node uses its user-data simulation directory. Point the Harness at that local
port and open `/workcell`. This software-only route does not require hardware,
but it is not an npm installer for the Python Node or a physical qualification.

The opt-in `test/execution-node-integration.test.js` accepts
`PHYSICAL_EXECUTION_TEST_PYTHON` and `PHYSICAL_EXECUTION_TEST_NODE_SOURCE`. Supply
an existing Python environment with the pinned Runtime installed and the Node
package source directory. The test starts only the real Node's simulated
registry/router/SQLite HTTP service in an isolated temporary directory, then
drives the real Harness client/controller through explicit preparation,
approval, verification and receipt retrieval. It is skipped by default and
never installs host dependencies or discovers real equipment.
Set `PHYSICAL_EXECUTION_TEST_PACKAGE_ROOT` to an absolute installed
`node_modules/physicalsystems` path to exercise those exact npm package bytes
instead of the source client. This test-only option does not change the
application's module loading or confer hardware authority.

The Python node must run on the equipment host. Its current compatibility
command is:

```bash
tinyedge-agent serve-physical-node --node-name ubuntu-workstation --port 8876
```

The npm package never installs system Python or robot drivers. The product
candidate includes pinned manifests for the separately licensed, approved Node
and dependencies; the managed first-run path downloads only the exact wheel set
matching this computer and installs it into a private Python environment.
First setup needs internet; verified later launches reuse the environment. This is one installation with
modular internals, not a merger of the private Node source into this repository.
`TINYEDGE_PHYSICAL_NODE_URL` can override the origin for development, but
non-loopback or plaintext LAN connections are rejected. The environment
variable and Python executable retain historical names until their own package
migration is complete.

### Managed first-run setup (release candidate)

The Harness, Node and Runtime have separate responsibilities, not three network
services. The Harness is the operator/agent interface. The Node is the one local
hardware-host process. The Runtime is its separately versioned contract library.
The proprietary `physicalsystems-node` wheel contains only reviewed physical
modules; managed cloud code and benchmark/model-build runners stay private.
Python wheels contain readable source, irrespective of their licensing terms.

When this npm release contains an approved Node manifest for the current
platform/Python version, first launch offers to download and install its exact wheel set.
The operator sees the release and wheel size. Setup creates an isolated,
versioned user environment, downloads from fixed manifest URLs without redirects,
verifies every wheel's SHA-256 and size, then invokes pip with no index,
no dependency resolution and hash checking on those verified local files. It
checks dependencies, native-library imports and the installed API version,
then records the successful selection. No `postinstall` or other npm lifecycle
script downloads software. System Python must already include `venv`/`ensurepip`;
missing prerequisites produce one actionable error rather than invoking sudo.

The **managed Node candidate** matrix is Linux x64 and Windows x64 with CPython
3.10, 3.11 or 3.12 (candidate wheel tests use Ubuntu 22.04 and Windows Server
2022). This is separate from the broader Harness-only npm platform matrix above:
Windows ARM64 npm checks do not qualify a managed Node wheel set. The generic
installer recognizes Python 3.13, but no approved 3.13 artifact is available.
Managed setup always requires an approved bundled manifest for the exact
platform and Python minor version; a nonempty index with no match fails closed.

For the qualified Windows 0.2.0 wheel set, the generated environment path must
be at most 126 characters. Setup checks this before installation because legacy
Windows path limits can prevent a required NumPy DLL from being installed.
Choose a shorter absolute `TINYEDGE_CONFIG_DIR` if prompted; setup does not
change Windows registry settings. Managed startup also removes ambient Python
path/home overrides so it loads the verified environment, not a source checkout.

```bash
physicalsystems setup-node --yes
physicalsystems
```

The new Node starts in discovery-only mode with no fabricated devices or
execution configurations. A saved, verified environment is reused on subsequent
launches without downloading the wheels again. This reuses a complete installed
environment; it is not a cross-version dependency cache. A 0.2.0 selection is
checked before offering the pinned 0.2.1 update;
approval is required even if that newer environment is already installed.
Declining or failing the update blocks managed startup and retains the previous
installation and selection. Same-version custom selections are not replaced,
and an older product does not downgrade a newer selection. A damaged installation
is not silently repaired, an interrupted setup lock is not stolen, and upgrading
does not replace a running physical controller.
`PHYSICAL_NODE_EXECUTABLE` and an explicit external Node URL preserve the manual
host paths. Physical commissioning and execution remain separate.

**Current release gate:** `src/physical/node-releases.json` pins the exact reviewed
Node wheel and its complete dependency set for Windows/Linux x64 with
CPython 3.10–3.12. Protected npm publication requires the corrected Node 0.2.1
descriptor set and its exact approved bytes. The npm package still requires
its own packaged installation checks
and protected publication; published Python dependencies alone do not prove
that the npm release is available.

Maintainers can verify a reviewed local artifact without publishing it:

```bash
physicalsystems setup-node --yes \
  --manifest /absolute/reviewed/node-manifest.json --sha256 MANIFEST_SHA256 \
  --wheelhouse /absolute/reviewed/wheels --python /absolute/python3
```

This explicit manifest selection is operator-only; it is never a model tool or
browser request. HTTPS downloads must be direct (redirects are rejected). Source
archives, arbitrary pip indexes, editable projects and dependency resolution from
the network are not supported by managed setup. References:
[pip hash-checked installs](https://pip.pypa.io/en/stable/topics/secure-installs/)
and [Python virtual environments](https://docs.python.org/3/library/venv.html).

### Optional explicitly installed Node supervisor

If the compatible Node is already installed, the Harness can start its own
local child process. This is opt-in through operator environment settings,
never an agent tool or browser request:

```bash
export PHYSICAL_NODE_EXECUTABLE=/absolute/path/to/venv/bin/tinyedge-agent
export PHYSICAL_NODE_EXECUTION_CONFIG=/absolute/path/to/commissioned-host.json
export PHYSICAL_NODE_EXECUTION_DATA=/absolute/path/to/workcell-run-data
export PHYSICAL_NODE_REGISTRY=/absolute/path/to/physical-registry.json
physicalsystems
```

The file is the Node's explicit installed-host configuration, not an Agent
Skill. It must already pin the installed controller, artifacts, devices and
observation requirements; the Harness does not invent it. Physical startup may
open the exact configured devices read-only but sends no motion or torque
commands. Only the later exact operator run approval can dispatch an invocation.

For a software-only test, set `PHYSICAL_NODE_EXECUTION_MODE=simulation` and
`PHYSICAL_NODE_EXECUTION_DATA` with the installed executable; leave the physical
configuration and registry variables unset. The simulation Node rejects mixing
real discovery/camera configuration. Neither mode installs Python or drivers.

The owned child selects an unused loopback port and reports its PID and origin.
The Harness verifies that identity and a fresh, private per-session execution
credential before connecting. Credentials are not command arguments, model
inputs or browser environment values. No automatic restart or motion retry is
performed. Closing only the browser does not stop the Node. Closing the Harness
requests graceful shutdown of this explicitly supervised child; an unconfirmed
shutdown is reported and never followed by a blind force-kill or replacement.
Without `PHYSICAL_NODE_EXECUTABLE`, external-node behavior is unchanged.

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
discovery, intent, capability-catalog, route-preview and curated instruction-reader
tools, plus the operator question tool. No general execution tool is exposed.

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
