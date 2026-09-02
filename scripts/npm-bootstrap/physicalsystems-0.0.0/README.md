# physicalsystems namespace bootstrap

This intentionally inert package reserves the public npm namespace used by the
Physical Systems Harness. Version `0.0.0` contains no executable code,
commands, dependencies, lifecycle scripts, or bundled files.

It is intentionally published with the non-default `bootstrap` tag. npm may
also create its automatic initial `latest` mapping to these same inert bytes.
Real Harness releases are built, verified, and published separately from the
public Physical Systems edge-client repository through its protected OIDC
workflow.
