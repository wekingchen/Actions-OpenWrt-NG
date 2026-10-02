#!/usr/bin/env bash
set -Eeuo pipefail

# 在 feeds install + .config 写入后、make defconfig 前执行。
# 默认 Profile 不做额外修改。
#
# 如需记录直接追踪的动态上游：
# source "$GITHUB_WORKSPACE/scripts/lib/trace.sh"
# trace_git upstream_example_commit /path/to/repo
# trace_file upstream_example_sha256 /path/to/file
