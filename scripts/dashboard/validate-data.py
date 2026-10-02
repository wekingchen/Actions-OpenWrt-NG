#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SHA_RE = re.compile(r"[0-9a-f]{40,64}")
SECRET_PATTERNS = (
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}", re.IGNORECASE),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}", re.IGNORECASE),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]+", re.IGNORECASE),
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate OpenWrt NG dashboard data")
    parser.add_argument("--repository", required=True, help="Expected owner/repo")
    parser.add_argument("--path", default="dashboard/data/status.json")
    args = parser.parse_args()

    path = Path(args.path)
    data = json.loads(path.read_text(encoding="utf-8"))

    required = {
        "schema_version",
        "generated_at",
        "repository",
        "latest_build",
        "profiles",
        "latest_builds",
        "latest_releases",
        "update_status",
    }
    missing = sorted(required - data.keys())
    if missing:
        raise SystemExit(f"missing dashboard fields: {missing}")

    if data["schema_version"] != 1:
        raise SystemExit("unexpected dashboard schema version")

    for key in ("profiles", "latest_builds", "latest_releases", "update_status"):
        if not isinstance(data[key], list):
            raise SystemExit(f"{key} must be a list")

    raw = path.read_text(encoding="utf-8")
    for pattern in SECRET_PATTERNS:
        if pattern.search(raw):
            raise SystemExit(f"possible secret leaked into dashboard data: {pattern.pattern}")

    repository = data.get("repository") or {}
    if repository.get("full_name") != args.repository:
        raise SystemExit(
            f"unexpected repository: {repository.get('full_name')!r}, expected {args.repository!r}"
        )

    latest_build = data.get("latest_build")
    if latest_build and latest_build.get("status") == "success":
        source_commit = latest_build.get("commit")
        if not SHA_RE.fullmatch(source_commit or ""):
            raise SystemExit(
                f"successful latest build is missing source commit: {source_commit!r}"
            )

    profile_ids = {profile.get("id") for profile in data["profiles"]}
    if None in profile_ids or "" in profile_ids:
        raise SystemExit("profile id must not be empty")

    for build in data["latest_builds"]:
        profile_id = build.get("profile")
        if profile_ids and profile_id not in profile_ids and profile_id != "unknown":
            raise SystemExit(f"build references unknown profile: {profile_id!r}")

    for release in data["latest_releases"]:
        for asset in release.get("assets", []):
            url = asset.get("download_url")
            if url and not url.startswith("https://github.com/"):
                raise SystemExit(f"unexpected asset download URL: {url}")

    latest = data.get("latest_build") or {}
    first_update = (data.get("update_status") or [{}])[0]
    print(
        "Dashboard schema OK:",
        f"repository={args.repository}",
        f"profiles={len(data['profiles'])}",
        f"builds={len(data['latest_builds'])}",
        f"releases={len(data['latest_releases'])}",
        f"source_commit={latest.get('commit')}",
        f"upstream_state={first_update.get('state')}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
