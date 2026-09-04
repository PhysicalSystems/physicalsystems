#!/usr/bin/env python3
"""Source-only Linux PTY acceptance; software consent is scoped to this test."""

from __future__ import annotations

import json
import os
import re
import select
import signal
import socket
import sys
import time


STARTUP_TIMEOUT_SECONDS = 600  # Includes matching pinned downloads and fresh private venv installation.
EXIT_TIMEOUT_SECONDS = 30
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
EXPECTED_HEADER = b"PHYSICAL SYSTEMS"
MARKER = b"PHYSICAL_SYSTEMS_ACCEPTANCE_"
SOFTWARE_CONSENT = re.compile(
    rb"Install Physical Systems Node 0\.2\.1 \([0-9]{1,4} MB\) in a private Python environment\? "
    rb"This sets up software; it does not enable robot movement\. \[y/N\] "
)


def plain_tail(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)
    return text[-4000:]


def listener_address(origin: str) -> tuple[str, int]:
    match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", origin)
    if not match or int(match[1]) > 65535:
        raise RuntimeError("Acceptance requires one owned loopback listener")
    return "127.0.0.1", int(match[1])


def listener_closed(origin: str, connect=socket.create_connection) -> bool:
    address = listener_address(origin)
    try:
        with connect(address, timeout=0.5):
            return False
    except ConnectionRefusedError:
        return True
    except OSError:
        # A timeout, broken route or other transport failure is not stop proof.
        return False


class AcceptanceTranscript:
    """Pure parser so consent/readiness regressions run without a PTY or hardware."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.pending = b""
        self.expected = None
        self.ready = False
        self.node_origin = None
        self.consent_sent = False

    def feed(self, chunk: bytes) -> bool:
        self.data.extend(chunk)
        if len(self.data) > MAX_TRANSCRIPT_BYTES:
            raise RuntimeError("Harness acceptance output exceeded its bound")
        self.pending += chunk
        lines = self.pending.split(b"\n")
        self.pending = lines.pop()
        for line in lines:
            if not line.startswith(MARKER):
                continue
            stage, encoded = line[len(MARKER):].split(b" ", 1)
            record = json.loads(encoded)
            if set(record) != {"contractVersion", "kind", "manifestDigest", "nodeOrigin"} or record["contractVersion"] != "physicalsystems-harness-acceptance-v1":
                raise RuntimeError("Invalid acceptance evidence")
            if record["kind"] not in ("managed", "source-only") or (
                record["kind"] == "managed" and not re.fullmatch(r"[a-f0-9]{64}", record["manifestDigest"] or "")
            ) or (record["kind"] == "source-only" and record["manifestDigest"] is not None):
                raise RuntimeError("Invalid acceptance mode or digest")
            if record["nodeOrigin"] is not None:
                listener_address(record["nodeOrigin"])
            if stage == b"EXPECTED" and self.expected is None:
                if record["nodeOrigin"] is not None:
                    raise RuntimeError("Fresh startup cannot already own a Node listener")
                self.expected = record
            elif stage == b"READY" and not self.ready and self.expected and all(
                record[key] == self.expected[key] for key in ("contractVersion", "kind", "manifestDigest")
            ):
                if record["kind"] == "managed" and not self.consent_sent:
                    raise RuntimeError("Managed acceptance did not exercise first-run software consent")
                if (record["kind"] == "managed") != (record["nodeOrigin"] is not None):
                    raise RuntimeError("Readiness must identify exactly the expected managed listener")
                self.ready = True
                self.node_origin = record["nodeOrigin"]
            else:
                raise RuntimeError("Unexpected or mismatched acceptance evidence")
        prompts = list(SOFTWARE_CONSENT.finditer(self.data))
        if len(prompts) > 1:
            raise RuntimeError("Acceptance must not approve repeated installation prompts")
        if prompts and not self.consent_sent:
            if not self.expected or self.expected["kind"] != "managed":
                raise RuntimeError("Software consent requires an expected pinned managed release")
            self.consent_sent = True
            return True
        return False

    @property
    def rendered_and_ready(self) -> bool:
        return self.ready and EXPECTED_HEADER in self.data

    def finish(self, exit_code: int, listener_stopped: bool = False) -> str:
        if exit_code != 0 or not self.rendered_and_ready or not listener_stopped:
            raise RuntimeError(f"Harness acceptance requires readiness, rendering and confirmed clean shutdown (exit {exit_code})\n{plain_tail(self.data)}")
        return self.expected["kind"]


def wait_for_exit(pid: int, deadline: float) -> int | None:
    while time.monotonic() < deadline:
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)
    return None


def cleanup_child(pid: int, exit_code: int | None, kill=os.kill, wait=wait_for_exit) -> None:
    if exit_code is not None:
        return  # A reaped PID may already belong to an unrelated process.
    try:
        kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        wait(pid, time.monotonic() + 3)
    except ChildProcessError:
        pass


def main() -> int:
    # Keep Linux-only imports out of the pure transcript regression tests.
    import fcntl
    import pty
    import struct
    import termios

    if len(sys.argv) != 4:
        raise SystemExit("Usage: check-linux-harness-pty.py NODE_EXECUTABLE ACCEPTANCE_WRAPPER INSTALLED_PACKAGE_ROOT")
    command, wrapper, package_root = [os.path.realpath(value) for value in sys.argv[1:]]
    if not os.path.isfile(command) or not os.access(command, os.X_OK) or not os.path.isfile(wrapper) or not os.path.isdir(package_root):
        raise SystemExit("Acceptance requires an executable Node, source-only wrapper and installed package directory")

    pid, terminal = pty.fork()
    if pid == 0:
        # This copy belongs only to the acceptance subprocess. Never inherit an
        # external Node, physical config, simulator, Python override or preload.
        environment = {key: value for key, value in os.environ.items()
                       if not re.match(r"^(PHYSICAL_|TINYEDGE_PHYSICAL_|PYTHON)", key, re.I)
                       and key.upper() not in ("VIRTUAL_ENV", "NODE_OPTIONS")}
        environment.update({"TERM": "xterm-256color", "COLUMNS": "100", "LINES": "40"})
        os.execve(command, [command, wrapper, package_root], environment)

    transcript = AcceptanceTranscript()
    exit_code = None
    exiting = False
    try:
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            readable, _, _ = select.select([terminal], [], [], 0.25)
            if readable:
                try:
                    chunk = os.read(terminal, 65536)
                except OSError:
                    chunk = b""
                if transcript.feed(chunk):
                    # Explicit test-only software consent, never a generic yes
                    # responder and never an approval for a physical run.
                    os.write(terminal, b"y\r")
            if transcript.rendered_and_ready and not exiting:
                os.write(terminal, b"\x04")
                exiting = True
                deadline = time.monotonic() + EXIT_TIMEOUT_SECONDS
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished == pid:
                exit_code = os.waitstatus_to_exitcode(status)
                # Drain final terminal output written just before process.exit.
                while select.select([terminal], [], [], 0)[0]:
                    try:
                        chunk = os.read(terminal, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    transcript.feed(chunk)
                break
        if exit_code is None:
            raise RuntimeError(f"Harness acceptance timed out during {'shutdown' if exiting else 'first-run startup'}\n{plain_tail(transcript.data)}")
        # The real Pi SDK exits the Harness process directly on Ctrl+D. Do not
        # replace its mode or pretend an outer finally ran: independently prove
        # that the owned Node closed after its stdin reached EOF.
        stopped = transcript.node_origin is None
        stop_deadline = time.monotonic() + EXIT_TIMEOUT_SECONDS
        while transcript.node_origin and time.monotonic() < stop_deadline:
            if listener_closed(transcript.node_origin):
                stopped = True
                break
            time.sleep(0.1)
        kind = transcript.finish(exit_code, listener_stopped=stopped)
    except BaseException:
        cleanup_child(pid, exit_code)
        raise
    finally:
        os.close(terminal)

    scope = "fresh managed Node (authenticated discovery, camera idle)" if kind == "managed" else "empty-index source candidate (NO managed Node acceptance)"
    print(f"Verified Linux instrumented packaged Harness: {scope}; render, keyboard input and confirmed clean exit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
