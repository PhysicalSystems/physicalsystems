# Security policy

## Supported versions

Security fixes currently target the source on `main` and the published
TinyEdge `0.1.3` release. The older `0.1.1` npm package is a legacy help-only
client and is not the native Harness described by this repository.

| Version | Security support |
| --- | --- |
| `main` | Yes |
| `0.1.5` | Yes when published to `preview`; until then use `main` |
| `0.1.4` | Yes while it remains the Windows `preview` |
| `0.1.3` | Yes |
| `0.1.2` | Previous published Harness |
| `0.1.1` and earlier | No active maintenance in this repository |

The current source supports Windows x64, Windows ARM64, and qualified Ubuntu
22.04/24.04 desktop x64 with Node.js 22.19.0 or newer. Headless Linux, Raspberry Pi, other
Linux targets, and macOS are not currently supported.

## Report a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion,
pull request, or chat transcript. Use GitHub's
[private vulnerability reporting](https://github.com/PhysicalSystems/tinyedge-edge/security/advisories/new).
If that route is unavailable, email <lienert@tinyedge.ai> with `[SECURITY]` in
the subject and only the minimum information needed to establish contact.

Include the affected commit or package version, platform and architecture,
impact, reproduction steps, and any proposed mitigation. Remove credentials,
access tokens, customer data, device identifiers, model artifacts, and private
URLs from the report.

We will acknowledge a complete report, investigate it, and coordinate a fix
and disclosure plan. We do not promise a bounty or a particular response time.

## Scope

Reports about the `tinyedge` client/command/extension package, compatibility runtime,
packaging, OAuth client boundary, local credential storage, or release workflow
belong here. Reports about a TinyEdge account, billing, or the hosted service
should use the private support route described in [SUPPORT.md](SUPPORT.md).
