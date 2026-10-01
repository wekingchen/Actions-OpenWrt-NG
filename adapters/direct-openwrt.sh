#!/usr/bin/env bash
set -Eeuo pipefail

command_name="${1:-}"
workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
build_root="$workspace/openwrt"

case "$command_name" in
  install-deps)
    # 标准 OpenWrt/Lean 不需要 Adapter 额外安装依赖。
    ;;

  prepare)
    : "${SOURCE_REPO:?SOURCE_REPO is required}"
    : "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"

    rm -rf "$build_root"

    echo "克隆源码：$SOURCE_REPO @ $SOURCE_BRANCH"
    git clone --depth=1 --branch "$SOURCE_BRANCH" "$SOURCE_REPO" "$build_root"

    source_commit="$(git -C "$build_root" rev-parse HEAD)"
    [[ "$source_commit" =~ ^[0-9a-f]{40,64}$ ]] || {
      echo "ERROR: invalid source commit: $source_commit" >&2
      exit 1
    }

    export SOURCE_COMMIT="$source_commit"
    if [ -n "${GITHUB_ENV:-}" ]; then
      printf 'SOURCE_COMMIT=%s\n' "$source_commit" >> "$GITHUB_ENV"
    fi

    echo "源码准备完成：$source_commit"
    ;;

  *)
    echo "Usage: $0 {install-deps|prepare}" >&2
    exit 2
    ;;
esac
