#!/usr/bin/env python3
"""Fail fast when shared code differs from a configured upstream repository."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_UPSTREAM_REF = "main"
LOCAL_CONFIG = Path(".openwrt-ng/sync-gate.json")
EXCLUDED_PREFIXES = (
    "profiles/",
    "dashboard/data/",
    ".openwrt-ng/",
)
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def run(*args: str, cwd: Path | None = None) -> str:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.check_output(
        args,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
    ).strip()


def tracked_index(root: Path) -> dict[str, tuple[str, str]]:
    raw = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "-s", "-z"]
    )
    result: dict[str, tuple[str, str]] = {}
    for record in raw.decode("utf-8").split("\0"):
        if not record:
            continue
        meta, path = record.split("\t", 1)
        mode, blob_sha, stage = meta.split()
        if stage != "0":
            raise RuntimeError(f"unexpected git index stage {stage}: {path}")
        if path.startswith(EXCLUDED_PREFIXES):
            continue
        result[path] = (mode, blob_sha)
    return result


def local_config(workspace: Path) -> dict[str, str]:
    path = workspace / LOCAL_CONFIG
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {LOCAL_CONFIG}: {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"{LOCAL_CONFIG} must contain a JSON object")
    result: dict[str, str] = {}
    for key in ("upstream_repository", "upstream_ref"):
        value = data.get(key, "")
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ValueError(f"{LOCAL_CONFIG} field {key} must be a string")
        result[key] = value.strip()
    return result


def configured_upstream(workspace: Path | None = None) -> tuple[str, str]:
    root = (workspace or Path(
        os.environ.get("GITHUB_WORKSPACE", Path.cwd())
    )).resolve()
    config = local_config(root)

    repository = (
        os.environ.get("OPENWRT_NG_UPSTREAM_REPOSITORY", "").strip()
        or config.get("upstream_repository", "")
    )
    ref = (
        os.environ.get("OPENWRT_NG_UPSTREAM_REF", "").strip()
        or config.get("upstream_ref", "")
        or DEFAULT_UPSTREAM_REF
    )
    force = os.environ.get("OPENWRT_NG_FORCE_SYNC_CHECK", "") == "1"

    if not repository:
        if force:
            raise ValueError(
                "OPENWRT_NG_FORCE_SYNC_CHECK=1 requires an upstream repository"
            )
        return "", ref

    if not REPOSITORY_RE.fullmatch(repository):
        raise ValueError("upstream repository must use owner/repository format")
    if not ref:
        raise ValueError("upstream ref must not be empty")
    return repository, ref


def main() -> int:
    workspace = Path(os.environ.get("GITHUB_WORKSPACE", Path.cwd())).resolve()
    try:
        upstream_repository, upstream_ref = configured_upstream(workspace)
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    if not upstream_repository:
        print(
            "共享代码同步门禁跳过：未配置上游仓库 "
            f"（可用仓库变量或 {LOCAL_CONFIG} 启用）。"
        )
        return 0

    repository = os.environ.get("GITHUB_REPOSITORY", "") or workspace.name

    with tempfile.TemporaryDirectory(prefix="openwrt-ng-sync-") as temp_dir:
        upstream = Path(temp_dir) / "upstream"
        subprocess.run(
            [
                "git",
                "clone",
                "--quiet",
                "--depth=1",
                "--branch",
                upstream_ref,
                f"https://github.com/{upstream_repository}.git",
                str(upstream),
            ],
            check=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )

        expected = tracked_index(upstream)
        actual = tracked_index(workspace)

        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        changed = sorted(
            path
            for path in set(expected) & set(actual)
            if expected[path] != actual[path]
        )

        upstream_sha = run("git", "-C", str(upstream), "rev-parse", "HEAD")
        current_sha = run("git", "-C", str(workspace), "rev-parse", "HEAD")

        if missing or extra or changed:
            print("ERROR: 共享代码与配置的上游仓库不一致。", file=sys.stderr)
            print(
                f"  upstream: {upstream_repository}@{upstream_ref} {upstream_sha}",
                file=sys.stderr,
            )
            print(f"  current : {repository} {current_sha}", file=sys.stderr)
            for label, items in (
                ("缺失", missing),
                ("额外", extra),
                ("内容/模式不同", changed),
            ):
                if not items:
                    continue
                print(f"  {label} ({len(items)}):", file=sys.stderr)
                for path in items[:100]:
                    print(f"    - {path}", file=sys.stderr)
                if len(items) > 100:
                    print(f"    ... 另有 {len(items) - 100} 项", file=sys.stderr)
            print("请先同步共享代码，再执行验证。", file=sys.stderr)
            return 2

        print(
            "共享代码同步校验通过："
            f" upstream={upstream_sha} current={current_sha} files={len(expected)}"
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
