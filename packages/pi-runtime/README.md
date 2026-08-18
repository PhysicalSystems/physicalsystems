# `@tinyedge/pi-runtime`

This is TinyEdge's audited, text-first compatibility package for the Pi SDK
and runtime. It is an internal dependency of the TinyEdge CLI, not a
standalone Pi distribution, and intentionally installs no `pi` or `tinyedge`
command.

The runtime payload comes from
[`@earendil-works/pi-coding-agent@0.84.2`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.84.2).
TinyEdge preserves its SDK exports while preventing two native capabilities
from being installed by default:

- native clipboard integration (`@mariozechner/clipboard`);
- Photon/WASM image processing (`@silvia-odwyer/photon-node`).

Both are optional peers. Text-first SDK and Harness imports work without them.
Without the native clipboard peer, addon-backed reads and clipboard-image
access are unavailable, while copy can still use Pi's OS/terminal fallbacks.
Photon-dependent image conversion is unavailable without its peer. During
guarded candidate preparation, TinyEdge keeps the repository manifest
`private: true`. An approved release removes that publication lock only after
the legal, security, and public-release gates are complete.

The public source tree retains Pi's upstream source maps for review. The npm
artifact omits those maps because the built JavaScript and declarations do not
need them at runtime.

See [UPSTREAM.md](./UPSTREAM.md) for the exact artifact provenance and metadata
delta, [UPSTREAM_README.md](./UPSTREAM_README.md) for the unmodified upstream
documentation, and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for
vendored JavaScript notices.

The Pi-derived payload is licensed under the accompanying MIT license,
Copyright (c) 2025 Mario Zechner. Dependencies retain their own licenses.
