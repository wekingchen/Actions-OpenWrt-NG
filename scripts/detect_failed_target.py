#!/usr/bin/env python3
import re
import sys
from pathlib import Path

FAILED_RE = re.compile(
    r"ERROR:\s+((?:package|tools|toolchain)/\S+)"
    r"(?:\s+\[(host)\])?\s+failed to build\."
)


def detect_failed_target(text: str) -> str:
    target = ""
    for match in FAILED_RE.finditer(text):
        path, flavor = match.groups()
        if flavor == "host" and path.startswith("package/"):
            target = f"{path}/host/compile"
        else:
            target = f"{path}/compile"
    return target


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} <build.log>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        return 0
    target = detect_failed_target(path.read_text(errors="replace"))
    if target:
        print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
