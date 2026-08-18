# npm registry erratum for `@tinyedge/pi-runtime@0.0.0`

The immutable `0.0.0` tarball's README records the pre-publication intent to
use only the non-default `bootstrap` tag. On the first public publication, npm
also created the package's initial `latest` mapping. npm 11.19 returned HTTP 400
when the maintainer used its supported `dist-tag rm` command to remove that
initial mapping.

Before the real runtime release, the fail-closed invariant was:

- `bootstrap` resolves to `0.0.0`;
- `latest` resolved to the same exact inert `0.0.0` bytes;
- `preview` was absent; and
- the real `0.84.2-tinyedge.1` runtime remained unpublished until staged review.

After the audited staged release and 2FA approval on 2026-08-18, the live tags
are:

- `bootstrap` remains pinned to the inert `0.0.0` artifact; and
- `preview` and `latest` both resolve to the audited
  `0.84.2-tinyedge.1` runtime.

The reviewed immutable bootstrap identity is:

- integrity: `sha512-uYd5UDXq76shmjwrszLmxzKXm163VHl8yHEzrAEaDjXD1QrrHtlRKh2T+CbrDXWgS0Q/HpUYgKkA5zrkUcG3Hg==`
- npm shasum: `d5ad1e7bbd5b82e04211dbf6b81750cdd90a0380`
- SHA-256: `6cae3adab08fac07a7199dc4be35153c09e0cf8db7c04a101c071bbf938da1cd`
- size: 1,267 bytes
- files: `package/LICENSE`, `package/README.md`, and `package/package.json`

This erratum is public release evidence; it is intentionally outside the
three-file bootstrap directory and is not part of the already-published
tarball. The protected release workflow rechecks the live tags, downloads the
tarball, and binds its integrity, shasum, manifest, and file list before it can
stage any candidate.
