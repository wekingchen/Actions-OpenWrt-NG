#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).with_name("cleanup-actions-caches.py")
spec = importlib.util.spec_from_file_location("cleanup_actions_caches", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def cache(
    cache_id: int,
    key: str,
    accessed: str,
    *,
    size: int = 100,
    created: str | None = None,
):
    return module.CacheRecord(
        id=cache_id,
        key=key,
        ref="refs/heads/main",
        size_in_bytes=size,
        created_at=created or accessed,
        last_accessed_at=accessed,
    )


assert module.parse_keep("2") == 2
for invalid in ("0", "-1", "abc"):
    try:
        module.parse_keep(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError(f"invalid keep value accepted: {invalid}")

assert module.normalized_prefixes(" a\n\na\n b \n") == ["a", "b"]
assert module.format_bytes(1024) == "1.00 KiB"
assert module.format_bytes(1024 * 1024) == "1.00 MiB"

dl = "openwrt-ng-dl-Linux-smoke-"
build = "openwrt-ng-build-v3-ubuntu24-Linux-X64-smoke-"
other = "openwrt-ng-dl-Linux-gl-mt3600be-"

caches = [
    cache(1, dl + "old", "2026-10-01T00:00:00Z", size=10),
    cache(2, dl + "mid", "2026-10-02T00:00:00Z", size=20),
    cache(3, dl + "new", "2026-10-03T00:00:00Z", size=30),
    cache(4, build + "old", "2026-10-01T00:00:00Z", size=40),
    cache(5, build + "mid", "2026-10-02T00:00:00Z", size=50),
    cache(6, build + "new", "2026-10-03T00:00:00Z", size=60),
    cache(7, other + "must-stay", "2026-09-01T00:00:00Z", size=70),
]

plan = module.plan_deletions(caches, [dl, build], 2)

assert [item.id for item in plan[dl]["keep"]] == [3, 2]
assert [item.id for item in plan[dl]["delete"]] == [1]
assert [item.id for item in plan[build]["keep"]] == [6, 5]
assert [item.id for item in plan[build]["delete"]] == [4]
assert all(
    item.id != 7
    for group in plan.values()
    for items in group.values()
    for item in items
)

# 同一访问时间时，用 created_at / id 稳定决定“更新”的 cache。
tie = [
    cache(10, dl + "a", "2026-10-03T00:00:00Z", created="2026-10-03T00:00:00Z"),
    cache(11, dl + "b", "2026-10-03T00:00:00Z", created="2026-10-04T00:00:00Z"),
]
tie_plan = module.plan_deletions(tie, [dl], 1)
assert [item.id for item in tie_plan[dl]["keep"]] == [11]
assert [item.id for item in tie_plan[dl]["delete"]] == [10]

print("Actions cache governance tests passed.")
