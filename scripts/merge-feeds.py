#!/usr/bin/env python3
"""Merge OpenWrt feed files with stable feed-name de-duplication.

Priority:
1. user/common extra feeds, first declaration wins;
2. source active feed file, first declaration wins for remaining names.

OpenWrt rejects duplicate feed names before update starts, so this normalization
must happen before ./scripts/feeds update -a.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

FEED_LINE_RE = re.compile(r"^\s*src-[^\s]+\s+(?P<body>.+?)\s*$")


def feed_name(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return ""
    match = FEED_LINE_RE.match(stripped)
    if not match:
        return ""
    for token in match.group("body").split():
        if token.startswith("--"):
            continue
        return token
    return ""


def active_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def merge(base_lines: list[str], extra_lines: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    output: list[str] = []
    seen: set[str] = set()
    removed: list[tuple[str, str]] = []

    def append_source(lines: list[str], origin: str, keep_comments: bool) -> None:
        for raw in lines:
            line = raw.rstrip()
            name = feed_name(line)
            if name:
                if name in seen:
                    removed.append((name, origin))
                    continue
                seen.add(name)
                output.append(line)
                continue
            if keep_comments and (not line.strip() or line.lstrip().startswith("#")):
                output.append(line)
            elif line.strip() and not line.lstrip().startswith("#"):
                # Preserve unusual active syntax rather than silently dropping it.
                output.append(line)

    # Extra/common feeds intentionally come first and therefore override source
    # defaults with the same feed name.
    append_source(extra_lines, "extra", False)
    if output and base_lines:
        output.append("")
    append_source(base_lines, "default", True)

    # Avoid trailing blank-line growth across repeated runs.
    while output and not output[-1].strip():
        output.pop()
    return output, removed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=Path)
    parser.add_argument("--extra", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    base = active_lines(args.base)
    extra = active_lines(args.extra) if args.extra else []
    merged, removed = merge(base, extra)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        ("\n".join(merged) + "\n") if merged else "",
        encoding="utf-8",
    )

    kept_names = [feed_name(line) for line in merged]
    kept_names = [name for name in kept_names if name]
    print("=== Feeds 名称去重 ===")
    print(f"最终 feeds：{len(kept_names)}")
    print(f"移除重复项：{len(removed)}")
    for name, origin in removed:
        if origin == "default":
            print(f"  ✓ {name}: 保留额外/较早声明，移除源码默认或后续重复项")
        else:
            print(f"  ✓ {name}: 额外 feeds 内重复，保留第一条")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
