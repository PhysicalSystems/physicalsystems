"""Synthetic acceptance transcripts; no downloads, camera access, or motion."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("acceptance", Path(__file__).resolve().parents[1] / "scripts/check-linux-harness-pty.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

PROMPT = b"Install Physical Systems Node 0.2.0 (123 MB) in a private Python environment? This downloads software; it does not enable robot movement. [y/N] "


def marker(stage, kind="managed", digest="a" * 64):
    record = {"contractVersion": "physicalsystems-harness-acceptance-v1", "kind": kind,
              "manifestDigest": digest if kind == "managed" else None,
              "nodeOrigin": "http://127.0.0.1:40123" if stage == "READY" and kind == "managed" else None}
    return b"\nPHYSICAL_SYSTEMS_ACCEPTANCE_" + stage.encode() + b" " + json.dumps(record).encode() + b"\r\n"


class TranscriptTests(unittest.TestCase):
    def test_fragmented_first_run_consent_ready_render_and_shutdown(self):
        transcript = acceptance.AcceptanceTranscript()
        writes = 0
        for byte in marker("EXPECTED") + PROMPT:
            writes += int(transcript.feed(bytes([byte])))
        self.assertEqual(writes, 1)
        self.assertFalse(transcript.feed(b"y\r\nInstalling exact wheels...\r\n"))
        transcript.feed(marker("READY"))
        self.assertFalse(transcript.rendered_and_ready)
        transcript.feed(b"\x1b[1mPHYSICAL SYSTEMS\x1b[0m")
        self.assertTrue(transcript.rendered_and_ready)
        with self.assertRaisesRegex(RuntimeError, "confirmed clean shutdown"):
            transcript.finish(0)
        self.assertEqual(transcript.finish(0, listener_stopped=True), "managed")

    def test_source_candidate_explicitly_has_no_managed_acceptance(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED", "source-only") + marker("READY", "source-only"))
        transcript.feed(b"PHYSICAL SYSTEMS")
        self.assertEqual(transcript.finish(0, listener_stopped=True), "source-only")
        self.assertFalse(transcript.consent_sent)

    def test_header_alone_is_not_acceptance(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(b"PHYSICAL SYSTEMS")
        self.assertFalse(transcript.rendered_and_ready)
        with self.assertRaises(RuntimeError):
            transcript.finish(0)

    def test_reused_installation_cannot_masquerade_as_first_run(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED"))
        with self.assertRaisesRegex(RuntimeError, "first-run software consent"):
            transcript.feed(marker("READY"))

    def test_unknown_prompts_are_not_approved(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED"))
        for prompt in (b"Move the robot? [y/N] ", b"Download arbitrary software? [y/N] "):
            self.assertFalse(transcript.feed(prompt))
        self.assertFalse(transcript.consent_sent)

    def test_repeated_software_consent_is_rejected(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED"))
        self.assertTrue(transcript.feed(PROMPT))
        with self.assertRaisesRegex(RuntimeError, "repeated"):
            transcript.feed(PROMPT)

    def test_source_candidate_cannot_approve_installation(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED", "source-only"))
        with self.assertRaisesRegex(RuntimeError, "expected bundled"):
            transcript.feed(PROMPT)

    def test_mismatched_manifest_is_rejected(self):
        transcript = acceptance.AcceptanceTranscript()
        transcript.feed(marker("EXPECTED"))
        transcript.feed(PROMPT)
        with self.assertRaisesRegex(RuntimeError, "mismatched"):
            transcript.feed(marker("READY", digest="b" * 64))

    def test_output_and_installation_time_are_bounded(self):
        self.assertGreaterEqual(acceptance.STARTUP_TIMEOUT_SECONDS, 300)
        self.assertLessEqual(acceptance.STARTUP_TIMEOUT_SECONDS, 600)
        with self.assertRaisesRegex(RuntimeError, "exceeded its bound"):
            acceptance.AcceptanceTranscript().feed(b"x" * (acceptance.MAX_TRANSCRIPT_BYTES + 1))

    def test_listener_shutdown_requires_connection_refused_not_timeout(self):
        def refused(address, timeout):
            self.assertEqual(address, ("127.0.0.1", 40123))
            raise ConnectionRefusedError()

        def timed_out(address, timeout):
            raise TimeoutError()

        def unknown(address, timeout):
            raise OSError("unreachable")

        self.assertTrue(acceptance.listener_closed("http://127.0.0.1:40123", connect=refused))
        self.assertFalse(acceptance.listener_closed("http://127.0.0.1:40123", connect=timed_out))
        self.assertFalse(acceptance.listener_closed("http://127.0.0.1:40123", connect=unknown))

    def test_live_listener_is_not_stopped(self):
        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        self.assertFalse(acceptance.listener_closed("http://127.0.0.1:40123", connect=lambda *args, **kwargs: Connection()))

    def test_non_loopback_or_credentialled_listener_is_never_probed(self):
        for origin in ("http://localhost:40123", "http://127.0.0.1:0", "http://127.0.0.1:65536",
                       "http://user:secret@127.0.0.1:40123", "http://127.0.0.1:40123/?token=secret"):
            with self.assertRaises(RuntimeError):
                acceptance.listener_address(origin)

    def test_shutdown_failure_never_signals_an_already_reaped_pid(self):
        calls = []
        kill = lambda *args: calls.append("kill")
        wait = lambda *args: calls.append("wait")
        for exit_code in (0, 1, -15):
            acceptance.cleanup_child(12345, exit_code, kill=kill, wait=wait)
        self.assertEqual(calls, [])
        acceptance.cleanup_child(12345, None, kill=kill, wait=wait)
        self.assertEqual(calls, ["kill", "wait"])


if __name__ == "__main__":
    unittest.main()
