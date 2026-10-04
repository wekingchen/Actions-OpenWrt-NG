#!/usr/bin/env python3
import re
import sys
from pathlib import Path

ERROR_RE = re.compile(
    r"(ERROR: .* failed to build|fatal error:|\berror:|FAILED:|"
    r"No rule to make target|undefined reference|ninja: build stopped|"
    r"make(?:\[\d+\])?: \*\*\*)",
    re.IGNORECASE,
)
TARGET_RE = re.compile(r"ERROR: .* failed to build", re.IGNORECASE)


def merged_ranges(ranges):
    merged = []
    for start, end in sorted(ranges):
        if not merged or start > merged[-1][1] + 1:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return merged


def select_ranges(lines, before=12, after=18, max_lines=320):
    if not lines:
        return []

    target_indexes = [i for i, line in enumerate(lines) if TARGET_RE.search(line)]
    anchor = target_indexes[-1] if target_indexes else len(lines) - 1
    scan_start = max(0, anchor - 1400)
    candidates = [
        i for i in range(scan_start, min(len(lines), anchor + 1))
        if ERROR_RE.search(lines[i])
    ]

    selected = []
    if candidates:
        selected.extend(candidates[:4])
        selected.extend(candidates[-8:])
    elif target_indexes:
        selected.append(anchor)
    else:
        return [[max(0, len(lines) - min(max_lines, 160)), len(lines) - 1]]

    ranges = [
        (max(0, idx - before), min(len(lines) - 1, idx + after))
        for idx in sorted(set(selected))
    ]
    merged = merged_ranges(ranges)

    total = sum(end - start + 1 for start, end in merged)
    while merged and total > max_lines:
        start, end = merged[0]
        block_size = end - start + 1
        if total - block_size >= max_lines // 2:
            merged.pop(0)
            total -= block_size
        else:
            trim = total - max_lines
            merged[0][0] = min(end, start + trim)
            total -= trim
            break
    return merged


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract_failure_context.py <log>")

    path = Path(sys.argv[1])
    if not path.is_file():
        raise SystemExit(f"log not found: {path}")

    lines = path.read_text(errors="replace").splitlines()
    ranges = select_ranges(lines)
    previous_end = None

    for start, end in ranges:
        if previous_end is not None and start > previous_end + 1:
            print("... 省略无关日志 ...")
        for idx in range(start, end + 1):
            print(f"{idx + 1}: {lines[idx]}")
        previous_end = end


if __name__ == "__main__":
    main()
