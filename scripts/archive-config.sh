#!/usr/bin/env bash
set -Eeuo pipefail

baseline_config="${1:?baseline config is required}"
final_config="${2:?final config is required}"
build_root="${3:?build root is required}"
record_dir="${4:?record directory is required}"

[ -s "$baseline_config" ] || {
  echo "ERROR: baseline config missing: $baseline_config" >&2
  exit 1
}
[ -s "$final_config" ] || {
  echo "ERROR: final config missing: $final_config" >&2
  exit 1
}

rm -rf "$record_dir"
mkdir -p "$record_dir"

cp "$baseline_config" "$record_dir/repository.config"
cp "$final_config" "$record_dir/final.config"

if [ -x "$build_root/scripts/diffconfig.sh" ]; then
  (
    cd "$build_root"
    ./scripts/diffconfig.sh
  ) > "$record_dir/diffconfig.txt"
else
  echo "# scripts/diffconfig.sh unavailable" > "$record_dir/diffconfig.txt"
fi

python3 - "$record_dir/repository.config" "$record_dir/final.config"   "$record_dir/config-changes.diff" "$record_dir/config-stats.env" <<'PY'
import re
import sys
from pathlib import Path

base_path, final_path, diff_path, stats_path = map(Path, sys.argv[1:])

def parse(path: Path):
    result = {}
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("CONFIG_") and "=" in line:
            key = line.split("=", 1)[0]
            result[key] = line
            continue
        m = re.match(r"# (CONFIG_[A-Za-z0-9_]+) is not set$", line)
        if m:
            result[m.group(1)] = line
    return result

base = parse(base_path)
final = parse(final_path)

added = []
removed = []
changed = []

for key in sorted(set(base) | set(final)):
    old = base.get(key)
    new = final.get(key)
    if old is None:
        added.append((key, new))
    elif new is None:
        removed.append((key, old))
    elif old != new:
        changed.append((key, old, new))

lines = []
for key, old, new in changed:
    lines += [f"~ {key}", f"- {old}", f"+ {new}", ""]
for key, new in added:
    lines += [f"+ {new}", ""]
for key, old in removed:
    lines += [f"- {old}", ""]

diff_path.write_text("\n".join(lines))
stats_path.write_text(
    f"CONFIG_CHANGED={len(changed)}\n"
    f"CONFIG_ADDED={len(added)}\n"
    f"CONFIG_REMOVED={len(removed)}\n"
)
PY

# GitHub Release 上传 API 对 0 字节附件并不可靠。
# 无语义配置变化时仍保留 diff 文件，但写入一行可读说明。
if [ ! -s "$record_dir/config-changes.diff" ]; then
  echo "# No semantic CONFIG changes." > "$record_dir/config-changes.diff"
fi

final_sha="$(sha256sum "$record_dir/final.config" | awk '{print $1}')"

cat > "$record_dir/build-info.txt" <<EOF
repository=${GITHUB_REPOSITORY:-local}
source_repo=${SOURCE_REPO:-unknown}
source_branch=${SOURCE_BRANCH:-unknown}
source_commit=${SOURCE_COMMIT:-unknown}
workflow_run=${GITHUB_RUN_NUMBER:-local}
workflow_run_id=${GITHUB_RUN_ID:-local}
workflow_attempt=${GITHUB_RUN_ATTEMPT:-local}
profile=${PROFILE_ID:-unknown}
profile_name=${PROFILE_NAME:-unknown}
adapter=${ADAPTER:-unknown}
feed_fingerprint=${FEED_FINGERPRINT:-unknown}
feed_priority_mode=${FEED_PRIORITY_MODE:-per-package}
build_cache_fingerprint=${BUILD_CACHE_FINGERPRINT:-unknown}
final_config_sha256=$final_sha
EOF

trace_file="${GITHUB_WORKSPACE:-$PWD}/.openwrt-ng-upstreams.env"
if [ -s "$trace_file" ]; then
  cat "$trace_file" >> "$record_dir/build-info.txt"
fi

feed_commits_file="${FEED_COMMITS_FILE:-}"
if [ -n "$feed_commits_file" ] && [ -s "$feed_commits_file" ]; then
  cp "$feed_commits_file" "$record_dir/feed-commits.txt"
else
  echo "# feed commit detail unavailable" > "$record_dir/feed-commits.txt"
fi

feed_priority_report="${FEED_PRIORITY_REPORT_FILE:-}"
if [ -n "$feed_priority_report" ] && [ -s "$feed_priority_report" ]; then
  cp "$feed_priority_report" "$record_dir/feed-priority.json"
else
  printf '%s\n' '{"mode":"unknown","decisionCount":0,"note":"feed priority report unavailable"}' > "$record_dir/feed-priority.json"
fi

if [ -n "${MANIFEST_RECORD_FILE:-}" ] && [ -s "$MANIFEST_RECORD_FILE" ]; then
  cp "$MANIFEST_RECORD_FILE" "$record_dir/manifest-files.txt"
fi

echo "generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$record_dir/build-info.txt"

cat > "$record_dir/README.txt" <<'EOF'
OpenWrt NG 构建留档

repository.config
  仓库/Profile 提供的本轮基准 .config。

final.config
  DIY Hook 与 make defconfig 后真正参与编译的配置。

diffconfig.txt
  OpenWrt scripts/diffconfig.sh 输出。

config-changes.diff
  repository.config 与 final.config 的 CONFIG symbol 语义差异。

config-stats.env
  CONFIG_CHANGED / CONFIG_ADDED / CONFIG_REMOVED。

build-info.txt
  源码、Profile、Adapter、feed/build cache 指纹、最终配置 SHA256，以及 DIY 主动登记的动态上游 commit / SHA256。

feed-commits.txt
  本轮 feeds update 后各真实 Git feed 的实际 HEAD commit。

feed-priority.json
  本轮第三方优先 feed 的冲突策略、胜出 feed、被替换项、不安全 source 冲突与跨 feed 依赖告警。

排障建议：
  1. 先比较 source_commit。
  2. 再比较 build-info.txt 中登记的动态上游。
  3. feed_fingerprint 不同时比较 feed-commits.txt。
  4. 再比较 final_config_sha256 / config-changes.diff。
  5. 都相同时再检查 Runner、下载、缓存或工具链环境。
EOF

# shellcheck disable=SC1090
source "$record_dir/config-stats.env"

echo "最终 .config SHA256：$final_sha"
echo "配置差异：changed=$CONFIG_CHANGED added=$CONFIG_ADDED removed=$CONFIG_REMOVED"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### OpenWrt NG 配置留档"
    echo
    printf '%s\n' "- Profile：\`${PROFILE_ID:-unknown}\`"
    printf '%s\n' "- 最终配置 SHA256：\`$final_sha\`"
    echo "- changed：$CONFIG_CHANGED"
    echo "- added：$CONFIG_ADDED"
    echo "- removed：$CONFIG_REMOVED"
  } >> "$GITHUB_STEP_SUMMARY"
fi
