#!/usr/bin/env python3
"""Verify a protected job's PyPI token exchange, without uploading anything.

The documented manual exchange is an implementation-specific PyPI interface:
https://docs.pypi.org/trusted-publishers/using-a-publisher/#the-manual-way
Use the PyPA action, not this helper, for publication. The minted credential is
never logged, written, returned, or passed to another process. Dropping Python
references is not a promise of cryptographic memory erasure.

PyPI's response does not identify projects or its configured environment policy.
An exchange can match an environment-less publisher or multiple projects. The
receipt deliberately does NOT attest those registration settings; a human must
check the existing project's PyPI registration. A pending publisher can also be
reified by PyPI when minting: configure existing projects, not pending ones.
"""

import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


REPOSITORY = "PhysicalSystems/physicalsystems"
COMPONENTS = {
    "runtime": ("tinyedge-runtime", "runtime-release.yml", "runtime-pypi"),
    "node": ("physicalsystems-node", "node-release.yml", "physical-node-pypi"),
}
API = "https://api.github.com"
MINT = "https://pypi.org/_/oidc/mint-token"
MAX_RESPONSE = 512 * 1024
TIMEOUT_SECONDS = 20
SCHEMA = "physicalsystems.publisher-verification.v1"


class VerificationError(Exception):
    """Messages are fixed diagnostic codes, never remote bodies or credentials."""


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def json_object(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate-json-key")
            result[key] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=unique)
        require(type(value) is dict, "json-object-required")
        return value
    except Exception:
        raise VerificationError("invalid-json-response") from None


def positive_id(value):
    require(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,19}", value), "invalid-run-identity")
    return value


def secret(value):
    require(type(value) is str and 1 <= len(value) <= 32768
            and all(32 < ord(char) < 127 for char in value), "missing-or-invalid-credential")
    return value


def checked_url(url, kind):
    """Check the origin BEFORE a credential is attached. No caller-chosen index."""
    require(type(url) is str and len(url) <= 8192
            and all(32 < ord(char) < 127 for char in url), "invalid-service-url")
    try:
        parts = urlsplit(url)
        require(parts.scheme == "https" and parts.port is None and not parts.username
                and not parts.password and not parts.fragment and "\\" not in url,
                "invalid-service-origin")
        if kind == "github":
            require(parts.netloc == "api.github.com"
                    and parts.path.startswith(f"/repos/{REPOSITORY}/"), "invalid-github-origin")
        elif kind == "oidc":
            # GitHub owns this service-only DNS suffix, not user content origins.
            require(re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.actions\.githubusercontent\.com", parts.netloc)
                    and parts.path.lower().rstrip("/").endswith("/idtoken"), "invalid-oidc-origin")
        elif kind == "pypi":
            require(url == MINT, "invalid-pypi-origin")
        else:
            raise VerificationError("invalid-service-kind")
        return parts
    except VerificationError:
        raise
    except Exception:
        raise VerificationError("invalid-service-origin") from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise VerificationError("redirect-forbidden")


class HTTPClient:
    def __init__(self):
        # Ignore ambient proxies; HTTPS certificate verification stays enabled.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request_json(self, url, *, kind, bearer=None, payload=None):
        checked_url(url, kind)
        require((kind == "pypi") == (payload is not None), "invalid-service-method")
        require((kind == "pypi") == (bearer is None), "invalid-service-credential")
        headers = {"Accept": "application/json", "User-Agent": "physicalsystems-publisher-verification/1"}
        if bearer is not None:
            headers["Authorization"] = "Bearer " + secret(bearer)
        if kind == "github":
            headers["X-GitHub-Api-Version"] = "2022-11-28"
        if payload is not None:
            headers["Content-Type"] = "application/json"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        try:
            request = Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                require(response.status == 200 and response.geturl() == url, "unexpected-http-response")
                raw = response.read(MAX_RESPONSE + 1)
                require(len(raw) <= MAX_RESPONSE, "response-too-large")
                return json_object(raw)
        except Exception:
            # HTTP errors can contain request credentials, token echoes, or URLs.
            # Do not expose the exception, its chain, headers, or response body.
            raise VerificationError("service-request-failed") from None


def audit_current_run(component, environ=None, client=None):
    """Read-only preflight, also callable before any candidate execution/OIDC.

Returns only bounded public identity fields. It does not claim an environment
approval occurred; the protected job and the exchanged JWT establish that later.
"""
    environ = os.environ if environ is None else environ
    client = HTTPClient() if client is None else client
    require(component in COMPONENTS, "unknown-component")
    distribution, workflow, environment = COMPONENTS[component]
    workflow_ref = f"{REPOSITORY}/.github/workflows/{workflow}@refs/heads/main"
    sha = environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "invalid-source-sha")
    require(environ.get("GITHUB_REPOSITORY") == REPOSITORY
            and environ.get("GITHUB_REF") == "refs/heads/main"
            and environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and environ.get("GITHUB_WORKFLOW_REF") == workflow_ref
            and environ.get("GITHUB_WORKFLOW_SHA") == sha, "invalid-local-workflow-identity")
    run_id = positive_id(environ.get("GITHUB_RUN_ID"))
    attempt = positive_id(environ.get("GITHUB_RUN_ATTEMPT"))
    token = secret(environ.get("GITHUB_TOKEN"))

    def github(path):
        return client.request_json(f"{API}/repos/{REPOSITORY}/{path}", kind="github", bearer=token)

    main = github("git/ref/heads/main")
    require(main.get("ref") == "refs/heads/main" and main.get("object", {}).get("sha") == sha
            and main.get("object", {}).get("type") == "commit", "current-main-mismatch")
    run = github(f"actions/runs/{run_id}")
    require(type(run.get("id")) is int and run["id"] == int(run_id)
            and type(run.get("run_attempt")) is int and run["run_attempt"] == int(attempt)
            and run.get("event") == "workflow_dispatch" and run.get("head_sha") == sha
            and run.get("head_branch") == "main" and run.get("path") == f".github/workflows/{workflow}"
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("repository", {}).get("private") is False, "run-attempt-mismatch")
    repository_id = run.get("repository", {}).get("id")
    owner_id = run.get("repository", {}).get("owner", {}).get("id")
    require(type(repository_id) is int and repository_id > 0 and type(owner_id) is int
            and owner_id > 0, "repository-id-missing")
    protection = github(f"environments/{environment}")
    require(protection.get("name") == environment and protection.get("can_admins_bypass") is False
            and protection.get("deployment_branch_policy") == {
                "protected_branches": False, "custom_branch_policies": True,
            }, "environment-not-protected")
    rules = protection.get("protection_rules")
    require(type(rules) is list and all(type(rule) is dict for rule in rules), "invalid-reviewer-policy")
    reviewers = [rule.get("reviewers") for rule in rules if rule.get("type") == "required_reviewers"]
    require(len(reviewers) == 1 and type(reviewers[0]) is list and 1 <= len(reviewers[0]) <= 6,
            "named-human-reviewer-required")
    for entry in reviewers[0]:
        require(type(entry) is dict and type(entry.get("reviewer")) is dict, "invalid-reviewer")
        user = entry["reviewer"]
        require(entry.get("type") == "User" and user.get("type") == "User"
                and type(user.get("id")) is int and user["id"] > 0
                and type(user.get("login")) is str and re.fullmatch(r"[A-Za-z0-9-]{1,39}", user["login"]),
                "named-human-reviewer-required")
    policies = github(f"environments/{environment}/deployment-branch-policies?per_page=100")
    branches = policies.get("branch_policies")
    require(type(policies.get("total_count")) is int and policies["total_count"] == 1
            and type(branches) is list and len(branches) == 1 and type(branches[0]) is dict
            and branches[0].get("name") == "main" and branches[0].get("type") == "branch",
            "exact-main-branch-policy-required")
    return {"component": component, "distribution": distribution, "repository": REPOSITORY,
            "workflow": workflow, "environment": environment, "runId": run_id, "runAttempt": attempt,
            "headSha": sha, "repositoryId": str(repository_id), "repositoryOwnerId": str(owner_id)}


def check_oidc_context(token, identity):
    """Consistency only: never accept this unverified decoding as authentication.

The SAME token must subsequently be verified by PyPI's TLS-authenticated server.
No decoded field is copied into the receipt (which uses the GitHub API audit).
"""
    parts = token.split(".")
    require(len(parts) == 3 and all(re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts), "invalid-oidc-token")
    try:
        claims = json_object(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except Exception:
        raise VerificationError("invalid-oidc-context") from None
    expected_ref = f"{REPOSITORY}/.github/workflows/{identity['workflow']}@refs/heads/main"
    expected = {
        "iss": "https://token.actions.githubusercontent.com", "aud": "pypi",
        "repository": REPOSITORY, "repository_visibility": "public",
        "repository_id": identity["repositoryId"], "repository_owner_id": identity["repositoryOwnerId"],
        "workflow_ref": expected_ref, "workflow_sha": identity["headSha"],
        "ref": "refs/heads/main", "sha": identity["headSha"], "event_name": "workflow_dispatch",
        "environment": identity["environment"], "run_id": identity["runId"], "run_attempt": identity["runAttempt"],
    }
    require(all(claims.get(key) == value for key, value in expected.items()), "oidc-context-mismatch")
    require(claims.get("job_workflow_ref", expected_ref) == expected_ref
            and claims.get("job_workflow_sha", identity["headSha"]) == identity["headSha"], "reusable-workflow-forbidden")
    now = int(time.time())
    require(all(type(claims.get(key)) is int for key in ("iat", "nbf", "exp"))
            and now - 600 <= claims["iat"] <= now + 30
            and claims["nbf"] <= now + 30 and now < claims["exp"] <= now + 600, "oidc-token-not-current")


def verify_publisher(component, environ=None, client=None, *, audit_only=False):
    environ = os.environ if environ is None else environ
    client = HTTPClient() if client is None else client
    identity = audit_current_run(component, environ, client)
    if not audit_only:
        parts = checked_url(environ.get("ACTIONS_ID_TOKEN_REQUEST_URL"), "oidc")
        query = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True)
        require(not any(key.lower() == "audience" for key, _ in query), "preselected-oidc-audience")
        url = urlunsplit(parts._replace(query=urlencode(query + [("audience", "pypi")])))
        response = client.request_json(url, kind="oidc", bearer=secret(environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")))
        oidc_token = secret(response.pop("value", None))
        response.clear()
        check_oidc_context(oidc_token, identity)
        response = client.request_json(MINT, kind="pypi", payload={"token": oidc_token})
        del oidc_token
        # Never return this response, put the token in GITHUB_OUTPUT, or mask/log it.
        minted = response.pop("token", None)
        accepted = response.get("success") is True and type(minted) is str and minted.startswith("pypi-")
        del minted
        response.clear()
        require(accepted, "pypi-exchange-not-accepted")
        require(audit_current_run(component, environ, client) == identity, "identity-changed-during-exchange")
    return {"schema": SCHEMA, **identity, "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "tokenExchangeVerified": not audit_only, "publicationPerformed": False,
            "distributionAuthorizationVerified": False, "pypiEnvironmentBindingVerified": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=sorted(COMPONENTS), required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--audit-only", action="store_true", help="Read GitHub identity/protections; do not request OIDC")
    args = parser.parse_args(argv)
    try:
        output = Path(args.output)
        require(output.is_absolute() and output.parent.is_dir() and not output.exists()
                and not output.is_symlink(), "output-must-be-new-absolute-file")
        receipt = verify_publisher(args.component, audit_only=args.audit_only)
        with output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
        print("Publisher audit receipt written; no package upload was performed.")
        return 0
    except VerificationError as error:
        # Only fixed reviewed diagnostics may reach a log. Never render arbitrary
        # exception strings, response bodies, URLs, JWTs or minted credentials.
        safe_codes = {"current-main-mismatch", "run-attempt-mismatch", "invalid-local-workflow-identity",
            "environment-not-protected", "named-human-reviewer-required", "exact-main-branch-policy-required",
            "oidc-context-mismatch", "oidc-token-not-current", "pypi-exchange-not-accepted",
            "identity-changed-during-exchange", "service-request-failed", "missing-or-invalid-credential",
            "invalid-oidc-origin", "output-must-be-new-absolute-file"}
        code = str(error) if str(error) in safe_codes else "verification-refused"
        print("Publisher verification failed: " + code + "; no successful receipt was produced.", file=sys.stderr)
        return 1
    except Exception:
        # Even unexpected library errors must not render credentials or a traceback.
        print("Publisher verification failed; no successful receipt was produced.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
