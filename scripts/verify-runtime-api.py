#!/usr/bin/env python3
"""Verify the workflow-to-runtime helper API contract before doing real work."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

API_FILE = Path(__file__).with_name("RUNTIME_API")
API_RE = re.compile(r"^[1-9][0-9]*$")


def main() -> int:
    expected = os.environ.get("OPENWRT_NG_EXPECTED_RUNTIME_API", "").strip()
    if not expected or not API_RE.fullmatch(expected):
        print("ERROR: OPENWRT_NG_EXPECTED_RUNTIME_API 必须是正整数。", file=sys.stderr)
        return 2
    try:
        actual = API_FILE.read_text(encoding="utf-8").strip()
    except OSError as error:
        print(f"ERROR: 无法读取 {API_FILE}: {error}", file=sys.stderr)
        return 2
    if not API_RE.fullmatch(actual):
        print(f"ERROR: {API_FILE} 内容无效: {actual!r}", file=sys.stderr)
        return 2
    if actual != expected:
        print(
            "ERROR: Runtime API 契约不匹配："
            f"workflow 期望 v{expected}，scripts 提供 v{actual}。",
            file=sys.stderr,
        )
        return 2
    print(f"Runtime API 契约校验通过：v{actual}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
