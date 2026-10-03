#!/usr/bin/env python3
"""Resolve duplicate source packages across priority (--force) OpenWrt feeds.

All --force feeds beat core/default packages. When multiple --force feeds
contain the same source package, keep only the candidate with the highest
Version from feed metadata before scripts/feeds install runs.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


FEED_RE = re.compile(
    r"^src-(?:git|git-full)\s+(?P<flags>(?:--\w+(?:=\S+)?\s+)*)"
    r"(?P<name>[A-Za-z0-9._-]+)\s+(?P<url>\S+)"
)
SOURCE_RE = re.compile(r"^Source-Makefile:\s+(.+)/([^/]+)/Makefile\s*$")
VERSION_RE = re.compile(r"^Version:\s*(.+?)\s*$")
PACKAGE_RE = re.compile(r"^Package:\s*(.+?)\s*$")


@dataclass
class SourceBlock:
    feed: str
    source: str
    lines: list[str]
    versions: list[str]
    packages: list[str]
    order: int

    @property
    def version(self) -> str:
        if not self.versions:
            return "0"
        best = self.versions[0]
        for candidate in self.versions[1:]:
            if version_gt(candidate, best):
                best = candidate
        return best


def version_gt(left: str, right: str) -> bool:
    if left == right:
        return False
    proc = subprocess.run(
        ["dpkg", "--compare-versions", left, "gt", right],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if proc.returncode in (0, 1):
        return proc.returncode == 0
    # Deterministic natural-ish fallback for unusual version strings.
    def key(value: str):
        return [
            (0, int(part)) if part.isdigit() else (1, part.lower())
            for part in re.findall(r"\d+|[^\d]+", value)
        ]
    return key(left) > key(right)


def active_feeds_file(root: Path) -> Path:
    explicit = root / "feeds.conf"
    return explicit if explicit.exists() else root / "feeds.conf.default"


def priority_feeds(root: Path) -> list[str]:
    path = active_feeds_file(root)
    result: list[str] = []
    if not path.exists():
        return result
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = FEED_RE.match(line)
        if not match:
            continue
        flags = match.group("flags") or ""
        if "--force" in flags.split():
            result.append(match.group("name"))
    return result


def parse_index(path: Path, feed: str, order: int) -> list[SourceBlock]:
    if not path.exists():
        return []
    raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines(True)
    blocks: list[SourceBlock] = []
    current: list[str] = []

    def flush(lines: list[str]) -> None:
        if not lines:
            return
        source = ""
        versions: list[str] = []
        packages: list[str] = []
        for raw in lines:
            line = raw.rstrip("\r\n")
            source_match = SOURCE_RE.match(line)
            if source_match:
                source = source_match.group(2)
            version_match = VERSION_RE.match(line)
            if version_match:
                versions.append(version_match.group(1))
            package_match = PACKAGE_RE.match(line)
            if package_match:
                packages.append(package_match.group(1))
        if source:
            blocks.append(
                SourceBlock(
                    feed=feed,
                    source=source,
                    lines=list(lines),
                    versions=versions,
                    packages=packages,
                    order=order,
                )
            )

    for raw in raw_lines:
        if raw.startswith("Source-Makefile:") and current:
            flush(current)
            current = []
        current.append(raw)
    flush(current)
    return blocks


def choose_winner(candidates: list[SourceBlock]) -> SourceBlock:
    winner = candidates[0]
    for candidate in candidates[1:]:
        if version_gt(candidate.version, winner.version):
            winner = candidate
    return winner


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("build_root", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    root = args.build_root.resolve()
    feeds = priority_feeds(root)
    feed_order = {name: index for index, name in enumerate(feeds)}
    candidates_by_source: dict[str, list[SourceBlock]] = {}
    blocks_by_feed: dict[str, list[SourceBlock]] = {}

    for feed in feeds:
        blocks = parse_index(root / "feeds" / f"{feed}.index", feed, feed_order[feed])
        blocks_by_feed[feed] = blocks
        for block in blocks:
            candidates_by_source.setdefault(block.source, []).append(block)

    losers: dict[str, set[str]] = {feed: set() for feed in feeds}
    decisions: list[dict[str, object]] = []

    for source, candidates in sorted(candidates_by_source.items()):
        if len(candidates) < 2:
            continue
        candidates.sort(key=lambda item: item.order)
        winner = choose_winner(candidates)
        dropped = []
        for candidate in candidates:
            if candidate.feed == winner.feed:
                continue
            losers[candidate.feed].add(source)
            dropped.append(
                {
                    "feed": candidate.feed,
                    "version": candidate.version,
                    "packages": candidate.packages,
                }
            )
        decisions.append(
            {
                "source": source,
                "winner": {
                    "feed": winner.feed,
                    "version": winner.version,
                    "packages": winner.packages,
                },
                "dropped": dropped,
            }
        )

    for feed, removed_sources in losers.items():
        if not removed_sources:
            continue
        path = root / "feeds" / f"{feed}.index"
        kept: list[str] = []
        for block in blocks_by_feed.get(feed, []):
            if block.source not in removed_sources:
                kept.extend(block.lines)
        path.write_text("".join(kept), encoding="utf-8")

    report = {
        "priorityFeeds": feeds,
        "collisionCount": len(decisions),
        "decisions": decisions,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print("=== 常用 Feed 同名包版本择优 ===")
    print(f"优先第三方 feeds：{len(feeds)}")
    print(f"检测到同名 source package：{len(decisions)}")
    for decision in decisions:
        winner = decision["winner"]
        print(
            f"  ✓ {decision['source']}: {winner['feed']} "
            f"{winner['version']}"
        )
        for dropped in decision["dropped"]:
            print(
                f"      跳过 {dropped['feed']} {dropped['version']}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
