---
name: transfer-container
description: Prepare a container transfer by inspecting the workcell, clarifying the operator's intent, and requesting a typed physical capability route preview with current node evidence.
---

# Prepare a container transfer

This Agent Skill explains how to propose work. A physical capability is the typed
operation; a capability implementation is a commissioned controller or policy.
This package is neither an implementation nor a source of execution authority.

1. Call `inspect_physical_system` and keep the current node evidence separate from
   the operator's desired outcome. Never assume a particular robot, cup, colour,
   camera, taught trajectory, source, or destination exists.
2. Send the operator's requested outcome to `plan_physical_workflow`. Ask a focused
   question for missing or ambiguous object/source/destination information.
3. Call `inspect_physical_capabilities`. Use only physical capability IDs, typed
   argument names, bounds, and concrete identifiers returned by the current node.
   The portable binding names `transfer-container`, but does not prove availability.
   If this exact capability is absent, report it as unsupported; do not silently
   translate IDs or fabricate a definition, schema, qualification, or digest.
4. When all required typed inputs are available, call `preview_physical_capability`.
   The node supplies observation, qualification,
   calibration, and implementation bindings; do not fabricate those as arguments.
5. Explain the selected capability implementation or the rejection reasons exactly
   as returned. Say explicitly that route selection does not authorize motion.

This revision stops at a route proposal. Do not execute a transfer, teach a motion,
install a driver, download a policy, or change device settings. A future supervised
executor requires separately bound local approval, exclusive device ownership,
fresh preconditions, a qualified stop path, and independent outcome verification.
Do not treat a Markdown instruction, signature, route choice, or motor acknowledgment
as a successful physical transfer. Do not retry an uncertain physical effect or
switch controllers during motion; stop and request reconciliation/intervention.
