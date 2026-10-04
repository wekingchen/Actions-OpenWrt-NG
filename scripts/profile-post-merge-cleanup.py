#!/usr/bin/env python3
"""Cleanup Control Plane profile lifecycle leftovers after a PR is merged.

This is a compensating path for Profile PRs that are merged after the
Control Plane request returns, including after-checks auto-merge and manual
review. It acts only on same-repository signed Control Plane Profile PRs.
Delete/rename additionally clean associated Config Studio sessions.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

API_ROOT = "https://api.github.com"
API_VERSION = "2022-11-28"
CONTROL_PLANE_SIGNATURE = "由 OpenWrt NG Control Plane 创建。"
PROFILE_ID = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
STANDARD_TITLE_RE = re.compile(
    rf"^profile\(({PROFILE_ID})\): "
    r"(create|copy|restore|delete|update|set-baseline) via Control Plane$"
)
RENAME_TITLE_RE = re.compile(
    rf"^profile\(({PROFILE_ID})\): rename to ({PROFILE_ID}) via Control Plane$"
)
SESSION_BRANCH_PREFIX = "openwrt-ng/config-session-"
SESSION_ID_RE = re.compile(r"^[0-9a-f]{16}$")
ACTIVE_RUN_STATUSES = {"queued", "in_progress", "requested", "waiting", "pending"}


def branch_slug(profile_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", str(profile_id))
    slug = re.sub(r"-+", "-", slug).strip("-")[:48]
    return slug or "profile"


@dataclass(frozen=True)
class CleanupTarget:
    profile_id: str
    action: str
    head_ref: str
    base_ref: str
    pr_number: int


def parse_cleanup_target(event: dict[str, Any], repository: str) -> CleanupTarget | None:
    pull = event.get("pull_request") or {}
    repo = event.get("repository") or {}

    if pull.get("merged") is not True:
        return None

    head = pull.get("head") or {}
    base = pull.get("base") or {}
    head_repo = head.get("repo") or {}
    head_ref = str(head.get("ref") or "")
    base_ref = str(base.get("ref") or "")
    default_branch = str(repo.get("default_branch") or "")

    if str(head_repo.get("full_name") or "").lower() != repository.lower():
        return None
    if not head_ref.startswith("openwrt-ng/profile-"):
        return None
    if default_branch and base_ref != default_branch:
        return None
    if not str(pull.get("body") or "").startswith(CONTROL_PLANE_SIGNATURE):
        return None

    title = str(pull.get("title") or "")
    match = RENAME_TITLE_RE.fullmatch(title)
    if match:
        action = "rename"
        profile_id = match.group(1)
    else:
        match = STANDARD_TITLE_RE.fullmatch(title)
        if not match:
            return None
        profile_id = match.group(1)
        action = match.group(2)
    expected_prefix = f"openwrt-ng/profile-{branch_slug(profile_id)}-"
    if not head_ref.startswith(expected_prefix):
        return None

    number = int(pull.get("number") or event.get("number") or 0)
    if number <= 0:
        return None

    return CleanupTarget(
        profile_id=profile_id,
        action=action,
        head_ref=head_ref,
        base_ref=base_ref,
        pr_number=number,
    )


class GitHubApi:
    def __init__(self, repository: str, token: str):
        if "/" not in repository:
            raise ValueError("repository must be owner/name")
        if not token:
            raise ValueError("GITHUB_TOKEN is required")
        self.repository = repository
        self.token = token

    def _request(
        self,
        method: str,
        path_or_url: str,
        body: dict[str, Any] | None = None,
        *,
        allow_status: set[int] | None = None,
    ) -> tuple[Any, dict[str, str], int]:
        url = (
            path_or_url
            if path_or_url.startswith("https://")
            else API_ROOT + path_or_url
        )
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "OpenWrt-NG-Profile-Post-Merge-Cleanup",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"

        request = Request(url, method=method, headers=headers, data=payload)
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                parsed = json.loads(raw) if raw else None
                return parsed, dict(response.headers.items()), response.status
        except HTTPError as error:
            if allow_status and error.code in allow_status:
                raw = error.read()
                parsed = json.loads(raw) if raw else None
                return parsed, dict(error.headers.items()), error.code
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError(
                f"GitHub API {method} {path_or_url} failed: HTTP {error.code} {detail}"
            ) from error

    @staticmethod
    def _next_link(headers: dict[str, str]) -> str:
        link = headers.get("Link") or headers.get("link") or ""
        for item in link.split(","):
            if 'rel="next"' not in item:
                continue
            match = re.search(r"<([^>]+)>", item)
            if match:
                return match.group(1)
        return ""

    def _paginate_list(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        url = path
        while url:
            body, headers, _ = self._request("GET", url)
            if not isinstance(body, list):
                raise RuntimeError(f"Expected list from GitHub API: {url}")
            items.extend(item for item in body if isinstance(item, dict))
            url = self._next_link(headers)
        return items

    def _paginate_key(self, path: str, key: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        url = path
        while url:
            body, headers, _ = self._request("GET", url)
            page = body.get(key, []) if isinstance(body, dict) else []
            items.extend(item for item in page if isinstance(item, dict))
            url = self._next_link(headers)
        return items

    def list_branches(self) -> list[str]:
        path = f"/repos/{self.repository}/branches?per_page=100"
        return [
            str(item.get("name") or "")
            for item in self._paginate_list(path)
            if item.get("name")
        ]

    def read_session_request(self, branch: str, request_id: str) -> dict[str, Any] | None:
        content_path = (
            f".openwrt-ng/config-studio/{request_id}/request.json"
        )
        query = urlencode({"ref": branch})
        path = (
            f"/repos/{self.repository}/contents/"
            f"{quote(content_path, safe='/')}?{query}"
        )
        body, _, status = self._request("GET", path, allow_status={404})
        if status == 404:
            return None
        if not isinstance(body, dict):
            return None
        encoded = str(body.get("content") or "").replace("\n", "")
        if body.get("encoding") != "base64" or not encoded:
            return None
        try:
            return json.loads(base64.b64decode(encoded).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def list_config_studio_runs(self) -> list[dict[str, Any]]:
        path = (
            f"/repos/{self.repository}/actions/workflows/config-studio.yml/"
            "runs?event=workflow_dispatch&per_page=100"
        )
        return self._paginate_key(path, "workflow_runs")

    def cancel_run(self, run_id: int) -> None:
        self._request(
            "POST",
            f"/repos/{self.repository}/actions/runs/{run_id}/cancel",
            allow_status={409},
        )

    @staticmethod
    def _ref_path(branch: str) -> str:
        return "/".join(quote(part, safe="") for part in ("heads", *branch.split("/")))

    def delete_branch(self, branch: str) -> None:
        self._request(
            "DELETE",
            f"/repos/{self.repository}/git/refs/{self._ref_path(branch)}",
            allow_status={404, 422},
        )

    def list_open_pulls(self, base_ref: str) -> list[dict[str, Any]]:
        query = urlencode({"state": "open", "base": base_ref, "per_page": 100})
        return self._paginate_list(f"/repos/{self.repository}/pulls?{query}")

    def close_pull(self, number: int) -> None:
        self._request(
            "PATCH",
            f"/repos/{self.repository}/pulls/{number}",
            {"state": "closed"},
        )


def cleanup_profile_merge(
    target: CleanupTarget,
    api: Any,
    repository: str,
) -> dict[str, Any]:
    sessions: list[tuple[str, str]] = []
    canceled_runs: list[int] = []
    deleted_session_branches: list[str] = []

    if target.action in {"delete", "rename"}:
        for branch in api.list_branches():
            if not branch.startswith(SESSION_BRANCH_PREFIX):
                continue
            request_id = branch[len(SESSION_BRANCH_PREFIX):]
            if not SESSION_ID_RE.fullmatch(request_id):
                continue
            request = api.read_session_request(branch, request_id)
            if str((request or {}).get("profileId") or "") == target.profile_id:
                sessions.append((request_id, branch))

        runs = api.list_config_studio_runs() if sessions else []
        for request_id, branch in sessions:
            marker = f"cs:{request_id}"
            for run in runs:
                title = str(run.get("display_title") or run.get("name") or "")
                status = str(run.get("status") or "")
                run_id = int(run.get("id") or 0)
                if marker in title and status in ACTIVE_RUN_STATUSES and run_id > 0:
                    api.cancel_run(run_id)
                    canceled_runs.append(run_id)

            api.delete_branch(branch)
            deleted_session_branches.append(branch)

    profile_prefix = (
        f"openwrt-ng/profile-{branch_slug(target.profile_id)}-"
    )
    superseded_pulls: list[int] = []
    superseded_branches: list[str] = []
    for pull in api.list_open_pulls(target.base_ref):
        number = int(pull.get("number") or 0)
        if number <= 0 or number == target.pr_number:
            continue
        head = pull.get("head") or {}
        head_repo = head.get("repo") or {}
        branch = str(head.get("ref") or "")
        title = str(pull.get("title") or "")
        body = str(pull.get("body") or "")
        if (
            str(head_repo.get("full_name") or "").lower() != repository.lower()
            or not branch.startswith(profile_prefix)
            or not title.startswith(f"profile({target.profile_id}): ")
            or not body.startswith(CONTROL_PLANE_SIGNATURE)
        ):
            continue

        api.close_pull(number)
        superseded_pulls.append(number)
        api.delete_branch(branch)
        superseded_branches.append(branch)

    api.delete_branch(target.head_ref)

    return {
        "profileId": target.profile_id,
        "action": target.action,
        "pullRequest": target.pr_number,
        "sessionsFound": len(sessions),
        "canceledRuns": canceled_runs,
        "deletedSessionBranches": deleted_session_branches,
        "supersededPullRequests": superseded_pulls,
        "supersededBranches": superseded_branches,
        "mergedProfileBranch": target.head_ref,
    }


def write_summary(result: dict[str, Any]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if not path:
        return
    lines = [
        "## Control Plane Profile 合并后清理",
        "",
        f"- Profile: `{result['profileId']}`",
        f"- 动作: `{result['action']}`",
        f"- Pull Request: #{result['pullRequest']}",
        f"- Config Studio 会话: {result['sessionsFound']}",
        f"- 已取消 Action: {len(result['canceledRuns'])}",
        f"- 已清理会话分支: {len(result['deletedSessionBranches'])}",
        f"- 已关闭过期 PR: {len(result['supersededPullRequests'])}",
        "- 本次 Profile 临时分支已请求清理。",
        "",
    ]
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    args = parser.parse_args()

    repository = args.repository.strip()
    if not repository:
        print("ERROR: repository is required", file=sys.stderr)
        return 2

    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    target = parse_cleanup_target(event, repository)
    if target is None:
        print("跳过：不是需要补偿清理的 Control Plane Profile 合并事件。")
        return 0

    api = GitHubApi(repository, os.environ.get("GITHUB_TOKEN", ""))
    result = cleanup_profile_merge(target, api, repository)
    write_summary(result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
