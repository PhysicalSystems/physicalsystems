# Local experiments

This module is the shared Harness experiment lifecycle. Terminal, browser and
desktop clients use the same controller and conversation-owned records. Pi
remains the agent runtime; Electron remains an operator interface.

## Implemented scope

The initial provider is an explicitly synthetic alignment fixture. An agent may
propose a simulation, inspect its inputs and measurements, choose a bounded
offset for a trial, inspect the result and choose another offset. Only the
operator can approve the exact proposed experiment. The controller enforces
the trial budget, parameter bounds, request identity and approval expiry.

The desktop's scripted demonstration exercises this same lifecycle without a
model account. Its deterministic choices are demonstration logic. They are not
a learned optimization policy, a VLA, a physics simulation or evidence that a
robot can perform the task. Real model tool calls can exercise the synthetic
fixture, but successful model reasoning must be verified separately from fake
model and scripted tests.

An experiment records the goal, reviewed plan, individual inputs, measured
results and termination state. A completed set of synthetic trials is not a
physical execution receipt. Trial results belong to the experiment and session
that produced them; a late response must not update a replacement conversation.

## Operator and agent responsibilities

- The agent can inspect, propose, request an approved simulated trial and finish
  its investigation. It cannot approve its own proposal.
- The operator reviews the experiment and budget, approves it and can stop it
  independently of an assistant response or ordinary pending action.
- Retrying a request with its original identifier must inspect or return the
  existing result, without executing the trial again. Different input with the
  same identifier is a conflict.
- Recovery preserves evidence and never silently resumes a trial. An expired
  approval, lost host or uncertain result does not grant another attempt.
- Simulation does not open a camera, connect to a Node or access credentials.

The records live in the application's private data directory. Source control
contains implementation, bounded synthetic fixtures and tests only. Keep raw
observations, user transcripts, credentials, datasets and model artifacts out of
the repository.

## Hardware integration boundary

The existing physical execution service remains operator-facing. This feature
does not turn its approval token into an agent tool or extend permission from
one physical invocation to a sequence of experiments. Hardware experimentation
is reported as unsupported by this provider.

A future hardware provider requires a separately versioned Node contract for
device-bound observations, allowed operations and parameter ranges, experiment
approval and budgets, resource ownership, independent Stop, uncertain outcomes
and durable receipts. It also needs adapter and setup qualification on each
supported setup. The Harness would consume that contract; concrete drivers and
hardware enforcement remain in the private Node repository. No UI decision or
agent-generated code may bypass those controls.

General experiment coordination belongs here. Separately licensed learned
optimization, calibration or promotion implementations remain outside the
public client under the repository's existing BOUNDARY.md rules.
