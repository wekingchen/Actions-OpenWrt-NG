#!/usr/bin/env bash
set -Eeuo pipefail

profile_id="${1:?profile id is required}"
output_file="${2:?output file is required}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$profile_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "ERROR: invalid profile id: $profile_id" >&2
  exit 1
}

profile_file="$root/profiles/$profile_id/profile.env"

[ -f "$profile_file" ] || {
  echo "ERROR: profile not found: $profile_file" >&2
  exit 1
}

# shellcheck disable=SC1090
source "$profile_file"

: "${SOURCE_REPO:?SOURCE_REPO is required}"
: "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"

resolve_path() {
  local value="${1:-}"
  [ -n "$value" ] || return 0
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$root" "$value"
  fi
}

resolve_ref() {
  local repo="$1"
  local ref="$2"
  local lines sha refname

  if [[ "$ref" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
    printf '%s\n' "${ref,,}"
    return 0
  fi

  if [[ "$ref" == refs/heads/* ]]; then
    lines="$(git ls-remote --exit-code "$repo" "$ref" 2>/dev/null || true)"
  elif [[ "$ref" == refs/tags/* ]]; then
    lines="$(git ls-remote --exit-code "$repo" "$ref" "$ref^{}" 2>/dev/null || true)"
  else
    lines="$(git ls-remote --exit-code "$repo" "refs/heads/$ref" 2>/dev/null || true)"
    if [ -z "$lines" ]; then
      lines="$(git ls-remote --exit-code "$repo" "refs/tags/$ref" "refs/tags/$ref^{}" 2>/dev/null || true)"
    fi
  fi

  [ -n "$lines" ] || {
    echo "ERROR: cannot resolve ref '$ref' from $repo" >&2
    return 1
  }

  sha=""
  while read -r candidate refname; do
    [ -n "$candidate" ] || continue
    [[ "$candidate" =~ ^[0-9a-fA-F]{40,64}$ ]] || continue

    # Annotated tag: prefer the dereferenced commit.
    if [[ "$refname" == *"^{}" ]]; then
      sha="$candidate"
      break
    fi

    [ -n "$sha" ] || sha="$candidate"
  done <<< "$lines"

  [[ "$sha" =~ ^[0-9a-fA-F]{40,64}$ ]] || {
    echo "ERROR: invalid resolved SHA for $repo @ $ref" >&2
    return 1
  }

  printf '%s\n' "${sha,,}"
}

tmp="${output_file}.tmp"
mkdir -p "$(dirname "$output_file")"
: > "$tmp"

declare -A labels=()

append_source() {
  local label="$1"
  local repo="$2"
  local ref="$3"
  local sha

  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "ERROR: invalid watch label: $label" >&2
    exit 1
  }
  [ -z "${labels[$label]:-}" ] || {
    echo "ERROR: duplicate watch label: $label" >&2
    exit 1
  }
  labels["$label"]=1

  sha="$(resolve_ref "$repo" "$ref")"
  printf '%s|%s|%s|%s\n' "$label" "$repo" "$ref" "$sha" >> "$tmp"
  echo "上游状态：$label -> $sha"
}

append_source "source" "$SOURCE_REPO" "$SOURCE_BRANCH"

watch_file="$(resolve_path "${WATCH_SOURCES_FILE:-}")"
if [ -n "$watch_file" ]; then
  [ -f "$watch_file" ] || {
    echo "ERROR: watch sources file not found: $watch_file" >&2
    exit 1
  }

  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$line" ] || continue

    IFS='|' read -r label repo_url ref extra <<< "$line"
    if [ -n "${extra:-}" ] || [ -z "${label:-}" ] || [ -z "${repo_url:-}" ] || [ -z "${ref:-}" ]; then
      echo "ERROR: invalid watch source line: $raw" >&2
      echo "Expected: label|git_url|branch_or_tag" >&2
      exit 1
    fi

    label="$(printf '%s' "$label" | xargs)"
    repo_url="$(printf '%s' "$repo_url" | xargs)"
    ref="$(printf '%s' "$ref" | xargs)"

    append_source "$label" "$repo_url" "$ref"
  done < "$watch_file"
fi

sort -o "$tmp" "$tmp"
mv "$tmp" "$output_file"

digest="$(sha256sum "$output_file" | awk '{print $1}')"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
  echo "ERROR: invalid update-state digest" >&2
  exit 1
}

echo "上游状态指纹：$digest"
printf '%s\n' "$digest"
