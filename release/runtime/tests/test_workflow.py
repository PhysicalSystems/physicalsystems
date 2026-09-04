from pathlib import Path
import re

ROOT = Path(__file__).parents[3]
WORKFLOW = ROOT / ".github/workflows/runtime-release.yml"


def test_runtime_publisher_is_manual_component_scoped_and_main_only():
    text = WORKFLOW.read_text()
    assert "  workflow_dispatch:" in text
    assert "  release:" not in text and "  push:" not in text and "  pull_request:" not in text
    assert "options: [verify-published, publish]" in text
    assert "default: verify-published" in text
    assert "runtime-v<version>-candidate" in text
    assert "github.repository == 'PhysicalSystems/physicalsystems'" in text
    assert "github.ref == 'refs/heads/main'" in text
    assert "github.event.repository.private == false" in text
    assert "name: runtime-pypi" in text
    assert "cancel-in-progress: false" in text


def test_only_qualified_human_gate_can_upload_once():
    text = WORKFLOW.read_text()
    assert text.count("id-token: write") == 1
    assert text.count("pypa/gh-action-pypi-publish@") == 1
    assert "needs: [verify, install]" in text
    assert "if: ${{ inputs.operation == 'publish' }}" in text
    assert "skip-existing: false" in text
    assert "attestations: true" in text
    assert "--audit-only" in text and "release/publisher-verification.py" in text
    assert "pattern: runtime-proof-${{ github.run_id }}-${{ github.run_attempt }}-*" in text
    assert "name: runtime-publisher-evidence-${{ github.run_id }}-${{ github.run_attempt }}" in text


def test_six_native_targets_and_immutable_actions():
    text = WORKFLOW.read_text()
    assert "platform: [linux-x64, win32-x64]" in text
    assert "python: ['3.10', '3.11', '3.12']" in text
    for action in re.findall(r"uses:\s+(\S+)", text):
        assert re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+@[a-f0-9]{40}", action)
    assert "persist-credentials: true" not in text


def test_readback_is_available_after_uncertain_upload_but_upload_is_not_retried():
    text = WORKFLOW.read_text()
    assert "always() && steps.stage.outcome == 'success'" in text
    assert "for attempt in range(4)" in text
    assert "Inspect the registry before any further upload" in text
    assert "'readback'" in text.split("for attempt in range(4)")[0]
