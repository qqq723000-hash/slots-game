#!/bin/sh
# 按固定 S3 VersionId 下载并回读验证 HMAC 停机证据；不读取 latest。
# English: Download and read-back verification HMAC outage evidence by fixed S3 VersionId; does not read latest.
set -eu

test "$#" -eq 2 || {
  printf '%s\n' '用法: download-hmac-quiesce-evidence.sh <consume|resume|finalize> <输出文件>' >&2
  exit 1
}
purpose=$1
output_file=$2
case "$purpose" in consume|resume|finalize) ;; *) printf '%s\n' '证据用途不合法' >&2; exit 1 ;; esac

AWS_BIN=${AWS_BIN:-aws}
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
head_file="${output_file}.head.json"
download_file="${output_file}.download"

cleanup() {
  rm -f "$head_file" "$download_file"
}
trap cleanup EXIT HUP INT TERM

test "${#INPUT_EVIDENCE_VERSION_ID}" -le 1024
printf '%s\n' "$INPUT_EVIDENCE_VERSION_ID" | grep -Eq '^[A-Za-z0-9._~+/=-]+$'
test "$INPUT_EVIDENCE_VERSION_ID" != null
printf '%s\n' "$INPUT_EVIDENCE_SHA256" | grep -Eq '^[0-9a-f]{64}$'
test "$("$AWS_BIN" s3api get-bucket-versioning \
  --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" --query Status --output text)" = Enabled

"$AWS_BIN" s3api head-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
  --key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" --version-id "$INPUT_EVIDENCE_VERSION_ID" \
  --output json > "$head_file"

repository_sha256=$(printf '%s' "$GITHUB_REPOSITORY" | sha256sum | awk '{ print $1 }')
workflow_ref_sha256=$(printf '%s' "$AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF" | sha256sum | awk '{ print $1 }')
producer_role_sha256=$(printf '%s' "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN" | sha256sum | awk '{ print $1 }')
# shellcheck disable=SC2016
jq -e \
  --arg version "$INPUT_EVIDENCE_VERSION_ID" \
  --arg sha "$INPUT_EVIDENCE_SHA256" \
  --arg kms "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN" \
  --arg environment "$TARGET_ENVIRONMENT" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_REGION" \
  --arg repository_sha "$repository_sha256" \
  --arg workflow_ref_sha "$workflow_ref_sha256" \
  --arg producer_role_sha "$producer_role_sha256" '
    .VersionId == $version and
    .ContentLength > 0 and
    .ContentType == "application/json" and
    .CacheControl == "no-store" and
    .ServerSideEncryption == "aws:kms" and
    .SSEKMSKeyId == $kms and
    .Metadata["schema-version"] == "slots-hmac-quiesce-v1" and
    .Metadata["content-sha256"] == $sha and
    .Metadata["target-environment"] == $environment and
    .Metadata["aws-account-id"] == $account and
    .Metadata["aws-region"] == $region and
    .Metadata["producer-repository-sha256"] == $repository_sha and
    .Metadata["producer-workflow-ref-sha256"] == $workflow_ref_sha and
    .Metadata["producer-role-arn-sha256"] == $producer_role_sha and
    (.Metadata["workflow-run-id"] | test("^[1-9][0-9]*$")) and
    (.Metadata["workflow-run-attempt"] | test("^[1-9][0-9]*$")) and
    (.Metadata["source-sha"] | test("^[0-9a-f]{40}$"))
  ' "$head_file" >/dev/null

"$AWS_BIN" s3api get-object --bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
  --key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" --version-id "$INPUT_EVIDENCE_VERSION_ID" \
  "$download_file" >/dev/null
actual_sha256=$(sha256sum "$download_file" | awk '{ print $1 }')
test "$actual_sha256" = "$INPUT_EVIDENCE_SHA256"
HMAC_EVIDENCE_EXPECTED_SHA256=$INPUT_EVIDENCE_SHA256 \
  ruby "$script_directory/verify-hmac-quiesce-evidence.rb" "$purpose" "$download_file" >/dev/null

observed_at=$(jq -er '.quiescence.observed_at' "$download_file")
expires_at=$(jq -er '.quiescence.expires_at' "$download_file")
jq -e --arg observed "$observed_at" --arg expires "$expires_at" '
  .Metadata["observed-at"] == $observed and .Metadata["expires-at"] == $expires
' "$head_file" >/dev/null

chmod 0600 "$download_file"
mv "$download_file" "$output_file"
trap - EXIT HUP INT TERM
rm -f "$head_file"
printf '%s\n' 'HMAC 停机证据固定版本下载与回读校验通过。'
