#!/usr/bin/env python3
"""OpenWrt NG Config Studio helpers.

The browser never tries to reimplement Kconfig dependency solving. This helper
only exports metadata for the UI, renders an explicit seed .config, and compares
the user's requested values with the .config produced by OpenWrt make defconfig.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

CONFIG_SET_RE = re.compile(r"^(CONFIG_[A-Za-z0-9_.+@/-]+)=(.*)$")
CONFIG_UNSET_RE = re.compile(r"^# (CONFIG_[A-Za-z0-9_.+@/-]+) is not set$")
SYMBOL_RE = re.compile(r"^CONFIG_[A-Za-z0-9_.+@/-]+$")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def decode_process_text(value: bytes | str | None) -> str:
    """Decode external build-tool output without letting legacy text kill a catalog.

    Some OpenWrt/feeds Kconfig prompts and help strings still contain bytes from
    legacy encodings. Symbols and config values are ASCII-safe; display text is
    allowed to use U+FFFD for undecodable bytes.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return value.decode("utf-8", errors="replace")


def parse_config_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        match = CONFIG_SET_RE.match(line)
        if match:
            values[match.group(1)] = match.group(2)
            continue
        match = CONFIG_UNSET_RE.match(line)
        if match:
            values[match.group(1)] = "n"
    return values


def config_value_for_json(raw: str) -> str:
    if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw[1:-1]
    return raw


def encode_config_value(symbol: str, value: Any) -> str:
    if not SYMBOL_RE.fullmatch(symbol):
        raise ValueError(f"invalid config symbol: {symbol}")
    text = str(value)
    if text == "n":
        return f"# {symbol} is not set"
    if text in {"y", "m"}:
        return f"{symbol}={text}"
    if re.fullmatch(r"-?[0-9]+|0x[0-9A-Fa-f]+", text):
        return f"{symbol}={text}"
    return f"{symbol}={json.dumps(text, ensure_ascii=False)}"


def conf_name(value: str) -> str:
    # 与 OpenWrt scripts/metadata.pm::confstr() 保持一致：/ . - 都转成下划线。
    return value.replace("/", "_").replace(".", "_").replace("-", "_")


def parse_targetinfo(path: Path, config: dict[str, str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    profile: dict[str, Any] | None = None

    for raw in read_text(path).splitlines():
        line = raw.rstrip()
        if line.startswith("Target:"):
            current = {
                "id": line.split(":", 1)[1].strip(),
                "name": "",
                "arch": "",
                "features": [],
                "defaultPackages": [],
                "profiles": [],
            }
            records.append(current)
            profile = None
            continue
        if current is None:
            continue
        if line.startswith("Target-Name:"):
            current["name"] = line.split(":", 1)[1].strip()
        elif line.startswith("Target-Arch:"):
            current["arch"] = line.split(":", 1)[1].strip()
        elif line.startswith("Target-Features:"):
            current["features"] = line.split(":", 1)[1].strip().split()
        elif line.startswith("Default-Packages:"):
            current["defaultPackages"] = line.split(":", 1)[1].strip().split()
        elif line.startswith("Target-Profile:"):
            profile = {
                "id": line.split(":", 1)[1].strip(),
                "name": "",
                "packages": [],
                "broken": False,
            }
            current["profiles"].append(profile)
        elif profile is not None and line.startswith("Target-Profile-Name:"):
            profile["name"] = line.split(":", 1)[1].strip()
        elif profile is not None and line.startswith("Target-Profile-Packages:"):
            profile["packages"] = line.split(":", 1)[1].strip().split()
        elif profile is not None and line.startswith("Target-Profile-Broken:"):
            profile["broken"] = True

    children: dict[str, list[dict[str, Any]]] = {}
    roots: dict[str, dict[str, Any]] = {}
    for record in records:
        if "/" in record["id"]:
            board, subtarget = record["id"].split("/", 1)
            item = dict(record)
            item["board"] = board
            item["subtarget"] = subtarget
            children.setdefault(board, []).append(item)
        else:
            roots[record["id"]] = record

    all_boards = sorted(set(roots) | set(children))
    output: list[dict[str, Any]] = []
    for board in all_boards:
        root = roots.get(board, {
            "id": board,
            "name": board,
            "arch": "",
            "features": [],
            "defaultPackages": [],
            "profiles": [],
        })
        target_symbol = f"CONFIG_TARGET_{conf_name(board)}"
        target = {
            "id": board,
            "name": root.get("name") or board,
            "symbol": target_symbol,
            "selected": config.get(target_symbol) == "y",
            "subtargets": [],
        }
        subrecords = sorted(children.get(board, []), key=lambda item: item["id"])
        if not subrecords:
            subrecords = [dict(root, board=board, subtarget="")]
        for record in subrecords:
            target_id = record["id"]
            sub_id = record.get("subtarget", "")
            sub_symbol = (
                f"CONFIG_TARGET_{conf_name(target_id)}"
                if sub_id
                else target_symbol
            )
            sub = {
                "id": sub_id,
                "name": record.get("name") or sub_id or root.get("name") or board,
                "symbol": sub_symbol,
                "selected": config.get(sub_symbol) == "y",
                "arch": record.get("arch", ""),
                "features": record.get("features", []),
                "defaultPackages": record.get("defaultPackages", []),
                "devices": [],
            }
            for item in record.get("profiles", []):
                profile_id = item["id"]
                device_symbol = f"CONFIG_TARGET_{conf_name(target_id)}_{profile_id}"
                sub["devices"].append({
                    "id": profile_id.removeprefix("DEVICE_"),
                    "profileId": profile_id,
                    "name": item.get("name") or profile_id,
                    "symbol": device_symbol,
                    "selected": config.get(device_symbol) == "y",
                    "broken": bool(item.get("broken")),
                    "packages": item.get("packages", []),
                })
            target["subtargets"].append(sub)
        output.append(target)
    return output


def dependency_rules_for_package(
    package_name: str,
    tokens: list[str],
) -> list[dict[str, str]]:
    """Extract package-select edges used by OpenWrt's generated menuconfig.

    Only '+' dependencies select another package. '+@FOO' selects a raw Kconfig
    symbol instead of a package and is therefore not shown as a package lock.
    Conditional package deps such as '+PACKAGE_x:foo' keep their Kconfig
    condition for the browser-side preview. The final source of truth remains
    OpenWrt's own make defconfig.
    """
    rules: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw_token in tokens:
        token = str(raw_token or "").strip()
        flags_match = re.match(r"^([@+]+)", token)
        flags = flags_match.group(1) if flags_match else ""
        if "+" not in flags or "@" in flags:
            continue

        value = token[len(flags):]
        condition = ""
        target = value
        if ":" in value:
            condition, target = value.split(":", 1)
            condition = condition.strip()
            target = target.strip()
            if condition == f"PACKAGE_{package_name}":
                condition = ""

        if not target or target.startswith("@"):
            continue

        key = (target, condition)
        if key in seen:
            continue
        seen.add(key)
        rules.append({
            "package": target,
            "condition": condition,
            "source": token,
        })
    return rules


def dependency_condition_names(rules: list[dict[str, str]]) -> set[str]:
    names: set[str] = set()
    for rule in rules:
        condition = str(rule.get("condition") or "")
        names.update(
            name
            for name in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", condition)
            if name not in {"y", "m", "n"}
        )
    return names


def parse_packageinfo(path: Path, config: dict[str, str]) -> list[dict[str, Any]]:
    packages: list[dict[str, Any]] = []
    source_makefile = ""
    current: dict[str, Any] | None = None

    for raw in read_text(path).splitlines():
        line = raw.rstrip()
        if line.startswith("Source-Makefile:"):
            source_makefile = line.split(":", 1)[1].strip()
            current = None
            continue
        if line.startswith("Package:"):
            name = line.split(":", 1)[1].strip()
            current = {
                "name": name,
                "symbol": f"CONFIG_PACKAGE_{name}",
                "title": "",
                "category": "Other",
                "submenu": "",
                "repository": "base",
                "depends": [],
                "menuDepends": [],
                "hidden": False,
                "buildOnly": False,
                "types": [],
                "sourceMakefile": source_makefile,
            }
            packages.append(current)
            continue
        if current is None:
            continue
        if line.startswith("Title:"):
            current["title"] = line.split(":", 1)[1].strip()
        elif line.startswith("Category:"):
            current["category"] = line.split(":", 1)[1].strip() or "Other"
        elif line.startswith("Submenu:"):
            current["submenu"] = line.split(":", 1)[1].strip()
        elif line.startswith("Repository:"):
            current["repository"] = line.split(":", 1)[1].strip() or "base"
        elif line.startswith("Depends:"):
            current["depends"] = line.split(":", 1)[1].strip().split()
        elif line.startswith("Menu-Depends:"):
            current["menuDepends"] = line.split(":", 1)[1].strip().split()
        elif line.startswith("Hidden:"):
            current["hidden"] = True
        elif line.startswith("Build-Only:"):
            current["buildOnly"] = True
        elif line.startswith("Type:"):
            current["types"] = line.split(":", 1)[1].strip().split()

    visible: list[dict[str, Any]] = []
    for package in packages:
        if package["hidden"] or package["buildOnly"]:
            continue
        raw_value = config.get(package["symbol"], "n")
        package["value"] = config_value_for_json(raw_value)
        package["selected"] = raw_value in {"y", "m"}
        package["luciApp"] = package["name"].startswith("luci-app-")
        package["assignable"] = (
            ["n", "m", "y"] if "ipkg" in package["types"] else ["n", "y"]
        )
        package["dependencyRules"] = dependency_rules_for_package(
            package["name"],
            package["depends"],
        )
        visible.append(package)
    return visible



def attach_package_config_options(
    packages: list[dict[str, Any]],
    package_kconfig: dict[str, dict[str, Any]],
) -> None:
    """Attach Package/<name>/config symbols to their owning package."""
    by_name = {str(package["name"]): package for package in packages}
    owners = sorted(by_name, key=lambda value: (-len(value), value.casefold()))
    for package in packages:
        package["configOptions"] = []

    for config_name, state in package_kconfig.items():
        if config_name in by_name:
            continue
        owner = next(
            (
                name
                for name in owners
                if config_name.startswith(name + "_")
            ),
            "",
        )
        if not owner:
            continue

        option = dict(state)
        option["configName"] = config_name
        option["name"] = config_name[len(owner) + 1 :]
        option["choicePrompt"] = str(option.get("choicePrompt") or "")
        option["choiceValue"] = bool(option.get("choiceValue"))
        potential = [
            str(value)
            for value in (option.get("potentialAssignable") or [])
            if str(value) in {"n", "m", "y"}
        ]
        if not potential:
            option_type = str(option.get("type") or "")
            if option_type == "boolean":
                potential = ["n", "y"]
            elif option_type == "tristate":
                potential = ["n", "m", "y"]
        option["potentialAssignable"] = potential
        by_name[owner]["configOptions"].append(option)

    for package in packages:
        package["configOptions"].sort(
            key=lambda item: (
                tuple(item.get("menuPath") or []),
                str(item.get("choicePrompt") or "").casefold(),
                str(item.get("prompt") or "").casefold(),
                str(item.get("name") or "").casefold(),
            )
        )


def kconfig_features(root: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], str]:
    config_dir = root / "scripts" / "config"
    exporter_source = Path(__file__).with_name("config-studio-kconfig.c")
    object_names = [
        "confdata.o",
        "expr.o",
        "lexer.lex.o",
        "menu.o",
        "parser.tab.o",
        "preprocess.o",
        "symbol.o",
        "util.o",
    ]

    if not exporter_source.is_file():
        return [], {}, f"OpenWrt Kconfig exporter missing: {exporter_source}"
    if not config_dir.is_dir():
        return [], {}, f"OpenWrt scripts/config missing: {config_dir}"

    try:
        subprocess.run(
            ["make", "-C", str(config_dir), "conf"],
            cwd=root,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        objects = [config_dir / name for name in object_names]
        missing = [str(path) for path in objects if not path.is_file()]
        if missing:
            return [], {}, "OpenWrt Kconfig objects missing: " + ", ".join(missing)

        with tempfile.TemporaryDirectory(prefix="openwrt-ng-kconfig-") as raw:
            binary = Path(raw) / "config-studio-kconfig"
            compile_cmd = [
                "cc",
                "-O2",
                "-I",
                str(config_dir),
                "-o",
                str(binary),
                str(exporter_source),
                *map(str, objects),
            ]
            compiled = subprocess.run(
                compile_cmd,
                cwd=root,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if compiled.returncode != 0:
                detail = decode_process_text(compiled.stderr or compiled.stdout).strip()
                return [], {}, f"OpenWrt Kconfig exporter compile failed: {detail[-1200:]}"

            env = os.environ.copy()
            env["srctree"] = str(root)
            exported = subprocess.run(
                [str(binary), "Config.in", ".config"],
                cwd=root,
                env=env,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            exported_stdout = decode_process_text(exported.stdout)
            exported_stderr = decode_process_text(exported.stderr)
            if exported.returncode != 0:
                detail = (exported_stderr or exported_stdout).strip()
                return [], {}, f"OpenWrt Kconfig exporter failed: {detail[-1200:]}" 

        features: list[dict[str, Any]] = []
        package_states: dict[str, dict[str, Any]] = {}
        seen: set[str] = set()
        for number, raw_line in enumerate(exported_stdout.splitlines(), 1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as error:
                return [], {}, f"OpenWrt Kconfig exporter invalid JSON at line {number}: {error}"

            name = str(item.get("name") or "")
            symbol = str(item.get("symbol") or "")
            if not name or not SYMBOL_RE.fullmatch(symbol) or symbol in seen:
                continue
            if name in {"MODULES", "HAVE_DOT_CONFIG"} or name.startswith("HOST_OS_"):
                continue

            seen.add(symbol)
            item["help"] = str(item.get("help") or "").strip()[:800]
            item["menuPath"] = [
                str(part)
                for part in (item.get("menuPath") or [])
                if str(part).strip()
            ][-8:]
            item["assignable"] = [
                str(value)
                for value in (item.get("assignable") or [])
                if str(value) in {"n", "m", "y"}
            ]
            item["potentialAssignable"] = [
                str(value)
                for value in (item.get("potentialAssignable") or [])
                if str(value) in {"n", "m", "y"}
            ]
            item["visible"] = bool(item.get("visible"))
            item["changeable"] = bool(item.get("changeable"))
            item["choiceValue"] = bool(item.get("choiceValue"))
            item["choicePrompt"] = str(item.get("choicePrompt") or "")

            if name.startswith("PACKAGE_"):
                package_states[name.removeprefix("PACKAGE_")] = item
                continue

            features.append(item)

        features.sort(
            key=lambda item: (
                tuple(item.get("menuPath") or []),
                str(item.get("prompt") or "").casefold(),
                str(item.get("name") or "").casefold(),
            )
        )
        return features, package_states, ""
    except subprocess.CalledProcessError as error:
        detail = decode_process_text(error.stderr or error.stdout or str(error)).strip()
        return [], {}, f"OpenWrt Kconfig prepare failed: {detail[-1200:]}"
    except Exception as error:
        return [], {}, f"OpenWrt Kconfig export failed: {type(error).__name__}: {error}"


def command_catalog(args: argparse.Namespace) -> None:
    root = Path(args.build_root).resolve()
    config_path = root / ".config"
    targetinfo = root / "tmp" / ".targetinfo"
    packageinfo = root / "tmp" / ".packageinfo"
    for path in (config_path, targetinfo, packageinfo):
        if not path.is_file():
            raise SystemExit(f"required OpenWrt metadata missing: {path}")

    config = parse_config_text(read_text(config_path))
    features, package_states, feature_error = kconfig_features(root)
    packages = parse_packageinfo(packageinfo, config)

    for package in packages:
        state = package_states.get(package["name"])
        if state:
            package["value"] = state["value"]
            package["selected"] = state["value"] in {"y", "m"}
            package["visible"] = state["visible"]
            package["changeable"] = state["changeable"]
            package["assignable"] = state["assignable"]
            package["menuPath"] = state["menuPath"]
        elif feature_error:
            # Degraded metadata-only fallback. A real Config Studio run should
            # normally have the native OpenWrt exporter available, but keeping
            # package metadata usable avoids turning the whole UI empty if the
            # exporter cannot be built on an unusual source tree.
            package["visible"] = True
            package["changeable"] = True
            package["menuPath"] = []
        else:
            package["visible"] = False
            package["changeable"] = False
            package["assignable"] = []
            package["menuPath"] = []

    attach_package_config_options(packages, package_states)

    dependency_condition_values: dict[str, str] = {}
    for package in packages:
        for name in dependency_condition_names(package["dependencyRules"]):
            symbol = f"CONFIG_{name}"
            dependency_condition_values[name] = config_value_for_json(
                config.get(symbol, "n")
            )

    categories = sorted(
        {
            item["category"]
            for item in packages
            if item["visible"] or item["selected"]
        },
        key=str.casefold,
    )
    payload = {
        "version": 3,
        "targets": parse_targetinfo(targetinfo, config),
        "packages": packages,
        "packageCategories": categories,
        "features": features,
        "dependencyConditionValues": dependency_condition_values,
        "featureCatalogError": feature_error,
        "configStats": {
            "symbols": len(config),
            "packages": len(packages),
            "packageOptions": sum(
                len(package.get("configOptions") or [])
                for package in packages
            ),
            "dependencyRules": sum(
                len(package.get("dependencyRules") or [])
                for package in packages
            ),
            "features": len(features),
        },
    }
    Path(args.output).write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def validated_values(payload: dict[str, Any]) -> dict[str, str]:
    selection = payload.get("selection") or {}
    values = selection.get("values") or {}
    if not isinstance(values, dict):
        raise SystemExit("selection.values must be an object")
    if len(values) > 20000:
        raise SystemExit("too many config selections")
    out: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str) or not SYMBOL_RE.fullmatch(key):
            raise SystemExit(f"invalid config symbol in request: {key!r}")
        text = str(value)
        if len(text.encode("utf-8")) > 4096:
            raise SystemExit(f"config value too large: {key}")
        out[key] = text
    return out


def command_seed(args: argparse.Namespace) -> None:
    request = json.loads(read_text(Path(args.request)))
    base = str(request.get("baseConfig") or "")
    values = parse_config_text(base)
    values.update(validated_values(request))
    lines = [encode_config_value(key, values[key]) for key in sorted(values)]
    Path(args.output).write_text("\n".join(lines) + "\n", encoding="utf-8")


def command_result(args: argparse.Namespace) -> None:
    request = json.loads(read_text(Path(args.request)))
    final_text = read_text(Path(args.config))
    final = parse_config_text(final_text)
    requested = validated_values(request)
    comparison = []
    honored = 0
    adjusted = 0
    for symbol, value in sorted(requested.items()):
        resolved_raw = final.get(symbol, "n")
        resolved = config_value_for_json(resolved_raw)
        same = str(resolved) == str(value)
        honored += int(same)
        adjusted += int(not same)
        comparison.append({
            "symbol": symbol,
            "requested": value,
            "resolved": resolved,
            "status": "honored" if same else "adjusted",
        })

    base = parse_config_text(str(request.get("baseConfig") or ""))
    base_packages = {
        key.removeprefix("CONFIG_PACKAGE_")
        for key, value in base.items()
        if key.startswith("CONFIG_PACKAGE_") and value in {"y", "m"}
    }
    selected_packages = {
        key.removeprefix("CONFIG_PACKAGE_")
        for key, value in final.items()
        if key.startswith("CONFIG_PACKAGE_") and value in {"y", "m"}
    }
    explicitly_enabled = {
        key.removeprefix("CONFIG_PACKAGE_")
        for key, value in requested.items()
        if key.startswith("CONFIG_PACKAGE_") and value in {"y", "m"}
    }
    explicitly_disabled = {
        key.removeprefix("CONFIG_PACKAGE_")
        for key, value in requested.items()
        if key.startswith("CONFIG_PACKAGE_") and value == "n"
    }

    added_packages = sorted(selected_packages - base_packages)
    removed_packages = sorted(base_packages - selected_packages)
    package_changes = [
        {
            "name": name,
            "change": "added",
            "reason": "requested" if name in explicitly_enabled else "dependency",
        }
        for name in added_packages
    ] + [
        {
            "name": name,
            "change": "removed",
            "reason": "requested" if name in explicitly_disabled else "dependency",
        }
        for name in removed_packages
    ]

    payload = {
        "version": 1,
        "requestId": request.get("requestId", ""),
        "finalConfig": final_text,
        "comparison": comparison,
        "selectedPackages": sorted(selected_packages),
        "packageChanges": package_changes,
        "summary": {
            "requested": len(requested),
            "honored": honored,
            "adjusted": adjusted,
            "finalSymbols": len(final),
            "selectedPackages": len(selected_packages),
            "packageAdded": len(added_packages),
            "packageRemoved": len(removed_packages),
            "packageDependencyAdded": sum(
                1
                for item in package_changes
                if item["change"] == "added" and item["reason"] == "dependency"
            ),
        },
    }
    Path(args.output).write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    catalog = sub.add_parser("catalog")
    catalog.add_argument("build_root")
    catalog.add_argument("output")
    catalog.set_defaults(func=command_catalog)

    seed = sub.add_parser("seed")
    seed.add_argument("request")
    seed.add_argument("output")
    seed.set_defaults(func=command_seed)

    result = sub.add_parser("result")
    result.add_argument("request")
    result.add_argument("config")
    result.add_argument("output")
    result.set_defaults(func=command_result)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
