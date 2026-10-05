#!/usr/bin/env python3
"""Resolve duplicate OpenWrt feed sources with explicit safety reporting.

Priority feeds are feeds declared with --force. They always shadow default
or non-priority feeds for the same source.

Modes:
- per-package (default): compare binary package versions across priority feeds.
  A whole source is pruned only when every package in that source agrees on
  the same winning feed. Split winners fail safely instead of silently
  selecting the wrong source tree.
- feed-order: choose the first priority feed in feeds.conf order for duplicate
  sources, preserving one feed's source tree as a unit.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


FEED_RE = re.compile(
    r"^src-(?:git|git-full)\s+(?P<flags>(?:--\w+(?:=\S+)?\s+)*)"
    r"(?P<name>[A-Za-z0-9._-]+)\s+(?P<url>\S+)"
)
SOURCE_RE = re.compile(r"^Source-Makefile:\s+(.+)/([^/]+)/Makefile\s*$")
VERSION_RE = re.compile(r"^Version:\s*(.+?)\s*$")
PACKAGE_RE = re.compile(r"^Package:\s*(.+?)\s*$")
DEPENDS_RE = re.compile(r"^Depends:\s*(.*?)\s*$")
PACKAGE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+@-]*$")


@dataclass
class PackageMeta:
    version: str = "0"
    dependencies: list[str] = field(default_factory=list)


@dataclass
class SourceBlock:
    feed: str
    source: str
    lines: list[str]
    packages: dict[str, PackageMeta]
    loose_versions: list[str]
    order: int

    @property
    def version(self) -> str:
        values = [item.version for item in self.packages.values()]
        values += self.loose_versions
        values = [value for value in values if value]
        if not values:
            return "0"
        best = values[0]
        for candidate in values[1:]:
            if version_gt(candidate, best):
                best = candidate
        return best

    @property
    def package_names(self) -> list[str]:
        return sorted(self.packages)


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

    def key(value: str):
        return [
            (0, int(part)) if part.isdigit() else (1, part.lower())
            for part in re.findall(r"\d+|[^\d]+", value)
        ]

    return key(left) > key(right)


def dependency_names(value: str) -> list[str]:
    result: list[str] = []
    for raw in str(value or "").split():
        token = raw.strip()
        if not token or token == "||" or token.startswith("@"):
            continue
        token = token.lstrip("+!")
        if ":" in token:
            token = token.rsplit(":", 1)[1]
        token = re.split(r"[<>=()]", token, maxsplit=1)[0].strip()
        if (
            token
            and PACKAGE_NAME_RE.fullmatch(token)
            and not token.startswith("PACKAGE_")
            and token not in result
        ):
            result.append(token)
    return result


def active_feeds_file(root: Path) -> Path:
    explicit = root / "feeds.conf"
    return explicit if explicit.exists() else root / "feeds.conf.default"


def feed_specs(root: Path) -> list[dict[str, object]]:
    path = active_feeds_file(root)
    result: list[dict[str, object]] = []
    if not path.exists():
        return result

    for line_order, raw in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines()
    ):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = FEED_RE.match(line)
        if not match:
            continue
        flags = (match.group("flags") or "").split()
        result.append(
            {
                "name": match.group("name"),
                "force": "--force" in flags,
                "order": line_order,
            }
        )
    return result


def parse_index(path: Path, feed: str, order: int) -> list[SourceBlock]:
    if not path.exists():
        return []

    raw_lines = path.read_text(
        encoding="utf-8",
        errors="replace",
    ).splitlines(True)
    blocks: list[SourceBlock] = []
    current: list[str] = []

    def flush(lines: list[str]) -> None:
        if not lines:
            return

        source = ""
        packages: dict[str, PackageMeta] = {}
        loose_versions: list[str] = []
        current_package = ""

        for raw in lines:
            line = raw.rstrip("\r\n")

            source_match = SOURCE_RE.match(line)
            if source_match:
                source = source_match.group(2)

            package_match = PACKAGE_RE.match(line)
            if package_match:
                current_package = package_match.group(1).strip()
                packages.setdefault(current_package, PackageMeta())
                continue

            version_match = VERSION_RE.match(line)
            if version_match:
                version = version_match.group(1)
                if current_package:
                    packages.setdefault(current_package, PackageMeta()).version = version
                else:
                    loose_versions.append(version)
                continue

            depends_match = DEPENDS_RE.match(line)
            if depends_match and current_package:
                meta = packages.setdefault(current_package, PackageMeta())
                for dependency in dependency_names(depends_match.group(1)):
                    if dependency not in meta.dependencies:
                        meta.dependencies.append(dependency)

        if source:
            blocks.append(
                SourceBlock(
                    feed=feed,
                    source=source,
                    lines=list(lines),
                    packages=packages,
                    loose_versions=loose_versions,
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


def choose_highest_version(
    entries: list[tuple[SourceBlock, str]],
) -> tuple[SourceBlock, str]:
    winner = entries[0]
    for candidate in entries[1:]:
        if version_gt(candidate[1], winner[1]):
            winner = candidate
    return winner


def choose_source_winner(
    priority: list[SourceBlock],
    mode: str,
) -> tuple[SourceBlock | None, dict[str, str], dict[str, object] | None]:
    priority = sorted(priority, key=lambda item: item.order)

    if mode == "feed-order":
        winner = priority[0]
        package_winners = {
            package: winner.feed for package in winner.package_names
        }
        return winner, package_winners, None

    package_candidates: dict[str, list[tuple[SourceBlock, str]]] = {}
    for candidate in priority:
        for package, meta in candidate.packages.items():
            package_candidates.setdefault(package, []).append(
                (candidate, meta.version or "0")
            )

    if not package_candidates:
        entries = [(candidate, candidate.version) for candidate in priority]
        winner, _ = choose_highest_version(entries)
        return winner, {}, None

    package_winners: dict[str, str] = {}
    package_details: dict[str, list[dict[str, str]]] = {}

    for package, entries in sorted(package_candidates.items()):
        winner, _ = choose_highest_version(entries)
        package_winners[package] = winner.feed
        package_details[package] = [
            {
                "feed": candidate.feed,
                "version": version,
            }
            for candidate, version in entries
        ]

    winning_feeds = set(package_winners.values())
    if len(winning_feeds) > 1:
        return (
            None,
            package_winners,
            {
                "packageWinners": package_winners,
                "candidates": package_details,
            },
        )

    winner_feed = next(iter(winning_feeds))
    winner = next(
        candidate for candidate in priority if candidate.feed == winner_feed
    )
    return winner, package_winners, None


def block_summary(block: SourceBlock) -> dict[str, object]:
    return {
        "feed": block.feed,
        "version": block.version,
        "packages": {
            name: {
                "version": meta.version,
                "dependencies": meta.dependencies,
            }
            for name, meta in sorted(block.packages.items())
        },
    }


def write_report(path: Path | None, report: dict[str, object]) -> None:
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("build_root", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--mode",
        choices=("per-package", "feed-order"),
        default="per-package",
    )
    args = parser.parse_args()

    root = args.build_root.resolve()
    specs = feed_specs(root)
    all_feeds = [str(item["name"]) for item in specs]
    priority_feeds = [
        str(item["name"]) for item in specs if bool(item["force"])
    ]
    feed_order = {
        str(item["name"]): int(item["order"]) for item in specs
    }
    force_set = set(priority_feeds)

    candidates_by_source: dict[str, list[SourceBlock]] = {}
    blocks_by_feed: dict[str, list[SourceBlock]] = {}

    for feed in all_feeds:
        blocks = parse_index(
            root / "feeds" / f"{feed}.index",
            feed,
            feed_order[feed],
        )
        blocks_by_feed[feed] = blocks
        for block in blocks:
            candidates_by_source.setdefault(block.source, []).append(block)

    losers: dict[str, set[str]] = {feed: set() for feed in all_feeds}
    decisions: list[dict[str, object]] = []
    unsafe_collisions: list[dict[str, object]] = []
    selected_blocks: dict[str, SourceBlock] = {}
    arbitrated: dict[str, list[str]] = {}
    priority_collision_count = 0
    default_shadow_count = 0

    for source, candidates in sorted(candidates_by_source.items()):
        priority = [
            item for item in candidates if item.feed in force_set
        ]
        if not priority:
            continue

        winner: SourceBlock | None
        package_winners: dict[str, str]
        unsafe: dict[str, object] | None

        if len(priority) > 1:
            priority_collision_count += 1
            arbitrated[source] = [
                block.feed for block in sorted(priority, key=lambda item: item.order)
            ]
            winner, package_winners, unsafe = choose_source_winner(
                priority,
                args.mode,
            )
        else:
            winner = priority[0]
            package_winners = {
                package: winner.feed for package in winner.package_names
            }
            unsafe = None

        if unsafe is not None:
            unsafe_collisions.append(
                {
                    "source": source,
                    "mode": args.mode,
                    "packageWinners": unsafe["packageWinners"],
                    "candidates": unsafe["candidates"],
                    "feeds": [block.feed for block in priority],
                }
            )
            continue

        assert winner is not None
        selected_blocks[source] = winner

        dropped_priority: list[dict[str, object]] = []
        dropped_default: list[dict[str, object]] = []

        for candidate in priority:
            if candidate.feed == winner.feed:
                continue
            losers[candidate.feed].add(source)
            dropped_priority.append(block_summary(candidate))

        for candidate in candidates:
            if candidate.feed in force_set:
                continue
            losers[candidate.feed].add(source)
            dropped_default.append(block_summary(candidate))

        if dropped_default:
            default_shadow_count += 1

        if dropped_priority or dropped_default:
            decisions.append(
                {
                    "source": source,
                    "mode": args.mode,
                    "reason": (
                        "feed-order"
                        if args.mode == "feed-order" and len(priority) > 1
                        else "per-package-highest-version"
                    ),
                    "winner": block_summary(winner),
                    "packageWinners": package_winners,
                    "droppedPriority": dropped_priority,
                    "droppedDefault": dropped_default,
                }
            )

    package_owner: dict[str, str] = {}
    package_source: dict[str, str] = {}
    for source, block in selected_blocks.items():
        for package in block.package_names:
            package_owner.setdefault(package, block.feed)
            package_source.setdefault(package, source)

    cross_feed_dependencies: list[dict[str, object]] = []
    seen_dependencies: set[tuple[str, str, str, str]] = set()

    for source, block in selected_blocks.items():
        for package, meta in block.packages.items():
            for dependency in meta.dependencies:
                dependency_feed = package_owner.get(dependency, "")
                if not dependency_feed or dependency_feed == block.feed:
                    continue
                dependency_source = package_source.get(dependency, "")
                if dependency_source not in arbitrated:
                    continue
                key = (
                    package,
                    block.feed,
                    dependency,
                    dependency_feed,
                )
                if key in seen_dependencies:
                    continue
                seen_dependencies.add(key)
                cross_feed_dependencies.append(
                    {
                        "package": package,
                        "packageFeed": block.feed,
                        "source": source,
                        "dependency": dependency,
                        "dependencyFeed": dependency_feed,
                        "dependencySource": dependency_source,
                        "competingFeeds": arbitrated[dependency_source],
                    }
                )

    report = {
        "mode": args.mode,
        "priorityFeeds": priority_feeds,
        "priorityCollisionCount": priority_collision_count,
        "defaultShadowCount": default_shadow_count,
        "unsafeSourceCollisionCount": len(unsafe_collisions),
        "crossFeedDependencyCount": len(cross_feed_dependencies),
        "decisionCount": len(decisions),
        "decisions": decisions,
        "unsafeSourceCollisions": unsafe_collisions,
        "crossFeedDependencies": cross_feed_dependencies,
    }
    write_report(args.report, report)

    print("=== 常用 Feed 同名包优先策略 ===")
    print(f"模式：{args.mode}")
    print(f"优先第三方 feeds：{len(priority_feeds)}")
    print(f"常用源之间 source 冲突：{priority_collision_count}")
    print(f"替换默认/普通 feed 同名 source：{default_shadow_count}")
    print(f"不安全的 source 冲突：{len(unsafe_collisions)}")
    print(f"跨 feed 依赖告警：{len(cross_feed_dependencies)}")

    for warning in cross_feed_dependencies:
        print(
            "  ! 跨 feed 依赖: "
            f"{warning['package']}[{warning['packageFeed']}] -> "
            f"{warning['dependency']}[{warning['dependencyFeed']}]"
        )

    if unsafe_collisions:
        for collision in unsafe_collisions:
            detail = ", ".join(
                f"{package}->{feed}"
                for package, feed in sorted(
                    collision["packageWinners"].items()
                )
            )
            print(
                "ERROR: 同一 source 的二进制包需要不同 feed 胜出，"
                f"无法安全整块裁剪：{collision['source']} ({detail})",
            )
        print(
            "提示：确认希望整套优先某个 feed 时，可将 "
            "FEED_PRIORITY_MODE 改为 feed-order。"
        )
        return 2

    for feed, removed_sources in losers.items():
        if not removed_sources:
            continue
        path = root / "feeds" / f"{feed}.index"
        kept: list[str] = []
        for block in blocks_by_feed.get(feed, []):
            if block.source not in removed_sources:
                kept.extend(block.lines)
        path.write_text("".join(kept), encoding="utf-8")

    for decision in decisions:
        winner = decision["winner"]
        print(
            f"  ✓ {decision['source']}: {winner['feed']} "
            f"{winner['version']} ({decision['reason']})"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
