# Security policy

## Supported versions

Security fixes currently target the source on `main` and the current
`physicalsystems` preview. The older TinyEdge npm packages are historical
clients and are not the current package identity described by this repository.

| Version | Security support |
| --- | --- |
| `main` | Yes |
| `physicalsystems@0.2.1` | Yes after the protected `preview` publication |
| `physicalsystems@0.2.0` | Superseded after `preview` moves to `0.2.1` |
| `tinyedge@0.1.5` | Historical preview during the package transition |
| `tinyedge@0.1.4` | Historical Windows preview |
| `tinyedge@0.1.3` | Historical latest |
| `tinyedge@0.1.2` and earlier | No active maintenance in this repository |

The current source supports Windows x64, Windows ARM64, and qualified Ubuntu
22.04/24.04 desktop x64 with Node.js 22.19.0 or newer. Headless Linux, Raspberry Pi, other
Linux targets, and macOS are not currently supported.

## Report a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion,
pull request, or chat transcript. Use GitHub's
[private vulnerability reporting](https://github.com/PhysicalSystems/physicalsystems/security/advisories/new).
If that route is unavailable, email <lienert@physicalsystems.ai> with `[SECURITY]` in
the subject and only the minimum information needed to establish contact.

Include the affected commit or package version, platform and architecture,
impact, reproduction steps, and any proposed mitigation. Remove credentials,
access tokens, customer data, device identifiers, model artifacts, and private
URLs from the report.

We will acknowledge a complete report, investigate it, and coordinate a fix
and disclosure plan. We do not promise a bounty or a particular response time.

## Scope

Reports about the `physicalsystems` client/command/extension package, compatibility runtime,
packaging, OAuth client boundary, local credential storage, or release workflow
belong here. Reports about a historical account, billing, or a hosted service
should use the private support route described in [SUPPORT.md](SUPPORT.md).
