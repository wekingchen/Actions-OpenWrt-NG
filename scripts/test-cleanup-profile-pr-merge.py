#!/usr/bin/env python3
from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).with_name("cleanup-profile-pr-merge.py")
spec = importlib.util.spec_from_file_location("cleanup_profile_pr_merge", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def event_for(title, *, merged=True, body=None, head_ref=None):
    return {
        "repository": {"full_name": "acme/router"},
        "pull_request": {
            "number": 57,
            "merged": merged,
            "title": title,
            "body": (
                module.CONTROL_PLANE_BODY_PREFIX + "\n\nAudit"
                if body is None
                else body
            ),
            "head": {
                "ref": head_ref or "openwrt-ng/profile-default-123-abc",
                "repo": {"full_name": "acme/router"},
            },
            "base": {
                "ref": "main",
                "repo": {"full_name": "acme/router"},
            },
        },
    }


parsed = module.parse_control_plane_pull_request(
    event_for("profile(default): rename to renamed via Control Plane")["pull_request"]
)
assert parsed["action"] == "rename"
assert parsed["profile_id"] == "default"
assert parsed["target_profile_id"] == "renamed"

assert module.parse_control_plane_pull_request(
    event_for("profile(default): delete via Control Plane", merged=False)["pull_request"]
) is None
assert module.parse_control_plane_pull_request(
    event_for(
        "profile(default): delete via Control Plane",
        body="manual pull request",
    )["pull_request"]
) is None
assert module.branch_slug("foo.bar/baz") == "foo-bar-baz"


class FakeApi:
    def __init__(self):
        self.calls = []

    def request(self, method, path, body=None, allow_status=()):
        self.calls.append((method, path, body))
        if method == "GET" and path.startswith("/pulls?"):
            return [
                {
                    "number": 41,
                    "title": "profile(default): update via Control Plane",
                    "body": module.CONTROL_PLANE_BODY_PREFIX + "\n\nold",
                    "head": {
                        "ref": "openwrt-ng/profile-default-111-old",
                        "repo": {"full_name": "acme/router"},
                    },
                },
                {
                    "number": 42,
                    "title": "manual",
                    "body": "manual",
                    "head": {
                        "ref": "feature/manual",
                        "repo": {"full_name": "acme/router"},
                    },
                },
            ]
        if method == "GET" and path == (
            "/git/matching-refs/heads/openwrt-ng/config-session-"
        ):
            return [
                {"ref": "refs/heads/openwrt-ng/config-session-aabbccddeeff0011"},
                {"ref": "refs/heads/openwrt-ng/config-session-1122334455667788"},
            ]
        if method == "GET" and path.startswith(
            "/actions/workflows/config-studio.yml/runs?"
        ):
            return {
                "workflow_runs": [
                    {
                        "id": 456,
                        "display_title": "Config · catalog · cs:aabbccddeeff0011",
                        "status": "in_progress",
                    },
                    {
                        "id": 457,
                        "display_title": "Config · catalog · cs:1122334455667788",
                        "status": "completed",
                    },
                ]
            }
        if method == "GET" and "/request.json?" in path:
            request_id = path.split("/config-studio/", 1)[1].split("/", 1)[0]
            profile_id = "default" if request_id == "aabbccddeeff0011" else "other"
            raw = json.dumps({"profileId": profile_id}).encode()
            return {
                "encoding": "base64",
                "content": base64.b64encode(raw).decode(),
            }
        return None


api = FakeApi()
result = module.reconcile(
    event_for("profile(default): rename to renamed via Control Plane"),
    api,
)
assert result["matched"] is True
assert result["action"] == "rename"
assert result["superseded_pull_requests"] == [41]
assert result["config_studio"]["sessions_found"] == 1
assert result["config_studio"]["branches_deleted"] == 1
assert result["config_studio"]["canceled_runs"] == [456]

calls = api.calls
assert any(
    method == "DELETE"
    and "heads/openwrt-ng/profile-default-123-abc" in path
    for method, path, _ in calls
)
assert any(
    method == "PATCH" and path == "/pulls/41" and body == {"state": "closed"}
    for method, path, body in calls
)
assert any(
    method == "POST" and path == "/actions/runs/456/cancel"
    for method, path, _ in calls
)
assert any(
    method == "DELETE"
    and "heads/openwrt-ng/config-session-aabbccddeeff0011" in path
    for method, path, _ in calls
)

copy_api = FakeApi()
copy_result = module.reconcile(
    event_for(
        "profile(copy-target): copy via Control Plane",
        head_ref="openwrt-ng/profile-copy-target-123-abc",
    ),
    copy_api,
)
assert copy_result["matched"] is True
assert copy_result["action"] == "copy"
assert copy_result["config_studio"]["sessions_found"] == 0
assert not any(
    "/git/matching-refs/heads/openwrt-ng/config-session-" in path
    for _, path, _ in copy_api.calls
)

print("Profile PR manual-merge cleanup tests passed.")
