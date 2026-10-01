#!/usr/bin/env bash
set -Eeuo pipefail

build_root="${1:?build root is required}"
record_dir="${2:?config record directory is required}"
bundle_dir="${3:?bundle directory is required}"

assets_dir="$bundle_dir/assets"
rm -rf "$bundle_dir"
mkdir -p "$assets_dir"

target_root="$build_root/bin/targets"
[ -d "$target_root" ] || {
  echo "ERROR: target directory missing: $target_root" >&2
  exit 1
}

mapfile -t firmware_files < <(
  find "$target_root" -type f \(     -name '*.bin' -o     -name '*.img' -o     -name '*.img.gz' -o     -name '*.itb' -o     -name '*.trx' -o     -name '*.tar' -o     -name '*.tar.gz' -o     -name '*.ubi' -o     -name '*.ubifs' -o     -name '*.squashfs' -o     -name '*.iso' -o     -name '*.vdi' -o     -name '*.vmdk' -o     -name '*.vhdx' -o     -name '*.qcow2'   \) -print | sort
)

[ "${#firmware_files[@]}" -gt 0 ] || {
  echo "ERROR: no firmware image candidate found" >&2
  exit 1
}

declare -A seen=()
for file in "${firmware_files[@]}"; do
  base="$(basename "$file")"
  if [ -n "${seen[$base]:-}" ]; then
    echo "ERROR: duplicate release asset basename: $base" >&2
    echo "  first: ${seen[$base]}" >&2
    echo "  next : $file" >&2
    exit 1
  fi
  seen[$base]="$file"
  cp "$file" "$assets_dir/$base"
done

mapfile -t config_files < <(find "$record_dir" -maxdepth 1 -type f -print | sort)
[ "${#config_files[@]}" -gt 0 ] || {
  echo "ERROR: config record is empty" >&2
  exit 1
}
cp "${config_files[@]}" "$assets_dir/"

cat > "$bundle_dir/release.txt" <<EOF
OpenWrt NG 自动构建。

- Profile: ${PROFILE_ID:-unknown}
- Profile Name: ${PROFILE_NAME:-unknown}
- Source: ${SOURCE_REPO:-unknown} @ ${SOURCE_BRANCH:-unknown}
- Source Commit: ${SOURCE_COMMIT:-unknown}
- Workflow Run: #${GITHUB_RUN_NUMBER:-unknown}
EOF

echo "Release 固件文件：${#firmware_files[@]} 个"
find "$assets_dir" -maxdepth 1 -type f -printf '  - %f\n' | sort
