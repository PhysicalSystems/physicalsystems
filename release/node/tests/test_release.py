"""Synthetic release-only regression tests: no credentials/network/hardware.

Copyright 2026 Lienert De Maeyer / Physical Systems.
SPDX-License-Identifier: Apache-2.0

Modified for TIN-417: import this directory's verifier by exact path, test the
consolidated authority binding and distinguish no-upload verification from new
version publication, including legacy and duplicate-publication rejection.
"""
import base64
import copy
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import zipfile

import pytest

_spec = importlib.util.spec_from_file_location(
    "physicalsystems_node_release", Path(__file__).resolve().parents[1] / "scripts/release.py")
r = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r)


def pack(files):
    """Rehash a synthetic wheel fixture; never execute its code."""
    files = dict(files)
    record = "physicalsystems_node-0.2.1.dist-info/RECORD"
    files.pop(record, None)
    rows = [[name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b"=").decode(), str(len(raw))]
        for name, raw in sorted(files.items())]
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows([*rows, [record, "", ""]])
    files[record] = out.getvalue().encode()
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, raw in files.items():
            archive.writestr(name, raw)
    return result.getvalue()


def bind_wheel(sample, raw):
    sample["wheel"] = raw
    sample["capsule"]["wheel"] = {"filename": r.NODE_WHEEL, "sha256": r.sha(raw), "bytes": len(raw)}


def rehash_source(sample):
    files = sample["files"]
    manifest = {"contractVersion": "physicalsystems-node-package-source-v1", "distribution": "physicalsystems-node",
        "version": "0.2.1", "scope": "explicit-first-party-physical-node-only", "files": [
            {"path": name, "sha256": r.sha(data), "bytes": len(data)} for name, data in sorted(files.items())
            if name.startswith("tinyedge_agent/") and name.endswith(".py")]}
    raw = r.canonical(manifest)
    files["tinyedge_agent/_distribution_manifest.json"] = raw
    sample["capsule"]["sourceManifestSha256"] = r.sha(raw)
    bind_wheel(sample, pack(files))


@pytest.fixture
def sample():
    # Explicitly synthetic package: 26 empty modules, never a physical controller.
    files = {"tinyedge_agent/" + name + ".py": b'"""Synthetic empty module, no hardware."""\n' for name in r.MODULES}
    files["tinyedge_agent/__init__.py"] = r.INITIALIZER
    prefix = "physicalsystems_node-0.2.1.dist-info/"
    files.update({
        prefix + "METADATA": b"Metadata-Version: 2.4\nName: physicalsystems-node\nVersion: 0.2.1\nRequires-Python: >=3.10\nRequires-Dist: tinyedge-runtime==0.2.0\nRequires-Dist: numpy<3,>=1.24\nRequires-Dist: opencv-python-headless<5,>=4.10\n\nSynthetic fixture.\n",
        prefix + "WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        prefix + "entry_points.txt": b"[console_scripts]\nphysicalsystems-node = tinyedge_agent.physical_node_cli:main\n",
        prefix + "top_level.txt": b"tinyedge_agent\n",
        prefix + "licenses/LICENSE": (r.ROOT / "policy/node-preview-notice.txt").read_bytes(),
    })
    capsule = {"contractVersion": "physicalsystems-node-release-capsule-v1", "distribution": "physicalsystems-node",
        "version": "0.2.1", "runtimeVersion": "0.2.0", "sourceManifestSha256": "a" * 64, "wheel": {}, "targets": []}
    for platform, python in sorted(r.TARGETS):
        tag = "win_amd64" if platform == "win32-x64" else "manylinux_2_17_x86_64.manylinux2014_x86_64"
        cp = "cp" + python.replace(".", "")
        filenames = {"tinyedge-runtime": r.RUNTIME_WHEEL,
            "numpy": f"numpy-1.26.4-{cp}-{cp}-{tag}.whl",
            "opencv-python-headless": f"opencv_python_headless-4.10.0.84-cp37-abi3-{tag}.whl"}
        artifacts = []
        for name, version in r.PINS.items():
            filename = filenames[name]
            artifacts.append({"name": name, "version": version, "filename": filename,
                "sha256": r.RUNTIME_SHA256 if name == "tinyedge-runtime" else r.sha(filename.encode()),
                "bytes": 100, "url": "https://files.pythonhosted.org/packages/synthetic/" + filename})
        capsule["targets"].append({"platform": platform, "python": python, "publicDependencies": artifacts})
    result = {"files": files, "capsule": capsule}
    rehash_source(result)
    return result


def validate(capsule):
    raw = r.canonical(capsule)
    return r.validate_capsule(raw, r.sha(raw))


def test_exact_capsule_and_minimal_synthetic_wheel(sample):
    assert r.REPOSITORY == "PhysicalSystems/physicalsystems"
    assert r.VERSION == "0.2.1" and r.RUNTIME_VERSION == "0.2.0"
    assert r.NODE_WHEEL == "physicalsystems_node-0.2.1-py3-none-any.whl"
    assert r.CANDIDATE_TAG == "physicalsystems-node-v0.2.1-candidate"
    assert r.RUNTIME_WHEEL == "tinyedge_runtime-0.2.0-py3-none-any.whl"
    assert r.PINS["tinyedge-runtime"] == "0.2.0"
    assert validate(sample["capsule"]) == sample["capsule"]
    r.inspect_node(sample["wheel"], sample["capsule"])


@pytest.mark.parametrize("fault", ["extra", "private-url", "missing-target", "duplicate-target", "unknown-platform", "unknown-python",
    "bool-size", "runtime-hash", "runtime-version", "extra-dependency", "dependency-name", "dependency-version", "incompatible-tag",
    "credential-url", "wrong-host", "query-url", "fragment-url", "inconsistent-common", "node-filename", "source-hash", "huge-wheel",
    "historical-node-version", "historical-node-wheel", "coupled-runtime-version"])
def test_capsule_closed_shape_and_exact_pins(sample, fault):
    value = sample["capsule"]
    dep = value["targets"][0]["publicDependencies"][0]
    if fault == "extra": value["comment"] = "unapproved"
    elif fault == "private-url": value["sourceUrl"] = "https://github.com/private/repo"
    elif fault == "missing-target": value["targets"].pop()
    elif fault == "duplicate-target": value["targets"][1] = copy.deepcopy(value["targets"][0])
    elif fault == "unknown-platform": value["targets"][0]["platform"] = "linux-arm64"
    elif fault == "unknown-python": value["targets"][0]["python"] = "3.13"
    elif fault == "bool-size": dep["bytes"] = True
    elif fault == "runtime-hash": dep["sha256"] = "b" * 64
    elif fault == "runtime-version": dep["version"] = "0.2.1"
    elif fault == "extra-dependency": value["targets"][0]["publicDependencies"].append(dict(dep))
    elif fault == "dependency-name": dep["name"] = "tinyedge-agent"
    elif fault == "dependency-version": value["targets"][0]["publicDependencies"][1]["version"] = "2.0.0"
    elif fault == "incompatible-tag": value["targets"][0]["publicDependencies"][1]["filename"] = "numpy-1.26.4-cp312-cp312-win_amd64.whl"
    elif fault == "credential-url": dep["url"] = dep["url"].replace("https://", "https://secret@")
    elif fault == "wrong-host": dep["url"] = dep["url"].replace("files.pythonhosted.org", "attacker.invalid")
    elif fault == "query-url": dep["url"] += "?token=secret"
    elif fault == "fragment-url": dep["url"] += "#secret"
    elif fault == "inconsistent-common": dep["bytes"] += 1
    elif fault == "node-filename": value["wheel"]["filename"] = "tinyedge_agent-0.2.0-py3-none-any.whl"
    elif fault == "source-hash": value["sourceManifestSha256"] = "Z" * 64
    elif fault == "huge-wheel": value["wheel"]["bytes"] = r.MAX_WHEEL + 1
    elif fault == "historical-node-version": value["version"] = "0.2.0"
    elif fault == "historical-node-wheel": value["wheel"]["filename"] = "physicalsystems_node-0.2.0-py3-none-any.whl"
    elif fault == "coupled-runtime-version": value["runtimeVersion"] = "0.2.1"
    with pytest.raises(r.ReleaseError): validate(value)


@pytest.mark.parametrize("raw", [b'{"a":1,"a":2}', b'{"a":NaN}', b'{', b'\xff', b'x' * (r.MAX_JSON + 1)],
    ids=["duplicate", "nonfinite", "malformed", "encoding", "oversized"])
def test_bad_json(raw):
    with pytest.raises(r.ReleaseError): r.document(raw)


def test_noncanonical_or_wrong_metadata_pin(sample):
    raw = r.canonical(sample["capsule"])
    with pytest.raises(r.ReleaseError): r.validate_capsule(raw, "f" * 64)
    with pytest.raises(r.ReleaseError): r.validate_capsule(raw + b"\n", r.sha(raw + b"\n"))


@pytest.mark.parametrize("fault", ["private-module", "native-code", "traversal", "missing-module", "initializer", "wrong-license", "extra-license",
    "wrong-entrypoint", "wrong-dependency", "duplicate-name", "extra-top-level", "binary-tag", "source-manifest", "source-hash", "private-import",
    "dynamic-import", "dynamic-exec", "upward-import", "record-hash"])
def test_package_boundary_rejects_unapproved_contents(sample, fault):
    files = sample["files"]
    prefix = "physicalsystems_node-0.2.1.dist-info/"
    if fault == "private-module": files["tinyedge_agent/client.py"] = b"# private cloud code must never enter\n"
    elif fault == "native-code": files["tinyedge_agent/payload.dll"] = b"native"
    elif fault == "traversal": files["../payload"] = b"escape"
    elif fault == "missing-module": files.pop("tinyedge_agent/physical_routes.py")
    elif fault == "initializer": files["tinyedge_agent/__init__.py"] += b"import os\n"
    elif fault == "wrong-license": files[prefix + "licenses/LICENSE"] = b"Apache-2.0"
    elif fault == "extra-license": files[prefix + "LICENSE"] = files[prefix + "licenses/LICENSE"]
    elif fault == "wrong-entrypoint": files[prefix + "entry_points.txt"] += b"tinyedge-agent = tinyedge_agent.__main__:main\n"
    elif fault == "wrong-dependency": files[prefix + "METADATA"] = files[prefix + "METADATA"].replace(b"\n\n", b"\nRequires-Dist: cloud-secret\n\n")
    elif fault == "duplicate-name": files[prefix + "METADATA"] = b"Name: other\n" + files[prefix + "METADATA"]
    elif fault == "extra-top-level": files[prefix + "top_level.txt"] += b"private_package\n"
    elif fault == "binary-tag": files[prefix + "WHEEL"] = b"Root-Is-Purelib: false\nTag: cp312-cp312-win_amd64\n"
    elif fault == "source-manifest": files["tinyedge_agent/_distribution_manifest.json"] += b"\n"
    elif fault == "source-hash": sample["capsule"]["sourceManifestSha256"] = "c" * 64
    elif fault in {"private-import", "dynamic-import", "dynamic-exec", "upward-import"}:
        code = {"private-import": b"from .client import Cloud\n", "dynamic-import": b"__import__(user_input)\n",
            "dynamic-exec": b"exec('arbitrary code')\n", "upward-import": b"from ..cloud import secret\n"}[fault]
        files["tinyedge_agent/physical_node_cli.py"] = code
        rehash_source(sample)
    elif fault == "record-hash":
        raw = sample["wheel"]
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            all_files = {item.filename: archive.read(item) for item in archive.infolist()}
        all_files[prefix + "RECORD"] = all_files[prefix + "RECORD"].replace(b"sha256=", b"sha512=")
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w") as archive:
            for name, data in all_files.items(): archive.writestr(name, data)
        bind_wheel(sample, result.getvalue())
    if fault != "record-hash": bind_wheel(sample, pack(files))
    with pytest.raises(r.ReleaseError): r.inspect_node(sample["wheel"], sample["capsule"])


@pytest.mark.parametrize("mode", ["duplicate", "symlink", "oversize"])
def test_archive_path_and_expansion_guards(sample, mode):
    raw = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(sample["wheel"])) as original, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in original.infolist():
            data = original.read(item)
            if item.filename == "tinyedge_agent/physical_node_cli.py":
                if mode == "symlink": item.external_attr = (stat.S_IFLNK | 0o777) << 16
                elif mode == "oversize": data = b"x" * (2 * 1024 * 1024 + 1)
            archive.writestr(item, data)
        if mode == "duplicate":
            with pytest.warns(UserWarning, match="Duplicate name"):
                archive.writestr("tinyedge_agent/physical_node_cli.py", b"duplicate")
    bind_wheel(sample, raw.getvalue())
    with pytest.raises(r.ReleaseError): r.inspect_node(sample["wheel"], sample["capsule"])


def metadata_for(artifact):
    return {"urls": [{"filename": artifact["filename"], "url": artifact["url"], "size": artifact["bytes"],
        "digests": {"sha256": artifact["sha256"]}, "packagetype": "bdist_wheel", "yanked": False}]}


@pytest.mark.parametrize("fault", ["missing", "yanked", "sha", "bytes", "url", "sdist", "duplicate"])
def test_public_registry_identity(sample, fault):
    artifact = sample["capsule"]["targets"][0]["publicDependencies"][0]
    metadata = metadata_for(artifact)
    item = metadata["urls"][0]
    if fault == "missing": metadata["urls"] = []
    elif fault == "yanked": item["yanked"] = True
    elif fault == "sha": item["digests"]["sha256"] = "0" * 64
    elif fault == "bytes": item["size"] += 1
    elif fault == "url": item["url"] = item["url"].replace("/synthetic/", "/different/")
    elif fault == "sdist": item["packagetype"] = "sdist"
    elif fault == "duplicate": metadata["urls"].append(dict(item))
    with pytest.raises(r.ReleaseError): r.verify_public(artifact, metadata)


@pytest.mark.parametrize("fault", [None, "different-bytes", "yanked", "missing", "different-hash"])
def test_verify_published_requires_exact_public_node_without_upload(sample, monkeypatch, fault):
    artifact = {**sample["capsule"]["wheel"], "url": "https://files.pythonhosted.org/packages/synthetic/" + r.NODE_WHEEL}
    metadata = metadata_for(artifact)
    if fault == "yanked": metadata["urls"][0]["yanked"] = True
    elif fault == "missing": metadata["urls"] = []
    elif fault == "different-hash": metadata["urls"][0]["digests"]["sha256"] = "0" * 64
    monkeypatch.setattr(r, "public_metadata", lambda name, version: metadata)
    monkeypatch.setattr(r, "public_read", lambda url, maximum: b"changed" if fault == "different-bytes" else sample["wheel"])
    monkeypatch.setattr(r.subprocess, "run", lambda *a, **k: pytest.fail("Verification must not execute an upload"))
    if fault:
        with pytest.raises(r.ReleaseError):
            r.verify_registry_mode("verify-published", sample["capsule"], sample["wheel"])
    else:
        r.verify_registry_mode("verify-published", sample["capsule"], sample["wheel"])


@pytest.mark.parametrize("metadata", [{"urls": []}, {"urls": [{"yanked": True}]}, {"urls": [{"yanked": False}]}])
def test_publish_never_reuses_an_existing_pypi_version(sample, monkeypatch, metadata):
    monkeypatch.setattr(r, "public_metadata", lambda name, version: metadata)
    monkeypatch.setattr(r, "public_read", lambda *args: pytest.fail("No wheel read or upload is needed for an existing version"))
    with pytest.raises(r.ReleaseError, match="already exists on PyPI"):
        r.verify_registry_mode("publish", sample["capsule"], sample["wheel"])


@pytest.mark.parametrize("status,official", [(404, True), (404, False), (403, True), (429, True), (500, True)])
def test_publish_requires_explicit_404_from_exact_official_version_endpoint(sample, monkeypatch, status, official):
    endpoint = f"https://pypi.org/pypi/physicalsystems-node/{r.VERSION}/json"
    def metadata(name, version):
        assert name == "physicalsystems-node" and version == r.VERSION
        raise r.urllib.error.HTTPError(endpoint if official else "https://unapproved.invalid/", status,
            "synthetic diagnostic never logged", {}, None)
    monkeypatch.setattr(r, "public_metadata", metadata)
    if status == 404 and official:
        r.verify_registry_mode("publish", sample["capsule"], sample["wheel"])
    else:
        with pytest.raises(r.ReleaseError, match="Cannot establish"):
            r.verify_registry_mode("publish", sample["capsule"], sample["wheel"])


@pytest.mark.parametrize("operation", ["verify", "stage"])
def test_release_commands_require_explicit_mode_before_any_network(operation, monkeypatch):
    monkeypatch.setattr(r, "workflow_identity", lambda: pytest.fail("No implicit mode may reach evidence APIs"))
    with pytest.raises(r.ReleaseError, match="explicit verification or publication mode"):
        r.main([operation, "--release-metadata-sha256", "a" * 64])


def test_unknown_mode_refused_before_registry_read(sample, monkeypatch):
    monkeypatch.setattr(r, "public_metadata", lambda *a: pytest.fail("Unrecognized mode reached registry"))
    with pytest.raises(r.ReleaseError): r.verify_registry_mode("skip-existing", sample["capsule"], sample["wheel"])


@pytest.fixture
def protection():
    return {"name": r.ENVIRONMENT, "can_admins_bypass": False,
        "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
        "protection_rules": [{"type": "required_reviewers", "prevent_self_review": False,
            "reviewers": [{"type": "User", "reviewer": {"type": "User", "id": 123, "login": "owner"}}]}]}


def branches():
    return {"total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}]}


def test_founder_can_approve_but_no_automatic_or_admin_bypass(protection):
    r.validate_environment(protection, branches(), r.POLICY)


@pytest.mark.parametrize("fault", ["bypass", "no-reviewer", "bot", "team", "wildcard", "tag", "extra", "policy", "wrong-env", "protected-any"])
def test_protection_gates(protection, fault):
    branch, policy = branches(), r.POLICY
    if fault == "bypass": protection["can_admins_bypass"] = True
    elif fault == "no-reviewer": protection["protection_rules"] = []
    elif fault == "bot": protection["protection_rules"][0]["reviewers"][0]["reviewer"]["type"] = "Bot"
    elif fault == "team": protection["protection_rules"][0]["reviewers"][0]["type"] = "Team"
    elif fault == "wildcard": branch["branch_policies"][0]["name"] = "*"
    elif fault == "tag": branch["branch_policies"][0]["type"] = "tag"
    elif fault == "extra": branch["total_count"] = 2
    elif fault == "policy": policy = "unreviewed"
    elif fault == "wrong-env": protection["name"] = "other"
    elif fault == "protected-any": protection["deployment_branch_policy"] = {"protected_branches": True, "custom_branch_policies": False}
    with pytest.raises(r.ReleaseError): r.validate_environment(protection, branch, policy)


def fake_ingress(monkeypatch, sample):
    raw = r.canonical(sample["capsule"])
    payloads = {"release.json": raw, r.NODE_WHEEL: sample["wheel"]}
    candidate = {"id": 77, "draft": False, "prerelease": True, "tag_name": r.CANDIDATE_TAG,
        "target_commitish": "main", "published_at": "2026-09-03T14:00:00Z", "assets": [
        {"id": index, "name": name, "state": "uploaded", "size": len(data), "digest": "sha256:" + r.sha(data)}
        for index, (name, data) in enumerate(payloads.items(), 100)]}
    calls = []
    def github(path, **kwargs):
        calls.append(path)
        if path.endswith("/releases/77"): return candidate
        asset = next(item for item in candidate["assets"] if path.endswith("/" + str(item["id"])))
        return payloads[asset["name"]]
    monkeypatch.setattr(r, "github", github)
    monkeypatch.setattr(r, "dependencies_public", lambda capsule: None)
    return candidate, payloads, raw, calls


def test_published_candidate_two_asset_ingress_and_hash_binding(monkeypatch, sample):
    candidate, payloads, raw, calls = fake_ingress(monkeypatch, sample)
    capsule, fetched = r.fetch_candidate("77", r.sha(raw))
    assert capsule == sample["capsule"] and fetched == payloads
    assert all(path.startswith("repos/PhysicalSystems/physicalsystems/") for path in calls)


@pytest.mark.parametrize("fault", ["draft", "not-prerelease", "wrong-tag", "historical-tag", "missing-published-at", "invalid-date", "non-utc-date",
    "branch", "extra", "missing", "wrong-id", "asset-digest", "asset-size", "incomplete", "substituted"])
def test_candidate_changes_fail_closed(monkeypatch, sample, fault):
    candidate, payloads, raw, _ = fake_ingress(monkeypatch, sample)
    if fault == "draft": candidate["draft"] = True
    elif fault == "not-prerelease": candidate["prerelease"] = False
    elif fault == "wrong-tag": candidate["tag_name"] = "unapproved-candidate"
    elif fault == "historical-tag": candidate["tag_name"] = "physicalsystems-node-v0.2.0-candidate"
    elif fault == "missing-published-at": candidate["published_at"] = None
    elif fault == "invalid-date": candidate["published_at"] = "2026-02-31T14:00:00Z"
    elif fault == "non-utc-date": candidate["published_at"] = "2026-09-03T14:00:00+01:00"
    elif fault == "branch": candidate["target_commitish"] = "feature"
    elif fault == "extra": candidate["assets"].append({"name": "source.tar.gz"})
    elif fault == "missing": candidate["assets"].pop()
    elif fault == "wrong-id": candidate["id"] = 78
    elif fault == "asset-digest": candidate["assets"][0]["digest"] = "sha256:" + "a" * 64
    elif fault == "asset-size": candidate["assets"][0]["size"] += 1
    elif fault == "incomplete": candidate["assets"][0]["state"] = "starter"
    elif fault == "substituted": payloads[r.NODE_WHEEL] += b"tampered"
    with pytest.raises(r.ReleaseError): r.fetch_candidate("77", r.sha(raw))


@pytest.mark.parametrize("path", ["repos/PhysicalSystems/node/contents/secret", "repos/PhysicalSystems/physicalsystems/contents/main",
    "repos/PhysicalSystems/physicalsystems/releases/1/../../other", "https://attacker.invalid", "repos/PhysicalSystems/physicalsystems/releases/assets/0",
    "repos/PhysicalSystems/node-releases/releases/77"])
def test_github_endpoint_allowlist_never_calls_process(monkeypatch, path):
    monkeypatch.setattr(r.subprocess, "run", lambda *a, **k: pytest.fail("unapproved endpoint reached network helper"))
    with pytest.raises(r.ReleaseError): r.github(path)


def test_public_reads_cannot_redirect():
    with pytest.raises(r.ReleaseError): r.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://attacker.invalid")


@pytest.fixture
def workflow(monkeypatch):
    env = {"GITHUB_REPOSITORY": r.REPOSITORY, "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "9", "GITHUB_RUN_ATTEMPT": "2"}
    run = {"id": 9, "run_attempt": 2, "event": "workflow_dispatch", "head_sha": "a" * 40, "head_branch": "main",
        "path": ".github/workflows/node-release.yml", "repository": {"full_name": r.REPOSITORY, "private": False}}
    main = {"object": {"sha": "a" * 40}}
    monkeypatch.setattr(r, "github", lambda path, **kwargs: main if path.endswith("/main") else run)
    return env, run, main


@pytest.mark.parametrize("fault", [None, "private", "event", "source", "main-moved", "attempt", "path", "repository",
    "legacy-workflow", "legacy-repository"])
def test_current_public_main_attempt(workflow, fault):
    env, run, main = workflow
    if fault == "private": run["repository"]["private"] = True
    elif fault == "event": run["event"] = "pull_request"
    elif fault == "source": run["head_sha"] = "b" * 40
    elif fault == "main-moved": main["object"]["sha"] = "b" * 40
    elif fault == "attempt": run["run_attempt"] = 1
    elif fault == "path": run["path"] = ".github/workflows/unreviewed.yml"
    elif fault == "repository": env["GITHUB_REPOSITORY"] = "PhysicalSystems/private"
    elif fault == "legacy-workflow": run["path"] = ".github/workflows/publish.yml"
    elif fault == "legacy-repository": env["GITHUB_REPOSITORY"] = "PhysicalSystems/node-releases"
    if fault:
        with pytest.raises(r.ReleaseError): r.workflow_identity(env)
    else:
        assert r.workflow_identity(env) == {"runId": "9", "runAttempt": "2", "toolingCommit": "a" * 40}


def write_proofs(tmp_path, sample, monkeypatch):
    identity = {"runId": "9", "runAttempt": "2", "toolingCommit": "a" * 40}
    raw = r.canonical(sample["capsule"])
    proofs, jobs = [], []
    for target in sample["capsule"]["targets"]:
        proof = {"contractVersion": "physicalsystems-node-public-install-proof-v1", "status": "passed",
            "platform": target["platform"], "python": target["python"], "releaseMetadataSha256": r.sha(raw),
            "wheelSha256": sample["capsule"]["wheel"]["sha256"], "publicDependencies": target["publicDependencies"], **identity,
            "installation": {"contractVersion": "physicalsystems-node-installation-v1", "distribution": "physicalsystems-node",
                "version": "0.2.1", "runtimeVersion": "0.2.0", "protocols": ["physicalsystems-node-ready-v1"]},
            "nativeImports": {"numpy": "1.26.4", "opencv": "4.10.0", "hardwareOpened": False}, "physicalExecutionAuthorized": False}
        path = tmp_path / r.proof_name(target["platform"], target["python"])
        path.write_bytes(r.canonical(proof))
        proofs.append((path, proof))
        jobs.append({"name": f"install-{target['platform']}-py{target['python']}", "status": "completed", "conclusion": "success"})
    monkeypatch.setattr(r, "github", lambda path: {"jobs": jobs, "total_count": len(jobs)})
    return identity, r.sha(raw), proofs, jobs


@pytest.mark.parametrize("fault", [None, "missing", "extra", "attempt", "wheel", "capsule", "dependency", "failed-job", "skipped-job", "native", "authorized",
    "historical-node-version", "coupled-runtime-version"])
def test_same_attempt_six_proofs_required(sample, tmp_path, monkeypatch, fault):
    identity, pin, proofs, jobs = write_proofs(tmp_path, sample, monkeypatch)
    path, proof = proofs[0]
    if fault == "missing": path.unlink()
    elif fault == "extra": (tmp_path / "private-report.json").write_bytes(b"{}")
    elif fault == "attempt": proof["runAttempt"] = "1"
    elif fault == "wheel": proof["wheelSha256"] = "0" * 64
    elif fault == "capsule": proof["releaseMetadataSha256"] = "0" * 64
    elif fault == "dependency": proof["publicDependencies"] = []
    elif fault == "failed-job": jobs[0]["conclusion"] = "failure"
    elif fault == "skipped-job": jobs[0]["conclusion"] = "skipped"
    elif fault == "native": proof["nativeImports"]["opencv"] = "4.9.0"
    elif fault == "authorized": proof["physicalExecutionAuthorized"] = True
    elif fault == "historical-node-version": proof["installation"]["version"] = "0.2.0"
    elif fault == "coupled-runtime-version": proof["installation"]["runtimeVersion"] = "0.2.1"
    if fault != "missing": path.write_bytes(r.canonical(proof))
    if fault:
        with pytest.raises(r.ReleaseError): r.validate_proofs(tmp_path, sample["capsule"], pin, identity)
    else: r.validate_proofs(tmp_path, sample["capsule"], pin, identity)


def test_staged_exact_wheel_and_no_extra_uploads(sample, tmp_path):
    output = tmp_path / "stage"
    raw = r.canonical(sample["capsule"])
    r.stage(output, {"release.json": raw, r.NODE_WHEEL: sample["wheel"]})
    assert r.check_stage(output, r.sha(raw))[0] == sample["capsule"]
    (output / "upload/source.tar.gz").write_bytes(b"private")
    with pytest.raises(r.ReleaseError): r.check_stage(output, r.sha(raw))


@pytest.mark.parametrize("fault", [None, "wrong-node", "yanked-node", "dependency-unavailable"])
def test_postpublication_exact_readback_only_then_install_manifests(sample, tmp_path, monkeypatch, fault):
    stage = tmp_path / "stage"
    raw = r.canonical(sample["capsule"])
    r.stage(stage, {"release.json": raw, r.NODE_WHEEL: sample["wheel"]})
    artifact = {**sample["capsule"]["wheel"], "url": "https://files.pythonhosted.org/packages/synthetic/" + r.NODE_WHEEL}
    metadata = metadata_for(artifact)
    if fault == "yanked-node": metadata["urls"][0]["yanked"] = True
    def dependencies(capsule):
        if fault == "dependency-unavailable": raise r.ReleaseError("dependency no longer public")
    monkeypatch.setattr(r, "dependencies_public", dependencies)
    monkeypatch.setattr(r, "public_metadata", lambda name, version: metadata)
    monkeypatch.setattr(r, "public_read", lambda url, size: b"substitute" if fault == "wrong-node" else sample["wheel"])
    output = tmp_path / "published"
    if fault:
        with pytest.raises(r.ReleaseError): r.published(stage, r.sha(raw), output)
        assert not output.exists()
    else:
        r.published(stage, r.sha(raw), output)
        manifests = [json.loads(path.read_bytes()) for path in output.iterdir()]
        assert len(manifests) == 6
        assert all(item["contractVersion"] == "physicalsystems-node-install-v1" and len(item["artifacts"]) == 4 for item in manifests)
        assert all(item["release"] == "0.2.1" and item["runtimeVersion"] == "0.2.0" for item in manifests)
        assert all({art["name"]: art["version"] for art in item["artifacts"]} == {
            "physicalsystems-node": "0.2.1", "tinyedge-runtime": "0.2.0",
            "numpy": "1.26.4", "opencv-python-headless": "4.10.0.84"} for item in manifests)
        assert all(next(art for art in item["artifacts"] if art["name"] == "physicalsystems-node")["url"] == artifact["url"] for item in manifests)


def test_readback_snapshot_survives_pypa_attestation_without_relaxing_stage_checks(sample, tmp_path, monkeypatch):
    upload_stage, snapshot = tmp_path / "upload-stage", tmp_path / "readback-input"
    metadata = r.canonical(sample["capsule"])
    pin = r.sha(metadata)
    r.stage(upload_stage, {"release.json": metadata, r.NODE_WHEEL: sample["wheel"]})
    r.check_stage(upload_stage, pin)
    shutil.copytree(upload_stage, snapshot)
    r.check_stage(snapshot, pin)
    # Match the pinned PyPA Action's filesystem mutation, without signing or
    # uploading anything. This synthetic sidecar is never treated as evidence.
    (upload_stage / "upload" / (r.NODE_WHEEL + ".publish.attestation")).write_bytes(b'{"synthetic":true}')
    with pytest.raises(r.ReleaseError, match="Unexpected publication files"):
        r.check_stage(upload_stage, pin)
    artifact = {**sample["capsule"]["wheel"], "url": "https://files.pythonhosted.org/packages/synthetic/" + r.NODE_WHEEL}
    monkeypatch.setattr(r, "dependencies_public", lambda capsule: None)
    monkeypatch.setattr(r, "public_metadata", lambda name, version: metadata_for(artifact))
    monkeypatch.setattr(r, "public_read", lambda url, size: sample["wheel"])
    r.published(snapshot, pin, tmp_path / "manifests")
    assert len(list((tmp_path / "manifests").iterdir())) == 6
    assert (snapshot / "upload" / r.NODE_WHEEL).read_bytes() == sample["wheel"]
    assert sorted(item.name for item in (snapshot / "upload").iterdir()) == [r.NODE_WHEEL]
    # The snapshot remains strict: neither an extra sidecar nor altered wheel
    # bytes may be silently accepted in the readback input itself.
    (snapshot / "upload" / r.NODE_WHEEL).write_bytes(sample["wheel"] + b"tampered")
    with pytest.raises(r.ReleaseError): r.check_stage(snapshot, pin)


def test_child_probe_environment_has_no_tokens_or_python_path(monkeypatch):
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "PYTHONPATH", "PIP_EXTRA_INDEX_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"):
        monkeypatch.setenv(name, "synthetic-secret")
    value = r.clean_environment()
    assert not any("synthetic-secret" in item for item in value.values())
    assert value["PYTHONNOUSERSITE"] == "1"


def test_install_rejects_credentials_before_any_fetch_or_execution(monkeypatch, sample):
    monkeypatch.setenv("GH_TOKEN", "synthetic-token")
    monkeypatch.setattr(r, "install_probe", lambda *a, **k: pytest.fail("credential inherited"))
    monkeypatch.setattr(r, "github", lambda *a, **k: pytest.fail("install should never call GitHub"))
    with pytest.raises(r.ReleaseError): r.main(["install", "--release-metadata-sha256", "a" * 64])


@pytest.mark.parametrize("fault", [None, "identity", "protection"])
def test_stage_rechecks_identity_and_protection_after_all_mutable_reads(monkeypatch, tmp_path, sample, fault):
    identity = {"runId": "9", "runAttempt": "2", "toolingCommit": "a" * 40}
    calls = []
    def current():
        calls.append("identity")
        return {**identity, "runAttempt": "3"} if fault == "identity" and calls.count("identity") == 2 else identity
    def protected():
        calls.append("protection")
        if fault == "protection" and calls.count("protection") == 2:
            raise r.ReleaseError("Human protection changed")
    raw = r.canonical(sample["capsule"])
    monkeypatch.setattr(r, "workflow_identity", current)
    monkeypatch.setattr(r, "protections", protected)
    def fetch(*args):
        calls.append("fetch")
        return sample["capsule"], {"release.json": raw, r.NODE_WHEEL: sample["wheel"]}
    monkeypatch.setattr(r, "fetch_candidate", fetch)
    monkeypatch.setattr(r, "validate_proofs", lambda *args: calls.append("proofs"))
    monkeypatch.setattr(r, "verify_registry_mode", lambda *args: calls.append("registry"))
    command = ["stage", "--mode", "verify-published", "--candidate-release-id", "77", "--release-metadata-sha256", r.sha(raw), "--output", str(tmp_path / "stage")]
    if fault:
        with pytest.raises(r.ReleaseError): r.main(command)
    else: r.main(command)
    assert calls[:6] == ["identity", "protection", "fetch", "registry", "proofs", "registry"]
    assert calls[6] == "identity"
    if fault != "identity": assert calls[7] == "protection"


@pytest.mark.parametrize("fault", [None, "historical-node-version", "coupled-runtime-version"])
def test_clean_install_probe_is_offline_hash_pinned_and_no_hardware(monkeypatch, sample, tmp_path, fault):
    import sys
    target_platform = "win32-x64" if sys.platform == "win32" else "linux-x64"
    target_python = f"{sys.version_info.major}.{sys.version_info.minor}"
    if (target_platform, target_python) not in r.TARGETS: pytest.skip("Test Python is outside the release matrix")
    target = next(item for item in sample["capsule"]["targets"] if (item["platform"], item["python"]) == (target_platform, target_python))
    payload = b"synthetic dependency, never installed"
    for dep in target["publicDependencies"]:
        dep["sha256"], dep["bytes"] = r.sha(payload), len(payload)
    monkeypatch.setattr(r, "public_read", lambda url, maximum: payload)
    calls = []
    def execute(command, environment):
        calls.append(command)
        assert "GH_TOKEN" not in environment
        if "--installation-info" in command:
            installation = {"contractVersion": "physicalsystems-node-installation-v1", "distribution": "physicalsystems-node",
                "version": "0.2.1", "runtimeVersion": "0.2.0", "protocols": ["physicalsystems-node-ready-v1"]}
            if fault == "historical-node-version": installation["version"] = "0.2.0"
            elif fault == "coupled-runtime-version": installation["runtimeVersion"] = "0.2.1"
            return r.canonical(installation)
        if "-c" in command:
            return r.canonical({"numpy": "1.26.4", "opencv": "4.10.0", "hardwareOpened": False})
        if "--require-hashes" in command:
            req = Path(command[command.index("-r") + 1]).read_text()
            assert req.count("--hash=sha256:") == 4
        return b""
    monkeypatch.setattr(r, "execute_probe", execute)
    if fault:
        with pytest.raises(r.ReleaseError, match="Installed Node identity/protocol mismatch"):
            r.install_probe(sample["capsule"], {r.NODE_WHEEL: sample["wheel"]}, target_platform, target_python)
        assert all("-c" not in command for command in calls)
        return
    result = r.install_probe(sample["capsule"], {r.NODE_WHEEL: sample["wheel"]}, target_platform, target_python)
    assert result["installation"]["version"] == "0.2.1" and result["installation"]["runtimeVersion"] == "0.2.0"
    assert result["nativeImports"]["hardwareOpened"] is False
    install = next(command for command in calls if "--require-hashes" in command)
    assert {"--no-index", "--no-deps", "--only-binary=:all:", "--isolated"} <= set(install)
    assert all("-I" in command for command in calls)
    assert all(not {"--camera-preview", "serve-physical-node", "discover-physical-devices"} & set(command) for command in calls)


def test_auth_asset_fetch_uses_read_only_own_repo_api_without_caller_url(monkeypatch):
    calls = []
    class Result:
        returncode, stdout = 0, b"asset"
    def run(command, **kwargs):
        calls.append(command)
        return Result()
    monkeypatch.setattr(r.subprocess, "run", run)
    assert r.github(f"repos/{r.REPOSITORY}/releases/assets/123", binary=True) == b"asset"
    assert calls[0][calls[0].index("--method") + 1] == "GET"
    assert "Accept: application/octet-stream" in calls[0]
    assert "--hostname" in calls[0]


@pytest.mark.parametrize("suffix,endpoint", [
    ("git/ref/heads/main", "main-reference"),
    ("actions/runs/123", "workflow-run"),
    ("actions/runs/123/attempts/1/jobs?per_page=100", "workflow-jobs"),
    ("environments/physical-node-pypi", "environment"),
    ("environments/physical-node-pypi/deployment-branch-policies?per_page=100", "branch-policy"),
    ("releases/77", "candidate-release"),
    ("releases/assets/123", "candidate-asset"),
])
def test_github_refusal_has_only_safe_endpoint_class_and_status(monkeypatch, suffix, endpoint):
    class Result:
        returncode = 1
        stdout = b'{"secret":"synthetic-body-secret"}'
        stderr = b'gh: synthetic-token https://example.invalid/private (HTTP 403)\n'
    monkeypatch.setattr(r.subprocess, "run", lambda *args, **kwargs: Result())
    with pytest.raises(r.ReleaseError) as error:
        r.github(f"repos/{r.REPOSITORY}/{suffix}")
    assert str(error.value) == f"GitHub evidence unavailable [{endpoint}; HTTP 403]"


@pytest.mark.parametrize("fault", ["no-status", "untrusted-status", "oversized", "timeout"])
def test_github_diagnostics_never_echo_untrusted_error_details(monkeypatch, fault):
    class Result:
        returncode = 0 if fault == "oversized" else 1
        stdout = b"synthetic-secret" * 100
        stderr = b"synthetic-secret (HTTP 999)" if fault == "untrusted-status" else b"synthetic-secret"
    def invoke(*args, **kwargs):
        if fault == "timeout":
            raise r.subprocess.TimeoutExpired(["gh", "synthetic-secret"], 60, output=b"synthetic-secret", stderr=b"synthetic-secret")
        return Result()
    monkeypatch.setattr(r.subprocess, "run", invoke)
    with pytest.raises(r.ReleaseError) as error:
        r.github(f"repos/{r.REPOSITORY}/releases/77", maximum=100)
    reason = {"no-status": "HTTP status unavailable", "untrusted-status": "HTTP status unavailable",
        "oversized": "response exceeds byte bound", "timeout": "timeout"}[fault]
    assert str(error.value) == f"GitHub evidence unavailable [candidate-release; {reason}]"
