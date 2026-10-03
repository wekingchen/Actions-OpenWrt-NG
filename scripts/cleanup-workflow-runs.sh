#!/usr/bin/env bash
set -Eeuo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

retention_days="${WORKFLOW_RETENTION_DAYS:-30}"
keep_minimum_runs="${WORKFLOW_KEEP_MINIMUM_RUNS:-10}"

if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || ! [[ "$keep_minimum_runs" =~ ^[0-9]+$ ]]; then
  echo "ERROR: WORKFLOW_RETENTION_DAYS / WORKFLOW_KEEP_MINIMUM_RUNS 必须是非负整数" >&2
  exit 2
fi

default_branch="$(gh api "repos/$repo" --jq '.default_branch')"
[ -n "$default_branch" ] || {
  echo "ERROR: 无法获取默认分支" >&2
  exit 1
}

current_workflows="$(mktemp)"
all_runs="$(mktemp)"
trap 'rm -f "$current_workflows" "$all_runs"' EXIT

gh api "repos/$repo/contents/.github/workflows?ref=$default_branch" \
  --jq '.[] | select(.type == "file") | select(.name | test("\\.(yml|yaml)$")) | .path' \
  | sort -u > "$current_workflows"

if [ ! -s "$current_workflows" ]; then
  echo "ERROR: 默认分支 $default_branch 未发现任何 Workflow，拒绝执行清理" >&2
  exit 1
fi

echo "当前默认分支：$default_branch"
echo "当前正式 Workflow："
sed 's/^/  - /' "$current_workflows"

gh api --paginate "repos/$repo/actions/runs?per_page=100" \
  --jq '.workflow_runs[] | [.id, .path, .status, .name] | @tsv' \
  > "$all_runs"

obsolete_deleted=0
obsolete_active=0
unknown_path=0

while IFS=$'\t' read -r run_id run_path run_status run_name; do
  [ -n "$run_id" ] || continue

  case "$run_path" in
    .github/workflows/*.yml|.github/workflows/*.yaml)
      ;;
    *)
      echo "跳过未知 Workflow 路径：$run_id | ${run_path:-<empty>} | $run_name"
      unknown_path=$((unknown_path + 1))
      continue
      ;;
  esac

  if grep -Fxq "$run_path" "$current_workflows"; then
    continue
  fi

  if [ "$run_status" != "completed" ]; then
    echo "跳过仍在运行的已删除 Workflow：$run_id | $run_path | $run_status | $run_name"
    obsolete_active=$((obsolete_active + 1))
    continue
  fi

  echo "删除已无对应 yml/yaml 的 Workflow Run：$run_id | $run_path | $run_name"
  gh api -X DELETE "repos/$repo/actions/runs/$run_id" --silent
  obsolete_deleted=$((obsolete_deleted + 1))
done < "$all_runs"

cutoff_epoch="$(date -u -d "$retention_days days ago" +%s)"
retention_deleted=0

while IFS=$'\t' read -r workflow_id workflow_path; do
  [ -n "$workflow_id" ] || continue
  grep -Fxq "$workflow_path" "$current_workflows" || continue

  mapfile -t runs < <(
    gh api --paginate "repos/$repo/actions/workflows/$workflow_id/runs?per_page=100" \
      --jq '.workflow_runs[] | [.id, .created_at, .status] | @tsv'
  )

  index=0
  for row in "${runs[@]}"; do
    index=$((index + 1))
    [ "$index" -le "$keep_minimum_runs" ] && continue

    run_id="$(printf '%s\n' "$row" | cut -f1)"
    created_at="$(printf '%s\n' "$row" | cut -f2)"
    run_status="$(printf '%s\n' "$row" | cut -f3)"

    [ "$run_status" = "completed" ] || continue

    created_epoch="$(date -u -d "$created_at" +%s)"
    [ "$created_epoch" -lt "$cutoff_epoch" ] || continue

    echo "删除过期 Workflow Run：$run_id | $workflow_path | $created_at"
    gh api -X DELETE "repos/$repo/actions/runs/$run_id" --silent
    retention_deleted=$((retention_deleted + 1))
  done
done < <(
  gh api --paginate "repos/$repo/actions/workflows?per_page=100" \
    --jq '.workflows[] | [.id, .path] | @tsv'
)

echo
echo "Workflow 历史清理完成："
echo "  已删除 workflow 的 completed runs：$obsolete_deleted"
echo "  已删除 workflow 的活动 runs（跳过）：$obsolete_active"
echo "  未知路径（跳过）：$unknown_path"
echo "  现存 workflow 的过期 runs：$retention_deleted"
echo "  保留策略：每个现存 workflow 至少 $keep_minimum_runs 条；仅清理 $retention_days 天前的额外记录"
