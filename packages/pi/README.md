# `@tinyedge/pi`

TinyEdge orchestration tools for people who already use Pi.

`@tinyedge/pi@0.1.2` is the Windows preview package for an existing Pi
installation. Source-code availability is not registry evidence. Require
`npm view @tinyedge/pi@0.1.2 version --json` to return `"0.1.2"` before
installing and registering the exact version with:

```powershell
pi install npm:@tinyedge/pi@0.1.2
pi list
```

This is a persistent Pi package registration, not the standalone Harness
installation route. For the standalone Windows Harness,
`npx tinyedge@0.1.2` is a one-shot npm route, while
`npm install --global tinyedge@0.1.2` creates a persistent `tinyedge` command.

Package metadata restricts this version to Windows because credentials use
Windows DPAPI. Linux Secret Service and macOS Keychain support remain
prerequisites for a future cross-platform release.

## Historical `0.1.1` evidence

The exact `0.1.1` artifact was installed and registered in an isolated Windows
Pi configuration with:

```powershell
pi install npm:@tinyedge/pi@0.1.1
pi list
```

This proves package installation and registration only. Production OAuth,
scope elevation, browser approval, and TinyEdge command execution were not
exercised in that release audit.

## TinyEdge commands

The `0.1.2` package exposes these commands inside Pi:

```text
/tinyedge-login
/tinyedge-login --allow-write --allow-run
/tinyedge-status
/tinyedge-tools
/tinyedge-logout
```

Read access is the default. Write and run scopes must be requested explicitly,
and consequential TinyEdge operations still require exact browser approval.
The TinyEdge extension never exposes OAuth credentials or TinyEdge's database
through its tools. An existing Pi installation retains the ambient shell and
filesystem capabilities that its user already enabled. Use the standalone
Harness when a TinyEdge-only tool boundary is required.

An existing Pi retains its normal environment while the add-on registers
TinyEdge commands and tools. Packed installation and registration do not
validate production OAuth, provider onboarding, MCP execution, or approval;
release acceptance requires separate live-flow evidence.
