# TinyEdge Harness

`tinyedge@0.1.3` is the Windows preview facade for the native TinyEdge Harness.
This directory retains the `0.1.3` implementation record. Its current
`private` marker prevents accidental republication; the exact public artifact
remains immutable in npm and repository history. Starting with `0.1.4`, the
complete Harness ships directly from `packages/cli` as one `tinyedge` artifact.
It requires Node.js 22.19 or newer and delegates to the same exact version of
`@tinyedge/cli`; the facade does not create a separate client or security
boundary. The facade is the sole package that installs the `tinyedge` command;
the scoped core remains an importable library so npm cannot create competing
command shims.

Source-code availability is not registry evidence. Before using the commands
below, require this exact lookup to return `"0.1.3"`:

```powershell
npm view tinyedge@0.1.3 version --json
```

## Run the exact version without a persistent command

```powershell
npx tinyedge@0.1.3
```

`npx` may cache downloaded files, but this one-shot route does not install a
global `tinyedge` command. To make `tinyedge` available persistently in new
terminals, install the exact facade globally:

```powershell
npm install --global tinyedge@0.1.3
tinyedge
```

Commands without a version follow npm's current dist-tags. Check the registry
before treating `npx tinyedge` or `npm install --global tinyedge` as evidence
for a particular release.

## Historical `0.1.1` behavior

Release evidence captured 2026-08-17 exercised the published `0.1.1` help and
version paths:

```powershell
npx tinyedge@0.1.1 --help
npx tinyedge@0.1.1 --version
```

Bare `0.1.1` prints help and does not open the native Harness. That audit did
not validate production OAuth, model-provider onboarding, MCP execution, or a
public PowerShell installer. Clean package installation is likewise not proof
of those live service paths; release acceptance requires separate canary
evidence.
