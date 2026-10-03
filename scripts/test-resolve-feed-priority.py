#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts" / "resolve-feed-priority.py"


def block(source: str, package: str, version: str) -> str:
    return (
        f"Source-Makefile: feeds/demo/{source}/Makefile\n"
        f"Package: {package}\n"
        f"Version: {version}\n"
        "Title: demo\n"
        "Type: ipkg\n"
    )


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "feeds").mkdir()
        (root / "feeds.conf.default").write_text(
            "\n".join(
                [
                    "src-git --force alpha https://example.invalid/alpha.git",
                    "src-git --force beta https://example.invalid/beta.git",
                    "src-git normal https://example.invalid/normal.git",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        (root / "feeds" / "alpha.index").write_text(
            block("xray-core", "xray-core", "26.5.9-r1")
            + block("demo-tool", "demo-tool", "1.0.0-r1"),
            encoding="utf-8",
        )
        (root / "feeds" / "beta.index").write_text(
            block("xray-core", "xray-core", "26.3.27-r1")
            + block("demo-tool", "demo-tool", "2.0.0-r1"),
            encoding="utf-8",
        )
        (root / "feeds" / "normal.index").write_text(
            block("xray-core", "xray-core", "99.0.0-r1"),
            encoding="utf-8",
        )

        report = root / "report.json"
        subprocess.run(
            ["python3", str(TOOL), str(root), "--report", str(report)],
            check=True,
        )

        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["priorityFeeds"] == ["alpha", "beta"]
        assert data["collisionCount"] == 2

        decisions = {item["source"]: item for item in data["decisions"]}
        assert decisions["xray-core"]["winner"]["feed"] == "alpha"
        assert decisions["xray-core"]["winner"]["version"] == "26.5.9-r1"
        assert decisions["demo-tool"]["winner"]["feed"] == "beta"
        assert decisions["demo-tool"]["winner"]["version"] == "2.0.0-r1"

        alpha = (root / "feeds" / "alpha.index").read_text(encoding="utf-8")
        beta = (root / "feeds" / "beta.index").read_text(encoding="utf-8")
        normal = (root / "feeds" / "normal.index").read_text(encoding="utf-8")

        assert "Source-Makefile: feeds/demo/xray-core/Makefile" in alpha
        assert "Source-Makefile: feeds/demo/demo-tool/Makefile" not in alpha
        assert "Source-Makefile: feeds/demo/xray-core/Makefile" not in beta
        assert "Source-Makefile: feeds/demo/demo-tool/Makefile" in beta

        # Non-priority feeds are not candidates even if their version is higher.
        assert "99.0.0-r1" in normal


if __name__ == "__main__":
    main()
