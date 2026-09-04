"""Stdlib-only synthetic receipt ZIP tests; no network, extraction or hardware."""
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import unittest
import warnings
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/read-release-evidence.py"
SPEC = importlib.util.spec_from_file_location("release_evidence_reader", SCRIPT)
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


def fixture(entries=(("publisher.json", b'{"verified":true}'),), compression=zipfile.ZIP_DEFLATED):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=compression) as archive:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, payload in entries:
                archive.writestr(name, payload)
    return data.getvalue()


class ReleaseEvidenceTests(unittest.TestCase):
    def test_both_supported_receipts_and_safe_extra_files(self):
        for member in sorted(r.MEMBERS):
            raw = fixture(((member, b'{"verified":true}'), ("proofs/", b""), ("proofs/a.json", b"{}")))
            self.assertEqual(r.read_json_member(raw, member), {"verified": True})

    def test_invalid_names_are_refused_even_on_unselected_members(self):
        for name in ("../escape", "/absolute", "C:/drive", "\\network", "dir\\file", "dir/../file",
            "./file", "dir//file", "dir/./file", "\ncontrol", "dir/\x7fcontrol"):
            # ZipInfo normalizes OS separators while writing on Windows. Patch
            # equal-length raw names so the reader sees an actually unsafe ZIP.
            raw_name = name.replace("\\", "_")
            raw = fixture((("publisher.json", b"{}"), (raw_name, b"x"))).replace(raw_name.encode(), name.encode())
            with self.subTest(name=name), self.assertRaises(r.EvidenceError):
                r.read_json_member(raw, "publisher.json")

    def test_duplicate_and_directory_file_aliases_refused(self):
        for entries in ((("publisher.json", b"{}"), ("publisher.json", b"{}")),
            (("publisher.json", b"{}"), ("x", b""), ("x/", b""))):
            with self.subTest(entries=entries), self.assertRaises(r.EvidenceError):
                r.read_json_member(fixture(entries), "publisher.json")

    def test_links_and_special_files_refused(self):
        for mode, attributes in ((stat.S_IFLNK | 0o777, 0), (stat.S_IFIFO | 0o600, 0), (stat.S_IFREG | 0o600, 0x400)):
            info = zipfile.ZipInfo("link")
            info.external_attr = (mode << 16) | attributes
            with self.subTest(mode=mode, attributes=attributes), self.assertRaises(r.EvidenceError):
                r.read_json_member(fixture((("publisher.json", b"{}"), (info, b"target"))), "publisher.json")

    def test_null_byte_name_truncation_refused(self):
        raw = fixture((("publisher.json", b"{}"), ("badXname", b""))).replace(b"badXname", b"bad\0name")
        with self.assertRaises(r.EvidenceError): r.read_json_member(raw, "publisher.json")

    def test_encryption_bits_refused(self):
        for bit in (0x1, 0x40):
            raw = bytearray(fixture())
            for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
                offset = raw.index(signature) + flag_offset
                flags = struct.unpack_from("<H", raw, offset)[0]
                struct.pack_into("<H", raw, offset, flags | bit)
            with self.subTest(bit=bit), self.assertRaises(r.EvidenceError):
                r.read_json_member(bytes(raw), "publisher.json")

    def test_compressed_expanded_and_json_size_bounds(self):
        cases = (b"x" * (r.MAX_COMPRESSED_BYTES + 1),
            fixture((("publisher.json", b"{}"), ("large", b"x" * (r.MAX_EXPANDED_BYTES + 1)))),
            fixture((("publisher.json", b" " * (r.MAX_JSON_BYTES + 1)),)))
        for raw in cases:
            with self.subTest(size=len(raw)), self.assertRaises(r.EvidenceError):
                r.read_json_member(raw, "publisher.json")

    def test_total_expanded_limit_applies_across_members(self):
        raw = fixture((("publisher.json", b"{}"), ("a", b"x" * (r.MAX_EXPANDED_BYTES // 2)),
            ("b", b"x" * (r.MAX_EXPANDED_BYTES // 2))))
        with self.assertRaises(r.EvidenceError): r.read_json_member(raw, "publisher.json")

    def test_json_boundary_and_stored_archives(self):
        raw = fixture((("publisher.json", b"{}" + b" " * (r.MAX_JSON_BYTES - 2)),), zipfile.ZIP_STORED)
        self.assertEqual(r.read_json_member(raw, "publisher.json"), {})

    def test_missing_member_non_json_bad_archive_and_member_count(self):
        cases = (b"", b"not zip", fixture((("other.json", b"{}"),)), fixture((("publisher.json/", b""),)),
            fixture(tuple((str(index), b"") for index in range(r.MAX_MEMBERS + 1))))
        for raw in cases:
            with self.subTest(size=len(raw)), self.assertRaises(r.EvidenceError):
                r.read_json_member(raw, "publisher.json")
        with self.assertRaises(r.EvidenceError): r.read_json_member(fixture(), "../publisher.json")

    def test_invalid_json_and_duplicate_keys_fail_closed(self):
        for payload in (b"[]", b"null", b"true", b"1", b"{", b'{"a":1,"a":2}', b'{"a":{"b":1,"b":2}}',
            b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}', b"\xff", b"[" * 2000):
            with self.subTest(payload=payload[:40]), self.assertRaises(r.EvidenceError):
                r.read_json_member(fixture((("publisher.json", payload),)), "publisher.json")

    def test_crc_and_malformed_compressed_member_refused(self):
        raw = fixture(compression=zipfile.ZIP_STORED).replace(b'{"verified":true}', b'{"verified":null}')
        with self.assertRaises(r.EvidenceError): r.read_json_member(raw, "publisher.json")
        corrupted = bytearray(fixture())
        name_length, extra_length = struct.unpack_from("<HH", corrupted, 26)
        start = 30 + name_length + extra_length
        corrupted[start:start + 5] = b"\xff" * 5
        with self.assertRaises(r.EvidenceError): r.read_json_member(bytes(corrupted), "publisher.json")

    def test_cli_is_json_only_and_does_not_echo_unsafe_data(self):
        success = subprocess.run([sys.executable, "-B", str(SCRIPT), "--member", "publisher.json"],
            input=fixture(), capture_output=True, check=False)
        self.assertEqual(success.returncode, 0)
        self.assertEqual(success.stderr, b"")
        self.assertEqual(json.loads(success.stdout), {"verified": True})
        rejected = subprocess.run([sys.executable, "-B", str(SCRIPT), "--member", "publisher.json"],
            input=fixture((("publisher.json", b"synthetic-secret\x1b[31m"),)), capture_output=True, check=False)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(rejected.stdout, b"")
        self.assertEqual(rejected.stderr.replace(b"\r\n", b"\n"), b"Release evidence refused: Invalid receipt JSON\n")


if __name__ == "__main__":
    unittest.main()
