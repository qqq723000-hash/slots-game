#!/bin/sh

# 验证在线阶段确实取得官方 Trivy DB 与 checks bundle，并把本次动态内容身份写入证据。
# 仅依赖文件系统，可在负向测试中删除任一资产来证明离线扫描会失败关闭。
# English: Verify that the online phase obtained the official Trivy DB and checks bundle, then record the
# dynamic content identity as evidence. The check uses only the filesystem, so negative tests can delete either
# asset to prove that offline scanning fails closed.
set -eu

fail() {
  printf '%s\n' "Trivy asset verification: $*" >&2
  exit 1
}

test "$#" -eq 2 || fail 'usage: verify-trivy-assets.sh CACHE_DIR EVIDENCE_DIR'
cache_dir=$(CDPATH='' cd -- "$1" && pwd)
mkdir -p "$2"
evidence_dir=$(CDPATH='' cd -- "$2" && pwd)

command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
test -s "$cache_dir/db/metadata.json" || fail 'vulnerability DB metadata is missing'
test -s "$cache_dir/db/trivy.db" || fail 'vulnerability DB is missing'
test -s "$cache_dir/policy/metadata.json" || fail 'checks bundle metadata is missing'
test -d "$cache_dir/policy/content" || fail 'checks bundle content is missing'

grep -Eq '"Version"[[:space:]]*:[[:space:]]*2[[:space:]]*([,}])' "$cache_dir/db/metadata.json" || \
  fail 'vulnerability DB schema version is not the reviewed v2 format'
grep -Eq '"Digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]{64}"' "$cache_dir/policy/metadata.json" || \
  fail 'checks bundle metadata has no immutable digest'
grep -Eq '"MajorVersion"[[:space:]]*:[[:space:]]*2[[:space:]]*([,}])' "$cache_dir/policy/metadata.json" || \
  fail 'checks bundle major version is not the reviewed v2 format'
if grep -Eq '"CustomBuild"[[:space:]]*:[[:space:]]*true[[:space:]]*([,}])' "$cache_dir/policy/metadata.json"; then
  fail 'custom or unverifiable checks bundles are forbidden'
fi

policy_file_list="$evidence_dir/.trivy-checks-files"
policy_link_list="$evidence_dir/.trivy-checks-links"
(
  cd "$cache_dir/policy/content"
  find . -type f -print
) > "$policy_file_list" || fail 'cannot enumerate checks bundle content'
(
  cd "$cache_dir/policy/content"
  find . -type l -print
) > "$policy_link_list" || fail 'cannot inspect checks bundle symbolic links'
if test -s "$policy_link_list"; then
  fail 'checks bundle must not contain symbolic links'
fi
rm -f "$policy_link_list"

rego_count=$(grep -E -c '\.rego$' "$policy_file_list" || true)
test "$rego_count" -ge 100 || fail 'checks bundle content is incomplete'

canary_report="$evidence_dir/trivy-iac-canary.json"
test -s "$canary_report" || fail 'IaC canary report is missing'
grep -F '"Misconfigurations"' "$canary_report" >/dev/null || fail 'IaC canary report has no misconfiguration section'
grep -E '"ID"[[:space:]]*:[[:space:]]*"(AVD|KSV|DS|AWS|AZU|GCP)-?[A-Z0-9-]*"' "$canary_report" >/dev/null || \
  fail 'IaC canary produced no check finding'

cp "$cache_dir/db/metadata.json" "$evidence_dir/trivy-db-metadata.json"
cp "$cache_dir/policy/metadata.json" "$evidence_dir/trivy-checks-metadata.json"
sha256sum "$cache_dir/db/trivy.db" > "$evidence_dir/trivy-db.sha256"
LC_ALL=C sort "$policy_file_list" > "$policy_file_list.sorted"
: > "$evidence_dir/trivy-checks-files.sha256"
while IFS= read -r policy_file
do
  policy_digest=$(sha256sum "$cache_dir/policy/content/${policy_file#./}") || \
    fail "cannot hash checks bundle file $policy_file"
  policy_digest=${policy_digest%% *}
  printf '%s  %s\n' "$policy_digest" "$policy_file" >> "$evidence_dir/trivy-checks-files.sha256"
done < "$policy_file_list.sorted"
rm -f "$policy_file_list" "$policy_file_list.sorted"
sha256sum "$evidence_dir/trivy-checks-files.sha256" | \
  awk '{ print $1 "  policy/content" }' > "$evidence_dir/trivy-checks-content.sha256"

test -s "$evidence_dir/trivy-checks-content.sha256" || fail 'checks bundle content digest is empty'
printf '%s\n' 'Trivy asset verification: ok'
