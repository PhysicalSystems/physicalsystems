from __future__ import annotations

import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import zipfile

import pytest

SPEC = importlib.util.spec_from_file_location("runtime_release", Path(__file__).parents[1] / "scripts/release.py")
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


@pytest.fixture(autouse=True)
def context(monkeypatch):
    for key, value in {"GITHUB_REPOSITORY": r.REPOSITORY, "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "a" * 40,
        "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_EVENT_NAME": "workflow_dispatch", "COORDINATOR_ID": "", "EXPECTED_HEAD_SHA": ""}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(r, "public", lambda *a, **kw: pytest.fail("Unmocked public network"))
    monkeypatch.setattr(r, "github", lambda *a, **kw: pytest.fail("Unmocked GitHub network"))
    monkeypatch.setattr(r, "audit_current_run", lambda: None)


def wheel(release_version="0.2.0", extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("tinyedge_runtime/__init__.py", b"__version__ = '0.2.0'\n")
        archive.writestr("tinyedge_runtime/py.typed", b"")
        archive.writestr(f"tinyedge_runtime-{release_version}.dist-info/METADATA", f"Name: tinyedge-runtime\nVersion: {release_version}\n\n")
        for name, raw in (extra or {}).items():
            archive.writestr(name, raw)
    return output.getvalue()


@pytest.fixture
def source(tmp_path, monkeypatch):
    folder = tmp_path / "source"
    package = folder / "packages/runtime/src/tinyedge_runtime"
    package.mkdir(parents=True)
    (package / "__init__.py").write_bytes(b"__version__ = '0.2.0'\n")
    (package / "py.typed").write_bytes(b"")
    (folder / "release").mkdir()
    pin = {"components": {"runtime": {"distribution": "tinyedge-runtime", "version": "0.2.0", "wheelSha256": r.sha(wheel())}}}
    (folder / "release/product.json").write_text(json.dumps(pin))
    monkeypatch.setattr(r, "ROOT", folder)
    return folder


def listing(raw=None):
    raw = raw or wheel()
    return [{"filename": "tinyedge_runtime-0.2.0-py3-none-any.whl", "url": "https://files.pythonhosted.org/packages/test.whl",
        "digests": {"sha256": r.sha(raw)}, "size": len(raw), "yanked": False}]


def published(monkeypatch, raw=None):
    raw = raw or wheel()
    monkeypatch.setattr(r, "pypi_files", lambda *a, **kw: listing(raw))
    monkeypatch.setattr(r, "public", lambda *a, **kw: raw)


def manifest():
    return {"contractVersion": r.SCHEMA, "distribution": r.DISTRIBUTION, "version": "0.2.1", "sourceSha": "a" * 40,
        "files": [{"filename": name, "sha256": "b" * 64, "size": 123} for name in r.names("0.2.1")]}


def validate(value):
    raw = json.dumps(value).encode()
    return r.validate_manifest(raw, r.sha(raw))


def test_exact_manifest():
    assert validate(manifest())["version"] == "0.2.1"


@pytest.mark.parametrize("mutation", [
    lambda m: m.update(distribution="other"),
    lambda m: m.update(sourceSha="main"),
    lambda m: m.update(extra=True),
    lambda m: m["files"].append(m["files"][0]),
    lambda m: m["files"][0].update(filename="../../secret"),
    lambda m: m["files"][0].update(sha256="B" * 64),
    lambda m: m["files"][0].update(size=True),
    lambda m: m["files"][0].update(size=r.LIMIT + 1),
])
def test_manifest_rejects_unsafe_or_ambiguous_values(mutation):
    value = manifest()
    mutation(value)
    with pytest.raises(r.Refused):
        validate(value)


def test_manifest_raw_hash_and_duplicate_keys():
    with pytest.raises(r.Refused, match="pin"):
        r.validate_manifest(json.dumps(manifest()).encode(), "0" * 64)
    with pytest.raises(r.Refused, match="Duplicate"):
        r.document(b'{"name":1,"name":2}')


def test_published_verification_uses_pinned_bytes_not_rebuild(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    assert receipt["operation"] == "verify-published"
    assert receipt["candidateReleaseId"] is None
    assert list(payloads) == ["tinyedge_runtime-0.2.0-py3-none-any.whl"]
    output = tmp_path / "input"
    r.store(output, receipt, payloads)
    assert r.check_input(output) == receipt


def test_verify_rejects_new_candidate_inputs(source):
    with pytest.raises(r.Refused, match="does not accept"):
        r.fetch("verify-published", "42", "a" * 64)


def test_verify_rejects_changed_public_bytes(source, monkeypatch):
    published(monkeypatch)
    monkeypatch.setattr(r, "public", lambda *a, **kw: b"changed bytes")
    with pytest.raises(r.Refused, match="bytes differ"):
        r.fetch("verify-published", "", "")


@pytest.mark.parametrize("field,value", [("yanked", True), ("digests", {"sha256": "0" * 64})])
def test_verify_rejects_yanked_or_different_registry_metadata(source, monkeypatch, field, value):
    published(monkeypatch)
    files = listing()
    files[0][field] = value
    monkeypatch.setattr(r, "pypi_files", lambda *a, **kw: files)
    with pytest.raises(r.Refused, match="approved"):
        r.fetch("verify-published", "", "")


def test_wheel_requires_exact_reviewed_runtime_code(source):
    r.inspect_wheel(wheel(), "0.2.0")
    with pytest.raises(r.Refused, match="Foreign"):
        r.inspect_wheel(wheel(extra={"other/private.py": b"private"}), "0.2.0")
    with pytest.raises(r.Refused, match="code differs"):
        r.inspect_wheel(wheel(extra={"tinyedge_runtime/new.py": b"unreviewed"}), "0.2.0")
    with pytest.raises(r.Refused, match="Unsafe"):
        r.inspect_wheel(wheel(extra={"tinyedge_runtime/../escape": b"escape"}), "0.2.0")


def test_wheel_metadata_identity(source):
    with pytest.raises(r.Refused):
        r.inspect_wheel(wheel("9.9.9"), "0.2.0")


def sdist(source, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        entries = {"PKG-INFO": b"Name: tinyedge-runtime\nVersion: 0.2.0\n\n",
            "src/tinyedge_runtime/__init__.py": b"__version__ = '0.2.0'\n", "src/tinyedge_runtime/py.typed": b""} | (extra or {})
        for name, raw in entries.items():
            info = tarfile.TarInfo("tinyedge_runtime-0.2.0/" + name)
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
    return output.getvalue()


def test_sdist_is_public_source_and_same_code_as_wheel(source):
    r.inspect_sdist(sdist(source), "0.2.0", wheel())
    with pytest.raises(r.Refused, match="outside reviewed"):
        r.inspect_sdist(sdist(source, {"private-passwords.txt": b"never export"}), "0.2.0", wheel())
    with pytest.raises(r.Refused, match="outside reviewed"):
        r.inspect_sdist(sdist(source, {"src/tinyedge_runtime/__init__.py": b"modified"}), "0.2.0", wheel())


def test_invalid_or_foreign_dispatch_is_refused(monkeypatch):
    monkeypatch.setenv("GITHUB_REF", "refs/tags/v0.2.0")
    with pytest.raises(r.Refused, match="manual"):
        r.identity()


@pytest.mark.parametrize("coordinator", ["../../other", "new\nrun", "not-a-uuid"])
def test_coordinator_id_is_bounded(monkeypatch, coordinator):
    monkeypatch.setenv("COORDINATOR_ID", coordinator)
    with pytest.raises(r.Refused, match="coordinator"):
        r.identity()


@pytest.mark.parametrize("expected", ["b" * 40, "main", "a" * 39, "A" * 40])
def test_expected_head_sha_prevents_dispatch_race(monkeypatch, expected):
    monkeypatch.setenv("EXPECTED_HEAD_SHA", expected)
    with pytest.raises(r.Refused, match="coordinator-reviewed"):
        r.identity()


def test_expected_head_sha_is_recorded(monkeypatch):
    monkeypatch.setenv("EXPECTED_HEAD_SHA", "a" * 40)
    assert r.identity()["expectedHeadSha"] == "a" * 40


def test_installed_code_gets_no_release_credentials(monkeypatch):
    for key in ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "PYTHONPATH", "PIP_INDEX_URL"]:
        monkeypatch.setenv(key, "sensitive")
    environment = r.clean_environment()
    assert not any(key in environment for key in ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "PYTHONPATH", "PIP_INDEX_URL"])


def proof_set(directory, receipt):
    directory.mkdir()
    wheel_sha = next(item["sha256"] for item in receipt["files"] if item["filename"].endswith(".whl"))
    for platform, python in r.TARGETS:
        proof = {"contractVersion": "physicalsystems-runtime-install-proof-v1", "inputSha256": r.sha((json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()),
            "platform": platform, "python": python, "testsPassed": 136, "conformanceFixtures": 12, "hardwareAccessed": False,
            "wheelSha256": wheel_sha, **r.identity()}
        r.write_json(directory / f"runtime-proof-{platform}-py{python}.json", proof)


def jobs():
    return {"total_count": 8, "jobs": [{"name": f"install-{platform}-py{python}", "conclusion": "success"} for platform, python in r.TARGETS]}


def test_all_six_current_attempt_proofs_and_jobs_required(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    proofs = tmp_path / "proofs"
    proof_set(proofs, receipt)
    monkeypatch.setattr(r, "github", lambda *a, **kw: jobs())
    r.check_proofs(proofs, receipt)
    first = next(proofs.glob("*.json"))
    value = json.loads(first.read_text())
    value["runAttempt"] = "1"
    r.write_json(first, value)
    with pytest.raises(r.Refused, match="Stale"):
        r.check_proofs(proofs, receipt)


def test_failed_job_cannot_be_replaced_by_forged_success_receipt(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    proofs = tmp_path / "proofs"
    proof_set(proofs, receipt)
    job_result = jobs()
    job_result["jobs"][0]["conclusion"] = "failure"
    monkeypatch.setattr(r, "github", lambda *a, **kw: job_result)
    with pytest.raises(r.Refused, match="not successful"):
        r.check_proofs(proofs, receipt)


def test_verify_stage_has_no_upload_directory_and_readback_claims_no_publication(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    proofs = tmp_path / "proofs"
    proof_set(proofs, receipt)
    monkeypatch.setattr(r, "github", lambda *a, **kw: jobs())
    stage = tmp_path / "stage"
    r.stage("verify-published", "", "", proofs, stage)
    assert not (stage / "upload").exists()
    result = r.readback(stage, tmp_path / "readback.json")
    assert result["anonymousReadbackVerified"] is True
    assert result["publicationRequested"] is False
    assert result["uploadAttributionVerified"] is False


def test_changed_artifact_and_stale_input_refused(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    directory = tmp_path / "input"
    r.store(directory, receipt, payloads)
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "3")
    with pytest.raises(r.Refused, match="exact workflow attempt"):
        r.check_input(directory)
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    next(directory.glob("*.whl")).write_bytes(b"tampered")
    with pytest.raises(r.Refused, match="hash differs"):
        r.check_input(directory)


def test_output_directory_cannot_overwrite_prior_evidence(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    with pytest.raises(r.Refused, match="new absolute"):
        r.store(tmp_path, receipt, payloads)


def test_publish_requires_component_scoped_tag_and_exact_source(source, monkeypatch):
    value = manifest()
    raw = json.dumps(value).encode()
    wheel_raw = wheel("0.2.1")
    assets_raw = {"release.json": raw, r.names("0.2.1")[0]: wheel_raw, r.names("0.2.1")[1]: b"not yet inspected"}
    release = {"id": 42, "draft": False, "prerelease": True, "tag_name": "v0.2.1",
        "assets": [{"id": i, "name": name, "size": len(data), "digest": "sha256:" + r.sha(data)} for i, (name, data) in enumerate(assets_raw.items(), 1)]}
    def github(route, binary=False):
        if route == "releases/42":
            return release
        return list(assets_raw.values())[int(route.rsplit("/", 1)[1]) - 1]
    monkeypatch.setattr(r, "github", github)
    with pytest.raises(r.Refused, match="component-scoped"):
        r.fetch("publish", "42", r.sha(raw))


def candidate_fixture(source, monkeypatch):
    # Synthetic registry absence: this never uploads or changes real 0.2.0.
    payloads = {r.names("0.2.0")[0]: wheel(), r.names("0.2.0")[1]: sdist(source)}
    value = {"contractVersion": r.SCHEMA, "distribution": r.DISTRIBUTION, "version": "0.2.0", "sourceSha": "a" * 40,
        "files": [{"filename": name, "sha256": r.sha(raw), "size": len(raw)} for name, raw in payloads.items()]}
    raw = json.dumps(value).encode()
    payloads["release.json"] = raw
    release = {"id": 42, "draft": False, "prerelease": True, "tag_name": "runtime-v0.2.0-candidate",
        "assets": [{"id": i, "name": name, "size": len(data), "digest": "sha256:" + r.sha(data)} for i, (name, data) in enumerate(payloads.items(), 1)]}
    def github(route, binary=False):
        if route.startswith("actions/"):
            return jobs()
        if route == "releases/42":
            return release
        return list(payloads.values())[int(route.rsplit("/", 1)[1]) - 1]
    monkeypatch.setattr(r, "github", github)
    absence_checks = []
    def pypi(release_version, absent=False):
        assert release_version == "0.2.0" and absent is True
        absence_checks.append(release_version)
        return []
    monkeypatch.setattr(r, "pypi_files", pypi)
    return r.sha(raw), absence_checks


def test_publish_stages_only_exact_two_distributions_after_six_proofs_and_live_audit(source, monkeypatch, tmp_path):
    pin, absence_checks = candidate_fixture(source, monkeypatch)
    receipt, payloads = r.fetch("publish", "42", pin)
    proofs = tmp_path / "proofs"
    proof_set(proofs, receipt)
    audited = []
    monkeypatch.setattr(r, "audit_current_run", lambda: audited.append(True))
    stage = tmp_path / "stage"
    assert r.stage("publish", "42", pin, proofs, stage) == receipt
    assert {path.name for path in (stage / "upload").iterdir()} == set(r.names("0.2.0"))
    assert absence_checks == ["0.2.0", "0.2.0"]
    assert audited == [True]


def test_main_or_protection_change_after_download_prevents_successful_stage(source, monkeypatch, tmp_path):
    published(monkeypatch)
    receipt, payloads = r.fetch("verify-published", "", "")
    proofs = tmp_path / "proofs"
    proof_set(proofs, receipt)
    monkeypatch.setattr(r, "github", lambda *a, **kw: jobs())
    def changed():
        raise r.Refused("main changed after download")
    monkeypatch.setattr(r, "audit_current_run", changed)
    with pytest.raises(r.Refused, match="main changed"):
        r.stage("verify-published", "", "", proofs, tmp_path / "stage")


def test_generated_setup_cfg_cannot_change_source_build(source):
    with pytest.raises(r.Refused, match="Source build configuration"):
        r.inspect_sdist(sdist(source, {"setup.cfg": b"[options]\nsetup_requires = unreviewed-code\n"}), "0.2.0", wheel())


def test_existing_version_fails_closed_instead_of_retry_upload(monkeypatch):
    monkeypatch.setattr(r, "public", lambda *a, **kw: b"{}")
    with pytest.raises(r.Refused, match="never repeat an upload"):
        r.pypi_files("0.2.0", absent=True)


def test_no_upload_command_in_runtime_tooling():
    text = Path(r.__file__).read_text()
    assert 'choices=("fetch", "install", "stage", "readback")' in text
    assert '"upload"' not in text.split('choices=(')[1].split(')')[0]
