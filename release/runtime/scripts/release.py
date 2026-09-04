"""Exact Runtime candidates and published-byte qualification; never uploads.

The protected workflow owns OIDC and its one upload. This program downloads
public reviewed bytes, validates them without importing them, and creates
current-attempt installation/readback receipts. No hardware is accessed.
"""
from __future__ import annotations

import argparse
import email.parser
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[3]
REPOSITORY = "PhysicalSystems/physicalsystems"
WORKFLOW = ".github/workflows/runtime-release.yml"
DISTRIBUTION = "tinyedge-runtime"
SCHEMA = "physicalsystems-runtime-candidate-v1"
OPERATIONS = ("verify-published", "publish")
TARGETS = {(platform, python) for platform in ("linux-x64", "win32-x64") for python in ("3.10", "3.11", "3.12")}
LIMIT = 32 * 1024 * 1024


class Refused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "Invalid SHA-256 pin")
    return value


def version(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:rc[0-9]+)?", value), "Invalid Runtime version")
    return value


def document(raw):
    require(len(raw) <= 1024 * 1024, "JSON exceeds bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise Refused("Invalid JSON") from error
    require(type(value) is dict, "Expected JSON object")
    return value


def write_json(path, value):
    # Receipts are hashed as raw bytes across Windows/Linux jobs. Text-mode
    # newline translation would make identical input produce different proofs.
    path.write_bytes((json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def identity(environ=os.environ):
    require(environ.get("GITHUB_REPOSITORY") == REPOSITORY and environ.get("GITHUB_REF") == "refs/heads/main"
        and environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Only manual public-main qualification is supported")
    source = environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", source), "Invalid workflow source")
    expected_source = environ.get("EXPECTED_HEAD_SHA", "")
    require(expected_source == "" or (re.fullmatch(r"[0-9a-f]{40}", expected_source) and expected_source == source),
        "Dispatch source differs from the coordinator-reviewed main revision")
    run_id, attempt = environ.get("GITHUB_RUN_ID", ""), environ.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[1-9][0-9]{0,14}", run_id) and re.fullmatch(r"[1-9][0-9]{0,14}", attempt), "Invalid workflow attempt")
    coordinator = environ.get("COORDINATOR_ID", "")
    require(coordinator == "" or re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", coordinator), "Invalid coordinator ID")
    return {"repository": REPOSITORY, "workflow": WORKFLOW, "sourceSha": source, "runId": run_id,
        "runAttempt": attempt, "coordinatorId": coordinator, "expectedHeadSha": expected_source}


def github(suffix, *, binary=False):
    require(re.fullmatch(r"(?:releases/[1-9][0-9]{0,14}|releases/assets/[1-9][0-9]{0,14}|actions/runs/[1-9][0-9]{0,14}/attempts/[1-9][0-9]{0,14}/jobs\?per_page=100)", suffix), "Unapproved GitHub route")
    command = ["gh", "api", "--hostname", "github.com", f"repos/{REPOSITORY}/{suffix}"]
    if binary:
        command += ["-H", "Accept: application/octet-stream"]
    result = subprocess.run(command, capture_output=True, timeout=120)
    require(result.returncode == 0 and len(result.stdout) <= LIMIT, "GitHub read failed or exceeded bound")
    return result.stdout if binary else document(result.stdout)


def audit_current_run():
    spec = importlib.util.spec_from_file_location("runtime_publisher_audit", ROOT / "release/publisher-verification.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.audit_current_run("runtime")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused("Public package download redirected")


def public(url, *, missing=False):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname in {"pypi.org", "files.pythonhosted.org"}
        and parsed.netloc == parsed.hostname and not parsed.query and not parsed.fragment
        and not parsed.username and not parsed.password, "Unapproved public package URL")
    # Anonymous, without proxies, cookies or GitHub/OIDC credentials.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "PhysicalSystems-Runtime-Release/1"}), timeout=60) as response:
            raw = response.read(LIMIT + 1)
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise Refused("Anonymous package read failed") from error
    require(len(raw) <= LIMIT, "Public package exceeds bound")
    return raw


def pypi_files(release_version, *, absent=False):
    raw = public(f"https://pypi.org/pypi/{DISTRIBUTION}/{version(release_version)}/json", missing=absent)
    if absent:
        require(raw is None, "Version already exists: inspect public readback; never repeat an upload")
        return []
    value = document(raw)
    require(value.get("info", {}).get("name") == DISTRIBUTION and value.get("info", {}).get("version") == release_version,
        "Public distribution identity differs")
    require(type(value.get("urls")) is list and value["urls"], "Public files are missing")
    return value["urls"]


def names(release_version):
    return f"tinyedge_runtime-{version(release_version)}-py3-none-any.whl", f"tinyedge_runtime-{release_version}.tar.gz"


def validate_manifest(raw, expected_sha):
    require(sha(raw) == digest(expected_sha), "Candidate manifest pin differs")
    value = document(raw)
    require(set(value) == {"contractVersion", "distribution", "version", "sourceSha", "files"}
        and value["contractVersion"] == SCHEMA and value["distribution"] == DISTRIBUTION,
        "Candidate manifest contract differs")
    expected_names = set(names(value["version"]))
    require(re.fullmatch(r"[0-9a-f]{40}", value.get("sourceSha", "")), "Candidate source must be an exact commit")
    require(type(value["files"]) is list and len(value["files"]) == 2, "Candidate requires exactly one wheel and one sdist")
    found = set()
    for entry in value["files"]:
        require(type(entry) is dict and set(entry) == {"filename", "sha256", "size"}, "Invalid candidate file")
        require(entry["filename"] in expected_names and entry["filename"] not in found, "Unexpected or duplicate candidate filename")
        digest(entry["sha256"])
        require(type(entry["size"]) is int and 0 < entry["size"] <= LIMIT, "Candidate file exceeds bound")
        found.add(entry["filename"])
    return value


def metadata(raw, release_version):
    value = email.parser.BytesParser().parsebytes(raw)
    require(value.get_all("Name") == [DISTRIBUTION] and value.get_all("Version") == [release_version], "Distribution metadata identity differs")
    require(not value.get_all("Requires-Dist") or all("extra ==" in item for item in value.get_all("Requires-Dist")), "Runtime must have no mandatory dependencies")


def inspect_wheel(raw, release_version, source_root=None):
    source_root = source_root or ROOT
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as wheel:
            entries = wheel.infolist()
            require(len(entries) <= 1000 and sum(item.file_size for item in entries) <= LIMIT, "Wheel expanded size exceeds bound")
            filenames = [item.filename for item in entries]
            require(len(filenames) == len(set(filenames)), "Duplicate wheel entry")
            for item in entries:
                require(not item.filename.startswith("/") and ".." not in item.filename.split("/") and "\\" not in item.filename
                    and (item.external_attr >> 16) & 0o170000 != 0o120000, "Unsafe wheel path")
                require(item.filename.startswith("tinyedge_runtime/") or item.filename.startswith(f"tinyedge_runtime-{release_version}.dist-info/"), "Foreign wheel payload")
            metadata(wheel.read(f"tinyedge_runtime-{release_version}.dist-info/METADATA"), release_version)
            source = source_root / "packages/runtime/src/tinyedge_runtime"
            expected = {"tinyedge_runtime/" + path.relative_to(source).as_posix(): path.read_bytes()
                for path in source.rglob("*") if path.is_file() and (path.suffix == ".py" or path.name == "py.typed")}
            actual = {name: wheel.read(name) for name in filenames if name.startswith("tinyedge_runtime/") and not name.endswith("/")}
            require(actual == expected and actual, "Wheel code differs from reviewed public Runtime source")
    except (zipfile.BadZipFile, KeyError) as error:
        raise Refused("Invalid Runtime wheel") from error


def inspect_sdist(raw, release_version, wheel_raw, source_root=None):
    source_root = source_root or ROOT
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            items = archive.getmembers()
            require(len(items) <= 2000 and sum(item.size for item in items) <= LIMIT, "Source distribution exceeds bound")
            prefix = f"tinyedge_runtime-{release_version}/"
            seen = set()
            generated = {"PKG-INFO", "setup.cfg", *{"src/tinyedge_runtime.egg-info/" + filename for filename in
                ("PKG-INFO", "SOURCES.txt", "dependency_links.txt", "entry_points.txt", "requires.txt", "top_level.txt")}}
            for item in items:
                require(item.name not in seen and (item.name == prefix[:-1] or item.name.startswith(prefix)) and ".." not in item.name.split("/")
                    and "\\" not in item.name and (item.isfile() or item.isdir()), "Unsafe source distribution member")
                seen.add(item.name)
                if item.isfile():
                    relative = item.name[len(prefix):]
                    source = source_root / "packages/runtime" / relative
                    if relative in generated:
                        require(item.size <= 256 * 1024, "Generated source metadata exceeds bound")
                        if relative == "setup.cfg":
                            require(archive.extractfile(item).read().replace(b"\r\n", b"\n") == b"[egg_info]\ntag_build = \ntag_date = 0\n\n",
                                "Source build configuration differs from the inert setuptools default")
                    else:
                        require(source.is_file() and not source.is_symlink() and archive.extractfile(item).read() == source.read_bytes(),
                            "Source distribution contains bytes outside reviewed public source")
            metadata(archive.extractfile(prefix + "PKG-INFO").read(), release_version)
            with zipfile.ZipFile(io.BytesIO(wheel_raw)) as wheel:
                expected = {name: wheel.read(name) for name in wheel.namelist() if name.startswith("tinyedge_runtime/") and not name.endswith("/")}
            actual = {item.name[len(prefix + "src/"):]: archive.extractfile(item).read() for item in items
                if item.isfile() and item.name.startswith(prefix + "src/tinyedge_runtime/")}
            require(actual == expected, "Source distribution code differs from qualified wheel")
    except (tarfile.TarError, KeyError, AttributeError) as error:
        raise Refused("Invalid Runtime source distribution") from error


def fetch(operation, candidate_id, manifest_sha):
    require(operation in OPERATIONS, "Unknown operation")
    context = identity()
    if operation == "verify-published":
        require(not candidate_id and not manifest_sha, "Published verification does not accept a new candidate")
        pin = document((ROOT / "release/product.json").read_bytes())["components"]["runtime"]
        require(pin["distribution"] == DISTRIBUTION, "Product Runtime identity differs")
        release_version = version(pin["version"])
        wheel_name = names(release_version)[0]
        matching = [item for item in pypi_files(release_version) if item.get("filename") == wheel_name]
        require(len(matching) == 1 and matching[0].get("digests", {}).get("sha256") == digest(pin["wheelSha256"])
            and matching[0].get("yanked") is False, "Public wheel differs from approved product pin")
        raw = public(matching[0]["url"])
        require(sha(raw) == pin["wheelSha256"] and len(raw) == matching[0].get("size"), "Public wheel bytes differ")
        payloads = {wheel_name: raw}
        approved_sha = sha((ROOT / "release/product.json").read_bytes())
    else:
        require(re.fullmatch(r"[1-9][0-9]{0,14}", candidate_id or ""), "A candidate release ID is required")
        digest(manifest_sha)
        release = github(f"releases/{candidate_id}")
        require(release.get("id") == int(candidate_id) and release.get("draft") is False and release.get("prerelease") is True,
            "Candidate must be an explicit public prerelease")
        assets = release.get("assets")
        require(type(assets) is list and len(assets) == 3, "Candidate release must contain exactly three approved assets")
        require(len({item.get("name") for item in assets}) == 3, "Duplicate candidate assets")
        payloads = {}
        for asset in assets:
            require(re.fullmatch(r"(?:release\.json|tinyedge_runtime-[0-9]+\.[0-9]+\.[0-9]+(?:rc[0-9]+)?(?:-py3-none-any\.whl|\.tar\.gz))", asset.get("name", "")), "Unexpected candidate asset")
            require(type(asset.get("id")) is int and asset["id"] > 0 and type(asset.get("size")) is int and 0 < asset["size"] <= LIMIT, "Invalid candidate asset identity")
            raw = github(f"releases/assets/{asset['id']}", binary=True)
            require(len(raw) == asset["size"] and asset.get("digest") == "sha256:" + sha(raw), "Candidate asset changed")
            payloads[asset["name"]] = raw
        require("release.json" in payloads, "Candidate manifest missing")
        manifest = validate_manifest(payloads["release.json"], manifest_sha)
        release_version = manifest["version"]
        require(release.get("tag_name") == f"runtime-v{release_version}-candidate", "Use the component-scoped Runtime candidate tag")
        require(manifest["sourceSha"] == context["sourceSha"], "Candidate was not built from this reviewed main revision")
        require(set(payloads) == {"release.json", *names(release_version)}, "Candidate artifact set differs")
        for entry in manifest["files"]:
            require(sha(payloads[entry["filename"]]) == entry["sha256"] and len(payloads[entry["filename"]]) == entry["size"], "Candidate manifest and artifact differ")
        pypi_files(release_version, absent=True)
        inspect_sdist(payloads[names(release_version)[1]], release_version, payloads[names(release_version)[0]])
        approved_sha = manifest_sha
    inspect_wheel(payloads[names(release_version)[0]], release_version)
    receipt = {"contractVersion": "physicalsystems-runtime-input-v1", "operation": operation, "distribution": DISTRIBUTION,
        "version": release_version, "approvalSha256": approved_sha, "candidateReleaseId": candidate_id or None,
        "files": [{"filename": name, "sha256": sha(raw), "size": len(raw)} for name, raw in sorted(payloads.items())], **context}
    return receipt, payloads


def store(directory, receipt, payloads):
    require(directory.is_absolute() and not directory.exists() and not directory.is_symlink(), "Output must be a new absolute directory")
    directory.mkdir(parents=True)
    for name, raw in payloads.items():
        (directory / name).write_bytes(raw)
    write_json(directory / "input.json", receipt)


def check_input(directory):
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink(), "Invalid input directory")
    receipt = document((directory / "input.json").read_bytes())
    require(receipt.get("contractVersion") == "physicalsystems-runtime-input-v1" and receipt.get("operation") in OPERATIONS
        and receipt.get("distribution") == DISTRIBUTION, "Invalid Runtime input receipt")
    for key, value in identity().items():
        require(receipt.get(key) == value, "Input does not belong to this exact workflow attempt")
    version(receipt.get("version"))
    digest(receipt.get("approvalSha256"))
    expected = {names(receipt["version"])[0]}
    if receipt["operation"] == "publish":
        expected |= {names(receipt["version"])[1], "release.json"}
    require(type(receipt.get("files")) is list and len(receipt["files"]) == len(expected)
        and {item.get("filename") for item in receipt["files"]} == expected, "Unexpected receipt artifacts")
    require({item.name for item in directory.iterdir()} == expected | {"input.json"}, "Unexpected input files")
    for entry in receipt["files"]:
        path = directory / entry["filename"]
        require(path.is_file() and not path.is_symlink(), "Input file is not regular")
        raw = path.read_bytes()
        require(len(raw) == entry["size"] and sha(raw) == digest(entry["sha256"]), "Input artifact hash differs")
    inspect_wheel((directory / names(receipt["version"])[0]).read_bytes(), receipt["version"])
    return receipt


def clean_environment():
    permitted = {"PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"}
    return {key: value for key, value in os.environ.items() if key in permitted} | {
        "PIP_CONFIG_FILE": os.devnull, "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}


def execute(command, *, cwd=None):
    result = subprocess.run(command, cwd=cwd, env=clean_environment(), capture_output=True, timeout=480)
    require(result.returncode == 0, "Installed-wheel test or conformance failed; no upload is permitted")
    return result.stdout


def install(directory, platform, python, output):
    require((platform, python) in TARGETS and ("win32-x64" if sys.platform == "win32" else "linux-x64") == platform
        and f"{sys.version_info.major}.{sys.version_info.minor}" == python, "Native installation target differs")
    receipt = check_input(directory)
    require(output.is_absolute() and not output.exists(), "Proof output must be a new absolute directory")
    output.mkdir(parents=True)
    test_source = output / "source-tests"
    test_source.mkdir()
    for folder in ("tests", "fixtures", "schemas"):
        shutil.copytree(ROOT / "packages/runtime" / folder, test_source / folder)
    shutil.copyfile(ROOT / "packages/runtime/pyproject.toml", test_source / "pyproject.toml")
    wheel = directory / names(receipt["version"])[0]
    execute([sys.executable, "-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", "--force-reinstall", str(wheel)])
    execute([sys.executable, "-I", "-m", "pip", "--isolated", "check"])
    probe = "import importlib.metadata,json,tinyedge_runtime; print(json.dumps({'distribution':importlib.metadata.version('tinyedge-runtime'),'module':tinyedge_runtime.__version__}))"
    installed = document(execute([sys.executable, "-I", "-c", probe], cwd=output))
    require(installed == {"distribution": receipt["version"], "module": receipt["version"]}, "Installed identities differ")
    execute([sys.executable, "-I", "-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml=" + str(output / "tests.xml")], cwd=test_source)
    report = ET.parse(output / "tests.xml").getroot()
    suites = list(report.iter("testsuite"))
    require(suites and all(int(item.get("failures", "0")) == 0 and int(item.get("errors", "0")) == 0 for item in suites), "Runtime tests did not pass")
    count = sum(int(item.get("tests", "0")) for item in suites)
    require(count > 0, "Runtime tests were not executed")
    fixtures = sorted((test_source / "fixtures").glob("runtime-*.json"))
    require(fixtures, "Public conformance fixtures missing")
    execute([sys.executable, "-I", "-m", "tinyedge_runtime.conformance", *map(str, fixtures)], cwd=output)
    proof = {"contractVersion": "physicalsystems-runtime-install-proof-v1", "inputSha256": sha((directory / "input.json").read_bytes()),
        "platform": platform, "python": python, "testsPassed": count, "conformanceFixtures": len(fixtures), "hardwareAccessed": False,
        "wheelSha256": sha(wheel.read_bytes()), **identity()}
    write_json(output / f"runtime-proof-{platform}-py{python}.json", proof)
    return proof


def check_proofs(directory, receipt):
    paths = sorted(directory.glob("*.json"))
    require(len(paths) == len(TARGETS), "All six native installation proofs are required")
    expected_hash = sha((json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    wheel_hash = next(item["sha256"] for item in receipt["files"] if item["filename"].endswith(".whl"))
    observed = set()
    for path in paths:
        require(not path.is_symlink(), "Proof cannot be a symbolic link")
        proof = document(path.read_bytes())
        target = (proof.get("platform"), proof.get("python"))
        require(target in TARGETS and target not in observed and path.name == f"runtime-proof-{target[0]}-py{target[1]}.json", "Duplicate or unexpected installation proof")
        require(proof.get("contractVersion") == "physicalsystems-runtime-install-proof-v1" and proof.get("inputSha256") == expected_hash
            and proof.get("wheelSha256") == wheel_hash and type(proof.get("testsPassed")) is int and proof["testsPassed"] > 0
            and type(proof.get("conformanceFixtures")) is int and proof["conformanceFixtures"] > 0 and proof.get("hardwareAccessed") is False,
            "Installation proof does not qualify these artifacts")
        for key, value in identity().items():
            require(proof.get(key) == value, "Stale or foreign installation proof")
        observed.add(target)
    context = identity()
    jobs = github(f"actions/runs/{context['runId']}/attempts/{context['runAttempt']}/jobs?per_page=100")
    required = {f"install-{platform}-py{python}" for platform, python in TARGETS}
    require(type(jobs.get("total_count")) is int and jobs["total_count"] <= 100, "Cannot establish complete current-attempt jobs")
    for name in required:
        matching = [job for job in jobs.get("jobs", []) if job.get("name") == name]
        require(len(matching) == 1 and matching[0].get("conclusion") == "success", "A native installation job is not successful in this attempt")


def stage(operation, candidate_id, manifest_sha, proofs, output):
    receipt, payloads = fetch(operation, candidate_id, manifest_sha)
    check_proofs(proofs, receipt)
    store(output, receipt, payloads)
    if operation == "publish":
        upload = output / "upload"
        upload.mkdir()
        for name in names(receipt["version"]):
            shutil.copyfile(output / name, upload / name)
    # Review may have waited and downloads may take minutes. Recheck the live
    # main/environment controls at the last stage boundary, not just preflight.
    audit_current_run()
    return receipt


def readback(directory, output):
    # Keep the input snapshot separate: the PyPA action adds attestations only
    # inside upload/. Never permit those additions in the checked snapshot.
    receipt = check_input(directory)
    published = pypi_files(receipt["version"])
    verified = []
    for entry in receipt["files"]:
        if entry["filename"] == "release.json":
            continue
        matching = [item for item in published if item.get("filename") == entry["filename"]]
        require(len(matching) == 1 and matching[0].get("digests", {}).get("sha256") == entry["sha256"]
            and matching[0].get("size") == entry["size"] and matching[0].get("yanked") is False, "Published metadata differs from exact qualified input")
        raw = public(matching[0]["url"])
        require(len(raw) == entry["size"] and sha(raw) == entry["sha256"], "Published bytes differ from exact qualified input")
        verified.append(entry | {"url": matching[0]["url"]})
    require(output.is_absolute() and not output.exists(), "Readback output must be new and absolute")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"contractVersion": "physicalsystems-runtime-readback-v1", "operation": receipt["operation"],
        "distribution": DISTRIBUTION, "version": receipt["version"], "inputSha256": sha((directory / "input.json").read_bytes()),
        "files": verified, "publicationRequested": receipt["operation"] == "publish", "uploadAttributionVerified": False,
        "anonymousReadbackVerified": True, **identity()}
    write_json(output, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("fetch", "install", "stage", "readback"))
    parser.add_argument("--operation", choices=OPERATIONS, default="verify-published")
    parser.add_argument("--candidate-release-id", default="")
    parser.add_argument("--release-metadata-sha256", default="")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--proofs", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform")
    parser.add_argument("--python")
    args = parser.parse_args()
    try:
        if args.command == "fetch":
            receipt, payloads = fetch(args.operation, args.candidate_release_id, args.release_metadata_sha256)
            store(args.output, receipt, payloads)
        elif args.command == "install":
            require(args.directory is not None, "Input directory is required")
            install(args.directory, args.platform, args.python, args.output)
        elif args.command == "stage":
            require(args.proofs is not None, "Proof directory is required")
            stage(args.operation, args.candidate_release_id, args.release_metadata_sha256, args.proofs, args.output)
        else:
            require(args.directory is not None, "Input directory is required")
            readback(args.directory, args.output)
    except (Refused, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, Refused) else "Local execution or bounded network read failed"
        print("Release refused: " + message, file=sys.stderr)
        return 1
    print("Runtime " + args.command + " verified; no hardware accessed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
