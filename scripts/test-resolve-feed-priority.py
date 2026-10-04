#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts" / "resolve-feed-priority.py"


def block(
    source: str,
    packages: list[tuple[str, str, str]],
) -> str:
    lines = [f"Source-Makefile: feeds/demo/{source}/Makefile\n"]
    for package, version, depends in packages:
        lines.append(f"Package: {package}\n")
        lines.append(f"Version: {version}\n")
        if depends:
            lines.append(f"Depends: {depends}\n")
        lines.append("Title: demo\n")
        lines.append("Type: ipkg\n")
    return "".join(lines)


def run_tool(
    root: Path,
    *,
    mode: str = "per-package",
) -> tuple[subprocess.CompletedProcess[str], dict]:
    report = root / "report.json"
    proc = subprocess.run(
        [
            "python3",
            str(TOOL),
            str(root),
            "--mode",
            mode,
            "--report",
            str(report),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    data = json.loads(report.read_text(encoding="utf-8"))
    return proc, data


def write_feeds(root: Path, lines: list[str]) -> None:
    (root / "feeds").mkdir()
    (root / "feeds.conf.default").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def test_per_package_happy_path() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        write_feeds(
            root,
            [
                "src-git --force alpha https://example.invalid/alpha.git",
                "src-git --force beta https://example.invalid/beta.git",
                "src-git normal https://example.invalid/normal.git",
            ],
        )

        (root / "feeds" / "alpha.index").write_text(
            block("xray-core", [("xray-core", "26.5.9-r1", "")])
            + block("demo-tool", [("demo-tool", "1.0.0-r1", "")]),
            encoding="utf-8",
        )
        (root / "feeds" / "beta.index").write_text(
            block("xray-core", [("xray-core", "26.3.27-r1", "")])
            + block("demo-tool", [("demo-tool", "2.0.0-r1", "")]),
            encoding="utf-8",
        )
        (root / "feeds" / "normal.index").write_text(
            block("xray-core", [("xray-core", "99.0.0-r1", "")]),
            encoding="utf-8",
        )

        proc, data = run_tool(root)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert data["mode"] == "per-package"
        assert data["priorityCollisionCount"] == 2
        assert data["defaultShadowCount"] == 1
        assert data["unsafeSourceCollisionCount"] == 0

        decisions = {item["source"]: item for item in data["decisions"]}
        assert decisions["xray-core"]["winner"]["feed"] == "alpha"
        assert decisions["demo-tool"]["winner"]["feed"] == "beta"

        alpha = (root / "feeds" / "alpha.index").read_text(encoding="utf-8")
        beta = (root / "feeds" / "beta.index").read_text(encoding="utf-8")
        normal = (root / "feeds" / "normal.index").read_text(encoding="utf-8")
        assert "xray-core" in alpha
        assert "demo-tool" not in alpha
        assert "xray-core" not in beta
        assert "demo-tool" in beta
        assert "99.0.0-r1" not in normal


def test_split_package_winners_fail_safe() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        write_feeds(
            root,
            [
                "src-git --force alpha https://example.invalid/alpha.git",
                "src-git --force beta https://example.invalid/beta.git",
            ],
        )
        alpha_before = block(
            "bundle",
            [
                ("pkg-a", "2.0-r1", ""),
                ("pkg-b", "1.0-r1", ""),
            ],
        )
        beta_before = block(
            "bundle",
            [
                ("pkg-a", "1.0-r1", ""),
                ("pkg-b", "2.0-r1", ""),
            ],
        )
        (root / "feeds" / "alpha.index").write_text(alpha_before, encoding="utf-8")
        (root / "feeds" / "beta.index").write_text(beta_before, encoding="utf-8")

        proc, data = run_tool(root)
        assert proc.returncode == 2
        assert data["unsafeSourceCollisionCount"] == 1
        collision = data["unsafeSourceCollisions"][0]
        assert collision["packageWinners"] == {
            "pkg-a": "alpha",
            "pkg-b": "beta",
        }
        assert (root / "feeds" / "alpha.index").read_text(encoding="utf-8") == alpha_before
        assert (root / "feeds" / "beta.index").read_text(encoding="utf-8") == beta_before


def test_feed_order_resolves_split_source() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        write_feeds(
            root,
            [
                "src-git --force alpha https://example.invalid/alpha.git",
                "src-git --force beta https://example.invalid/beta.git",
            ],
        )
        (root / "feeds" / "alpha.index").write_text(
            block(
                "bundle",
                [
                    ("pkg-a", "1.0-r1", ""),
                    ("pkg-b", "1.0-r1", ""),
                ],
            ),
            encoding="utf-8",
        )
        (root / "feeds" / "beta.index").write_text(
            block(
                "bundle",
                [
                    ("pkg-a", "9.0-r1", ""),
                    ("pkg-b", "9.0-r1", ""),
                ],
            ),
            encoding="utf-8",
        )

        proc, data = run_tool(root, mode="feed-order")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        decision = data["decisions"][0]
        assert decision["winner"]["feed"] == "alpha"
        assert decision["reason"] == "feed-order"
        beta = (root / "feeds" / "beta.index").read_text(encoding="utf-8")
        assert "bundle" not in beta


def test_cross_feed_dependency_warning() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        write_feeds(
            root,
            [
                "src-git --force alpha https://example.invalid/alpha.git",
                "src-git --force beta https://example.invalid/beta.git",
            ],
        )
        (root / "feeds" / "alpha.index").write_text(
            block("app", [("app", "1.0-r1", "+libfoo")]),
            encoding="utf-8",
        )
        (root / "feeds" / "beta.index").write_text(
            block("libfoo", [("libfoo", "1.0-r1", "")]),
            encoding="utf-8",
        )

        proc, data = run_tool(root)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert data["crossFeedDependencyCount"] == 1
        warning = data["crossFeedDependencies"][0]
        assert warning["package"] == "app"
        assert warning["packageFeed"] == "alpha"
        assert warning["dependency"] == "libfoo"
        assert warning["dependencyFeed"] == "beta"


def main() -> None:
    test_per_package_happy_path()
    test_split_package_winners_fail_safe()
    test_feed_order_resolves_split_source()
    test_cross_feed_dependency_warning()
    print("Feed priority mode tests passed.")


if __name__ == "__main__":
    main()
