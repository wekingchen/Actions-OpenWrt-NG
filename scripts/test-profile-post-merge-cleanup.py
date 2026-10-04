#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "profile-post-merge-cleanup.py"
WORKFLOW = ROOT / ".github" / "workflows" / "profile-post-merge-cleanup.yml"

spec = importlib.util.spec_from_file_location("profile_post_merge_cleanup", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def event(**overrides):
    value = {
        "number": 57,
        "repository": {
            "full_name": "acme/router",
            "default_branch": "main",
        },
        "pull_request": {
            "number": 57,
            "merged": True,
            "title": "profile(old): delete via Control Plane",
            "body": "由 OpenWrt NG Control Plane 创建。\n\n删除标准 Profile 文件。",
            "head": {
                "ref": "openwrt-ng/profile-old-12345678-abcdef01",
                "repo": {"full_name": "acme/router"},
            },
            "base": {"ref": "main"},
        },
    }
    for key, item in overrides.items():
        if key == "pull_request":
            value["pull_request"].update(item)
        else:
            value[key] = item
    return value


target = module.parse_cleanup_target(event(), "acme/router")
assert target is not None
assert target.profile_id == "old"
assert target.action == "delete"
assert target.pr_number == 57

rename = event(
    pull_request={
        "title": "profile(old): rename to new-name via Control Plane",
    }
)
rename_target = module.parse_cleanup_target(rename, "acme/router")
assert rename_target is not None
assert rename_target.action == "rename"

assert module.parse_cleanup_target(
    event(pull_request={"merged": False}), "acme/router"
) is None
assert module.parse_cleanup_target(
    event(pull_request={"body": "普通 PR"}), "acme/router"
) is None
assert module.parse_cleanup_target(
    event(
        pull_request={
            "head": {
                "ref": "openwrt-ng/profile-old-12345678-abcdef01",
                "repo": {"full_name": "someone/fork"},
            }
        }
    ),
    "acme/router",
) is None
assert module.parse_cleanup_target(
    event(
        pull_request={
            "head": {
                "ref": "openwrt-ng/profile-someone-else-1234-abcd",
                "repo": {"full_name": "acme/router"},
            }
        }
    ),
    "acme/router",
) is None


class FakeApi:
    def __init__(self):
        self.canceled = []
        self.deleted = []
        self.closed = []

    def list_branches(self):
        return [
            "main",
            "openwrt-ng/config-session-aabbccddeeff0011",
            "openwrt-ng/config-session-0011223344556677",
        ]

    def read_session_request(self, branch, request_id):
        if request_id == "aabbccddeeff0011":
            return {"profileId": "old"}
        return {"profileId": "other"}

    def list_config_studio_runs(self):
        return [
            {
                "id": 456,
                "display_title": "Config · resolve · cs:aabbccddeeff0011",
                "status": "in_progress",
            },
            {
                "id": 457,
                "display_title": "Config · catalog · cs:0011223344556677",
                "status": "in_progress",
            },
        ]

    def cancel_run(self, run_id):
        self.canceled.append(run_id)

    def delete_branch(self, branch):
        self.deleted.append(branch)

    def list_open_pulls(self, base_ref):
        assert base_ref == "main"
        return [
            {
                "number": 58,
                "title": "profile(old): update via Control Plane",
                "body": "由 OpenWrt NG Control Plane 创建。\n\n旧 PR",
                "head": {
                    "ref": "openwrt-ng/profile-old-99999999-deadbeef",
                    "repo": {"full_name": "acme/router"},
                },
            },
            {
                "number": 59,
                "title": "profile(other): update via Control Plane",
                "body": "由 OpenWrt NG Control Plane 创建。",
                "head": {
                    "ref": "openwrt-ng/profile-other-99999999-deadbeef",
                    "repo": {"full_name": "acme/router"},
                },
            },
        ]

    def close_pull(self, number):
        self.closed.append(number)


fake = FakeApi()
result = module.cleanup_profile_merge(target, fake, "acme/router")
assert result["sessionsFound"] == 1
assert result["canceledRuns"] == [456]
assert fake.canceled == [456]
assert fake.closed == [58]
assert "openwrt-ng/config-session-aabbccddeeff0011" in fake.deleted
assert "openwrt-ng/profile-old-99999999-deadbeef" in fake.deleted
assert target.head_ref in fake.deleted
assert "openwrt-ng/config-session-0011223344556677" not in fake.deleted

workflow = WORKFLOW.read_text(encoding="utf-8")
assert "pull_request:" in workflow
assert "types: [closed]" in workflow
assert "contents: write" in workflow
assert "actions: write" in workflow
assert "pull-requests: write" in workflow
assert "github.event.pull_request.merged == true" in workflow
assert "scripts/profile-post-merge-cleanup.py" in workflow

print("Profile post-merge cleanup tests passed.")
