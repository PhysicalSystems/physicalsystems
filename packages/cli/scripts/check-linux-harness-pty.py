#!/usr/bin/env python3
"""Exercise the packed Harness through a real Linux pseudo-terminal."""

from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


STARTUP_TIMEOUT_SECONDS = 45
EXIT_TIMEOUT_SECONDS = 15
EXPECTED_HEADER = b"PHYSICAL SYSTEMS"


def plain_tail(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)
    return text[-4000:]


def wait_for_exit(pid: int, deadline: float) -> int | None:
    while time.monotonic() < deadline:
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)
    return None


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: check-linux-harness-pty.py PATH_TO_TINYEDGE")

    command = os.path.realpath(sys.argv[1])
    if not os.path.isfile(command) or not os.access(command, os.X_OK):
        raise SystemExit(f"TinyEdge command is not executable: {command}")

    pid, terminal = pty.fork()
    if pid == 0:
        environment = dict(os.environ)
        environment.update({"TERM": "xterm-256color", "COLUMNS": "100", "LINES": "40"})
        os.execve(command, [command], environment)

    transcript = bytearray()
    try:
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        startup_deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        while time.monotonic() < startup_deadline and EXPECTED_HEADER not in transcript:
            readable, _, _ = select.select([terminal], [], [], 0.25)
            if not readable:
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished == pid:
                    code = os.waitstatus_to_exitcode(status)
                    raise RuntimeError(f"Harness exited before rendering (code {code})\n{plain_tail(transcript)}")
                continue
            try:
                transcript.extend(os.read(terminal, 65536))
            except OSError:
                break

        if EXPECTED_HEADER not in transcript:
            raise RuntimeError(f"Harness did not render its Physical Systems header\n{plain_tail(transcript)}")

        # Ctrl+D exits Pi only when the editor is empty. This proves that the
        # installed command accepts terminal input and restores the terminal.
        os.write(terminal, b"\x04")
        exit_code = wait_for_exit(pid, time.monotonic() + EXIT_TIMEOUT_SECONDS)
        if exit_code is None:
            raise RuntimeError("Harness rendered but did not exit after Ctrl+D")
        if exit_code != 0:
            raise RuntimeError(f"Harness exited with code {exit_code}\n{plain_tail(transcript)}")
    except BaseException:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            wait_for_exit(pid, time.monotonic() + 3)
        except ChildProcessError:
            # The failure path may already have reaped the child.
            pass
        raise
    finally:
        os.close(terminal)

    print("Verified Linux Harness render, keyboard input, and clean exit through a pseudo-terminal")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
