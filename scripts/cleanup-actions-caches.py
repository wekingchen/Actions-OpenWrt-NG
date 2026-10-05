#!/usr/bin/env python3
"""Prune stale OpenWrt NG Actions caches without touching unrelated cache keys."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

API_ROOT = "https://api.github.com"
API_VERSION = "2022-11-28"
HASH_TAIL_RE = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class CacheRecord:
    id: int
    key: str
    ref: str
    size_in_bytes: int
    created_at: str
    last_accessed_at: str

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "CacheRecord":
        return cls(
            id=int(value.get("id") or 0),
            key=str(value.get("key") or ""),
            ref=str(value.get("ref") or ""),
            size_in_bytes=int(value.get("size_in_bytes") or 0),
            created_at=str(value.get("created_at") or ""),
            last_accessed_at=str(value.get("last_accessed_at") or ""),
        )


def format_bytes(value: int) -> str:
    amount = float(max(0, int(value)))
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    unit = units[0]
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            break
        amount /= 1024
    if unit == "B":
        return f"{int(amount)} {unit}"
    return f"{amount:.2f} {unit}"


def parse_keep(value: str) -> int:
    try:
        keep = int(str(value).strip())
    except ValueError as error:
        raise ValueError("ACTIONS_CACHE_KEEP_PER_PREFIX must be an integer") from error
    if keep < 1:
        raise ValueError("ACTIONS_CACHE_KEEP_PER_PREFIX must be >= 1")
    return keep


def normalized_prefixes(value: str) -> list[str]:
    prefixes: list[str] = []
    for line in str(value or "").splitlines():
        prefix = line.strip()
        if not prefix or prefix in prefixes:
            continue
        prefixes.append(prefix)
    return prefixes


def key_matches(key: str, prefix: str) -> bool:
    return key.startswith(prefix) and bool(
        HASH_TAIL_RE.fullmatch(key[len(prefix):])
    )


def cache_sort_key(cache: CacheRecord) -> tuple[str, str, int]:
    return (cache.last_accessed_at, cache.created_at, cache.id)


def plan_deletions(
    caches: list[CacheRecord],
    prefixes: list[str],
    keep_per_prefix: int,
) -> dict[str, dict[str, list[CacheRecord]]]:
    plan: dict[str, dict[str, list[CacheRecord]]] = {}
    claimed: set[int] = set()

    for prefix in prefixes:
        matched = [
            cache
            for cache in caches
            if cache.id > 0 and cache.id not in claimed and key_matches(cache.key, prefix)
        ]
        matched.sort(key=cache_sort_key, reverse=True)
        for cache in matched:
            claimed.add(cache.id)
        plan[prefix] = {
            "keep": matched[:keep_per_prefix],
            "delete": matched[keep_per_prefix:],
        }

    return plan


class GitHubApi:
    def __init__(self, repository: str, token: str) -> None:
        self.repository = repository
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        allow_status: tuple[int, ...] = (),
    ) -> Any:
        url = API_ROOT + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": API_VERSION,
                "User-Agent": "openwrt-ng-cache-governance",
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

    def list_caches(self) -> list[CacheRecord]:
        caches: list[CacheRecord] = []
        page = 1
        while True:
            payload = self.request(
                "GET",
                f"/repos/{self.repository}/actions/caches?per_page=100&page={page}",
            )
            rows = payload.get("actions_caches", []) if isinstance(payload, dict) else []
            if not isinstance(rows, list):
                raise RuntimeError("GitHub cache list returned an invalid payload")
            caches.extend(
                CacheRecord.from_json(row)
                for row in rows
                if isinstance(row, dict)
            )
            if len(rows) < 100:
                break
            page += 1
        return caches

    def cache_usage(self) -> tuple[int, int]:
        payload = self.request(
            "GET",
            f"/repos/{self.repository}/actions/cache/usage",
        )
        if not isinstance(payload, dict):
            return (0, 0)
        return (
            int(payload.get("active_caches_count") or 0),
            int(payload.get("active_caches_size_in_bytes") or 0),
        )

    def delete_cache(self, cache_id: int) -> None:
        self.request(
            "DELETE",
            f"/repos/{self.repository}/actions/caches/{cache_id}",
            allow_status=(404,),
        )


def append_summary(
    *,
    repository: str,
    prefixes: list[str],
    keep_per_prefix: int,
    before_usage: tuple[int, int],
    after_usage: tuple[int, int],
    plan: dict[str, dict[str, list[CacheRecord]]],
    deleted: list[CacheRecord],
    dry_run: bool,
) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY", "").strip()
    if not summary_path:
        return

    deleted_ids = {cache.id for cache in deleted}
    with open(summary_path, "a", encoding="utf-8") as handle:
        handle.write("## OpenWrt NG · Actions Cache 治理\n\n")
        handle.write(f"- 仓库：{repository}\n")
        handle.write(f"- 每个前缀保留：最近使用的 {keep_per_prefix} 份\n")
        handle.write(f"- 模式：{'dry-run' if dry_run else '实际清理'}\n")
        handle.write(
            f"- 清理前：{before_usage[0]} 个 · {format_bytes(before_usage[1])}\n"
        )
        handle.write(
            f"- 清理后：{after_usage[0]} 个 · {format_bytes(after_usage[1])}\n\n"
        )
        handle.write("| Cache 前缀 | 匹配 | 保留 | 删除 | 删除容量 |\n")
        handle.write("|---|---:|---:|---:|---:|\n")
        for prefix in prefixes:
            item = plan[prefix]
            matched = item["keep"] + item["delete"]
            actual_deleted = [
                cache for cache in item["delete"] if cache.id in deleted_ids
            ]
            deleted_bytes = sum(cache.size_in_bytes for cache in actual_deleted)
            handle.write(
                f"| `{prefix}` | {len(matched)} | {len(item['keep'])} | "
                f"{len(actual_deleted)} | {format_bytes(deleted_bytes)} |\n"
            )
        handle.write("\n")


def main() -> int:
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token = (
        os.environ.get("GH_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
    )
    if not repository:
        print("ERROR: GITHUB_REPOSITORY is required", file=sys.stderr)
        return 2
    if not token:
        print("ERROR: GH_TOKEN or GITHUB_TOKEN is required", file=sys.stderr)
        return 2

    try:
        keep_per_prefix = parse_keep(
            os.environ.get("ACTIONS_CACHE_KEEP_PER_PREFIX", "2")
        )
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    prefixes = normalized_prefixes(
        os.environ.get("ACTIONS_CACHE_PREFIXES", "")
    )
    if not prefixes:
        print("缓存治理跳过：没有提供 ACTIONS_CACHE_PREFIXES。")
        return 0

    dry_run = os.environ.get("ACTIONS_CACHE_DRY_RUN", "") == "1"
    api = GitHubApi(repository, token)

    before_usage = api.cache_usage()
    caches = api.list_caches()
    plan = plan_deletions(caches, prefixes, keep_per_prefix)

    deleted: list[CacheRecord] = []
    for prefix in prefixes:
        item = plan[prefix]
        print(
            f"缓存前缀 {prefix}: 匹配 {len(item['keep']) + len(item['delete'])}，"
            f"保留 {len(item['keep'])}，计划删除 {len(item['delete'])}"
        )
        for cache in item["keep"]:
            print(
                "  保留: "
                f"id={cache.id} key={cache.key} "
                f"last_accessed={cache.last_accessed_at} "
                f"size={format_bytes(cache.size_in_bytes)}"
            )
        for cache in item["delete"]:
            print(
                "  删除" + ("(dry-run)" if dry_run else "") + ": "
                f"id={cache.id} key={cache.key} "
                f"last_accessed={cache.last_accessed_at} "
                f"size={format_bytes(cache.size_in_bytes)}"
            )
            if not dry_run:
                api.delete_cache(cache.id)
            deleted.append(cache)

    after_usage = before_usage if dry_run else api.cache_usage()
    append_summary(
        repository=repository,
        prefixes=prefixes,
        keep_per_prefix=keep_per_prefix,
        before_usage=before_usage,
        after_usage=after_usage,
        plan=plan,
        deleted=deleted,
        dry_run=dry_run,
    )

    deleted_bytes = sum(cache.size_in_bytes for cache in deleted)
    print(
        "Actions Cache 治理完成："
        f"删除 {len(deleted)} 个，"
        f"预计释放 {format_bytes(deleted_bytes)}，"
        f"仓库缓存 {before_usage[0]} -> {after_usage[0]} 个，"
        f"{format_bytes(before_usage[1])} -> {format_bytes(after_usage[1])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
