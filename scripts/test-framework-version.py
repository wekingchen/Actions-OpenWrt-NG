#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", VERSION), VERSION

EXPORT = ROOT / "scripts" / "dashboard" / "export-data.py"
spec = importlib.util.spec_from_file_location("dashboard_export_data", EXPORT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)
assert module.framework_version(ROOT) == VERSION

status = json.loads(
    (ROOT / "dashboard" / "data" / "status.json").read_text(encoding="utf-8")
)
assert status["repository"]["version"] == f"V{VERSION}"

readme = (ROOT / "README.md").read_text(encoding="utf-8")
assert f"V{VERSION}" in readme

print(f"Framework version contract passed: {VERSION}")
