#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts" / "config-studio.py"


SPEC = importlib.util.spec_from_file_location("config_studio", TOOL)
assert SPEC and SPEC.loader
CONFIG_STUDIO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONFIG_STUDIO)


def run(*args: str) -> None:
    subprocess.run(
        [sys.executable, str(TOOL), *map(str, args)],
        check=True,
        cwd=ROOT,
    )


def main() -> None:
    legacy = CONFIG_STUDIO.decode_process_text(
        b'{"prompt":"legacy \xa1 text","symbol":"CONFIG_TEST"}\n'
    )
    assert "\ufffd" in legacy
    assert json.loads(legacy)["symbol"] == "CONFIG_TEST"

    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        build = temp / "openwrt"
        (build / "tmp").mkdir(parents=True)

        (build / ".config").write_text(
            "\n".join(
                [
                    "CONFIG_TARGET_ath79=y",
                    "CONFIG_TARGET_ath79_generic=y",
                    "CONFIG_TARGET_ath79_generic_DEVICE_glinet_gl-ar300m16=y",
                    "CONFIG_PACKAGE_luci-app-test=y",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (build / "tmp" / ".targetinfo").write_text(
            """Target: ath79
Target-Name: Atheros ATH79
Target: ath79/generic
Target-Name: Generic
Target-Arch: mips
Target-Features: squashfs
Default-Packages: base-files busybox
Target-Profile: DEVICE_glinet_gl-ar300m16
Target-Profile-Name: GL.iNet GL-AR300M16
Target-Profile-Packages: kmod-usb2
""",
            encoding="utf-8",
        )
        (build / "tmp" / ".packageinfo").write_text(
            """Source-Makefile: feeds/luci/applications/luci-app-test/Makefile
Package: luci-app-test
Version: 1
Depends: +luci-base
Section: luci
Category: LuCI
Submenu: 3. Applications
Repository: luci
Title: Test application
Type: ipkg
Description: Test app
@@
Source-Makefile: package/base-files/Makefile
Package: base-files
Version: 1
Section: base
Category: Base system
Title: Base files
Type: ipkg
Description: Base
@@
""",
            encoding="utf-8",
        )

        catalog_path = temp / "catalog.json"
        run("catalog", build, catalog_path)
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        ath79 = next(item for item in catalog["targets"] if item["id"] == "ath79")
        generic = next(
            item for item in ath79["subtargets"] if item["id"] == "generic"
        )
        device = generic["devices"][0]
        assert ath79["selected"] is True
        assert generic["selected"] is True
        assert device["profileId"] == "DEVICE_glinet_gl-ar300m16"
        assert device["selected"] is True
        pkg = next(
            item for item in catalog["packages"] if item["name"] == "luci-app-test"
        )
        assert pkg["selected"] is True
        assert pkg["luciApp"] is True
        assert pkg["category"] == "LuCI"
        assert pkg["assignable"] == ["n", "m", "y"]

        # OpenWrt scripts/metadata.pm::confstr() also converts '-' to '_'.
        (build / ".config").write_text(
            "CONFIG_TARGET_demo_board=y\n",
            encoding="utf-8",
        )
        (build / "tmp" / ".targetinfo").write_text(
            """Target: demo-board
Target-Name: Demo Board
""",
            encoding="utf-8",
        )
        hyphen_catalog_path = temp / "catalog-hyphen.json"
        run("catalog", build, hyphen_catalog_path)
        hyphen_catalog = json.loads(
            hyphen_catalog_path.read_text(encoding="utf-8")
        )
        demo = next(
            item
            for item in hyphen_catalog["targets"]
            if item["id"] == "demo-board"
        )
        assert demo["symbol"] == "CONFIG_TARGET_demo_board"
        assert demo["selected"] is True

        # Restore the original metadata for the result tests below.
        (build / ".config").write_text(
            "\n".join(
                [
                    "CONFIG_TARGET_ath79=y",
                    "CONFIG_TARGET_ath79_generic=y",
                    "CONFIG_TARGET_ath79_generic_DEVICE_glinet_gl-ar300m16=y",
                    "CONFIG_PACKAGE_luci-app-test=y",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        request = {
            "requestId": "0123456789abcdef",
            "baseConfig": (
                "# CONFIG_PACKAGE_luci-app-test is not set\n"
                "CONFIG_PACKAGE_old=y\n"
            ),
            "selection": {
                "values": {
                    "CONFIG_PACKAGE_luci-app-test": "y",
                    "CONFIG_PACKAGE_old": "n",
                    "CONFIG_CUSTOM_STRING": "hello world",
                }
            },
        }
        request_path = temp / "request.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")

        seed_path = temp / "seed.config"
        run("seed", request_path, seed_path)
        seed = seed_path.read_text(encoding="utf-8")
        assert "CONFIG_PACKAGE_luci-app-test=y" in seed
        assert "# CONFIG_PACKAGE_old is not set" in seed
        assert 'CONFIG_CUSTOM_STRING="hello world"' in seed

        final_path = temp / "final.config"
        final_path.write_text(
            """CONFIG_PACKAGE_luci-app-test=y
# CONFIG_PACKAGE_old is not set
CONFIG_PACKAGE_auto-dependency=y
CONFIG_CUSTOM_STRING="hello world"
""",
            encoding="utf-8",
        )
        result_path = temp / "result.json"
        run("result", request_path, final_path, result_path)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        assert result["summary"]["adjusted"] == 0
        assert result["summary"]["selectedPackages"] == 2

        changes = {
            (item["name"], item["change"]): item["reason"]
            for item in result["packageChanges"]
        }
        assert changes[("luci-app-test", "added")] == "requested"
        assert changes[("auto-dependency", "added")] == "dependency"
        assert changes[("old", "removed")] == "requested"

    print("Config Studio helper tests passed")


if __name__ == "__main__":
    main()
