"""Keep release authority and the fresh platform matrix explicit in source.

Modified for TIN-417: verify the protected consolidated publisher, distinguish
verification-only from upload mode, and retain the inactive import as history.
"""
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "workflows/node-release.yml.template"
PUBLISH = ROOT.parents[1] / ".github/workflows/node-release.yml"


def test_workflows_pin_actions_and_have_no_private_access_or_automatic_publish():
    paths = [TEMPLATE, PUBLISH]
    for path in paths:
        text = path.read_text()
        actions = re.findall(r"uses:\s*([^\s]+)", text)
        assert actions and all(re.fullmatch(r"[A-Za-z0-9_./-]+@[a-f0-9]{40}", action) for action in actions)
        assert "persist-credentials: false" in text
        assert "pull_request_target:" not in text and "workflow_run:" not in text
        assert "secrets." not in text and "contents: write" not in text
        assert "PhysicalSystems/node/" not in text
    publish = PUBLISH.read_text()
    assert "workflow_dispatch:" in publish and "pull_request:" not in publish and "push:" not in publish
    assert "Published candidate prerelease ID" in publish
    assert "platform: [linux-x64, win32-x64]" in publish
    assert "python: ['3.10', '3.11', '3.12']" in publish
    assert "needs: [verify, install]" in publish
    assert "name: physical-node-pypi" in publish
    assert publish.count("id-token: write") == 1
    assert "packages-dir: .release-stage/upload/" in publish
    assert "skip-existing: false" in publish and "attestations: true" in publish
    assert "dc37677b2e1c63e2034f94d8a5b11f265b73ba33" in publish
    assert "node-proof-${{ github.run_id }}-${{ github.run_attempt }}-*" in publish
    assert "physicalsystems-node-install-v1" not in publish  # Generated only after exact readback.


def test_historical_template_stays_inactive_and_active_authority_stays_main_only():
    assert not (ROOT / ".github/workflows").exists()
    publish = PUBLISH.read_text()
    guard = ("if: ${{ github.repository == 'PhysicalSystems/physicalsystems' "
        "&& github.ref == 'refs/heads/main' && github.event.repository.private == false "
        "&& vars.PHYSICAL_NODE_PUBLISH_POLICY == 'v1-minimal-node-preview' }}")
    assert publish.count(guard) == 2
    assert TEMPLATE.read_text().count("if: ${{ false &&") == 2
    assert "if: ${{ false &&" not in publish
    assert "release/node/scripts/release.py" in publish
    assert "python -B -m pytest -q -p no:cacheprovider release/node/tests" in publish
    assert "PhysicalSystems/node-releases" not in publish
    assert "'scripts/release.py'" not in publish
    verifier = (ROOT / "scripts/release.py").read_text()
    assert 'REPOSITORY = "PhysicalSystems/physicalsystems"' in verifier
    assert 'run.get("path") == ".github/workflows/node-release.yml"' in verifier
    assert '.github/workflows/publish.yml' not in verifier


def test_auth_fetch_and_installed_probe_are_separate_steps():
    text = PUBLISH.read_text()
    install_step = text.split("- name: Install offline", 1)[1].split("- uses:", 1)[0]
    assert "GH_TOKEN" not in install_step and "github.token" not in install_step
    assert "'install'" in install_step and "--directory" in install_step
    assert "--candidate-release-id" not in install_step


def test_public_release_tooling_has_no_wheel_or_node_runtime_payload():
    assert not list(ROOT.glob("**/*.whl"))
    assert not (ROOT / "tinyedge_agent").exists()
    assert not (ROOT / "tinyedge_runtime").exists()
    text = (ROOT / "scripts/release.py").read_text()
    assert "build_physical_node" not in text
    assert "private-candidate" not in text


def step_python(name):
    text = PUBLISH.read_text()
    step = text.split("- name: " + name, 1)[1].split("        run: |\n", 1)[1]
    lines = []
    for line in step.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line[10:])
    return "\n".join(lines)


def test_snapshot_created_and_validated_before_pypa_uses_original_upload_stage():
    text = PUBLISH.read_text()
    snapshot = step_python("Revalidate pins, all six current-attempt proofs, dependencies and protections after human approval")
    compile(snapshot, "workflow-stage", "exec")
    assert "shutil.copytree(upload_stage, readback_input)" in snapshot
    assert "['check_stage'](readback_input, os.environ['METADATA_SHA256'])" in snapshot
    assert snapshot.index("subprocess.run") < snapshot.index("shutil.copytree") < snapshot.index("['check_stage']")
    assert text.index("shutil.copytree") < text.index("uses: pypa/gh-action-pypi-publish")
    readback = step_python("Verify anonymous exact public readback and generate six real install manifests")
    assert "Path(os.environ['RUNNER_TEMP']) / 'readback-input'" in readback
    assert "GITHUB_WORKSPACE" not in readback and ".release-stage" not in readback
    assert "packages-dir: .release-stage/upload/" in text


def test_verification_default_never_enters_pypa_and_both_modes_keep_protected_proof():
    text = PUBLISH.read_text()
    assert "default: verify-published" in text
    assert "options: [verify-published, publish]" in text
    assert text.count("'--mode', os.environ['RELEASE_MODE']") == 3
    upload_step = text.split("- name: Publish one reviewed prebuilt wheel via environment-scoped OIDC", 1)[1].split("- name:", 1)[0]
    assert "if: ${{ inputs.operation == 'publish' }}" in upload_step
    assert "skip-existing: false" in upload_step
    assert text.count("uses: pypa/gh-action-pypi-publish") == 1
    proof_step = text.split("- name: Verify the protected PyPI trusted publisher without uploading", 1)[1].split("- name:", 1)[0]
    assert "'release/publisher-verification.py', '--component', 'node'" in proof_step
    assert "GITHUB_TOKEN: ${{ github.token }}" in proof_step
    assert "if:" not in proof_step and "--audit-only" not in proof_step
    # Current main/attempt/protections and registry state are checked again
    # after the potentially slow token exchange, immediately before upload.
    assert text.index("'release/publisher-verification.py'") < text.index("'stage', '--mode'") < text.index("uses: pypa/gh-action-pypi-publish")
    readback_step = text.split("- name: Verify anonymous exact public readback", 1)[1].split("- uses:", 1)[0]
    assert "if: ${{ always() && steps.stage.outcome == 'success' }}" in readback_step
    assert "inputs.operation" not in readback_step
    assert "id: stage" in text and "id: readback" in readback_step
    assert text.count("if: ${{ always() && steps.readback.outcome == 'success' }}") == 2
    assert "node-publisher-verification-${{ github.run_id }}-${{ github.run_attempt }}" in text


@pytest.mark.parametrize("value,valid", [("", True), ("9a15c81e-414e-4bac-b9f8-8e79534cd6d3", True),
    ("anything-else", False), ("9A15C81E-414E-4BAC-B9F8-8E79534CD6D3", False)])
def test_coordinator_identity_is_optional_but_canonical(monkeypatch, value, valid):
    monkeypatch.setenv("COORDINATOR_ID", value)
    monkeypatch.setenv("EXPECTED_HEAD_SHA", "")
    code = compile(step_python("Validate coordinator and requested source"), "coordinator-identity", "exec")
    if valid: exec(code, {})
    else:
        with pytest.raises((ValueError, SystemExit)): exec(code, {})
    assert "run-name: Node ${{ inputs.operation }} / ${{ inputs.coordinator_id || 'manual' }}" in PUBLISH.read_text()


@pytest.mark.parametrize("expected,valid", [("", True), ("a" * 40, True), ("b" * 40, False), ("A" * 40, False), ("a" * 39, False)])
def test_requested_source_is_optional_but_exact_before_validation(monkeypatch, expected, valid):
    monkeypatch.setenv("COORDINATOR_ID", "")
    monkeypatch.setenv("EXPECTED_HEAD_SHA", expected)
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    code = compile(step_python("Validate coordinator and requested source"), "requested-source", "exec")
    if valid: exec(code, {})
    else:
        with pytest.raises(SystemExit, match="requested reviewed main revision"): exec(code, {})


def test_requested_source_is_rechecked_before_any_protected_staging(monkeypatch):
    import subprocess
    monkeypatch.setenv("EXPECTED_HEAD_SHA", "a" * 40)
    monkeypatch.setenv("GITHUB_SHA", "b" * 40)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("A mismatched source reached staging"))
    code = step_python("Revalidate pins, all six current-attempt proofs, dependencies and protections after human approval")
    with pytest.raises(SystemExit, match="requested reviewed main revision"):
        exec(compile(code, "requested-stage-source", "exec"), {})


def test_readback_failure_prints_only_bounded_sanitized_refusal(monkeypatch, capsys, tmp_path):
    import subprocess
    import time
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("METADATA_SHA256", "a" * 64)
    commands = []
    unsafe = "Traceback with synthetic-secret\nRelease refused: " + "x" * 301 + "\nRelease refused: \x1b[31munsafe\n"
    stderr = unsafe + "Release refused: Unexpected publication files\n"
    def run(command, **kwargs):
        commands.append(command)
        assert command[command.index("--directory") + 1] == str(tmp_path / "readback-input")
        assert "readback" in command and "stage" not in command
        return SimpleNamespace(returncode=1, stdout="synthetic-secret", stderr=stderr)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(time, "sleep", lambda seconds: None)
    code = step_python("Verify anonymous exact public readback and generate six real install manifests")
    with pytest.raises(RuntimeError, match="Inspect before any new upload"):
        exec(compile(code, "workflow-readback", "exec"), {})
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == "Release refused: Unexpected publication files\n" * 4
    assert len(commands) == 4  # Reads only; the upload Action is never retried.
