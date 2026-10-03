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
from pathlib import Path
from typing import Any

CONFIG_SET_RE = re.compile(r"^(CONFIG_[A-Za-z0-9_.+@/-]+)=(.*)$")
CONFIG_UNSET_RE = re.compile(r"^# (CONFIG_[A-Za-z0-9_.+@/-]+) is not set$")
SYMBOL_RE = re.compile(r"^CONFIG_[A-Za-z0-9_.+@/-]+$")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


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
    return value.replace("/", "_").replace(".", "_")


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

    visible: list[dict[str, Any]] = []
    for package in packages:
        if package["hidden"] or package["buildOnly"]:
            continue
        raw_value = config.get(package["symbol"], "n")
        package["value"] = config_value_for_json(raw_value)
        package["selected"] = raw_value in {"y", "m"}
        package["luciApp"] = package["name"].startswith("luci-app-")
        visible.append(package)
    return visible


def menu_path(node: Any) -> list[str]:
    out: list[str] = []
    parent = getattr(node, "parent", None)
    while parent is not None:
        prompt = getattr(parent, "prompt", None)
        if prompt and prompt[0]:
            out.append(str(prompt[0]))
        parent = getattr(parent, "parent", None)
    out.reverse()
    return out[-6:]


def kconfig_features(root: Path) -> tuple[list[dict[str, Any]], str]:
    try:
        import kconfiglib  # type: ignore
    except Exception as error:
        return [], f"kconfiglib unavailable: {error}"

    previous = Path.cwd()
    old_srctree = os.environ.get("srctree")
    try:
        os.chdir(root)
        os.environ["srctree"] = str(root)
        kconf = kconfiglib.Kconfig("Config.in", warn=False)
        kconf.load_config(".config", replace=True)

        features: list[dict[str, Any]] = []
        seen: set[str] = set()
        for symbol in kconf.unique_defined_syms:
            name = getattr(symbol, "name", None)
            if not name or name in seen:
                continue
            if (
                name.startswith("PACKAGE_")
                or name.startswith("TARGET_")
                or name.startswith("DEFAULT_")
                or name.startswith("MODULE_DEFAULT_")
            ):
                continue

            node = next(
                (
                    item
                    for item in symbol.nodes
                    if getattr(item, "prompt", None)
                    and item.prompt
                    and item.prompt[0]
                ),
                None,
            )
            if node is None:
                continue
            seen.add(name)
            symbol_name = "CONFIG_" + name
            type_name = kconfiglib.TYPE_TO_STR.get(symbol.type, "unknown")
            assignable = [
                kconfiglib.TRI_TO_STR[item]
                for item in getattr(symbol, "assignable", ())
                if item in kconfiglib.TRI_TO_STR
            ]
            help_text = (getattr(node, "help", None) or "").strip()
            features.append({
                "name": name,
                "symbol": symbol_name,
                "prompt": str(node.prompt[0]),
                "type": type_name,
                "value": symbol.str_value,
                "assignable": assignable,
                "visible": bool(symbol.visibility),
                "menuPath": menu_path(node),
                "help": help_text[:800],
            })
        features.sort(key=lambda item: (item["menuPath"], item["prompt"], item["name"]))
        return features, ""
    except Exception as error:
        return [], f"kconfig parse failed: {type(error).__name__}: {error}"
    finally:
        os.chdir(previous)
        if old_srctree is None:
            os.environ.pop("srctree", None)
        else:
            os.environ["srctree"] = old_srctree


def command_catalog(args: argparse.Namespace) -> None:
    root = Path(args.build_root).resolve()
    config_path = root / ".config"
    targetinfo = root / "tmp" / ".targetinfo"
    packageinfo = root / "tmp" / ".packageinfo"
    for path in (config_path, targetinfo, packageinfo):
        if not path.is_file():
            raise SystemExit(f"required OpenWrt metadata missing: {path}")

    config = parse_config_text(read_text(config_path))
    features, feature_error = kconfig_features(root)
    packages = parse_packageinfo(packageinfo, config)
    categories = sorted({item["category"] for item in packages}, key=str.casefold)
    payload = {
        "version": 1,
        "targets": parse_targetinfo(targetinfo, config),
        "packages": packages,
        "packageCategories": categories,
        "features": features,
        "featureCatalogError": feature_error,
        "configStats": {
            "symbols": len(config),
            "packages": len(packages),
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

    selected_packages = sorted(
        key.removeprefix("CONFIG_PACKAGE_")
        for key, value in final.items()
        if key.startswith("CONFIG_PACKAGE_") and value in {"y", "m"}
    )
    payload = {
        "version": 1,
        "requestId": request.get("requestId", ""),
        "finalConfig": final_text,
        "comparison": comparison,
        "selectedPackages": selected_packages,
        "summary": {
            "requested": len(requested),
            "honored": honored,
            "adjusted": adjusted,
            "finalSymbols": len(final),
            "selectedPackages": len(selected_packages),
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
