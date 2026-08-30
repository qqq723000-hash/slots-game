#!/bin/sh
# 在 AWS 凭据前绑定 Terraform HMAC 维护批准与受保护的证据标识。
# English: Bind Terraform HMAC to maintain approval and protected evidence IDs in front of AWS credentials.
set -eu

test "$#" -eq 1 || {
  printf '%s\n' '用法: validate-hmac-terraform-inputs.sh <tfvars.json>' >&2
  exit 1
}
tfvars_file=$1

fail() {
  printf '%s\n' "Terraform HMAC 证据输入失败：$*" >&2
  exit 1
}

rotation_mode=$(jq -er '.configuration.valkey_rotation_mode' "$tfvars_file") || fail '缺少 valkey_rotation_mode'
jq -e --arg namespace "$AWS_EKS_NAMESPACE" --arg release "$AWS_HELM_RELEASE_NAME" '
  .configuration.application_namespace == $namespace and
  .configuration.helm_release_name == $release
' "$tfvars_file" >/dev/null || fail 'application namespace 或 Helm release 未绑定受保护 Environment'

case "$rotation_mode" in
  hmac-maintenance)
    test "${#INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID}" -le 1024 || fail '证据 VersionId 过长'
    printf '%s\n' "$INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID" | \
      grep -Eq '^[A-Za-z0-9._~+/=-]+$' || fail '证据 VersionId 格式错误'
    test "$INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID" != null || fail '证据不得来自未版本化对象'
    printf '%s\n' "$INPUT_HMAC_QUIESCE_EVIDENCE_SHA256" | \
      grep -Eq '^[0-9a-f]{64}$' || fail '证据 SHA-256 格式错误'
    jq -e \
      --arg bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET" \
      --arg key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" \
      --arg version "$INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID" \
      --arg sha "$INPUT_HMAC_QUIESCE_EVIDENCE_SHA256" '
        .configuration.valkey_hmac_maintenance_approval as $approval |
        ($approval | type == "object") and
        ($approval | keys | sort) == ["bucket_reset_accepted", "evidence_reference"] and
        $approval.bucket_reset_accepted == true and
        ($approval.evidence_reference | type == "object") and
        ($approval.evidence_reference | keys | sort) == ["bucket", "key", "sha256", "version_id"] and
        $approval.evidence_reference == {
          "bucket": $bucket, "key": $key, "version_id": $version, "sha256": $sha
        }
      ' "$tfvars_file" >/dev/null || fail 'HMAC maintenance approval 未精确绑定固定证据引用'
    ;;
  steady|password-rotation)
    jq -e '.configuration.valkey_hmac_maintenance_approval == null' "$tfvars_file" >/dev/null || \
      fail '非 HMAC 维护模式禁止携带停机批准'
    test -z "${INPUT_HMAC_QUIESCE_EVIDENCE_VERSION_ID:-}" || \
      fail '非 HMAC 维护模式禁止 dispatch 证据 VersionId'
    test -z "${INPUT_HMAC_QUIESCE_EVIDENCE_SHA256:-}" || \
      fail '非 HMAC 维护模式禁止 dispatch 证据 SHA-256'
    ;;
  *) fail 'valkey_rotation_mode 不受支持' ;;
esac

printf '%s\n' 'Terraform HMAC 维护批准与固定证据标识绑定通过。'
