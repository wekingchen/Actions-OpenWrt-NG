#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_root="${1:-}"
log_file="${2:-}"

[ -n "$build_root" ] || { echo "ERROR: build root missing" >&2; exit 1; }
[ -d "$build_root" ] || { echo "ERROR: build root not found: $build_root" >&2; exit 1; }

if [ -z "$log_file" ]; then
  log_file="$(mktemp)"
fi
mkdir -p "$(dirname "$log_file")"

cd "$build_root"

priority_report="${log_file%.log}-priority.json"
priority_mode="${FEED_PRIORITY_MODE:-per-package}"
python3 "$script_dir/resolve-feed-priority.py" "$build_root" \
  --mode "$priority_mode" \
  --report "$priority_report"

if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'FEED_PRIORITY_REPORT_FILE=%s\n' "$priority_report" >> "$GITHUB_ENV"
fi

set +e
./scripts/feeds install -a 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

echo
echo "=== OpenWrt core 覆盖摘要 ==="

override_count="$(grep -c '^Overriding core package ' "$log_file" 2>/dev/null || true)"
skip_count="$(grep -c 'Not overriding core package ' "$log_file" 2>/dev/null || true)"

echo "OpenWrt core 直接 override：$override_count"
if [ "$override_count" -gt 0 ]; then
  grep '^Overriding core package ' "$log_file" | sed 's/^/  ✓ /'
fi

echo "检测到未覆盖 core 同名包：$skip_count"
if [ "$skip_count" -gt 0 ]; then
  grep 'Not overriding core package ' "$log_file" | sed 's/^/  ! /'
  echo "提示：自定义 feed 若需要加入第三方优先规则，请在 feeds.conf 对应行加 --force。"
fi

exit "$status"
