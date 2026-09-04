# Support

## Bugs and feature requests

Search the [GitHub issue tracker](https://github.com/PhysicalSystems/physicalsystems/issues)
before opening a new issue. Include the Physical Systems command and version, Node.js
version, operating-system version, CPU architecture, expected behavior, actual behavior,
and a minimal reproduction.

The public source and `physicalsystems@0.2.2` release target support Windows x64, Windows ARM64,
and qualified Ubuntu 22.04/24.04 desktop x64 with Node.js 22.19.0 or newer.
Historical `tinyedge` releases remain immutable. Use `npm view physicalsystems dist-tags
--json` and report the exact resolved version with a new release problem. To work from source, see
[DEVELOPMENT.md](DEVELOPMENT.md).

Remove credentials, tokens, account details, device identifiers, private URLs,
customer data, model artifacts, and session transcripts before posting. This
repository does not provide support for headless Linux, Raspberry Pi, other
Linux targets, macOS, or a public PowerShell installer. Historical TinyEdge
package or hosted-service problems should include
`npm view tinyedge dist-tags --json` separately.

## Security issues

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) to report it privately.

## Historical accounts and hosted-service support

Questions involving account access, billing, approvals, private device or
fleet state, or production service behavior do not belong in this public
repository. Use the relevant private support route and do not paste sensitive
information into GitHub.

Community support is best effort. Opening an issue does not guarantee a fix,
timeline, service-level agreement, or compatibility commitment.
