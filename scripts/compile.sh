#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
log_file="${2:-${GITHUB_WORKSPACE:-$PWD}/build.log}"
failure_log="${3:-${GITHUB_WORKSPACE:-$PWD}/build-failure.log}"
context_log="${4:-${GITHUB_WORKSPACE:-$PWD}/build-error-context.log}"

jobs="${BUILD_JOBS:-$(nproc)}"
heartbeat_seconds="${HEARTBEAT_SECONDS:-300}"
diagnostic_timeout="${DIAGNOSTIC_TIMEOUT:-20m}"
debug_stream="${OPENWRT_NG_DEBUG_STREAM_LOG:-false}"

cd "$build_root"

# OpenWrt 内核构建内部使用 FILES_DIR 指向 target/linux/<target>/files。
# 不允许 Profile 或外部环境变量覆盖它，否则平台内核附加文件不会复制进构建树。
unset FILES_DIR

make_env=()
if [ -n "${MAKE_LD_LIBRARY_PATH_RELATIVE:-}" ]; then
  host_lib="$build_root/$MAKE_LD_LIBRARY_PATH_RELATIVE"
  make_env=(env "LD_LIBRARY_PATH=${host_lib}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}")
  echo "make 专用 LD_LIBRARY_PATH 前缀：$host_lib"
fi

started_at="${BUILD_STARTED_AT:-$(date +%s)}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ccache_bin=""
if [ -x staging_dir/host/bin/ccache ]; then
  ccache_bin="staging_dir/host/bin/ccache"
elif command -v ccache >/dev/null 2>&1; then
  ccache_bin="$(command -v ccache)"
fi

write_ccache_stats() {
  [ -n "$ccache_bin" ] || return 0

  echo "=== OpenWrt ccache 本轮统计 ==="
  echo "CCACHE_DIR=$PWD/.ccache"
  du -sh .ccache 2>/dev/null || true
  CCACHE_DIR="$PWD/.ccache" "$ccache_bin" -s |
    tee "${GITHUB_WORKSPACE:-$PWD}/ccache-stats.txt" || true
}

extract_context() {
  local source_log="$1"
  local destination="$2"

  : > "$destination"
  if [ -s "$source_log" ]; then
    python3 "$script_dir/extract_failure_context.py" "$source_log" > "$destination" 2>/dev/null ||
      tail -n 160 "$source_log" > "$destination" || true
  fi
}

if [ -n "$ccache_bin" ]; then
  mkdir -p .ccache
  echo "=== OpenWrt ccache 编译前状态 ==="
  echo "CCACHE_DIR=$PWD/.ccache"
  du -sh .ccache 2>/dev/null || true
  CCACHE_DIR="$PWD/.ccache" "$ccache_bin" -s || true
  CCACHE_DIR="$PWD/.ccache" "$ccache_bin" -z || true
fi

echo "并行编译：$jobs 线程"
echo "心跳周期：$heartbeat_seconds 秒"
if [ "$debug_stream" = "true" ]; then
  echo "编译日志策略：DEBUG 全量流式输出"
else
  echo "编译日志策略：静默编译；仅心跳与失败上下文写入 GitHub 日志"
fi

: > "$log_file"
: > "$failure_log"
: > "$context_log"

set +e
if [ "$debug_stream" = "true" ]; then
  "${make_env[@]}" make -j"$jobs" > >(tee "$log_file") 2>&1 &
else
  "${make_env[@]}" make -j"$jobs" > "$log_file" 2>&1 &
fi
build_pid=$!

(
  while kill -0 "$build_pid" 2>/dev/null; do
    sleep "$heartbeat_seconds"
    if kill -0 "$build_pid" 2>/dev/null; then
      elapsed=$(( $(date +%s) - started_at ))
      log_size="$(du -h "$log_file" 2>/dev/null | awk '{print $1}')"
      log_mtime="$(stat -c '%y' "$log_file" 2>/dev/null | cut -d'.' -f1)"
      last_line="$(
        tail -n 1 "$log_file" 2>/dev/null |
          tr '\n\r' '  ' |
          cut -c1-240
      )"
      printf '编译心跳：%d 分钟 | build.log=%s | mtime=%s | %s\n' \
        "$((elapsed / 60))" \
        "${log_size:-0}" \
        "${log_mtime:-unknown}" \
        "${last_line:-暂无新日志}"
    fi
  done
) &
heartbeat_pid=$!

wait "$build_pid"
build_status=$?
kill "$heartbeat_pid" 2>/dev/null || true
wait "$heartbeat_pid" 2>/dev/null || true
set -e

if [ "$build_status" -eq 0 ]; then
  elapsed=$(( $(date +%s) - started_at ))
  log_size="$(du -h "$log_file" 2>/dev/null | awk '{print $1}')"
  echo "固件编译成功：耗时 $((elapsed / 60)) 分 $((elapsed % 60)) 秒，完整 make 日志仅保存在 Runner 临时文件（${log_size:-0}）。"

  write_ccache_stats
  exit 0
fi

write_ccache_stats

failed_target="$(
  python3 "$script_dir/detect_failed_target.py" "$log_file"
)"

if [ -z "$failed_target" ]; then
  failed_target="$(
    grep -Eo '(package|tools|toolchain)/[^[:space:]]+/(host/)?compile' "$log_file" |
    tail -n 1 || true
  )"
fi

parallel_context="$(mktemp)"
extract_context "$log_file" "$parallel_context"

{
  echo "=== 并行编译失败上下文 ==="
  if [ -s "$parallel_context" ]; then
    cat "$parallel_context"
  else
    echo "未提取到可显示的失败上下文。"
  fi
} > "$context_log"

echo "::group::并行编译失败上下文"
if [ -n "$failed_target" ]; then
  echo "检测到失败目标：$failed_target"
else
  echo "未能稳定识别 package / tools / toolchain 失败目标。"
fi
cat "$parallel_context" || true
echo "::endgroup::"

echo "::group::失败目标诊断"
set +e
if [ -n "$failed_target" ]; then
  echo "运行有限时单目标诊断：$failed_target · $diagnostic_timeout"
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout" \
    "${make_env[@]}" make "$failed_target" -j1 V=s > "$failure_log" 2>&1
  retry_status=$?
else
  echo "执行有限时全量单线程诊断：$diagnostic_timeout"
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout" \
    "${make_env[@]}" make -j1 V=s > "$failure_log" 2>&1
  retry_status=$?
fi
set -e

if [ "$retry_status" -eq 124 ] || [ "$retry_status" -eq 137 ]; then
  echo "诊断达到超时上限：$diagnostic_timeout"
fi

diagnostic_context="$(mktemp)"
extract_context "$failure_log" "$diagnostic_context"

echo "诊断退出状态：$retry_status"
echo "以下仅显示诊断错误上下文，不输出完整 V=s 日志："
cat "$diagnostic_context" || true
echo "::endgroup::"

{
  echo
  echo "=== 单目标/单线程诊断上下文 ==="
  if [ -s "$diagnostic_context" ]; then
    cat "$diagnostic_context"
  else
    echo "未提取到可显示的诊断上下文。"
  fi
  echo
  echo "诊断退出状态：$retry_status"
} >> "$context_log"

rm -f "$parallel_context" "$diagnostic_context"

exit "$build_status"
