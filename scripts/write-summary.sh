#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:?summary mode is required}"
summary="${GITHUB_STEP_SUMMARY:-}"

[ -n "$summary" ] || exit 0

md_escape() {
  local value="${1:-}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  value="${value//|/\\|}"
  printf '%s' "$value"
}

short_sha() {
  local value="${1:-unknown}"
  if [[ "$value" =~ ^[0-9a-fA-F]{12,}$ ]]; then
    printf '%s' "${value:0:12}"
  else
    printf '%s' "$value"
  fi
}

bool_icon() {
  case "${1:-}" in
    true|success) printf '✅' ;;
    false|failure) printf '❌' ;;
    skipped) printf '➖' ;;
    *) printf '•' ;;
  esac
}

outcome_icon() {
  case "${1:-}" in
    success) printf '✅' ;;
    failure) printf '❌' ;;
    cancelled) printf '⛔' ;;
    skipped) printf '➖' ;;
    *) printf '•' ;;
  esac
}

cache_text() {
  case "${1:-}" in
    true) printf '命中 ✅' ;;
    false) printf '未命中' ;;
    *) printf '未执行 / 未知' ;;
  esac
}

run_url() {
  printf 'https://github.com/%s/actions/runs/%s'     "${GITHUB_REPOSITORY:-unknown}" "${GITHUB_RUN_ID:-unknown}"
}

append_header() {
  local title="$1"
  {
    echo "## $title"
    echo
  } >> "$summary"
}

case "$mode" in
  preflight)
    append_header "OpenWrt NG · 构建预检"

    {
      echo "| 项目 | 当前值 |"
      echo "|---|---|"
      printf '| Profile | %s · %s |\n'         "$(md_escape "${PROFILE_ID:-unknown}")"         "$(md_escape "${PROFILE_NAME:-unknown}")"
      printf '| 源码 | %s @ %s |\n'         "$(md_escape "${SOURCE_REPO:-unknown}")"         "$(md_escape "${SOURCE_BRANCH:-unknown}")"
      printf '| Adapter | %s |\n' "$(md_escape "${ADAPTER:-unknown}")"
      printf '| 触发方式 | %s |\n' "$(md_escape "${GITHUB_EVENT_NAME:-unknown}")"
      printf '| 自动追新 | %s %s |\n'         "$(bool_icon "${AUTO_UPDATE:-false}")"         "$(md_escape "${AUTO_UPDATE:-false}")"
      printf '| 扩展构建空间 | %s %s |\n'         "$(bool_icon "${MAXIMIZE_BUILD_SPACE:-false}")"         "$(md_escape "${MAXIMIZE_BUILD_SPACE:-false}")"
      printf '| 流式编译日志 | %s %s |\n'         "$(bool_icon "${STREAM_BUILD_LOG:-true}")"         "$(md_escape "${STREAM_BUILD_LOG:-true}")"
      printf '| 发布 Release | %s %s |\n'         "$(bool_icon "${UPLOAD_RELEASE:-false}")"         "$(md_escape "${UPLOAD_RELEASE:-false}")"
      echo
      printf '[查看本次运行](%s)\n' "$(run_url)"
    } >> "$summary"
    ;;

  build)
    append_header "OpenWrt NG · 构建结果"

    source_repo="${SOURCE_REPO:-unknown}"
    source_branch="${SOURCE_BRANCH:-unknown}"
    source_commit="${SOURCE_COMMIT:-unknown}"
    config_changed="unknown"
    config_added="unknown"
    config_removed="unknown"
    final_config_sha="unknown"

    if [ -s config-record/build-info.txt ]; then
      source_repo="$(sed -n 's/^source_repo=//p' config-record/build-info.txt | tail -n1)"
      source_branch="$(sed -n 's/^source_branch=//p' config-record/build-info.txt | tail -n1)"
      source_commit="$(sed -n 's/^source_commit=//p' config-record/build-info.txt | tail -n1)"
      final_config_sha="$(sed -n 's/^final_config_sha256=//p' config-record/build-info.txt | tail -n1)"
    fi

    if [ -s config-record/config-stats.env ]; then
      # shellcheck disable=SC1091
      source config-record/config-stats.env
      config_changed="${CONFIG_CHANGED:-unknown}"
      config_added="${CONFIG_ADDED:-unknown}"
      config_removed="${CONFIG_REMOVED:-unknown}"
    fi

    firmware_count=0
    if [ -d openwrt/bin/targets ]; then
      firmware_count="$(
        find openwrt/bin/targets -type f \(           -name '*.bin' -o -name '*.img' -o -name '*.img.gz' -o           -name '*.itb' -o -name '*.trx' -o -name '*.tar' -o           -name '*.tar.gz' -o -name '*.ubi' -o -name '*.ubifs' -o           -name '*.squashfs' -o -name '*.iso' -o -name '*.vdi' -o           -name '*.vmdk' -o -name '*.vhdx' -o -name '*.qcow2'         \) | wc -l | tr -d ' '
      )"
    fi

    compile_seconds=""
    if [[ "${BUILD_STARTED_AT:-}" =~ ^[0-9]+$ ]] &&
       [[ "${BUILD_FINISHED_AT:-}" =~ ^[0-9]+$ ]] &&
       [ "$BUILD_FINISHED_AT" -ge "$BUILD_STARTED_AT" ]; then
      compile_seconds="$((BUILD_FINISHED_AT - BUILD_STARTED_AT))"
    fi

    {
      echo "| 项目 | 当前值 |"
      echo "|---|---|"
      printf '| Profile | %s · %s |\n'         "$(md_escape "${PROFILE_ID:-unknown}")"         "$(md_escape "${PROFILE_NAME:-unknown}")"
      printf '| 源码 | %s @ %s |\n'         "$(md_escape "$source_repo")" "$(md_escape "$source_branch")"
      printf '| 源码 Commit | %s |\n' "$(short_sha "$source_commit")"
      printf '| Adapter | %s |\n' "$(md_escape "${ADAPTER:-unknown}")"
      printf '| dl 缓存 | %s |\n' "$(cache_text "${DL_CACHE_HIT:-}")"
      printf '| 编译缓存 | %s |\n' "$(cache_text "${BUILD_CACHE_HIT:-}")"
      if [ -n "$compile_seconds" ]; then
        printf '| 编译耗时 | %dm %02ds |\n'           "$((compile_seconds / 60))" "$((compile_seconds % 60))"
      fi
      printf '| 固件候选文件 | %s 个 |\n' "$firmware_count"
      printf '| 最终配置 SHA256 | %s |\n' "$(short_sha "$final_config_sha")"
      printf '| 配置变化 | changed=%s · added=%s · removed=%s |\n'         "$config_changed" "$config_added" "$config_removed"
      echo
      echo "### 阶段状态"
      echo
      echo "| 阶段 | 状态 |"
      echo "|---|---|"
      printf '| 编译 | %s %s |\n'         "$(outcome_icon "${COMPILE_OUTCOME:-}")"         "$(md_escape "${COMPILE_OUTCOME:-unknown}")"
      printf '| Manifest 验收 | %s %s |\n'         "$(outcome_icon "${MANIFEST_OUTCOME:-}")"         "$(md_escape "${MANIFEST_OUTCOME:-unknown}")"
      printf '| 配置留档 | %s %s |\n'         "$(outcome_icon "${CONFIG_OUTCOME:-}")"         "$(md_escape "${CONFIG_OUTCOME:-unknown}")"
      printf '| Release 交接包 | %s %s |\n'         "$(outcome_icon "${RELEASE_ASSETS_OUTCOME:-}")"         "$(md_escape "${RELEASE_ASSETS_OUTCOME:-unknown}")"
      echo
      printf '[查看本次运行](%s)\n' "$(run_url)"
    } >> "$summary"
    ;;

  release)
    append_header "OpenWrt NG · Release"

    tag="${RELEASE_TAG:-}"
    asset_count=0
    asset_size=0
    if [ -d release-bundle/assets ]; then
      asset_count="$(find release-bundle/assets -maxdepth 1 -type f | wc -l | tr -d ' ')"
      asset_size="$(find release-bundle/assets -maxdepth 1 -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
    fi

    {
      echo "| 项目 | 当前值 |"
      echo "|---|---|"
      printf '| 发布状态 | %s %s |\n'         "$(outcome_icon "${RELEASE_OUTCOME:-}")"         "$(md_escape "${RELEASE_OUTCOME:-unknown}")"
      printf '| Release Tag | %s |\n' "$(md_escape "${tag:-未生成}")"
      printf '| 附件 | %s 个 · %s bytes |\n' "$asset_count" "$asset_size"
      printf '| Workflow Run | #%s · %s |\n'         "$(md_escape "${GITHUB_RUN_NUMBER:-unknown}")"         "$(short_sha "${GITHUB_SHA:-unknown}")"
      echo
      if [ -n "$tag" ] && [ "${RELEASE_OUTCOME:-}" = "success" ]; then
        printf '[打开 Release](https://github.com/%s/releases/tag/%s) · '           "${GITHUB_REPOSITORY:-unknown}" "$tag"
      fi
      printf '[查看本次运行](%s)\n' "$(run_url)"
    } >> "$summary"
    ;;

  update)
    append_header "OpenWrt NG · 上游更新检查"

    cache_hit="${STATE_CACHE_HIT:-}"
    force="${FORCE_UPDATE:-false}"
    action="未触发构建"
    if [ "$force" = "true" ]; then
      action="强制触发构建"
    elif [ "$cache_hit" != "true" ]; then
      action="检测到新状态，触发构建"
    fi

    {
      echo "| 项目 | 当前值 |"
      echo "|---|---|"
      printf '| Profile | %s |\n' "$(md_escape "${PROFILE_ID:-unknown}")"
      printf '| 上游状态指纹 | %s |\n' "$(short_sha "${UPDATE_HASH:-unknown}")"
      printf '| 历史状态 | %s |\n' "$(cache_text "$cache_hit")"
      printf '| Force | %s %s |\n' "$(bool_icon "$force")" "$(md_escape "$force")"
      printf '| 本轮动作 | **%s** |\n' "$(md_escape "$action")"
      echo
      if [ -n "${CURRENT_UPDATE_STATE:-}" ] && [ -s "$CURRENT_UPDATE_STATE" ]; then
        echo "<details><summary>查看上游明细</summary>"
        echo
        echo "<pre>"
        sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' "$CURRENT_UPDATE_STATE"
        echo "</pre>"
        echo "</details>"
        echo
      fi
      printf '[查看本次运行](%s)\n' "$(run_url)"
    } >> "$summary"
    ;;

  recovery)
    append_header "OpenWrt NG · Release 恢复"

    tag="${RELEASE_TAG:-}"
    {
      echo "| 项目 | 当前值 |"
      echo "|---|---|"
      printf '| 来源 Run | #%s · %s |\n'         "$(md_escape "${SOURCE_RUN_NUMBER:-unknown}")"         "$(md_escape "${SOURCE_RUN_ID:-unknown}")"
      printf '| 来源 Commit | %s |\n' "$(short_sha "${SOURCE_HEAD_SHA:-unknown}")"
      printf '| 恢复发布 | %s %s |\n'         "$(outcome_icon "${RECOVERY_OUTCOME:-}")"         "$(md_escape "${RECOVERY_OUTCOME:-unknown}")"
      printf '| Release Tag | %s |\n' "$(md_escape "${tag:-未生成}")"
      echo
      if [ -n "$tag" ] && [ "${RECOVERY_OUTCOME:-}" = "success" ]; then
        printf '[打开 Release](https://github.com/%s/releases/tag/%s) · '           "${GITHUB_REPOSITORY:-unknown}" "$tag"
      fi
      printf '[查看本次运行](%s)\n' "$(run_url)"
    } >> "$summary"
    ;;

  *)
    echo "Usage: $0 {preflight|build|release|update|recovery}" >&2
    exit 2
    ;;
esac
