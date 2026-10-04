#!/usr/bin/env bash
set -Eeuo pipefail

command_name="${1:-validate}"
profile_id="${2:-default}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$profile_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "ERROR: invalid profile name: $profile_id" >&2
  exit 1
}

profile_dir="$root/profiles/$profile_id"
profile_file="$profile_dir/profile.env"

[ -f "$profile_file" ] || {
  echo "ERROR: profile not found: $profile_file" >&2
  exit 1
}

# shellcheck disable=SC1090
source "$profile_file"

required_vars=(SOURCE_REPO SOURCE_BRANCH ADAPTER CONFIG_FILE)
for key in "${required_vars[@]}"; do
  [ -n "${!key:-}" ] || {
    echo "ERROR: profile variable is empty: $key" >&2
    exit 1
  }
done

[[ "$ADAPTER" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "ERROR: invalid adapter name: $ADAPTER" >&2
  exit 1
}

resolve_path() {
  local value="${1:-}"
  [ -n "$value" ] || return 0
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$root" "$value"
  fi
}

CONFIG_FILE="$(resolve_path "$CONFIG_FILE")"
DIY_PART1="$(resolve_path "${DIY_PART1:-}")"
DIY_PART2="$(resolve_path "${DIY_PART2:-}")"
PREFLIGHT_SCRIPT="$(resolve_path "${PREFLIGHT_SCRIPT:-}")"
POST_FEEDS_SCRIPT="$(resolve_path "${POST_FEEDS_SCRIPT:-}")"
legacy_files_dir="${FILES_DIR:-}"
PROFILE_FILES_DIR="$(resolve_path "${PROFILE_FILES_DIR:-$legacy_files_dir}")"
unset FILES_DIR
REQUIRED_PACKAGES_FILE="$(resolve_path "${REQUIRED_PACKAGES_FILE:-}")"
WATCH_SOURCES_FILE="$(resolve_path "${WATCH_SOURCES_FILE:-}")"
EXTRA_FEEDS_FILE="$(resolve_path "${EXTRA_FEEDS_FILE:-}")"
ADAPTER_SCRIPT="$root/adapters/$ADAPTER.sh"
MAKE_LD_LIBRARY_PATH_RELATIVE="${MAKE_LD_LIBRARY_PATH_RELATIVE:-}"
PROFILE_NAME="${PROFILE_NAME:-$profile_id}"
AUTO_UPDATE="${AUTO_UPDATE:-false}"
MAXIMIZE_BUILD_SPACE="${MAXIMIZE_BUILD_SPACE:-false}"
STREAM_BUILD_LOG="${STREAM_BUILD_LOG:-false}"
UPLOAD_BIN_DIR="${UPLOAD_BIN_DIR:-false}"
UPLOAD_FIRMWARE="${UPLOAD_FIRMWARE:-true}"
UPLOAD_RELEASE="${UPLOAD_RELEASE:-true}"

[ -f "$CONFIG_FILE" ] || {
  echo "ERROR: config not found: $CONFIG_FILE" >&2
  exit 1
}
[ -x "$ADAPTER_SCRIPT" ] || {
  echo "ERROR: adapter is missing or not executable: $ADAPTER_SCRIPT" >&2
  exit 1
}

for optional_script in "$DIY_PART1" "$DIY_PART2" "$PREFLIGHT_SCRIPT" "$POST_FEEDS_SCRIPT"; do
  [ -z "$optional_script" ] || [ -f "$optional_script" ] || {
    echo "ERROR: DIY script not found: $optional_script" >&2
    exit 1
  }
done

if [ -n "$WATCH_SOURCES_FILE" ] && [ ! -f "$WATCH_SOURCES_FILE" ]; then
  echo "ERROR: watch sources file not found: $WATCH_SOURCES_FILE" >&2
  exit 1
fi

if [ -n "$EXTRA_FEEDS_FILE" ] && [ ! -f "$EXTRA_FEEDS_FILE" ]; then
  echo "ERROR: extra feeds file not found: $EXTRA_FEEDS_FILE" >&2
  exit 1
fi

if [ -n "$MAKE_LD_LIBRARY_PATH_RELATIVE" ]; then
  [[ "$MAKE_LD_LIBRARY_PATH_RELATIVE" != /* ]] || {
    echo "ERROR: MAKE_LD_LIBRARY_PATH_RELATIVE must be relative" >&2
    exit 1
  }
  [[ "/$MAKE_LD_LIBRARY_PATH_RELATIVE/" != *"/../"* ]] || {
    echo "ERROR: MAKE_LD_LIBRARY_PATH_RELATIVE must not contain .." >&2
    exit 1
  }
fi

for flag in AUTO_UPDATE MAXIMIZE_BUILD_SPACE STREAM_BUILD_LOG UPLOAD_BIN_DIR UPLOAD_FIRMWARE UPLOAD_RELEASE; do
  value="${!flag}"
  [[ "$value" = true || "$value" = false ]] || {
    echo "ERROR: $flag must be true/false, got: $value" >&2
    exit 1
  }
done

emit_env() {
  local key="$1"
  local value="$2"
  [ -n "${GITHUB_ENV:-}" ] || {
    echo "ERROR: GITHUB_ENV is not available" >&2
    exit 1
  }
  printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
}

case "$command_name" in
  validate)
    echo "Profile 校验通过：$profile_id"
    echo "  名称：$PROFILE_NAME"
    echo "  源码：$SOURCE_REPO @ $SOURCE_BRANCH"
    echo "  Adapter：$ADAPTER"
    echo "  配置：$CONFIG_FILE"
    ;;

  export)
    emit_env PROFILE_ID "$profile_id"
    emit_env PROFILE_NAME "$PROFILE_NAME"
    emit_env PROFILE_DIR "$profile_dir"
    emit_env SOURCE_REPO "$SOURCE_REPO"
    emit_env SOURCE_BRANCH "$SOURCE_BRANCH"
    emit_env ADAPTER "$ADAPTER"
    emit_env ADAPTER_SCRIPT "$ADAPTER_SCRIPT"
    emit_env CONFIG_FILE "$CONFIG_FILE"
    emit_env DIY_PART1 "$DIY_PART1"
    emit_env DIY_PART2 "$DIY_PART2"
    emit_env PREFLIGHT_SCRIPT "$PREFLIGHT_SCRIPT"
    emit_env POST_FEEDS_SCRIPT "$POST_FEEDS_SCRIPT"
    emit_env PROFILE_FILES_DIR "$PROFILE_FILES_DIR"
    emit_env REQUIRED_PACKAGES_FILE "$REQUIRED_PACKAGES_FILE"
    emit_env WATCH_SOURCES_FILE "$WATCH_SOURCES_FILE"
    emit_env EXTRA_FEEDS_FILE "$EXTRA_FEEDS_FILE"
    emit_env AUTO_UPDATE "$AUTO_UPDATE"
    emit_env MAKE_LD_LIBRARY_PATH_RELATIVE "$MAKE_LD_LIBRARY_PATH_RELATIVE"
    emit_env MAXIMIZE_BUILD_SPACE "$MAXIMIZE_BUILD_SPACE"
    emit_env STREAM_BUILD_LOG "$STREAM_BUILD_LOG"
    emit_env UPLOAD_BIN_DIR "$UPLOAD_BIN_DIR"
    emit_env UPLOAD_FIRMWARE "$UPLOAD_FIRMWARE"
    emit_env UPLOAD_RELEASE "$UPLOAD_RELEASE"
    echo "Profile 已导出到 GitHub Actions 环境：$profile_id"
    ;;

  *)
    echo "Usage: $0 {validate|export} [profile]" >&2
    exit 2
    ;;
esac
