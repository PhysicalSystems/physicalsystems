"""Keep release authority and the fresh platform matrix explicit in source.

Modified for TIN-417: verify the relocated inactive publisher template, not a
live uploader. Root Python source CI is tested separately in this repository.
"""
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "workflows/node-release.yml.template"


def test_workflows_pin_actions_and_have_no_private_access_or_automatic_publish():
    paths = [TEMPLATE]
    for path in paths:
        text = path.read_text()
        actions = re.findall(r"uses:\s*([^\s]+)", text)
        assert actions and all(re.fullmatch(r"[A-Za-z0-9_./-]+@[a-f0-9]{40}", action) for action in actions)
        assert "persist-credentials: false" in text
        assert "pull_request_target:" not in text and "workflow_run:" not in text
        assert "secrets." not in text and "contents: write" not in text
        assert "PhysicalSystems/node/" not in text
    publish = TEMPLATE.read_text()
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


def test_migration_template_is_inactive_and_future_authority_stays_main_only():
    assert not (ROOT / ".github/workflows").exists()
    assert not (ROOT.parents[1] / ".github/workflows/node-release.yml").exists()
    publish = TEMPLATE.read_text()
    guard = ("if: ${{ false && github.repository == 'PhysicalSystems/physicalsystems' "
        "&& github.ref == 'refs/heads/main' && github.event.repository.private == false "
        "&& vars.PHYSICAL_NODE_PUBLISH_POLICY == 'v1-minimal-node-preview' }}")
    assert publish.count(guard) == 2  # Neither verification nor upload is active.
    assert "release/node/scripts/release.py" in publish
    assert "python -B -m pytest -q -p no:cacheprovider release/node/tests" in publish
    assert "PhysicalSystems/node-releases" not in publish
    assert "'scripts/release.py'" not in publish
    verifier = (ROOT / "scripts/release.py").read_text()
    assert 'REPOSITORY = "PhysicalSystems/physicalsystems"' in verifier
    assert 'run.get("path") == ".github/workflows/node-release.yml"' in verifier
    assert '.github/workflows/publish.yml' not in verifier


def test_auth_fetch_and_installed_probe_are_separate_steps():
    text = TEMPLATE.read_text()
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
    text = TEMPLATE.read_text()
    step = text.split("- name: " + name, 1)[1].split("        run: |\n", 1)[1]
    lines = []
    for line in step.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line[10:])
    return "\n".join(lines)


def test_snapshot_created_and_validated_before_pypa_uses_original_upload_stage():
    text = TEMPLATE.read_text()
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
