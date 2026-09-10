# Operator gripper check

The optional gripper check is a separate commissioning operation. It does not
qualify ordinary physical execution, create a controller configuration, install
robot dependencies, alter calibration, or expose device mutations to model tools.
The Node must explicitly enable the versioned gripper-check API using a reviewed
local configuration. Existing discovery-only Nodes report this path unavailable.

The trusted host uses these commands with the existing project, conversation,
server, session and connection-generation scope:

| Command | Additional fields | Effect |
| --- | --- | --- |
| `workcell.commissioning.refresh` | None | Read retained Node status; never open hardware. |
| `workcell.commissioning.inspect` | None | Explicit bounded read-only robot inspection. |
| `workcell.commissioning.prepare` | `configurationDigest`, `inspectionDigest`, `targetPosition` | Prepare an exact absolute gripper-percent target from fresh inspection. |
| `workcell.commissioning.approve` | `trialId`, `trialDigest`, `approved: true` | Submit one explicit approval for the current unexpired plan. |
| `workcell.commissioning.stop` | `trialId`, `reason: "operator-requested-stop"` | Independently stop the exact retained trial, including from another selected conversation. |

The host supplies `expectedNodeSessionId` from its validated state, never from
model arguments or browser-selected connection data. Only the execution credential
already stored by the native encrypted credential store authenticates these
requests. Response bodies are bounded to 64 KiB, parsed against an exact versioned
shape, and never followed across redirects. Unsupported 404/501 responses become
an unavailable feature, never a ready robot. Inspection has a 35-second transport
deadline for the Node's bounded inspection; other requests retain a five-second
deadline. A long inspection cannot hold the independent Stop request channel.

`workcell.commissioning` contains `status`, `available`, `fresh`, `receivedAt`
(milliseconds), `maximumAgeMs` (5000), `pending`, `stopPending`, `unresolved` and
`message`. The Node `status` contract is validated in
`packages/cli/src/physical/commissioning-client.js`. Unknown inspection positions
and torque states are represented by null, and cannot satisfy readiness. A host
must also expire freshness locally while rendering, and mask readiness when the
connection is unavailable.

Top-level `activeCommissioning` retains each operation's original scope, status,
trial and Node session identities, and independent Stop availability. Preparing a
trial does not grant motion authority. Approval is not retried after an uncertain
acknowledgement. Known unresolved trials are polled even if their view is closed.
Missing trials, changed Node sessions, transport failures and unconfirmed Stop
never silently release the original owner. The service journals known ownership
before approval and blocks closing or disconnecting while unresolved. After a
service restart, only exact retained Stop is available; approval is never replayed.

A trial is resolved only by a matching terminal response with `stopStatus:
"STOPPED"`. `OUTCOME_UNKNOWN` always retains ownership, including after Node
restart. Software Stop and readback do not replace an independent motor-power
cutoff. A completed gripper check is evidence about that bounded trial only; normal
capability routing, configuration qualification and run approval remain unchanged.

The tests use a loopback HTTP Node fixture and synthetic responses. They neither
open a serial device nor access a real camera, robot, credential store or Node.
