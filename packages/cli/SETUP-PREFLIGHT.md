# Inspect physical setup

Inside the standalone Physical Systems Harness, enter:

```text
/physical-setup
```

The assistant can read the same setup report with
`inspect_physical_setup` and the empty arguments object `{}`. The tool accepts
no file paths, device identifiers, configuration changes or approval arguments.

The report explains the setup evidence available to this Harness session. It
combines retained, validated discovery and capability-route information with a
bounded read of the Node execution service's public status. It does not refresh
discovery, request a new capability route, open a camera, prepare a run or
change commissioning. It grants no execution authority.

## Read the report

The report distinguishes evidence that is **present**, explicitly **missing**,
or **unverified**. Present means that the named evidence was reported; it does
not mean that equipment is ready, calibration is valid or movement is approved.
An unavailable service or absent inspection leaves facts unverified. It is not
proof that the laptop has no configuration or calibration.

Read each item with its source and observation time. A retained route describes
one earlier assessment of one exact invocation. A historical successful run
does not establish current physical state. Simulation evidence remains
simulation evidence throughout the report.

A follow-up conversation retires the active proposal. Setup inspection can still
explain the most recent assessment as **retired** historical evidence, with its
original timestamps. This copy is only for explanation: it does not restore a
proposal, preparation eligibility or approval. Discovery, catalog or route
refreshes, camera evidence changes, errors and session changes invalidate that
retained copy. A new invocation needs a newly reviewed current route.

The useful areas are:

| Area | What the report can explain |
|---|---|
| Capability and request | Whether an inspected catalog exposes the requested operation and typed inputs, or the request has missing, unknown, wrongly typed or out-of-bounds arguments. |
| Workcell and configuration | Reported workcell references, local configuration availability, and a mismatch between the current route and installed configuration. |
| Dependencies | A route's explicit missing or mismatched dependency bindings. It does not inspect or install driver packages. |
| Calibration | A route's explicit missing or mismatched calibration bindings. A binding mismatch does not by itself prove that equipment physically moved. |
| Implementation artifacts | A route's explicit missing or mismatched artifacts. These may be controller or policy artifacts; their purpose is not inferred from a generic rejection code. |
| Current state | Missing, unknown, violated, stale or inconsistently bound observations reported by routing. The exact reason remains visible. |
| Qualification and policy | Reported qualification status or rejection, an explicitly blocked implementation, and incomplete or inconsistent routing policy. |
| Execution target | A route's unavailable or mismatched execution target and the separately reported execution service availability. |

Rejections remain attached to the implementation that received them. A rejected
candidate does not automatically block a different selected implementation.
Request-level errors remain separate from implementation requirements. An
unknown host reason is retained as an unclassified blocker, not ignored or
treated as success.

Large inventories have explicit displayed/total counts and omission notices.
The report preserves the selected implementation and prioritizes its matching
configuration when limiting the display. An omitted entry has not been
evaluated in this report; omission does not mean that it is missing or eligible.

## Continue from the actual blocker

1. If the session lacks current discovery information, use the existing
   `/physical` command when you want to refresh it. Then ask the assistant to
   inspect the capability catalog. Setup inspection itself does not perform
   that refresh.
2. Ask for a supported capability proposal using exact catalog inputs. Clarify
   missing object or station identifiers. Candidate-only discovery cannot
   ground a legacy natural-language plan, but a separately available typed
   catalog can support a route when its required inputs are known. Every Node
   routing gate still applies.
3. Inspect setup again and resolve the reported area with the operator or
   integrator responsible for that workcell. Correct request inputs for an
   argument error. Review exact bindings for a configuration, dependency or
   calibration mismatch. Obtain valid observations through the configured
   host for an observation error. Do not invent evidence or relax policy to
   make a proposal eligible.
4. When a current route and matching local configuration are available, open
   `/workcell` and use **Physical run**. Select the configuration and choose
   **Prepare invocation**. Node checks current preconditions. Review the mode,
   exact run/configuration/implementation identities and expiry, then explicitly
   approve that one invocation. Setup inspection and an assistant answer cannot
   perform this approval.
5. After the run, inspect its exact status and verified receipt using the
   existing execution inspection path. `RUNNING` is not success. A failed
   inspection is not Node's `OUTCOME_UNKNOWN`, and a historical receipt does
   not establish current readiness. Never replay an uncertain effect to obtain
   a clearer result.

If the identified implementation explicitly uses taught positions, its setup
may require reviewed source/destination positions and a taught transfer path.
Use that implementation's commissioned procedure and artifacts. The report
does not infer a waypoint controller from the capability name, invent positions
or limits, or teach a motion. Other implementations can require different
artifacts and calibration.

## Public API limits

This Harness report reuses Node 0.2.1 and Runtime 0.2.0. The public capability
catalog exposes typed capability inputs, common precondition references and
workcell references. It does not enumerate per-implementation calibration,
dependency or artifact requirements. Implementation candidates and their
rejection codes become available through a route receipt.

The raw stored receipt contains additional Runtime and host data, but the
Harness deliberately uses its bounded, validated presentation projection. The
setup report does not expose raw configuration, embedded implementation
bindings, local paths, camera images, credentials or private host diagnostics.
An area that has no explicit reported rejection is not thereby verified or
declared unnecessary.

The report cannot perform physical calibration, establish image-to-robot
geometry, validate a driver's physical behavior, measure live scene readiness,
or qualify a stop procedure. A camera preview and matching calibration hashes
cannot establish these conditions. Basic preview remains available separately
through `/workcell` without commissioning; preview supplies no motion authority.

There is no new physical commissioning or first-trial qualification wizard in
this patch. A real implementation still needs its legitimate, reviewed setup
and qualification process. No successful physical-trial evidence is created
by a setup report, simulated run or software test.
