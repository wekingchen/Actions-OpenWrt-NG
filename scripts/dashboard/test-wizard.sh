#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
profile_id="test-profile"

cleanup() {
  rm -rf "$tmp" "$root/profiles/$profile_id"
}
trap cleanup EXIT

cd "$root"

zip_file="$tmp/profile.zip"
extract_dir="$tmp/extracted"
mkdir -p "$extract_dir"

node scripts/dashboard/test-wizard.mjs "$zip_file"
unzip -t "$zip_file" >/dev/null
unzip -q "$zip_file" -d "$extract_dir"

profile_dir="$extract_dir/profiles/$profile_id"

test -f "$profile_dir/profile.env"
test -f "$profile_dir/.config"
test -f "$profile_dir/required-packages.txt"
test -f "$profile_dir/watch-sources.txt"
test -x "$profile_dir/diy-part1.sh"
test -x "$profile_dir/diy-part2.sh"

bash -n "$profile_dir/profile.env"
bash -n "$profile_dir/diy-part1.sh"
bash -n "$profile_dir/diy-part2.sh"

cp -a "$profile_dir" "$root/profiles/"

bash scripts/profile.sh validate "$profile_id"

github_env="$tmp/github.env"
: > "$github_env"
GITHUB_ENV="$github_env" bash scripts/profile.sh export "$profile_id"

grep -Fx "PROFILE_ID=$profile_id" "$github_env"
grep -Fx "AUTO_UPDATE=true" "$github_env"
grep -Fx "UPLOAD_RELEASE=true" "$github_env"
grep -Fx "PROFILE_NAME=Test Profile O'Reilly" "$github_env"

bash scripts/resolve-update-state.sh \
  "$profile_id" "$tmp/update-state.txt" >/dev/null

grep -q '^source|' "$tmp/update-state.txt"
grep -q '^packages|' "$tmp/update-state.txt"
[ "$(wc -l < "$tmp/update-state.txt" | tr -d ' ')" = "2" ]

fake_root="$tmp/fake-build"
mkdir -p "$fake_root/bin/targets/test/generic"
printf 'base-files - 1\ncurl - 1\nluci - 1\n' \
  > "$fake_root/bin/targets/test/generic/test.manifest"

bash scripts/validate-manifest.sh \
  "$fake_root" \
  "$profile_dir/required-packages.txt" \
  "$tmp/manifest-files.txt"

python3 - "$root/dashboard/wizard.html" "$root/dashboard/assets/wizard.js" <<'PY'
import re
import sys
from pathlib import Path

html = Path(sys.argv[1]).read_text()
js = Path(sys.argv[2]).read_text()

html_ids = set(re.findall(r'\bid="([^"]+)"', html))
js_ids = set(re.findall(r'\$\("([^"]+)"\)', js))
missing = sorted(js_ids - html_ids)
if missing:
    raise SystemExit(f"wizard.js references missing HTML ids: {missing}")

print(f"Wizard DOM contract OK: ids={len(js_ids)}")
PY

echo "Profile Wizard 集成测试通过"
