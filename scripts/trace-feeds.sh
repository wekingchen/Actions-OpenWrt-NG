#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
output_file="${2:?output file is required}"

[ -d "$build_root/feeds" ] || {
  echo "ERROR: feeds directory not found: $build_root/feeds" >&2
  exit 1
}

tmp="${output_file}.tmp"
: > "$tmp"

for feed in "$build_root"/feeds/*; do
  [ -d "$feed" ] || continue

  # 只记录自身就是 Git 仓库/worktree 的真实 feed。
  # 防止 feeds/*.tmp 等普通目录向父级查找 .git 后误记根仓库 HEAD。
  [ -e "$feed/.git" ] || continue

  commit="$(git -C "$feed" rev-parse HEAD)"
  [[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || {
    echo "ERROR: invalid feed commit: $feed -> $commit" >&2
    exit 1
  }

  printf '%s=%s\n' "$(basename "$feed")" "$commit" >> "$tmp"
done

sort -o "$tmp" "$tmp"
mv "$tmp" "$output_file"

echo "Feeds 实际 commit："
if [ -s "$output_file" ]; then
  cat "$output_file"
else
  echo "  （没有发现 Git feed）"
fi
