#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
log_file="${2:-${GITHUB_WORKSPACE:-$PWD}/build.log}"
failure_log="${3:-${GITHUB_WORKSPACE:-$PWD}/build-failure.log}"

jobs="${BUILD_JOBS:-$(nproc)}"
heartbeat_seconds="${HEARTBEAT_SECONDS:-300}"
diagnostic_timeout="${DIAGNOSTIC_TIMEOUT:-20m}"

cd "$build_root"

make_env=()
if [ -n "${MAKE_LD_LIBRARY_PATH_RELATIVE:-}" ]; then
  host_lib="$build_root/$MAKE_LD_LIBRARY_PATH_RELATIVE"
  make_env=(env "LD_LIBRARY_PATH=${host_lib}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}")
  echo "make 专用 LD_LIBRARY_PATH 前缀：$host_lib"
fi

started_at="${BUILD_STARTED_AT:-$(date +%s)}"

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

set +e
if [ "${STREAM_BUILD_LOG:-true}" = "true" ]; then
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
      last_line="$(tail -n 1 "$log_file" 2>/dev/null | tr '\n\r' '  ')"
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
  echo "固件编译成功。"
  echo "build.log 最后 40 行："
  tail -n 40 "$log_file" || true

  write_ccache_stats
  exit 0
fi

write_ccache_stats

echo "::group::并行编译错误摘要"
grep -nE '(^|[[:space:]])(fatal error:|error:|Error [0-9]+|FAILED:|No rule to make target|undefined reference)' "$log_file" | tail -n 200 || true
echo
echo "build.log 最后 200 行："
tail -n 200 "$log_file" || true
echo "::endgroup::"

failed_target="$(
  sed -nE 's/.*ERROR: ((package|tools|toolchain)\/[^[:space:]]+) failed to build.*/\1\/compile/p' "$log_file" |
  tail -n 1
)"

if [ -z "$failed_target" ]; then
  failed_target="$(
    grep -Eo '(package|tools|toolchain)/[^[:space:]]+/compile' "$log_file" |
    tail -n 1 || true
  )"
fi

echo "::group::失败目标诊断"
set +e
if [ -n "$failed_target" ]; then
  echo "检测到失败目标：$failed_target"
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout" \
    "${make_env[@]}" make "$failed_target" -j1 V=s > >(tee "$failure_log") 2>&1
  retry_status=$?
else
  echo "未能稳定识别 package / tools / toolchain 失败目标。"
  echo "执行有限时全量单线程诊断：$diagnostic_timeout"
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout" \
    "${make_env[@]}" make -j1 V=s > >(tee "$failure_log") 2>&1
  retry_status=$?
fi
set -e

if [ "$retry_status" -eq 124 ] || [ "$retry_status" -eq 137 ]; then
  echo "诊断达到超时上限：$diagnostic_timeout"
fi

echo
echo "build-failure.log 最后 300 行："
tail -n 300 "$failure_log" || true
echo "诊断退出状态：$retry_status"
echo "::endgroup::"

exit "$build_status"
