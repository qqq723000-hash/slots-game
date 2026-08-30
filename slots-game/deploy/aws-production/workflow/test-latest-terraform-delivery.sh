#!/bin/sh
# 使用本地 JSON fixture 证明普通发布也会拒绝旧 delivery VersionId 与内容漂移。
# English: Use local JSON fixture to demonstrate that normal releases also reject old delivery VersionIds with
# content drift.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/slots-latest-delivery-test.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT

fail() {
  printf '%s\n' "Terraform delivery 最新版本 fixture 失败：$*" >&2
  exit 1
}

delivery="$script_directory/fixtures/live-delivery.json"
object="$temporary_directory/object.json"
head="$temporary_directory/head.json"
export AWS_TERRAFORM_DELIVERY_VERSION_ID=delivery-version-9
export AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN=arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111
export INPUT_TARGET_ENVIRONMENT=prod-primary
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=ap-southeast-1
sha=$(sha256sum "$delivery" | awk '{ print $1 }')
jq -n --arg version "$AWS_TERRAFORM_DELIVERY_VERSION_ID" \
  --arg kms "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN" --arg sha "$sha" '{
    VersionId: $version, ContentLength: 4096, ContentType: "application/json", CacheControl: "no-store",
    ServerSideEncryption: "aws:kms", SSEKMSKeyId: $kms,
    Metadata: {"schema-version": "1", "content-sha256": $sha,
      "target-environment": "prod-primary", "aws-account-id": "123456789012",
      "aws-region": "ap-southeast-1", "source-sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "plan-sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
  }' > "$object"
cp "$object" "$head"
"$script_directory/verify-latest-terraform-delivery.sh" "$delivery" "$object" "$head" >/dev/null

jq '.VersionId = "delivery-version-10"' "$head" > "$temporary_directory/stale-head.json"
if "$script_directory/verify-latest-terraform-delivery.sh" \
  "$delivery" "$object" "$temporary_directory/stale-head.json" >/dev/null 2>&1; then
  fail '普通发布仍接受受保护 Environment 中的旧 VersionId'
fi

jq '.Metadata["content-sha256"] = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  "$head" > "$temporary_directory/wrong-sha-head.json"
if "$script_directory/verify-latest-terraform-delivery.sh" \
  "$delivery" "$object" "$temporary_directory/wrong-sha-head.json" >/dev/null 2>&1; then
  fail '普通发布仍接受 latest delivery 内容 SHA 漂移'
fi

printf '%s\n' '普通发布 latest Terraform delivery 正负 fixture 通过。'
