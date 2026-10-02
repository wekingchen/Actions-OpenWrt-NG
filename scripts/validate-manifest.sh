#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
required_file="${2:-}"
record_file="${3:-${GITHUB_WORKSPACE:-$PWD}/manifest-files.txt}"

target_root="$build_root/bin/targets"
[ -d "$target_root" ] || {
  echo "ERROR: target output directory not found: $target_root" >&2
  exit 1
}

mapfile -t manifests < <(
  find "$target_root" -type f -name '*.manifest' ! -name 'Packages.manifest' -print | sort
)

[ "${#manifests[@]}" -gt 0 ] || {
  echo "ERROR: no image manifest found under $target_root" >&2
  exit 1
}

printf '%s\n' "${manifests[@]}" > "$record_file"

package_list="$(mktemp)"
trap 'rm -f "$package_list"' EXIT

for manifest in "${manifests[@]}"; do
  awk 'NF >= 3 && $2 == "-" {print $1}' "$manifest" >> "$package_list"
done
sort -u -o "$package_list" "$package_list"

required_packages=()
if [ -n "$required_file" ] && [ -f "$required_file" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | xargs)"
    [ -n "$line" ] && required_packages+=("$line")
  done < "$required_file"
fi

for package in "${required_packages[@]}"; do
  if ! grep -Fxq "$package" "$package_list"; then
    echo "ERROR: required package missing from image manifests: $package" >&2
    exit 1
  fi
  echo "通过  $package"
done

echo "固件 manifest 验收通过：${#manifests[@]} 个 image manifest"
