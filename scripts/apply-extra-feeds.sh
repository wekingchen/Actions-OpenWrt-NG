#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_root="${1:-}"
feeds_file="${2:-}"

[ -n "$build_root" ] || { echo "ERROR: build root missing" >&2; exit 1; }
[ -d "$build_root" ] || { echo "ERROR: build root not found: $build_root" >&2; exit 1; }

if [ -n "$feeds_file" ] && [ ! -f "$feeds_file" ]; then
  echo "ERROR: extra feeds file not found: $feeds_file" >&2
  exit 1
fi

# OpenWrt 优先读取 feeds.conf；源码没有自定义 feeds.conf 时才使用
# feeds.conf.default。无论是否配置额外 feeds，都做一次名称级归一化，
# 防止源码自身或第三方源出现 Duplicate feed name。
if [ -f "$build_root/feeds.conf" ]; then
  target="$build_root/feeds.conf"
else
  target="$build_root/feeds.conf.default"
  touch "$target"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

args=("$target" "--output" "$tmp")
if [ -n "$feeds_file" ] && [ -s "$feeds_file" ]; then
  args+=("--extra" "$feeds_file")
fi

python3 "$script_dir/merge-feeds.py" "${args[@]}"
cp "$tmp" "$target"

echo
if [ -n "$feeds_file" ] && [ -s "$feeds_file" ]; then
  echo "已应用额外 feeds，并按 feed name 自动去重：$feeds_file"
else
  echo "未配置额外 feeds；已检查源码 feeds 名称重复。"
fi
echo "Active feeds 文件：${target#$build_root/}"
