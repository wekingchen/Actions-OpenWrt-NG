#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

API_ROOT = "https://api.github.com"

FRAMEWORK_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward GitHub bearer credentials to signed artifact hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            return None

        old_host = urllib.parse.urlparse(req.full_url).netloc.lower()
        new_host = urllib.parse.urlparse(newurl).netloc.lower()
        if old_host != new_host:
            for store in (redirected.headers, redirected.unredirected_hdrs):
                for key in list(store):
                    if key.lower() == "authorization":
                        del store[key]
        return redirected
PROFILE_KEYS = (
    "PROFILE_NAME",
    "SOURCE_REPO",
    "SOURCE_BRANCH",
    "ADAPTER",
    "AUTO_UPDATE",
    "UPLOAD_RELEASE",
)


def framework_version(root: Path) -> str:
    path = root / "VERSION"
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError(f"framework VERSION is unavailable: {path}") from error
    if not FRAMEWORK_VERSION_RE.fullmatch(value):
        raise RuntimeError(
            f"framework VERSION must use MAJOR.MINOR.PATCH: {value!r}"
        )
    return value


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def duration_seconds(start: str | None, end: str | None) -> int | None:
    start_dt = parse_time(start)
    end_dt = parse_time(end)
    if not start_dt or not end_dt:
        return None
    return max(0, int((end_dt - start_dt).total_seconds()))


def env_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError(f"expected true/false, got {value!r}")


def short_repo(url: str | None) -> str | None:
    if not url:
        return None
    value = url.removesuffix(".git").rstrip("/")
    if value.startswith("git@github.com:"):
        return value.split(":", 1)[1]
    try:
        parsed = urllib.parse.urlparse(value)
        if parsed.hostname:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2:
                return "/".join(parts[-2:])
    except ValueError:
        pass
    return value


class GitHub:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token
        self.opener = urllib.request.build_opener(SafeRedirectHandler())

    def _request(self, path: str, *, accept: str = "application/vnd.github+json") -> bytes:
        url = path if path.startswith("https://") else API_ROOT + path
        headers = {
            "Accept": accept,
            "User-Agent": "Actions-OpenWrt-NG-Dashboard",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"GitHub API {exc.code} for {path}: {detail}") from exc

    def json(self, path: str) -> Any:
        return json.loads(self._request(path).decode("utf-8"))

    def bytes(self, path: str) -> bytes:
        # GitHub's artifact download endpoint currently requires the standard
        # API media type and then redirects to the ZIP object URL.
        return self._request(path)

    def repo_path(self, suffix: str) -> str:
        return f"/repos/{self.repository}{suffix}"


def read_profile(profile_file: Path) -> dict[str, str]:
    shell = r"""
set -Eeuo pipefail
source "$1"
printf '%s\0' \
  "${PROFILE_NAME:-}" \
  "${SOURCE_REPO:-}" \
  "${SOURCE_BRANCH:-}" \
  "${ADAPTER:-}" \
  "${AUTO_UPDATE:-}" \
  "${UPLOAD_RELEASE:-}"
"""
    proc = subprocess.run(
        ["bash", "-c", shell, "_", str(profile_file)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    values = proc.stdout.decode("utf-8", errors="strict").split("\0")
    if values and values[-1] == "":
        values.pop()
    if len(values) != len(PROFILE_KEYS):
        raise RuntimeError(f"cannot parse profile: {profile_file}")
    return dict(zip(PROFILE_KEYS, values, strict=True))


def resolve_baseline_profile(root: Path, profile_ids: list[str]) -> str | None:
    if not profile_ids:
        return None

    marker = root / "profiles" / ".baseline"
    if marker.is_file():
        baseline = marker.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", baseline):
            raise RuntimeError(f"invalid baseline Profile: {baseline!r}")
        if baseline not in profile_ids:
            raise RuntimeError(f"baseline Profile does not exist: {baseline}")
        return baseline

    if "default" in profile_ids:
        return "default"
    return sorted(profile_ids)[0]


def load_profiles(root: Path) -> list[dict[str, Any]]:
    profiles = []
    for profile_file in sorted((root / "profiles").glob("*/profile.env")):
        profile_id = profile_file.parent.name
        if not re.fullmatch(r"[A-Za-z0-9._-]+", profile_id):
            raise RuntimeError(f"invalid profile id: {profile_id}")
        values = read_profile(profile_file)
        profiles.append(
            {
                "id": profile_id,
                "name": values["PROFILE_NAME"] or profile_id,
                "source_repo": values["SOURCE_REPO"],
                "source_branch": values["SOURCE_BRANCH"],
                "adapter": values["ADAPTER"],
                "auto_update": env_bool(values["AUTO_UPDATE"], False),
                "upload_release": env_bool(values["UPLOAD_RELEASE"], True),
            }
        )

    baseline = resolve_baseline_profile(root, [profile["id"] for profile in profiles])
    for profile in profiles:
        profile["baseline"] = profile["id"] == baseline
    return profiles


def artifact_record(gh: GitHub, run_id: int) -> tuple[str | None, dict[str, str]]:
    data = gh.json(gh.repo_path(f"/actions/runs/{run_id}/artifacts?per_page=100"))
    artifacts = data.get("artifacts", [])
    record = next(
        (
            item
            for item in artifacts
            if item.get("name", "").startswith("OpenWrt_config_record_")
            and not item.get("expired", False)
        ),
        None,
    )
    if not record:
        return None, {}

    name = record["name"]
    remainder = name[len("OpenWrt_config_record_"):]
    match = re.match(r"(.+)_([0-9]{12})$", remainder)
    profile_id = match.group(1) if match else None

    try:
        raw = gh.bytes(gh.repo_path(f"/actions/artifacts/{record['id']}/zip"))
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = {Path(name).name: name for name in archive.namelist()}
            info: dict[str, str] = {}
            if "build-info.txt" in names:
                text = archive.read(names["build-info.txt"]).decode("utf-8", errors="replace")
                for line in text.splitlines():
                    if "=" in line:
                        key, value = line.split("=", 1)
                        info[key.strip()] = value.strip()
            if "config-stats.env" in names:
                text = archive.read(names["config-stats.env"]).decode("utf-8", errors="replace")
                for line in text.splitlines():
                    if "=" in line:
                        key, value = line.split("=", 1)
                        info[key.strip().lower()] = value.strip()
            return profile_id, info
    except Exception as exc:
        print(f"warning: cannot read config record for run {run_id}: {exc}", file=sys.stderr)
        return profile_id, {}


def build_job_summary(gh: GitHub, run_id: int) -> dict[str, Any]:
    try:
        data = gh.json(gh.repo_path(f"/actions/runs/{run_id}/jobs?per_page=100"))
    except Exception as exc:
        print(f"warning: cannot read jobs for run {run_id}: {exc}", file=sys.stderr)
        return {
            "conclusion": None,
            "succeeded": False,
            "duration_seconds": None,
        }

    job = next(
        (job for job in data.get("jobs", []) if job.get("name") == "编译 OpenWrt 固件"),
        None,
    )
    if not job:
        return {
            "conclusion": None,
            "succeeded": False,
            "duration_seconds": None,
        }

    conclusion = job.get("conclusion")
    return {
        "conclusion": conclusion,
        "succeeded": conclusion == "success",
        "duration_seconds": duration_seconds(
            job.get("started_at"),
            job.get("completed_at"),
        ),
    }


def load_builds(
    gh: GitHub,
    profiles: list[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    encoded = urllib.parse.quote("build-openwrt.yml", safe="")
    data = gh.json(
        gh.repo_path(
            f"/actions/workflows/{encoded}/runs?per_page={max(1, min(limit, 50))}"
        )
    )
    known_profiles = {item["id"] for item in profiles}
    only_profile = profiles[0]["id"] if len(profiles) == 1 else None
    builds = []

    for run in data.get("workflow_runs", [])[:limit]:
        run_id = int(run["id"])
        profile_id, info = artifact_record(gh, run_id)
        if profile_id not in known_profiles:
            profile_id = info.get("profile") if info.get("profile") in known_profiles else None
        if not profile_id:
            title = run.get("display_title") or ""
            match = re.search(r"(?:Build|Profile)\s*[·:]\s*([A-Za-z0-9._-]+)", title)
            if match and match.group(1) in known_profiles:
                profile_id = match.group(1)
        if not profile_id:
            profile_id = only_profile or "unknown"

        status = run.get("conclusion") or run.get("status") or "unknown"
        build_job = build_job_summary(gh, run_id)
        build_duration = build_job["duration_seconds"]
        if build_duration is None:
            build_duration = duration_seconds(
                run.get("run_started_at") or run.get("created_at"),
                run.get("updated_at"),
            )

        builds.append(
            {
                "run_id": run_id,
                "run_number": run.get("run_number"),
                "profile": profile_id,
                "status": status,
                "build_conclusion": build_job["conclusion"],
                "build_succeeded": build_job["succeeded"],
                "event": run.get("event"),
                "repository_commit": run.get("head_sha"),
                "commit": info.get("source_commit"),
                "source_repo": info.get("source_repo"),
                "source": short_repo(info.get("source_repo")),
                "branch": info.get("source_branch"),
                "adapter": info.get("adapter"),
                "duration_seconds": build_duration,
                "created_at": run.get("created_at"),
                "updated_at": run.get("updated_at"),
                "config": {
                    "changed": int(info["config_changed"]) if info.get("config_changed", "").isdigit() else None,
                    "added": int(info["config_added"]) if info.get("config_added", "").isdigit() else None,
                    "removed": int(info["config_removed"]) if info.get("config_removed", "").isdigit() else None,
                    "sha256": info.get("final_config_sha256"),
                },
                "url": run.get("html_url"),
            }
        )
    return builds


def resolve_git_ref(repo: str, ref: str) -> str | None:
    if not repo or not ref:
        return None
    candidates = [f"refs/heads/{ref}", f"refs/tags/{ref}^{{}}", f"refs/tags/{ref}"]
    for candidate in candidates:
        try:
            proc = subprocess.run(
                ["git", "ls-remote", "--exit-code", repo, candidate],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            print(
                f"warning: git ls-remote timed out for {repo} @ {ref}",
                file=sys.stderr,
            )
            return None
        if proc.returncode != 0:
            continue
        for line in proc.stdout.splitlines():
            sha = line.split(maxsplit=1)[0]
            if re.fullmatch(r"[0-9a-fA-F]{40,64}", sha):
                return sha.lower()
    return None


def attach_profile_status(
    profiles: list[dict[str, Any]],
    builds: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    result = []
    for profile in profiles:
        item = dict(profile)
        matching = [build for build in builds if build["profile"] == profile["id"]]
        latest = matching[0] if matching else None
        latest_success = next(
            (build for build in matching if build.get("build_succeeded") is True),
            None,
        )

        item["last_build_status"] = latest["status"] if latest else "unknown"
        item["last_build_url"] = latest["url"] if latest else None
        item["last_build_at"] = latest["created_at"] if latest else None
        item["last_commit"] = latest_success.get("commit") if latest_success else None
        result.append(item)
    return result


def load_update_status(
    profiles: list[dict[str, Any]],
    builds: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    statuses = []
    for profile in profiles:
        matching = [
            build
            for build in builds
            if build["profile"] == profile["id"]
            and build.get("build_succeeded") is True
            and build.get("commit")
        ]
        last_built = matching[0]["commit"] if matching else None
        try:
            current = resolve_git_ref(profile["source_repo"], profile["source_branch"])
        except Exception as exc:
            print(f"warning: cannot resolve upstream for {profile['id']}: {exc}", file=sys.stderr)
            current = None

        if current and last_built:
            changed: bool | None = current != last_built
            state = "update_available" if changed else "up_to_date"
        else:
            changed = None
            state = "unknown"

        statuses.append(
            {
                "profile": profile["id"],
                "state": state,
                "changed": changed,
                "commit": current,
                "last_built_commit": last_built,
                "checked_at": iso_now(),
            }
        )
    return statuses


def load_releases(gh: GitHub, limit: int) -> list[dict[str, Any]]:
    releases = gh.json(gh.repo_path(f"/releases?per_page={max(1, min(limit, 50))}"))
    result = []
    for release in releases[:limit]:
        assets = [
            {
                "name": asset.get("name"),
                "size": asset.get("size"),
                "download_count": asset.get("download_count"),
                "download_url": asset.get("browser_download_url"),
            }
            for asset in release.get("assets", [])
        ]
        result.append(
            {
                "tag": release.get("tag_name"),
                "published_at": release.get("published_at"),
                "url": release.get("html_url"),
                "assets": assets,
            }
        )
    return result


def load_latest_update_run(gh: GitHub) -> dict[str, Any] | None:
    encoded = urllib.parse.quote("update-checker.yml", safe="")
    try:
        data = gh.json(gh.repo_path(f"/actions/workflows/{encoded}/runs?per_page=1"))
    except Exception as exc:
        print(f"warning: cannot read Update Checker runs: {exc}", file=sys.stderr)
        return None
    runs = data.get("workflow_runs", [])
    if not runs:
        return None
    run = runs[0]
    return {
        "run_id": run.get("id"),
        "status": run.get("conclusion") or run.get("status"),
        "created_at": run.get("created_at"),
        "url": run.get("html_url"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Export OpenWrt NG dashboard data")
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--output", default="dashboard/data/status.json")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--releases", type=int, default=10)
    args = parser.parse_args()

    if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repository):
        parser.error("--repository must be owner/repo")

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token:
        print("warning: GITHUB_TOKEN is empty; API rate limits will be lower", file=sys.stderr)

    root = Path(__file__).resolve().parents[2]
    output = (root / args.output).resolve()
    try:
        output.relative_to(root)
    except ValueError as exc:
        raise SystemExit("output must stay inside repository") from exc

    gh = GitHub(args.repository, token)
    repo = gh.json(gh.repo_path(""))
    profiles = load_profiles(root)
    builds = load_builds(gh, profiles, max(1, args.runs))
    profiles = attach_profile_status(profiles, builds)
    updates = load_update_status(profiles, builds)
    releases = load_releases(gh, max(1, args.releases))

    latest_build = builds[0] if builds else None
    if latest_build:
        profile = next(
            (profile for profile in profiles if profile["id"] == latest_build["profile"]),
            None,
        )
        latest_build = dict(latest_build)
        latest_build["profile_name"] = profile["name"] if profile else latest_build["profile"]
        if not latest_build.get("source"):
            latest_build["source"] = short_repo(profile.get("source_repo")) if profile else None
        if not latest_build.get("branch"):
            latest_build["branch"] = profile.get("source_branch") if profile else None

    data = {
        "schema_version": 1,
        "generated_at": iso_now(),
        "repository": {
            "name": repo.get("name"),
            "full_name": repo.get("full_name"),
            "html_url": repo.get("html_url"),
            "actions_url": f"{repo.get('html_url')}/actions",
            "releases_url": f"{repo.get('html_url')}/releases",
            "default_branch": repo.get("default_branch"),
            "is_template": repo.get("is_template", False),
            "version": f"V{framework_version(root)}",
            "baseline_profile": next(
                (profile["id"] for profile in profiles if profile.get("baseline")),
                None,
            ),
        },
        "latest_build": latest_build,
        "profiles": profiles,
        "latest_builds": builds,
        "latest_releases": releases,
        "update_status": updates,
        "latest_update_run": load_latest_update_run(gh),
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

    print(
        "Dashboard data exported: "
        f"profiles={len(profiles)} builds={len(builds)} releases={len(releases)} "
        f"output={output.relative_to(root)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
