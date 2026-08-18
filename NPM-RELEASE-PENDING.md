# npm publication approval pending

This file is a package-publication lock. While it exists, all four npm package
manifests must keep `"private": true`, and `.github/workflows/npm-release.yml`
must refuse to build, stage, or publish a release candidate.

This lock is separate from the completed source-license decision. The approved
cutover removed `LICENSE-PENDING.md`, changed the TinyEdge-authored package
licenses to Apache-2.0, installed the reviewed legal files, and retained MIT
for the Pi compatibility runtime. npm publication is still forbidden.

Publishing the source did not remove this file or `private: true` from any of
the four package manifests. Remove this file and those four private flags only
in one separately protected npm-release change after repository protection,
independent review, npm 2FA, trusted publishing, namespace bootstrap,
provenance, empty staging slots, and clean-machine controls have current
evidence.

Source licensing does not authorize npm publication.

This file is not a software license, does not modify any third-party license,
and does not restrict access to the source. It blocks npm package publication.
