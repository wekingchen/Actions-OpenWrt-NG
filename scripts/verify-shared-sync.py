#!/usr/bin/env python3
"""Fail fast when the test repository's shared code differs from upstream main."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


TEST_REPOSITORY = "wekingchen/Actions-OpenWrt-NG-Test"
DEFAULT_UPSTREAM_REPOSITORY = "wekingchen/Actions-OpenWrt-NG"
DEFAULT_UPSTREAM_REF = "main"
EXCLUDED_PREFIXES = (
    "profiles/",
    "dashboard/data/",
    ".openwrt-ng/",
)


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


def main() -> int:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    force = os.environ.get("OPENWRT_NG_FORCE_SYNC_CHECK", "") == "1"
    if repository != TEST_REPOSITORY and not force:
        print(f"共享代码同步门禁跳过：repository={repository or 'local'}")
        return 0

    workspace = Path(os.environ.get("GITHUB_WORKSPACE", Path.cwd())).resolve()
    upstream_repository = os.environ.get(
        "OPENWRT_NG_UPSTREAM_REPOSITORY", DEFAULT_UPSTREAM_REPOSITORY
    )
    upstream_ref = os.environ.get("OPENWRT_NG_UPSTREAM_REF", DEFAULT_UPSTREAM_REF)

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
            print("ERROR: 测试仓共享代码与主仓最新 main 不一致。", file=sys.stderr)
            print(f"  upstream: {upstream_repository}@{upstream_ref} {upstream_sha}", file=sys.stderr)
            print(f"  current : {repository or workspace.name} {current_sha}", file=sys.stderr)
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
            print(
                "请先把主仓共享代码完整同步到测试仓，再执行验证。",
                file=sys.stderr,
            )
            return 2

        print(
            "共享代码同步校验通过："
            f" upstream={upstream_sha} current={current_sha} files={len(expected)}"
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
