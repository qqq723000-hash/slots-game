#!/bin/sh
# 验证应用发布消费的是固定 S3 key 的最新版本，并把对象内容绑定到受保护 metadata。
# English: Verify that the application release is consuming the latest version of the pinned S3 key and bind the
# object content to protected metadata.
set -eu

fail() {
  printf '%s\n' "Terraform delivery 最新版本门禁失败：$*" >&2
  exit 1
}

test "$#" -eq 3 || fail '用法: verify-latest-terraform-delivery.sh <delivery.json> <get-object.json> <latest-head.json>'
delivery_file=$1
get_object_file=$2
latest_head_file=$3
test -f "$delivery_file" -a -f "$get_object_file" -a -f "$latest_head_file" || fail '输入文件不完整'

for name in AWS_TERRAFORM_DELIVERY_VERSION_ID AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN \
  INPUT_TARGET_ENVIRONMENT AWS_ACCOUNT_ID AWS_REGION
do
  value=$(printenv "$name" 2>/dev/null || true)
  test -n "$value" || fail "$name 未配置"
done

content_sha256=$(sha256sum "$delivery_file" | awk '{ print $1 }')
printf '%s\n' "$content_sha256" | grep -Eq '^[0-9a-f]{64}$' || fail 'delivery SHA-256 计算失败'

verify_object_metadata() {
  object_file=$1
  jq -e --arg version "$AWS_TERRAFORM_DELIVERY_VERSION_ID" \
    --arg kms "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN" --arg target "$INPUT_TARGET_ENVIRONMENT" \
    --arg account "$AWS_ACCOUNT_ID" --arg region "$AWS_REGION" --arg content_sha "$content_sha256" '
      .VersionId == $version and .ContentLength > 0 and
      .ContentType == "application/json" and .CacheControl == "no-store" and
      .ServerSideEncryption == "aws:kms" and .SSEKMSKeyId == $kms and
      .Metadata["schema-version"] == "1" and .Metadata["content-sha256"] == $content_sha and
      .Metadata["target-environment"] == $target and .Metadata["aws-account-id"] == $account and
      .Metadata["aws-region"] == $region and
      (.Metadata["source-sha"] | test("^[0-9a-f]{40}$")) and
      (.Metadata["plan-sha256"] | test("^[0-9a-f]{64}$"))
    ' "$object_file" >/dev/null || fail 'S3 对象版本、KMS 或 metadata 不可信'
}

verify_object_metadata "$latest_head_file"
verify_object_metadata "$get_object_file"
jq -e --slurpfile latest "$latest_head_file" '
  .VersionId == $latest[0].VersionId and .ContentLength == $latest[0].ContentLength and
  .ContentType == $latest[0].ContentType and .CacheControl == $latest[0].CacheControl and
  .ServerSideEncryption == $latest[0].ServerSideEncryption and .SSEKMSKeyId == $latest[0].SSEKMSKeyId and
  .Metadata == $latest[0].Metadata
' "$get_object_file" >/dev/null || fail 'get-object 与 latest head 身份不一致'

printf '%s\n' 'Terraform delivery 最新 VersionId 与内容 SHA-256 门禁通过。'
