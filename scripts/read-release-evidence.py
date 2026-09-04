#!/usr/bin/env python3
"""Read one bounded JSON receipt from a verified archive; never extract files.

The caller must verify the raw archive SHA-256 against GitHub's artifact digest.
This helper validates the ZIP structure and receipt, not its publishing authority.
Copyright 2026 Lienert De Maeyer / Physical Systems.
SPDX-License-Identifier: Apache-2.0
"""

import argparse
import io
import json
import stat
import sys
import zipfile
import zlib


MAX_COMPRESSED_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024
MAX_JSON_BYTES = 16 * 1024
MAX_MEMBERS = 128
MEMBERS = {"publisher.json", "publisher-verification.json"}


class EvidenceError(ValueError):
    """Fixed safe-to-log refusal, never archive data or caller-controlled paths."""


def require(condition, message):
    if not condition:
        raise EvidenceError(message)


def safe_member_name(info):
    name = info.filename
    require(name == info.orig_filename and name and "\\" not in name and ":" not in name
        and not any(ord(char) < 32 or ord(char) == 127 for char in name), "Unsafe archive path")
    parts = (name[:-1] if info.is_dir() else name).split("/")
    require(all(part and part not in {".", ".."} for part in parts), "Unsafe archive path")
    mode = stat.S_IFMT(info.external_attr >> 16)
    require(mode in {0, stat.S_IFREG, stat.S_IFDIR}
        and not (info.external_attr & 0x400), "Archive links or special files are forbidden")
    require(mode != stat.S_IFDIR or info.is_dir(), "Inconsistent archive directory")
    require(not info.is_dir() or info.file_size == 0, "Archive directories must be empty")
    return "/".join(parts)


def read_json_member(raw, member):
    require(member in MEMBERS, "Unsupported receipt name")
    require(type(raw) is bytes and 0 < len(raw) <= MAX_COMPRESSED_BYTES, "Archive exceeds compressed byte bound")
    selected = None
    expanded = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            require(0 < len(infos) <= MAX_MEMBERS, "Archive member count exceeds bound")
            names = set()
            require(sum(info.file_size for info in infos) <= MAX_EXPANDED_BYTES, "Archive exceeds expanded byte bound")
            for info in infos:
                name = safe_member_name(info)
                require(name not in names, "Duplicate archive path")
                names.add(name)
                require(not info.flag_bits & (0x1 | 0x40), "Encrypted archive entries are forbidden")
                require(info.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}, "Unsupported archive compression")
                if info.filename == member:
                    require(not info.is_dir() and info.file_size <= MAX_JSON_BYTES, "Receipt exceeds JSON byte bound")
                with archive.open(info) as stream:
                    payload = stream.read(MAX_EXPANDED_BYTES - expanded + 1)
                expanded += len(payload)
                require(expanded <= MAX_EXPANDED_BYTES and len(payload) == info.file_size,
                    "Archive expanded bytes differ from its bounds")
                if info.filename == member:
                    require(len(payload) <= MAX_JSON_BYTES, "Receipt exceeds JSON byte bound")
                    selected = payload
    except EvidenceError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError, NotImplementedError, EOFError, zlib.error):
        raise EvidenceError("Invalid receipt archive") from None
    require(selected is not None, "Required receipt is absent")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result

    def nonfinite(_):
        raise EvidenceError("Nonfinite JSON value")

    try:
        value = json.loads(selected.decode("utf-8"), object_pairs_hook=unique, parse_constant=nonfinite)
        require(type(value) is dict, "Receipt must be a JSON object")
        json.dumps(value, allow_nan=False)  # Also reject numeric overflow such as 1e999.
        return value
    except EvidenceError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise EvidenceError("Invalid receipt JSON") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--member", choices=sorted(MEMBERS), required=True)
    args = parser.parse_args(argv)
    try:
        value = read_json_member(sys.stdin.buffer.read(MAX_COMPRESSED_BYTES + 1), args.member)
        result = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    except (EvidenceError, OSError, ValueError, RecursionError) as error:
        reason = str(error) if isinstance(error, EvidenceError) else "Receipt processing failed"
        print("Release evidence refused: " + reason, file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
