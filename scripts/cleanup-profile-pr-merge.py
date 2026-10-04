#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CONFIG_SESSION_RE = re.compile(r"^[0-9a-f]{16}$")
CONTROL_PLANE_BODY_PREFIX = "由 OpenWrt NG Control Plane 创建。"
PROFILE_BRANCH_PREFIX = "openwrt-ng/profile-"
CONFIG_BRANCH_PREFIX = "openwrt-ng/config-session-"
ACTIVE_STATUSES = {"queued", "in_progress", "requested", "waiting", "pending"}

STANDARD_TITLE_RE = re.compile(
    r"^profile\((?P<profile>[A-Za-z0-9][A-Za-z0-9._-]{0,63})\): "
    r"(?P<action>create|copy|restore|delete|update|set-baseline) via Control Plane$"
)
RENAME_TITLE_RE = re.compile(
    r"^profile\((?P<profile>[A-Za-z0-9][A-Za-z0-9._-]{0,63})\): "
    r"rename to (?P<target>[A-Za-z0-9][A-Za-z0-9._-]{0,63}) via Control Plane$"
)


def branch_slug(profile_id: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", str(profile_id))
    slug = re.sub(r"-+", "-", slug).strip("-")[:48]
    return slug or "profile"


def parse_control_plane_pull_request(pull: dict[str, Any]) -> dict[str, Any] | None:
    if pull.get("merged") is not True:
        return None
    body = str(pull.get("body") or "")
    if not body.startswith(CONTROL_PLANE_BODY_PREFIX):
        return None

    head = pull.get("head") or {}
    base = pull.get("base") or {}
    head_ref = str(head.get("ref") or "")
    head_repo = str((head.get("repo") or {}).get("full_name") or "")
    base_repo = str((base.get("repo") or {}).get("full_name") or "")
    if (
        not head_ref.startswith(PROFILE_BRANCH_PREFIX)
        or not head_repo
        or head_repo.lower() != base_repo.lower()
    ):
        return None

    title = str(pull.get("title") or "")
    rename = RENAME_TITLE_RE.fullmatch(title)
    if rename:
        return {
            "action": "rename",
            "profile_id": rename.group("profile"),
            "target_profile_id": rename.group("target"),
            "head_ref": head_ref,
            "base_ref": str(base.get("ref") or ""),
            "number": int(pull.get("number") or 0),
        }

    standard = STANDARD_TITLE_RE.fullmatch(title)
    if not standard:
        return None
    return {
        "action": standard.group("action"),
        "profile_id": standard.group("profile"),
        "target_profile_id": "",
        "head_ref": head_ref,
        "base_ref": str(base.get("ref") or ""),
        "number": int(pull.get("number") or 0),
    }


class GitHubApi:
    def __init__(self, repository: str, token: str) -> None:
        self.repository = repository
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        allow_status: tuple[int, ...] = (),
    ) -> Any:
        url = f"https://api.github.com/repos/{self.repository}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "openwrt-ng-profile-cleanup",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if error.code in allow_status:
                return None
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError(
                f"GitHub API {method} {path} failed: HTTP {error.code} {detail[:500]}"
            ) from error


def ref_path(branch: str) -> str:
    return "/".join(
        urllib.parse.quote(part, safe="")
        for part in ["heads", *str(branch).split("/")]
    )


def delete_branch(api: GitHubApi, branch: str) -> bool:
    api.request("DELETE", f"/git/refs/{ref_path(branch)}", allow_status=(404,))
    return True


def decode_content(payload: Any) -> str:
    if not isinstance(payload, dict) or payload.get("encoding") != "base64":
        return ""
    content = str(payload.get("content") or "").replace("\n", "")
    try:
        return base64.b64decode(content).decode("utf-8")
    except Exception:
        return ""


def cleanup_superseded_profile_prs(
    api: GitHubApi,
    info: dict[str, Any],
    repository: str,
) -> list[int]:
    query = urllib.parse.urlencode(
        {"state": "open", "base": info["base_ref"], "per_page": 100}
    )
    pulls = api.request("GET", f"/pulls?{query}") or []
    prefix = f"{PROFILE_BRANCH_PREFIX}{branch_slug(info['profile_id'])}-"
    closed: list[int] = []

    for pull in pulls if isinstance(pulls, list) else []:
        number = int(pull.get("number") or 0)
        branch = str((pull.get("head") or {}).get("ref") or "")
        head_repo = str(
            ((pull.get("head") or {}).get("repo") or {}).get("full_name") or ""
        )
        title = str(pull.get("title") or "")
        body = str(pull.get("body") or "")
        if (
            number <= 0
            or number == info["number"]
            or not branch.startswith(prefix)
            or head_repo.lower() != repository.lower()
            or not title.startswith(f"profile({info['profile_id']}): ")
            or not body.startswith(CONTROL_PLANE_BODY_PREFIX)
        ):
            continue
        api.request("PATCH", f"/pulls/{number}", {"state": "closed"})
        delete_branch(api, branch)
        closed.append(number)

    return closed


def cleanup_config_sessions(api: GitHubApi, profile_id: str) -> dict[str, Any]:
    refs = api.request(
        "GET",
        "/git/matching-refs/heads/openwrt-ng/config-session-",
        allow_status=(404,),
    ) or []
    runs_body = api.request(
        "GET",
        "/actions/workflows/config-studio.yml/runs?event=workflow_dispatch&per_page=100",
        allow_status=(404,),
    ) or {}
    runs = runs_body.get("workflow_runs", []) if isinstance(runs_body, dict) else []

    result = {
        "sessions_found": 0,
        "branches_deleted": 0,
        "canceled_runs": [],
    }

    for ref in refs if isinstance(refs, list) else []:
        full_ref = str(ref.get("ref") or "")
        marker = "refs/heads/" + CONFIG_BRANCH_PREFIX
        if not full_ref.startswith(marker):
            continue
        request_id = full_ref[len(marker):]
        if not CONFIG_SESSION_RE.fullmatch(request_id):
            continue
        branch = CONFIG_BRANCH_PREFIX + request_id
        path = (
            f"/contents/.openwrt-ng/config-studio/{request_id}/request.json?"
            + urllib.parse.urlencode({"ref": branch})
        )
        payload = api.request("GET", path, allow_status=(404,))
        if payload is None:
            continue
        try:
            request_data = json.loads(decode_content(payload))
        except json.JSONDecodeError:
            continue
        if str(request_data.get("profileId") or "") != profile_id:
            continue

        result["sessions_found"] += 1
        for run in runs if isinstance(runs, list) else []:
            title = str(run.get("display_title") or run.get("name") or "")
            status = str(run.get("status") or "")
            run_id = int(run.get("id") or 0)
            if (
                run_id > 0
                and f"cs:{request_id}" in title
                and status in ACTIVE_STATUSES
            ):
                api.request(
                    "POST",
                    f"/actions/runs/{run_id}/cancel",
                    allow_status=(409,),
                )
                result["canceled_runs"].append(run_id)

        delete_branch(api, branch)
        result["branches_deleted"] += 1

    return result


def reconcile(event: dict[str, Any], api: GitHubApi) -> dict[str, Any]:
    pull = event.get("pull_request") or {}
    info = parse_control_plane_pull_request(pull)
    if info is None:
        return {"matched": False}

    repository = str((event.get("repository") or {}).get("full_name") or "")
    if not repository:
        raise RuntimeError("missing repository.full_name in pull_request event")

    delete_branch(api, info["head_ref"])
    superseded = cleanup_superseded_profile_prs(api, info, repository)
    sessions = {
        "sessions_found": 0,
        "branches_deleted": 0,
        "canceled_runs": [],
    }
    if info["action"] in {"delete", "rename"}:
        sessions = cleanup_config_sessions(api, info["profile_id"])

    return {
        "matched": True,
        "action": info["action"],
        "profile_id": info["profile_id"],
        "head_branch_deleted": True,
        "superseded_pull_requests": superseded,
        "config_studio": sessions,
    }


def append_summary(result: dict[str, Any]) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as handle:
        handle.write("## Profile 生命周期补偿清理\n\n")
        if not result.get("matched"):
            handle.write("本次 PR 不是 Control Plane Profile PR，无需处理。\n")
            return
        handle.write(f"- 操作：{result['action']}\n")
        handle.write(f"- Profile：{result['profile_id']}\n")
        handle.write("- 本次 Profile 临时分支：已清理\n")
        handle.write(
            f"- 被取代的旧 PR：{len(result['superseded_pull_requests'])} 个\n"
        )
        sessions = result["config_studio"]
        handle.write(
            f"- Config Studio 会话：发现 {sessions['sessions_found']} 个，"
            f"清理 {sessions['branches_deleted']} 个\n"
        )
        handle.write(
            f"- 取消仍在运行的 Config Studio Action："
            f"{len(sessions['canceled_runs'])} 个\n"
        )


def main() -> int:
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not event_path or not repository or not token:
        raise RuntimeError(
            "GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GITHUB_TOKEN are required"
        )
    event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    result = reconcile(event, GitHubApi(repository, token))
    append_summary(result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
