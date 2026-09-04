# Consolidated Runtime publishing

The only new Runtime publisher identity is repository
`PhysicalSystems/physicalsystems`, workflow `runtime-release.yml`, environment
`runtime-pypi`, distribution **`tinyedge-runtime`**. The import remains
`tinyedge_runtime`. No component versions or product pins change during cutover.

The workflow is manual, current-main-only, public-repository-only, serialized,
and protected by named human reviewers with admin bypass disabled and an exact
`main` deployment branch policy. Source tests do not request OIDC or publish.
The GitHub/PyPI owner settings and old-publisher retirement are separate,
explicitly verified migration steps; merely adding this file does not perform
them.

## Verify the existing release without another upload

Dispatch `runtime-release.yml` with `operation=verify-published` (the default).
Leave candidate inputs empty. An optional coordinator UUID correlates a dispatch
without retrying an uncertain write. The coordinator also supplies
`expected_head_sha`; a race that moves main before dispatch fails closed instead
of qualifying an unreviewed revision.

1. Check the exact current GitHub workflow/run/main identity and protection rules.
2. Read the Runtime pin from `release/product.json`, anonymously fetch its PyPI
   metadata and wheel, and require exact SHA-256 and reviewed public source bytes.
3. Install that wheel on Windows/Linux x64, CPython 3.10/3.11/3.12; run all Runtime
   tests against the installed distribution, plus golden-fixture conformance.
   Installed code receives no GitHub, OIDC, model or registry credentials.
4. After human environment review, verify the PyPI token exchange, collect all
   six current-attempt proofs, and recheck live main/environment policy.
5. Read back the exact published bytes anonymously and retain safe evidence.

This does **not** rebuild, bump or republish `0.2.0`. A successful token exchange
does not independently prove project authorization or the precise PyPI
environment configuration; owner configuration evidence is also required before
retiring legacy publishers. Native qualification and public readback do not
authorize hardware movement.

## Publish a separately approved new Runtime version

Change and review the Runtime version and source in `packages/runtime` first.
Build a wheel and sdist outside the source checkout using the supported build
toolchain; do not reuse `0.2.0` for changed bytes. Retain build/source provenance.
Create an explicitly reviewed public prerelease in this repository whose tag is
`runtime-v<VERSION>-candidate`. It must contain **only**:

- `tinyedge_runtime-<VERSION>-py3-none-any.whl`
- `tinyedge_runtime-<VERSION>.tar.gz`
- `release.json`

The candidate manifest has this exact structure (the hashes below are
illustrative, not publishable):

```json
{
  "contractVersion": "physicalsystems-runtime-candidate-v1",
  "distribution": "tinyedge-runtime",
  "version": "0.2.2",
  "sourceSha": "<exact reviewed 40-character current-main commit>",
  "files": [
    {"filename": "tinyedge_runtime-0.2.2-py3-none-any.whl", "sha256": "<64 lowercase hex characters>", "size": 123},
    {"filename": "tinyedge_runtime-0.2.2.tar.gz", "sha256": "<64 lowercase hex characters>", "size": 456}
  ]
}
```

Dispatch `operation=publish`, `candidate_release_id=<numeric prerelease ID>` and
`release_metadata_sha256=<operator-reviewed hash of the exact raw release.json>`.
The workflow checks source/metadata identity, an exact three-asset set, GitHub
asset digests, wheel/sdist contents and metadata, absence of this version on
PyPI, six native installation proofs, human review, OIDC registration and the
live protection policy. It uploads the checked wheel and sdist **once**, with
attestations. Generic product tags such as `v0.2.2` never trigger this publisher.

There is no token-based fallback, automatic version bump or `skip-existing`.
If upload times out or otherwise becomes uncertain, anonymous readback is still
attempted. Only reads may be retried. Exact readback proves that the expected
bytes exist; it does not attribute who uploaded them. Investigate before another
dispatch. A changed main revision invalidates the old candidate/run instead of
silently replacing its provenance.

## Evidence and tests

Each successful run retains `runtime-publisher-evidence-<RUN>-<ATTEMPT>` with the
safe publisher probe, exact input receipt, six installed-wheel proofs and public
readback. Credentials are never written to receipts. Historical downloads stay
available through migration and rollback.

```sh
python -B -m pytest -q -p no:cacheprovider release/runtime/tests
```

Tests use synthetic fixtures and mocked network responses, including malformed
manifests, source drift, stale attempts, missing/failed native jobs and changed
registry bytes. The release utility itself has no upload command.
