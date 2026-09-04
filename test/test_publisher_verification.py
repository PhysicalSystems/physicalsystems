"""Synthetic HTTP only: never request real publisher credentials or upload."""

import base64
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request


SPEC = importlib.util.spec_from_file_location(
    "publisher_verification", Path(__file__).resolve().parents[1] / "release/publisher-verification.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
SHA = "a" * 40
GITHUB_SECRET = "github-job-SECRET"
REQUEST_SECRET = "oidc-request-SECRET"
MINTED_SECRET = "pypi-minted-SECRET"
OIDC_ORIGIN = "https://run-actions-1-azure-eastus.actions.githubusercontent.com"
OIDC_UUIDS = "01234567-89ab-cdef-0123-456789abcdef/89abcdef-0123-4567-89ab-cdef01234567"
OIDC_NEW_PATH = f"/123456789//idtoken/{OIDC_UUIDS}"
INVALID_OIDC_URLS = [
    f"http://run-actions-1-azure-eastus.actions.githubusercontent.com{OIDC_NEW_PATH}",
    f"https://actions.githubusercontent.com{OIDC_NEW_PATH}",
    f"https://evilactions.githubusercontent.com{OIDC_NEW_PATH}",
    f"https://run-actions-1-azure-eastus.actions.githubusercontent.com.evil.example{OIDC_NEW_PATH}",
    f"https://user:password@run-actions-1-azure-eastus.actions.githubusercontent.com{OIDC_NEW_PATH}",
    f"https://@run-actions-1-azure-eastus.actions.githubusercontent.com{OIDC_NEW_PATH}",
    f"{OIDC_ORIGIN}:443{OIDC_NEW_PATH}",
    f"{OIDC_ORIGIN}:8443{OIDC_NEW_PATH}",
    f"{OIDC_ORIGIN}.{OIDC_NEW_PATH}",
    f"{OIDC_ORIGIN}{OIDC_NEW_PATH}#fragment",
    f" {OIDC_ORIGIN}{OIDC_NEW_PATH}",
] + [OIDC_ORIGIN + path for path in (
    "/123456789//idtoken/" + OIDC_UUIDS.split("/")[0],
    "/123456789//idtoken/" + OIDC_UUIDS + "/" + OIDC_UUIDS.split("/")[0],
    OIDC_NEW_PATH + "/",
    "/123456789//other/" + OIDC_UUIDS,
    "/123456789/idtoken/" + OIDC_UUIDS,
    "//idtoken/" + OIDC_UUIDS,
    "/abc//idtoken/" + OIDC_UUIDS,
    "/-123//idtoken/" + OIDC_UUIDS,
    "/123456789//idtoken/" + OIDC_UUIDS.replace("-", ""),
    "/123456789//idtoken/" + OIDC_UUIDS.replace("a", "g", 1),
    "/123456789//idtoken/{" + OIDC_UUIDS.split("/")[0] + "}/" + OIDC_UUIDS.split("/")[1],
    OIDC_NEW_PATH.replace("//idtoken", "/%2fidtoken"),
    OIDC_NEW_PATH.replace("//idtoken", "/%2Fidtoken"),
    OIDC_NEW_PATH.replace("/idtoken/", "/idtoken%2f"),
    "/123456789//idtoken/../" + OIDC_UUIDS,
    "/123456789//idtoken/./" + OIDC_UUIDS,
    "/123456789//idtoken/%2e%2e/" + OIDC_UUIDS,
    "/example/_apis/jobs/../idtoken",
    "/example/_apis/jobs/./idtoken",
    "/example/_apis/jobs/%2e%2e/idtoken",
    "/example/_apis/jobs/abc%2fdef/idtoken",
    "/example/_apis/jobs/abc\\def/idtoken",
)]


def environment(component="runtime"):
    workflow = probe.COMPONENTS[component][1]
    return {
        "GITHUB_REPOSITORY": probe.REPOSITORY, "GITHUB_REF": "refs/heads/main",
        "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": SHA,
        "GITHUB_WORKFLOW_SHA": SHA,
        "GITHUB_WORKFLOW_REF": f"{probe.REPOSITORY}/.github/workflows/{workflow}@refs/heads/main",
        "GITHUB_RUN_ID": "123456", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_TOKEN": GITHUB_SECRET,
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN": REQUEST_SECRET,
        "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/example/_apis/jobs/abc/idtoken?api-version=2.0",
    }


def jwt(claims):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    return encode({"alg": "RS256"}) + "." + encode(claims) + ".signatureSECRET"


class FakeClient:
    def __init__(self, component="runtime"):
        self.component = component
        self.calls = []
        self.mutations = {}
        _, workflow, protected = probe.COMPONENTS[component]
        now = int(time.time())
        self.claims = {
            "iss": "https://token.actions.githubusercontent.com", "aud": "pypi",
            "repository": probe.REPOSITORY, "repository_visibility": "public",
            "repository_id": "123", "repository_owner_id": "456",
            "workflow_ref": f"{probe.REPOSITORY}/.github/workflows/{workflow}@refs/heads/main",
            "workflow_sha": SHA, "ref": "refs/heads/main", "sha": SHA,
            "event_name": "workflow_dispatch", "environment": protected,
            "run_id": "123456", "run_attempt": "2", "iat": now, "nbf": now, "exp": now + 300,
        }
        self.objects = {
            "git/ref/heads/main": {"ref": "refs/heads/main", "object": {"sha": SHA, "type": "commit"}},
            "actions/runs/123456": {
                "id": 123456, "run_attempt": 2, "event": "workflow_dispatch", "head_sha": SHA,
                "head_branch": "main", "path": f".github/workflows/{workflow}",
                "repository": {"id": 123, "full_name": probe.REPOSITORY, "private": False, "owner": {"id": 456}},
            },
            f"environments/{protected}": {
                "name": protected, "can_admins_bypass": False,
                "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
                "protection_rules": [{"type": "required_reviewers", "reviewers": [
                    {"type": "User", "reviewer": {"id": 789, "type": "User", "login": "named-human"}},
                ]}],
            },
            f"environments/{protected}/deployment-branch-policies?per_page=100": {
                "total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}],
            },
        }
        self.mint = {"success": True, "token": MINTED_SECRET, "expires": now + 900}

    def request_json(self, url, **options):
        self.calls.append((url, deepcopy(options)))
        kind = options["kind"]
        if kind == "github":
            path = url.removeprefix(f"{probe.API}/repos/{probe.REPOSITORY}/")
            value = deepcopy(self.objects[path])
            if len(self.calls) > 6 and path in self.mutations:
                return self.mutations[path](value)
            return value
        if kind == "oidc":
            return {"value": jwt(self.claims)}
        if kind == "pypi":
            return deepcopy(self.mint)
        raise AssertionError("Unexpected HTTP purpose")


class VerificationTests(unittest.TestCase):
    def test_legacy_and_current_github_oidc_routes_complete_both_component_flows(self):
        urls = [
            environment()["ACTIONS_ID_TOKEN_REQUEST_URL"],
            "https://pipelines.actions.githubusercontent.com/example/_apis/jobs/abc/IDToken/?api-version=2.0",
            OIDC_ORIGIN + OIDC_NEW_PATH + "?api-version=2.0",
            OIDC_ORIGIN + "/123456789//idtoken/" + OIDC_UUIDS.upper() + "?api-version=2.0",
        ]
        for component in probe.COMPONENTS:
            for url in urls:
                with self.subTest(component=component, url=url):
                    client = FakeClient(component)
                    env = environment(component) | {"ACTIONS_ID_TOKEN_REQUEST_URL": url}
                    receipt = probe.verify_publisher(component, env, client)
                    self.assertTrue(receipt["tokenExchangeVerified"])
                    self.assertFalse(receipt["publicationPerformed"])
                    self.assertEqual(len(client.calls), 10)
                    oidc = [(call_url, options) for call_url, options in client.calls if options["kind"] == "oidc"]
                    self.assertEqual(len(oidc), 1)
                    self.assertEqual(urlsplit(oidc[0][0]).path, urlsplit(url).path)
                    self.assertEqual(parse_qs(urlsplit(oidc[0][0]).query), {"api-version": ["2.0"], "audience": ["pypi"]})
                    self.assertEqual(oidc[0][1]["bearer"], REQUEST_SECRET)
                    self.assertEqual(sum(options["kind"] == "pypi" for _, options in client.calls), 1)
                    for value in (GITHUB_SECRET, REQUEST_SECRET, MINTED_SECRET, jwt(client.claims)):
                        self.assertNotIn(value, json.dumps(receipt))

    def test_invalid_oidc_origins_and_paths_stop_both_flows_before_oidc_or_pypi(self):
        for component in probe.COMPONENTS:
            for url in INVALID_OIDC_URLS:
                with self.subTest(component=component, url=url):
                    client = FakeClient(component)
                    env = environment(component) | {"ACTIONS_ID_TOKEN_REQUEST_URL": url}
                    with self.assertRaises(probe.VerificationError):
                        probe.verify_publisher(component, env, client)
                    self.assertEqual(len(client.calls), 4)
                    self.assertTrue(all(options["kind"] == "github" for _, options in client.calls))

    def test_both_components_exchange_once_discard_secret_and_emit_limited_receipt(self):
        for component in probe.COMPONENTS:
            with self.subTest(component=component):
                client = FakeClient(component)
                receipt = probe.verify_publisher(component, environment(component), client)
                self.assertEqual(receipt["schema"], probe.SCHEMA)
                self.assertEqual(receipt["distribution"], probe.COMPONENTS[component][0])
                self.assertEqual(receipt["headSha"], SHA)
                self.assertEqual((receipt["runId"], receipt["runAttempt"]), ("123456", "2"))
                self.assertTrue(receipt["tokenExchangeVerified"])
                self.assertFalse(receipt["publicationPerformed"])
                self.assertFalse(receipt["distributionAuthorizationVerified"])
                self.assertFalse(receipt["pypiEnvironmentBindingVerified"])
                self.assertEqual(len(client.calls), 10)
                oidc = client.calls[4]
                self.assertEqual(parse_qs(urlsplit(oidc[0]).query)["audience"], ["pypi"])
                self.assertEqual(oidc[1]["bearer"], REQUEST_SECRET)
                self.assertEqual(client.calls[5], (probe.MINT, {"kind": "pypi", "payload": {"token": jwt(client.claims)}}))
                self.assertNotIn("bearer", client.calls[5][1])
                for value in (GITHUB_SECRET, REQUEST_SECRET, MINTED_SECRET, jwt(client.claims)):
                    self.assertNotIn(value, json.dumps(receipt))

    def test_audit_only_has_no_oidc_and_does_not_claim_exchange(self):
        env = environment()
        del env["ACTIONS_ID_TOKEN_REQUEST_URL"], env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
        client = FakeClient()
        receipt = probe.verify_publisher("runtime", env, client, audit_only=True)
        self.assertFalse(receipt["tokenExchangeVerified"])
        self.assertEqual(len(client.calls), 4)
        self.assertTrue(all(options["kind"] == "github" for _, options in client.calls))

    def test_local_identity_rejected_before_http(self):
        cases = {"GITHUB_REPOSITORY": "attacker/fork", "GITHUB_REF": "refs/tags/main",
                 "GITHUB_EVENT_NAME": "pull_request", "GITHUB_SHA": "bad",
                 "GITHUB_WORKFLOW_REF": "other-workflow", "GITHUB_WORKFLOW_SHA": "b" * 40,
                 "GITHUB_RUN_ID": "0", "GITHUB_RUN_ATTEMPT": "02", "GITHUB_TOKEN": "bad\ncredential"}
        for key, value in cases.items():
            with self.subTest(key=key):
                client = FakeClient()
                with self.assertRaises(probe.VerificationError):
                    probe.audit_current_run("runtime", environment() | {key: value}, client)
                self.assertEqual(client.calls, [])

    def test_run_current_main_and_public_repo_are_required_before_oidc(self):
        cases = [("git/ref/heads/main", "object", {"sha": "b" * 40, "type": "commit"}),
                 ("actions/runs/123456", "run_attempt", 1), ("actions/runs/123456", "id", True),
                 ("actions/runs/123456", "path", ".github/workflows/node-release.yml"),
                 ("actions/runs/123456", "repository", {"full_name": probe.REPOSITORY, "private": True})]
        for path, key, value in cases:
            with self.subTest(path=path, key=key):
                client = FakeClient()
                client.objects[path][key] = value
                with self.assertRaises(probe.VerificationError):
                    probe.verify_publisher("runtime", environment(), client)
                self.assertTrue(all(options["kind"] == "github" for _, options in client.calls))

    def test_fail_closed_environment_variants(self):
        cases = [
            ("can_admins_bypass", True), ("can_admins_bypass", None),
            ("deployment_branch_policy", {"protected_branches": True, "custom_branch_policies": False}),
            ("protection_rules", []), ("protection_rules", [{"type": "required_reviewers", "reviewers": []}]),
            ("protection_rules", [{"type": "required_reviewers", "reviewers": [{"type": "Team", "reviewer": {"type": "Team"}}]}]),
            ("protection_rules", [{"type": "required_reviewers", "reviewers": [{"type": "User", "reviewer": {"type": "Bot", "id": 1, "login": "robot"}}]}]),
            ("protection_rules", [{"type": "required_reviewers", "reviewers": [{"type": "User", "reviewer": {"type": "User", "id": True, "login": "human"}}]}]),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                client = FakeClient()
                client.objects["environments/runtime-pypi"][key] = value
                with self.assertRaises(probe.VerificationError):
                    probe.verify_publisher("runtime", environment(), client)
                self.assertTrue(all(options["kind"] == "github" for _, options in client.calls))

    def test_only_one_literal_main_branch_policy(self):
        for policy in ({"name": "*", "type": "branch"}, {"name": "main", "type": "tag"}, {"name": "main*", "type": "branch"}):
            client = FakeClient()
            client.objects["environments/runtime-pypi/deployment-branch-policies?per_page=100"]["branch_policies"] = [policy]
            with self.assertRaises(probe.VerificationError):
                probe.audit_current_run("runtime", environment(), client)

    def test_changed_main_or_protection_after_mint_produces_no_proof(self):
        for path, mutate in [
            ("git/ref/heads/main", lambda value: value | {"object": {"sha": "b" * 40, "type": "commit"}}),
            ("environments/runtime-pypi", lambda value: value | {"can_admins_bypass": True}),
            ("actions/runs/123456", lambda value: value | {"run_attempt": 3}),
        ]:
            client = FakeClient()
            client.mutations[path] = mutate
            with self.assertRaises(probe.VerificationError):
                probe.verify_publisher("runtime", environment(), client)
            self.assertEqual(sum(options["kind"] == "pypi" for _, options in client.calls), 1)

    def test_context_mismatch_does_not_exchange_even_if_payload_looks_signed(self):
        cases = {"aud": "testpypi", "iss": "https://evil.example", "environment": "other",
                 "repository": "fork/repo", "repository_id": "124", "repository_owner_id": "457",
                 "repository_visibility": "private", "workflow_ref": "other", "workflow_sha": "b" * 40,
                 "run_id": "123457", "run_attempt": "1", "sha": "b" * 40,
                 "ref": "refs/heads/other", "event_name": "push", "exp": 0, "nbf": int(time.time()) + 1000,
                 "job_workflow_ref": "unreviewed/reusable", "job_workflow_sha": "c" * 40}
        for key, value in cases.items():
            with self.subTest(key=key):
                client = FakeClient()
                client.claims[key] = value
                with self.assertRaises(probe.VerificationError):
                    probe.verify_publisher("runtime", environment(), client)
                self.assertFalse(any(options["kind"] == "pypi" for _, options in client.calls))

    def test_correct_context_is_not_enough_without_server_acceptance(self):
        for response in ({"success": False, "token": MINTED_SECRET}, {"success": True}, {"success": True, "token": 4}):
            client = FakeClient()
            client.mint = response
            with self.assertRaises(probe.VerificationError):
                probe.verify_publisher("runtime", environment(), client)

    def test_preselected_audience_rejected_before_oidc_request(self):
        client = FakeClient()
        env = environment()
        env["ACTIONS_ID_TOKEN_REQUEST_URL"] += "&audience=pypi"
        with self.assertRaises(probe.VerificationError):
            probe.verify_publisher("runtime", env, client)
        self.assertEqual(len(client.calls), 4)


class HTTPTests(unittest.TestCase):
    def test_invalid_oidc_routes_never_construct_an_authenticated_request(self):
        for url in INVALID_OIDC_URLS:
            with self.subTest(url=url):
                client = probe.HTTPClient()
                with patch.object(probe, "Request") as request, patch.object(client.opener, "open") as opened:
                    with self.assertRaises(probe.VerificationError):
                        client.request_json(url, kind="oidc", bearer=REQUEST_SECRET)
                request.assert_not_called()
                opened.assert_not_called()

    def test_strict_origins_rejected_before_http_or_credential_attachment(self):
        cases = [("github", "https://api.github.com.evil.example/repos/PhysicalSystems/physicalsystems/x"),
                 ("github", "https://api.github.com/repos/other/repo/x"),
                 ("github", "http://api.github.com/repos/PhysicalSystems/physicalsystems/x"),
                 ("pypi", "https://pypi.org/legacy/"), ("pypi", "https://test.pypi.org/_/oidc/mint-token"),
                 ("oidc", "https://actions.githubusercontent.com.evil.example/idtoken"),
                 ("oidc", "https://user:password@pipelines.actions.githubusercontent.com/idtoken"),
                 ("oidc", "https://pipelines.actions.githubusercontent.com:8443/idtoken"),
                 ("oidc", "https://pipelines.actions.githubusercontent.com/idtoken#fragment"),
                 ("oidc", "https://pipelines.actions.githubusercontent.com/other"),
                 ("oidc", " https://pipelines.actions.githubusercontent.com/idtoken")]
        for kind, url in cases:
            with self.subTest(kind=kind, url=url):
                client = probe.HTTPClient()
                with patch.object(client.opener, "open") as opened, self.assertRaises(probe.VerificationError):
                    client.request_json(url, kind=kind, **({"payload": {"token": "secret"}} if kind == "pypi" else {"bearer": GITHUB_SECRET}))
                opened.assert_not_called()

    def test_http_timeout_and_errors_are_sanitized(self):
        for error in (TimeoutError(MINTED_SECRET), HTTPError(probe.MINT, 422, MINTED_SECRET, {}, io.BytesIO(MINTED_SECRET.encode()))):
            client = probe.HTTPClient()
            with patch.object(client.opener, "open", side_effect=error) as opened:
                with self.assertRaises(probe.VerificationError) as raised:
                    client.request_json(probe.MINT, kind="pypi", payload={"token": "oidc-secret"})
                self.assertEqual(str(raised.exception), "service-request-failed")
                self.assertEqual(opened.call_args.kwargs["timeout"], 20)
                self.assertEqual(opened.call_args.args[0].method, "POST")

    def test_redirect_handler_never_forwards_a_credential(self):
        with self.assertRaises(probe.VerificationError):
            probe.NoRedirect().redirect_request(Request(probe.MINT), None, 302, "Found", {}, "https://evil.example")

    def test_response_bounds_status_url_and_duplicate_keys(self):
        for raw, status, url in [(b"x" * (probe.MAX_RESPONSE + 1), 200, probe.MINT),
                                 (b'{"token":"a","token":"b"}', 200, probe.MINT),
                                 (b"{}", 302, probe.MINT), (b"{}", 200, "https://evil.example"),
                                 (b"[]", 200, probe.MINT), (b"invalid-json-secret", 200, probe.MINT)]:
            client = probe.HTTPClient()
            response = unittest.mock.MagicMock()
            response.__enter__.return_value = response
            response.status = status
            response.geturl.return_value = url
            response.read.return_value = raw
            with patch.object(client.opener, "open", return_value=response), self.assertRaises(probe.VerificationError):
                client.request_json(probe.MINT, kind="pypi", payload={"token": "secret"})

    def test_no_proxy_handler_uses_environment_proxy(self):
        with patch.dict("os.environ", {"HTTPS_PROXY": "http://evil.example:8080"}):
            client = probe.HTTPClient()
            self.assertFalse(any(getattr(handler, "proxies", {}) for handler in client.opener.handlers))


class CLITests(unittest.TestCase):
    def test_only_allowlisted_diagnostic_codes_are_printed(self):
        for reason, expected in [("current-main-mismatch", "current-main-mismatch"), (MINTED_SECRET, "verification-refused")]:
            with tempfile.TemporaryDirectory(prefix="publisher-proof-test-") as directory:
                stderr = io.StringIO()
                with patch.object(probe, "verify_publisher", side_effect=probe.VerificationError(reason)), redirect_stderr(stderr):
                    self.assertEqual(probe.main(["--component", "runtime", "--output", str(Path(directory) / "proof.json")]), 1)
                self.assertIn(expected, stderr.getvalue())
                self.assertNotIn(MINTED_SECRET, stderr.getvalue())

    def test_success_receipt_is_new_safe_json_and_existing_file_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="publisher-proof-test-") as directory:
            output = Path(directory) / "receipt.json"
            receipt = probe.verify_publisher("runtime", environment(), FakeClient())
            with patch.object(probe, "verify_publisher", return_value=receipt) as verify, redirect_stdout(io.StringIO()):
                self.assertEqual(probe.main(["--component", "runtime", "--output", str(output)]), 0)
            verify.assert_called_once_with("runtime", audit_only=False)
            self.assertEqual(json.loads(output.read_bytes()), receipt)
            original = output.read_bytes()
            with patch.object(probe, "verify_publisher") as verify, redirect_stderr(io.StringIO()):
                self.assertEqual(probe.main(["--component", "runtime", "--output", str(output)]), 1)
            verify.assert_not_called()
            self.assertEqual(output.read_bytes(), original)

    def test_no_receipt_or_secret_output_on_unexpected_failure(self):
        with tempfile.TemporaryDirectory(prefix="publisher-proof-test-") as directory:
            output = Path(directory) / "receipt.json"
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(probe, "verify_publisher", side_effect=RuntimeError(MINTED_SECRET)), redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(probe.main(["--component", "node", "--output", str(output)]), 1)
            self.assertFalse(output.exists())
            self.assertNotIn(MINTED_SECRET, stdout.getvalue() + stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
