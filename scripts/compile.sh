#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
log_file="${2:-${GITHUB_WORKSPACE:-$PWD}/build.log}"
failure_log="${3:-${GITHUB_WORKSPACE:-$PWD}/build-failure.log}"

jobs="${BUILD_JOBS:-$(nproc)}"
heartbeat_seconds="${HEARTBEAT_SECONDS:-300}"
diagnostic_timeout="${DIAGNOSTIC_TIMEOUT:-20m}"

cd "$build_root"

echo "并行编译：$jobs 线程"
echo "心跳周期：$heartbeat_seconds 秒"

set +e
make -j"$jobs" > >(tee "$log_file") 2>&1 &
build_pid=$!

(
  while kill -0 "$build_pid" 2>/dev/null; do
    sleep "$heartbeat_seconds"
    if kill -0 "$build_pid" 2>/dev/null; then
      elapsed=$(( $(date +%s) - ${BUILD_STARTED_AT:-$(date +%s)} ))
      printf '编译心跳：仍在运行，已持续约 %d 分钟\n' "$((elapsed / 60))"
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
  command -v ccache >/dev/null 2>&1 && ccache -s || true
  exit 0
fi

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
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout"     make "$failed_target" -j1 V=s > >(tee "$failure_log") 2>&1
  retry_status=$?
else
  echo "未能稳定识别 package / tools / toolchain 失败目标。"
  echo "执行有限时全量单线程诊断：$diagnostic_timeout"
  timeout --signal=TERM --kill-after=1m "$diagnostic_timeout"     make -j1 V=s > >(tee "$failure_log") 2>&1
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
