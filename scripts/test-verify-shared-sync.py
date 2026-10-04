#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("verify-shared-sync.py")
spec = importlib.util.spec_from_file_location("verify_shared_sync", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    with patch.dict(os.environ, {}, clear=True):
        repository, ref = module.configured_upstream(root)
        assert repository == ""
        assert ref == "main"

        marker = root / ".openwrt-ng" / "sync-gate.json"
        marker.parent.mkdir(parents=True)
        marker.write_text(
            json.dumps({
                "upstream_repository": "owner/repository",
                "upstream_ref": "stable",
            }),
            encoding="utf-8",
        )
        repository, ref = module.configured_upstream(root)
        assert repository == "owner/repository"
        assert ref == "stable"

    with patch.dict(
        os.environ,
        {
            "OPENWRT_NG_UPSTREAM_REPOSITORY": "env/repository",
            "OPENWRT_NG_UPSTREAM_REF": "release/test",
        },
        clear=True,
    ):
        repository, ref = module.configured_upstream(root)
        assert repository == "env/repository"
        assert ref == "release/test"

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    with patch.dict(
        os.environ,
        {"OPENWRT_NG_FORCE_SYNC_CHECK": "1"},
        clear=True,
    ):
        try:
            module.configured_upstream(root)
        except ValueError as error:
            assert "requires an upstream repository" in str(error)
        else:
            raise AssertionError("force mode must require upstream repository")

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    with patch.dict(
        os.environ,
        {"OPENWRT_NG_UPSTREAM_REPOSITORY": "https://github.com/owner/repo"},
        clear=True,
    ):
        try:
            module.configured_upstream(root)
        except ValueError as error:
            assert "owner/repository" in str(error)
        else:
            raise AssertionError("URL form must not be accepted")

print("Shared sync gate configuration tests passed.")
