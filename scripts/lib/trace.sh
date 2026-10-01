#!/usr/bin/env bash

trace_file_path="${OPENWRT_NG_TRACE_FILE:-${GITHUB_WORKSPACE:-$PWD}/.openwrt-ng-upstreams.env}"

_trace_validate_key() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

trace_set() {
  local key="$1"
  local value="$2"

  _trace_validate_key "$key" || {
    echo "ERROR: invalid trace key: $key" >&2
    return 1
  }

  mkdir -p "$(dirname "$trace_file_path")"
  touch "$trace_file_path"
  sed -i "/^$key=/d" "$trace_file_path"
  printf '%s=%s\n' "$key" "$value" >> "$trace_file_path"
  echo "上游追溯：$key=$value"
}

trace_git() {
  local key="$1"
  local repo_dir="$2"
  local commit

  [ -e "$repo_dir/.git" ] || {
    echo "ERROR: not a Git worktree: $repo_dir" >&2
    return 1
  }

  commit="$(git -C "$repo_dir" rev-parse HEAD)"
  [[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || {
    echo "ERROR: invalid Git commit for $key: $commit" >&2
    return 1
  }

  trace_set "$key" "$commit"
}

trace_file() {
  local key="$1"
  local file="$2"
  local digest

  [ -s "$file" ] || {
    echo "ERROR: trace file not found or empty: $file" >&2
    return 1
  }

  digest="$(sha256sum "$file" | awk '{print $1}')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    echo "ERROR: invalid SHA256 for $key: $digest" >&2
    return 1
  }

  trace_set "$key" "$digest"
}
