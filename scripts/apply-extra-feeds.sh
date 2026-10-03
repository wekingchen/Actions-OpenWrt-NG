#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:-}"
feeds_file="${2:-}"

[ -n "$build_root" ] || { echo "ERROR: build root missing" >&2; exit 1; }
[ -d "$build_root" ] || { echo "ERROR: build root not found: $build_root" >&2; exit 1; }

if [ -z "$feeds_file" ] || [ ! -s "$feeds_file" ]; then
  echo "未配置额外 feeds，使用源码默认 feeds.conf.default"
  exit 0
fi

[ -f "$feeds_file" ] || { echo "ERROR: extra feeds file not found: $feeds_file" >&2; exit 1; }

target="$build_root/feeds.conf.default"
touch "$target"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# 用户额外 feeds 放在顶部，和 OpenWrt-Passwall 等项目的官方说明保持一致。
{
  grep -vE '^[[:space:]]*(#|$)' "$feeds_file" || true
  printf '\n'
  cat "$target"
} > "$tmp"

cp "$tmp" "$target"
echo "已应用额外 feeds：$feeds_file"
grep -vE '^[[:space:]]*(#|$)' "$feeds_file" | sed 's/^/  + /' || true
