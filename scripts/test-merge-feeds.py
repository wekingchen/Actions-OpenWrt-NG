#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts" / "merge-feeds.py"
SPEC = importlib.util.spec_from_file_location("merge_feeds", TOOL)
assert SPEC and SPEC.loader
MERGE_FEEDS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MERGE_FEEDS)


def main() -> None:
    base = [
        "# source defaults",
        "src-git packages https://git.openwrt.org/feed/packages.git",
        "src-git helloworld https://example/default-helloworld.git",
        "src-git-full luci https://git.openwrt.org/project/luci.git",
        "src-link local /opt/local-feed",
        "",
    ]
    extra = [
        "src-git --force helloworld https://github.com/fw876/helloworld.git",
        "src-git --force custom https://example/custom.git",
        "src-git --force helloworld https://example/ignored.git",
    ]

    merged, removed = MERGE_FEEDS.merge(base, extra)
    active = [line for line in merged if MERGE_FEEDS.feed_name(line)]

    assert active == [
        "src-git --force helloworld https://github.com/fw876/helloworld.git",
        "src-git --force custom https://example/custom.git",
        "src-git packages https://git.openwrt.org/feed/packages.git",
        "src-git-full luci https://git.openwrt.org/project/luci.git",
        "src-link local /opt/local-feed",
    ]
    assert removed == [
        ("helloworld", "extra"),
        ("helloworld", "default"),
    ]
    assert [MERGE_FEEDS.feed_name(line) for line in active].count("helloworld") == 1

    # Source defaults are normalized too, even without extra feeds.
    merged_default, removed_default = MERGE_FEEDS.merge(
        [
            "src-git packages https://example/one.git",
            "src-git packages https://example/two.git",
        ],
        [],
    )
    assert merged_default == ["src-git packages https://example/one.git"]
    assert removed_default == [("packages", "default")]

    # CLI writes a clean file.
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        base_path = temp / "feeds.conf.default"
        extra_path = temp / "extra.conf"
        output_path = temp / "merged.conf"
        base_path.write_text("\n".join(base) + "\n", encoding="utf-8")
        extra_path.write_text("\n".join(extra) + "\n", encoding="utf-8")

        import subprocess
        subprocess.run(
            [
                "python3",
                str(TOOL),
                str(base_path),
                "--extra",
                str(extra_path),
                "--output",
                str(output_path),
            ],
            check=True,
        )
        names = [
            MERGE_FEEDS.feed_name(line)
            for line in output_path.read_text(encoding="utf-8").splitlines()
        ]
        names = [name for name in names if name]
        assert len(names) == len(set(names))
        assert names[0:2] == ["helloworld", "custom"]

    print("Feed name de-dup tests passed")


if __name__ == "__main__":
    main()
