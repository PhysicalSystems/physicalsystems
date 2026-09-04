"""Release-only verification of operator-staged Node bytes; no private access.

Copyright 2026 Lienert De Maeyer / Physical Systems.
SPDX-License-Identifier: Apache-2.0

This is public release tooling, not a Node build system or hardware client.
It never builds a package, publishes, approves an environment, or reads a
private repository. The publishing Action is a separate protected step.

Modified for TIN-417: bind future release evidence to the consolidated public
repository and node-release.yml. The imported workflow is an inactive template;
this relocation does not authorize or activate a publisher.
"""
from __future__ import annotations

import argparse
import ast
import base64
import csv
from datetime import datetime
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import urllib.request
import zipfile

from packaging.requirements import Requirement
from packaging.tags import compatible_tags, cpython_tags
from packaging.utils import parse_wheel_filename

REPOSITORY = "PhysicalSystems/physicalsystems"
ENVIRONMENT = "physical-node-pypi"
POLICY = "v1-minimal-node-preview"
VERSION = "0.2.1"
# Node and Runtime are independently versioned. A Node patch must not imply a
# Runtime upgrade in capsules, installation proofs or published manifests.
RUNTIME_VERSION = "0.2.0"
NODE_WHEEL = f"physicalsystems_node-{VERSION}-py3-none-any.whl"
CANDIDATE_TAG = f"physicalsystems-node-v{VERSION}-candidate"
RUNTIME_WHEEL = f"tinyedge_runtime-{RUNTIME_VERSION}-py3-none-any.whl"
RUNTIME_SHA256 = "4d25fcfa055bf54faf69591e4a14bec89dc7f8d086b2bed6bf19912041403937"
PINS = {"tinyedge-runtime": RUNTIME_VERSION, "numpy": "1.26.4", "opencv-python-headless": "4.10.0.84"}
TARGETS = {(platform, python) for platform in ("linux-x64", "win32-x64") for python in ("3.10", "3.11", "3.12")}
MODULES = tuple("""contract_hashing physical_camera physical_camera_preview physical_camera_preview_api
physical_camera_v4l2 physical_camera_vacancy physical_candidates physical_discovery physical_execution_fakes
physical_execution_host physical_execution_provider physical_intent physical_node_api physical_node_cli
physical_registry physical_routes physical_run_archive physical_run_store physical_runs physical_runs_api
physical_so101_execution physical_so101_teaching_bridge physical_system physical_teaching_recording
physical_waypoint_teaching physical_waypoints""".split())
INITIALIZER = f'"""Physical Systems minimal proprietary Node distribution."""\n__version__ = "{VERSION}"\n'.encode()
MAX_JSON, MAX_WHEEL, MAX_DEPENDENCY = 128 * 1024, 4 * 1024 * 1024, 128 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


class ReleaseError(ValueError):
    """A bounded, safe-to-log publication refusal."""


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def document(raw, maximum=MAX_JSON):
    require(type(raw) is bytes and len(raw) <= maximum, "JSON exceeds its byte bound")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON field")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ReleaseError("Nonfinite JSON")))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ReleaseError("Invalid bounded JSON") from error


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected.split()), "Unexpected or missing contract fields")


def hash_pin(value):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value), "Invalid SHA-256 pin")
    return value


def positive_id(value):
    require(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,14}", value), "Invalid positive release/run ID")
    return value


def read_file(path, limit=MAX_JSON):
    path = Path(path).absolute()
    for ancestor in (path, *path.parents):
        info = ancestor.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
            "Linked inputs are not allowed")
    require(path.is_file() and path.stat().st_size <= limit, "Expected a bounded regular file")
    with path.open("rb") as handle:
        raw = handle.read(limit + 1)
    require(len(raw) <= limit, "File grew beyond its byte bound")
    return raw


def official_url(value):
    require(type(value) is str and len(value) <= 2048, "Invalid official wheel URL")
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.netloc == "files.pythonhosted.org"
        and not parsed.query and not parsed.fragment and parsed.path.startswith("/packages/")
        and not any(char.isspace() or ord(char) < 32 for char in value), "Only official credential-free PyPI wheel URLs are allowed")
    return value


def target_tags(platform, python):
    py = tuple(map(int, python.split(".")))
    platforms = ["win_amd64"] if platform == "win32-x64" else [
        *[f"manylinux_2_{minor}_x86_64" for minor in range(35, 16, -1)], "manylinux2014_x86_64"]
    return set(cpython_tags(py, platforms=platforms)) | set(compatible_tags(py, interpreter="cp" + python.replace(".", ""), platforms=platforms))


def validate_capsule(raw, expected_sha):
    require(sha(raw) == hash_pin(expected_sha), "Release metadata differs from the operator's pin")
    value = document(raw)
    keys(value, "contractVersion distribution version runtimeVersion sourceManifestSha256 wheel targets")
    require(value["contractVersion"] == "physicalsystems-node-release-capsule-v1"
        and value["distribution"] == "physicalsystems-node" and value["version"] == VERSION
        and value["runtimeVersion"] == RUNTIME_VERSION, "Unsupported release capsule")
    hash_pin(value["sourceManifestSha256"])
    wheel = value["wheel"]
    keys(wheel, "filename sha256 bytes")
    require(wheel["filename"] == NODE_WHEEL, "Only the reviewed minimal Node wheel is permitted")
    hash_pin(wheel["sha256"])
    require(type(wheel["bytes"]) is int and 0 < wheel["bytes"] <= MAX_WHEEL, "Invalid Node wheel size")
    require(type(value["targets"]) is list and len(value["targets"]) == 6, "Exactly six install targets are required")
    seen = set()
    common_artifacts = {}
    for target in value["targets"]:
        keys(target, "platform python publicDependencies")
        require(type(target["platform"]) is str and type(target["python"]) is str, "Invalid target identity")
        identity = (target["platform"], target["python"])
        require(identity in TARGETS and identity not in seen, "Duplicate or unsupported install target")
        seen.add(identity)
        dependencies = target["publicDependencies"]
        require(type(dependencies) is list and len(dependencies) == 3, "Exact three-wheel dependency closure is required")
        names = set()
        for artifact in dependencies:
            keys(artifact, "name version filename sha256 bytes url")
            name = artifact["name"]
            require(type(name) is str and name in PINS and name not in names and artifact["version"] == PINS[name],
                "Unapproved or duplicate dependency")
            names.add(name)
            hash_pin(artifact["sha256"])
            require(type(artifact["bytes"]) is int and 0 < artifact["bytes"] <= MAX_DEPENDENCY, "Invalid dependency size")
            filename = artifact["filename"]
            require(type(filename) is str and re.fullmatch(r"[A-Za-z0-9_.+-]{1,200}\.whl", filename), "Invalid wheel filename")
            try:
                parsed_name, version, build, tags = parse_wheel_filename(filename)
            except ValueError as error:
                raise ReleaseError("Malformed dependency wheel filename") from error
            require(parsed_name == name and str(version) == artifact["version"] and not build
                and tags & target_tags(*identity), "Dependency wheel does not match its install target")
            official_url(artifact["url"])
            require(urlsplit(artifact["url"]).path.rsplit("/", 1)[-1] == filename, "Wheel URL filename mismatch")
            if name == "tinyedge-runtime":
                require(filename == RUNTIME_WHEEL and artifact["sha256"] == RUNTIME_SHA256, "Runtime must be the approved exact public release")
            if filename in common_artifacts:
                require(common_artifacts[filename] == artifact, "Same dependency filename has inconsistent identity")
            common_artifacts[filename] = artifact
    require(canonical(value) == raw, "Release metadata must be canonical UTF-8 JSON without trailing bytes")
    return value


def inspect_node(raw, capsule):
    """Inspect data only. No imported/executed wheel code during this check."""
    require(len(raw) == capsule["wheel"]["bytes"] and sha(raw) == capsule["wheel"]["sha256"], "Node wheel bytes differ from capsule")
    package = "tinyedge_agent/"
    dist = f"physicalsystems_node-{VERSION}.dist-info/"
    sources = {package + name + ".py" for name in MODULES} | {package + "__init__.py"}
    allowed = sources | {package + "_distribution_manifest.json"} | {dist + name for name in (
        "METADATA", "WHEEL", "entry_points.txt", "top_level.txt", "RECORD", "LICENSE", "licenses/LICENSE")}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            require(len(infos) <= len(allowed) and len({item.filename for item in infos}) == len(infos), "Duplicate or excessive wheel paths")
            require(sum(item.file_size for item in infos) <= 16 * 1024 * 1024, "Expanded wheel exceeds its bound")
            for item in infos:
                require(item.filename in allowed and not item.is_dir() and not stat.S_ISLNK(item.external_attr >> 16)
                    and item.file_size <= 2 * 1024 * 1024, "Wheel includes an unapproved path, link, or oversized member")
            files = {item.filename: archive.read(item) for item in infos}
    except (zipfile.BadZipFile, RuntimeError, OSError) as error:
        raise ReleaseError("Invalid wheel archive") from error
    require(sources | {package + "_distribution_manifest.json"} | {dist + name for name in (
        "METADATA", "WHEEL", "entry_points.txt", "RECORD")} <= files.keys(), "Incomplete minimal Node package")
    require(files[package + "__init__.py"] == INITIALIZER, "Unapproved package initializer")
    license_files = [name for name in (dist + "LICENSE", dist + "licenses/LICENSE") if name in files]
    require(len(license_files) == 1 and files[license_files[0]].replace(b"\r\n", b"\n") == read_file(ROOT / "policy/node-preview-notice.txt"),
        "The proprietary Node preview notice must be preserved")
    metadata = BytesParser().parsebytes(files[dist + "METADATA"])
    require(all(len(metadata.get_all(key, [])) == 1 for key in ("Name", "Version", "Requires-Python")), "Ambiguous package metadata")
    try:
        requirements = [str(Requirement(item)) for item in metadata.get_all("Requires-Dist", [])]
    except ValueError as error:
        raise ReleaseError("Invalid Node dependency metadata") from error
    require(metadata["Name"] == "physicalsystems-node" and metadata["Version"] == VERSION and metadata["Requires-Python"] == ">=3.10"
        and len(requirements) == 3 and set(requirements) == {f"tinyedge-runtime=={RUNTIME_VERSION}", "numpy<3,>=1.24", "opencv-python-headless<5,>=4.10"}
        and not metadata.get_all("Provides-Extra"), "Unapproved package identity or dependencies")
    require(files[dist + "entry_points.txt"].replace(b"\r\n", b"\n").strip() ==
        b"[console_scripts]\nphysicalsystems-node = tinyedge_agent.physical_node_cli:main", "Unapproved console entrypoint")
    if dist + "top_level.txt" in files:
        require(files[dist + "top_level.txt"].strip() == b"tinyedge_agent", "Unapproved top-level package")
    wheel = BytesParser().parsebytes(files[dist + "WHEEL"])
    require(wheel.get_all("Root-Is-Purelib") == ["true"] and wheel.get_all("Tag") == ["py3-none-any"], "Node must be a pure Python wheel")
    manifest_bytes = files[package + "_distribution_manifest.json"]
    manifest = {"contractVersion": "physicalsystems-node-package-source-v1", "distribution": "physicalsystems-node",
        "version": VERSION, "scope": "explicit-first-party-physical-node-only",
        "files": [{"path": name, "sha256": sha(files[name]), "bytes": len(files[name])} for name in sorted(sources)]}
    require(manifest_bytes == canonical(manifest) and sha(manifest_bytes) == capsule["sourceManifestSha256"], "Embedded source manifest mismatch")
    # Reject static references to excluded private modules without executing code.
    approved_imports = set(sys.stdlib_module_names) | {"fcntl", "msvcrt", "termios", "numpy", "cv2", "tinyedge_runtime", "lerobot"}
    for name in sorted(sources):
        try:
            tree = ast.parse(files[name], filename=name)
        except SyntaxError as error:
            raise ReleaseError("Unparseable Node module") from error
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    require(node.level == 1 and (node.module in MODULES if node.module else
                        all(item.name in {*MODULES, "__version__"} for item in node.names)), "Import leaves the minimal package")
                    continue
                targets = [node.module or ""]
            elif isinstance(node, ast.Import):
                targets = [item.name for item in node.names]
            elif isinstance(node, ast.Call):
                function = node.func
                require(not isinstance(function, ast.Name) or function.id not in {"exec", "eval"}, "Dynamic source execution is not permitted")
                if ((isinstance(function, ast.Name) and function.id == "__import__")
                        or (isinstance(function, ast.Attribute) and function.attr == "import_module")):
                    require(node.args and isinstance(node.args[0], ast.Constant) and type(node.args[0].value) is str,
                        "Dynamic import target is not explicitly reviewable")
                    targets = [node.args[0].value]
            for target in targets:
                require((target.startswith("tinyedge_agent.") and target.split(".", 1)[1] in MODULES)
                    or target.split(".")[0] in approved_imports, "Import reaches excluded code")
    try:
        rows = list(csv.reader(io.StringIO(files[dist + "RECORD"].decode())))
        require(len(rows) == len(files) and all(len(row) == 3 for row in rows)
            and {row[0] for row in rows} == files.keys(), "Incomplete or duplicate wheel RECORD")
        for path, digest, size in rows:
            raw_file = files[path]
            expected = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw_file).digest()).rstrip(b"=").decode()
            require((not digest and not size) if path == dist + "RECORD" else
                (digest == expected and size == str(len(raw_file))), "Wheel RECORD differs from actual bytes")
    except (UnicodeError, csv.Error) as error:
        raise ReleaseError("Invalid wheel RECORD") from error


def github(path, *, binary=False, maximum=MAX_JSON):
    """Only known read endpoints of this one public repository are reachable."""
    prefix = "repos/" + REPOSITORY + "/"
    permitted = r"(?:releases/[1-9][0-9]{0,14}|releases/assets/[1-9][0-9]{0,14}|git/ref/heads/main|environments/physical-node-pypi(?:/deployment-branch-policies\?per_page=100)?|actions/runs/[1-9][0-9]{0,14}(?:/attempts/[1-9][0-9]{0,14}/jobs\?per_page=100)?)"
    require(type(path) is str and path.startswith(prefix) and re.fullmatch(permitted, path[len(prefix):]), "GitHub read outside the release-only allowlist")
    suffix = path[len(prefix):]
    if suffix == "git/ref/heads/main":
        endpoint = "main-reference"
    elif suffix.startswith("actions/runs/"):
        endpoint = "workflow-jobs" if "/jobs?" in suffix else "workflow-run"
    elif suffix.startswith("environments/"):
        endpoint = "branch-policy" if "/deployment-branch-policies?" in suffix else "environment"
    else:
        endpoint = "candidate-asset" if suffix.startswith("releases/assets/") else "candidate-release"
    command = ["gh", "api", "--hostname", "github.com", "--method", "GET", "-H", "X-GitHub-Api-Version: 2022-11-28"]
    if binary:
        command += ["-H", "Accept: application/octet-stream"]
    try:
        result = subprocess.run([*command, path], capture_output=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        raise ReleaseError(f"GitHub evidence unavailable [{endpoint}; timeout]") from error
    if result.returncode != 0:
        # Only a fixed endpoint class and three-digit status are safe to log.
        # Never include gh stderr/stdout, a URL, caller input, or credentials.
        status = re.search(rb"\(HTTP ([1-5][0-9]{2})\)", result.stderr[-2048:])
        label = "HTTP " + status[1].decode("ascii") if status else "HTTP status unavailable"
        raise ReleaseError(f"GitHub evidence unavailable [{endpoint}; {label}]")
    require(len(result.stdout) <= maximum, f"GitHub evidence unavailable [{endpoint}; response exceeds byte bound]")
    return result.stdout if binary else document(result.stdout, maximum)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError("Public package reads must not redirect")


def public_read(url, maximum):
    parsed = urlsplit(url)
    require(parsed.scheme == "https" and parsed.netloc in {"pypi.org", "files.pythonhosted.org"}
        and not parsed.query and not parsed.fragment, "Unapproved public registry endpoint")
    # No environment proxy/auth/GitHub credential is attached to these reads.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(urllib.request.Request(url, headers={"Accept": "application/octet-stream"}), timeout=45) as response:
        raw = response.read(maximum + 1)
    require(len(raw) <= maximum, "Public registry response exceeds its bound")
    return raw


def public_metadata(name, version):
    require(name in {"physicalsystems-node", *PINS} and version == ({"physicalsystems-node": VERSION, **PINS})[name], "Unapproved public package identity")
    value = document(public_read(f"https://pypi.org/pypi/{name}/{version}/json", 4 * 1024 * 1024), 4 * 1024 * 1024)
    require(type(value) is dict and type(value.get("urls")) is list and len(value["urls"]) <= 512, "Invalid PyPI metadata")
    return value


def verify_public(artifact, metadata):
    matches = [item for item in metadata["urls"] if item.get("filename") == artifact["filename"]]
    require(len(matches) == 1, "Exact wheel is not publicly available")
    item = matches[0]
    require(item.get("packagetype") == "bdist_wheel" and item.get("yanked") is False and item.get("size") == artifact["bytes"]
        and item.get("digests", {}).get("sha256") == artifact["sha256"], "Public wheel is yanked or differs from tested bytes")
    url = official_url(item.get("url"))
    require("url" not in artifact or artifact["url"] == url, "Public wheel URL differs from its pin")
    return url


def dependencies_public(capsule):
    metadata = {name: public_metadata(name, version) for name, version in PINS.items()}
    for target in capsule["targets"]:
        for item in target["publicDependencies"]:
            verify_public(item, metadata[item["name"]])


def fetch_candidate(release_id, metadata_sha):
    release_id = positive_id(release_id)
    hash_pin(metadata_sha)
    release = github(f"repos/{REPOSITORY}/releases/{release_id}")
    require(release.get("id") == int(release_id) and release.get("draft") is False and release.get("prerelease") is True
        and release.get("tag_name") == CANDIDATE_TAG and release.get("target_commitish") == "main",
        "Candidate must be the approved published prerelease targeting main")
    published_at = release.get("published_at")
    require(type(published_at) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", published_at),
        "Candidate must have a valid publication timestamp")
    try:
        datetime.strptime(published_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise ReleaseError("Candidate must have a valid publication timestamp") from error
    assets = release.get("assets")
    require(type(assets) is list and len(assets) == 2 and {item.get("name") for item in assets} == {NODE_WHEEL, "release.json"},
        "Candidate release must contain exactly the wheel and release.json")
    fetched = {}
    for item in assets:
        require(type(item.get("id")) is int and item["id"] > 0 and item.get("state") == "uploaded", "Invalid candidate asset identity/state")
        limit = MAX_WHEEL if item["name"] == NODE_WHEEL else MAX_JSON
        require(type(item.get("size")) is int and 0 < item["size"] <= limit, "Candidate asset exceeds its bound")
        raw = github(f"repos/{REPOSITORY}/releases/assets/{item['id']}", binary=True, maximum=limit)
        require(len(raw) == item["size"] and item.get("digest") == "sha256:" + sha(raw), "Candidate asset changed or API digest differs")
        fetched[item["name"]] = raw
    capsule = validate_capsule(fetched["release.json"], metadata_sha)
    inspect_node(fetched[NODE_WHEEL], capsule)
    dependencies_public(capsule)
    return capsule, fetched


def validate_environment(value, policies, policy):
    require(policy == POLICY and value.get("name") == ENVIRONMENT and value.get("can_admins_bypass") is False,
        "Publishing requires explicit policy and a non-bypassable environment")
    require(value.get("deployment_branch_policy") == {"protected_branches": False, "custom_branch_policies": True},
        "Publishing requires an exact custom main-only environment policy")
    rules = [rule for rule in value.get("protection_rules", []) if rule.get("type") == "required_reviewers"]
    require(len(rules) == 1 and rules[0].get("reviewers"), "Publishing requires named human reviewers")
    for reviewer in rules[0]["reviewers"]:
        identity = reviewer.get("reviewer", {})
        require(reviewer.get("type") == "User" and identity.get("type") == "User"
            and type(identity.get("id")) is int and identity["id"] > 0
            and re.fullmatch(r"[A-Za-z0-9-]{1,39}", identity.get("login", "")), "Reviewer must be a named human user")
    branches = policies.get("branch_policies")
    require(policies.get("total_count") == 1 and type(branches) is list and len(branches) == 1
        and branches[0].get("name") == "main" and branches[0].get("type") == "branch", "No wildcard, tag or alternative publishing branch is allowed")


def local_identity(environ=os.environ):
    require(environ.get("GITHUB_REPOSITORY") == REPOSITORY and environ.get("GITHUB_REF") == "refs/heads/main"
        and environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Publication is manual from reviewed public main")
    source = environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", source), "Invalid workflow source identity")
    run_id, attempt = positive_id(environ.get("GITHUB_RUN_ID")), positive_id(environ.get("GITHUB_RUN_ATTEMPT"))
    return {"runId": run_id, "runAttempt": attempt, "toolingCommit": source}


def workflow_identity(environ=os.environ):
    identity = local_identity(environ)
    source, run_id, attempt = identity["toolingCommit"], identity["runId"], identity["runAttempt"]
    main = github(f"repos/{REPOSITORY}/git/ref/heads/main")
    require(main.get("object", {}).get("sha") == source, "Release tooling main changed; dispatch a new reviewed run")
    run = github(f"repos/{REPOSITORY}/actions/runs/{run_id}")
    require(run.get("id") == int(run_id) and run.get("run_attempt") == int(attempt) and run.get("event") == "workflow_dispatch"
        and run.get("head_sha") == source and run.get("head_branch") == "main" and run.get("path") == ".github/workflows/node-release.yml"
        and run.get("repository", {}).get("full_name") == REPOSITORY and run.get("repository", {}).get("private") is False,
        "Workflow evidence does not match this exact public main attempt")
    return identity


def protections():
    validate_environment(github(f"repos/{REPOSITORY}/environments/{ENVIRONMENT}"),
        github(f"repos/{REPOSITORY}/environments/{ENVIRONMENT}/deployment-branch-policies?per_page=100"),
        os.environ.get("PHYSICAL_NODE_PUBLISH_POLICY"))


def clean_environment():
    # Child-installed code receives no repository token, OIDC request credentials,
    # model credentials, PYTHONPATH, registry config or caller-selected libraries.
    allowed = {"PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"}
    return {key: value for key, value in os.environ.items() if key in allowed} | {
        "PIP_CONFIG_FILE": os.devnull, "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONNOUSERSITE": "1"}


def execute_probe(command, environ):
    result = subprocess.run(command, capture_output=True, timeout=240, env=environ)
    require(result.returncode == 0 and len(result.stdout) <= MAX_JSON, "Isolated installation/probe failed; no hardware was requested")
    return result.stdout


def install_probe(capsule, fetched, platform, python):
    require((platform, python) in TARGETS and f"{sys.version_info.major}.{sys.version_info.minor}" == python
        and ((sys.platform == "win32") == (platform == "win32-x64")), "Probe runner differs from target")
    target = next(item for item in capsule["targets"] if (item["platform"], item["python"]) == (platform, python))
    environment = clean_environment()
    with tempfile.TemporaryDirectory(prefix="psn-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        directory = Path(temporary)
        venv = directory / "env"
        require(platform != "win32-x64" or len(str(venv.absolute())) <= 126, "Windows install path exceeds native-wheel safe bound")
        wheelhouse = directory / "wheels"
        wheelhouse.mkdir()
        (wheelhouse / NODE_WHEEL).write_bytes(fetched[NODE_WHEEL])
        artifacts = [{"name": "physicalsystems-node", "version": VERSION, **capsule["wheel"]}, *target["publicDependencies"]]
        for artifact in target["publicDependencies"]:
            raw = public_read(artifact["url"], artifact["bytes"])
            require(len(raw) == artifact["bytes"] and sha(raw) == artifact["sha256"], "Dependency download differs from pinned bytes")
            (wheelhouse / artifact["filename"]).write_bytes(raw)
        requirements = directory / "requirements.txt"
        requirements.write_text("\n".join(f"{item['name']}=={item['version']} --hash=sha256:{item['sha256']}" for item in artifacts) + "\n", encoding="utf-8")
        execute_probe([sys.executable, "-I", "-m", "venv", str(venv)], environment)
        interpreter = venv / ("Scripts/python.exe" if platform == "win32-x64" else "bin/python")
        execute_probe([str(interpreter), "-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", "--only-binary=:all:",
            "--require-hashes", "--find-links", str(wheelhouse), "-r", str(requirements)], environment)
        execute_probe([str(interpreter), "-I", "-m", "pip", "--isolated", "check"], environment)
        installation = document(execute_probe([str(interpreter), "-I", "-m", "tinyedge_agent.physical_node_cli", "--installation-info"], environment))
        expected_installation = {"contractVersion": "physicalsystems-node-installation-v1", "distribution": "physicalsystems-node",
            "version": VERSION, "runtimeVersion": RUNTIME_VERSION, "protocols": ["physicalsystems-node-ready-v1"]}
        require(installation == expected_installation, "Installed Node identity/protocol mismatch")
        probe = ("import json,sys; import tinyedge_runtime,numpy,cv2; "
            "assert cv2.cvtColor(numpy.zeros((2,2,3),dtype=numpy.uint8),cv2.COLOR_BGR2HSV).shape==(2,2,3); "
            "assert not any(n.startswith(('tinyedge_agent.physical_camera','tinyedge_agent.physical_candidates','tinyedge_agent.physical_discovery','tinyedge_agent.physical_so101')) for n in sys.modules); "
            "print(json.dumps({'numpy':numpy.__version__,'opencv':cv2.__version__,'hardwareOpened':False}))")
        native = document(execute_probe([str(interpreter), "-I", "-c", probe], environment))
        require(native == {"numpy": "1.26.4", "opencv": "4.10.0", "hardwareOpened": False}, "Native dependency probe mismatch")
    return {"installation": installation, "nativeImports": native}


def proof_name(platform, python):
    return f"{platform}-py{python}.json"


def validate_proofs(directory, capsule, metadata_sha, identity):
    directory = Path(directory)
    require({path.name for path in directory.iterdir()} == {proof_name(*target) for target in TARGETS}, "Six exact proof files are required")
    expected_jobs = {f"install-{platform}-py{python}" for platform, python in TARGETS}
    jobs = github(f"repos/{REPOSITORY}/actions/runs/{identity['runId']}/attempts/{identity['runAttempt']}/jobs?per_page=100")
    require(type(jobs.get("jobs")) is list and jobs.get("total_count", 101) <= 100, "Unbounded or unavailable current-attempt jobs")
    for name in expected_jobs:
        matching = [item for item in jobs["jobs"] if item.get("name") == name]
        require(len(matching) == 1 and matching[0].get("status") == "completed" and matching[0].get("conclusion") == "success",
            "All six fresh install jobs must have succeeded")
    for target in capsule["targets"]:
        proof = document(read_file(directory / proof_name(target["platform"], target["python"])))
        keys(proof, "contractVersion status platform python releaseMetadataSha256 wheelSha256 publicDependencies runId runAttempt toolingCommit installation nativeImports physicalExecutionAuthorized")
        require(proof["contractVersion"] == "physicalsystems-node-public-install-proof-v1" and proof["status"] == "passed"
            and (proof["platform"], proof["python"]) == (target["platform"], target["python"])
            and proof["releaseMetadataSha256"] == metadata_sha and proof["wheelSha256"] == capsule["wheel"]["sha256"]
            and proof["publicDependencies"] == target["publicDependencies"]
            and all(proof[key] == value for key, value in identity.items()) and proof["physicalExecutionAuthorized"] is False,
            "Install proof is not bound to this exact release and workflow attempt")
        require(proof["installation"] == {"contractVersion": "physicalsystems-node-installation-v1", "distribution": "physicalsystems-node",
            "version": VERSION, "runtimeVersion": RUNTIME_VERSION, "protocols": ["physicalsystems-node-ready-v1"]}
            and proof["nativeImports"] == {"numpy": "1.26.4", "opencv": "4.10.0", "hardwareOpened": False}, "Required isolated probes did not pass")


def stage(output, fetched):
    output = Path(output)
    require(not output.exists(), "Publication stage already exists")
    output.mkdir(parents=True)
    (output / "release.json").write_bytes(fetched["release.json"])
    (output / "upload").mkdir()
    (output / "upload" / NODE_WHEEL).write_bytes(fetched[NODE_WHEEL])


def check_stage(directory, metadata_sha):
    directory = Path(directory)
    require({item.name for item in directory.iterdir()} == {"release.json", "upload"}
        and {item.name for item in (directory / "upload").iterdir()} == {NODE_WHEEL}, "Unexpected publication files")
    capsule = validate_capsule(read_file(directory / "release.json"), metadata_sha)
    raw = read_file(directory / "upload" / NODE_WHEEL, MAX_WHEEL)
    inspect_node(raw, capsule)
    return capsule, raw


def published(directory, metadata_sha, output):
    capsule, raw = check_stage(directory, metadata_sha)
    dependencies_public(capsule)
    url = verify_public(capsule["wheel"], public_metadata("physicalsystems-node", VERSION))
    remote = public_read(url, MAX_WHEEL)
    require(remote == raw, "PyPI readback differs from the approved uploaded wheel")
    result = Path(output)
    require(not result.exists(), "Published evidence output already exists")
    result.mkdir(parents=True)
    for target in capsule["targets"]:
        manifest = {"contractVersion": "physicalsystems-node-install-v1", "release": VERSION,
            "distribution": "physicalsystems-node", "runtimeVersion": RUNTIME_VERSION, "platform": target["platform"], "python": target["python"],
            "artifacts": sorted([{"name": "physicalsystems-node", "version": VERSION, **capsule["wheel"], "url": url},
                *target["publicDependencies"]], key=lambda item: item["name"])}
        (result / proof_name(target["platform"], target["python"])).write_bytes(canonical(manifest))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify", "install", "stage", "readback"))
    parser.add_argument("--candidate-release-id")
    parser.add_argument("--release-metadata-sha256", required=True)
    parser.add_argument("--platform")
    parser.add_argument("--python")
    parser.add_argument("--proofs")
    parser.add_argument("--directory")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    if args.operation == "readback":
        published(args.directory, args.release_metadata_sha256, args.output)
        print("Exact public Node wheel verified; six install descriptors written.")
        return
    if args.operation == "install":
        # Separate from authenticated fetching: this process and all its
        # descendants must start without a GitHub/PyPI/OIDC credential.
        require(not any(os.environ.get(name) for name in ("GH_TOKEN", "GITHUB_TOKEN", "PYPI_TOKEN",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL")), "Install probes must not inherit publishing/repository credentials")
        identity = local_identity()
        capsule, wheel = check_stage(args.directory, args.release_metadata_sha256)
        fetched = {NODE_WHEEL: wheel}
    else:
        identity = workflow_identity()
        protections()
        capsule, fetched = fetch_candidate(args.candidate_release_id, args.release_metadata_sha256)
    if args.operation == "verify":
        if args.output:
            stage(args.output, fetched)
        print(json.dumps({"releaseMetadataSha256": args.release_metadata_sha256, "wheelSha256": capsule["wheel"]["sha256"], "targets": 6}))
    elif args.operation == "install":
        result = install_probe(capsule, fetched, args.platform, args.python)
        proof = {"contractVersion": "physicalsystems-node-public-install-proof-v1", "status": "passed", "platform": args.platform,
            "python": args.python, "releaseMetadataSha256": args.release_metadata_sha256, "wheelSha256": capsule["wheel"]["sha256"],
            "publicDependencies": next(target["publicDependencies"] for target in capsule["targets"]
                if (target["platform"], target["python"]) == (args.platform, args.python)), **identity, **result, "physicalExecutionAuthorized": False}
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=False)
        (output / proof_name(args.platform, args.python)).write_bytes(canonical(proof))
    else:
        validate_proofs(args.proofs, capsule, args.release_metadata_sha256, identity)
        stage(args.output, fetched)
        check_stage(args.output, args.release_metadata_sha256)
        # Network evidence reads can take time. Do not hand a stage to PyPA if
        # main/attempt/protection changed while those bounded reads completed.
        require(workflow_identity() == identity, "Workflow identity changed during stage verification")
        protections()


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        # Never dump network headers, subprocess output, local paths or traceback.
        print("Release refused: " + (str(error) if isinstance(error, ReleaseError) else "Required evidence or isolated probe unavailable"), file=sys.stderr)
        raise SystemExit(1)
