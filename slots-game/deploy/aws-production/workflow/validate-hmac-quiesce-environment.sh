#!/bin/sh
# 该脚本只验证 HMAC 停机证据生产者的固定边界，不访问 AWS 或 Kubernetes。
set -eu

fail() {
  printf '%s\n' "HMAC 停机证据环境校验失败：$*" >&2
  exit 1
}

require_value() {
  name=$1
  value=$(printenv "$name" 2>/dev/null || true)
  test -n "$value" || fail "$name 未配置"
}

require_bucket() {
  value=$1
  printf '%s\n' "$value" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' || fail 'S3 bucket 格式错误'
  case "$value" in *..*|*.-*|-.*|*-.) fail 'S3 bucket 格式错误' ;; esac
}

require_key() {
  value=$1
  label=$2
  test "${#value}" -le 1024 || fail "$label 超过 1024 字符"
  printf '%s\n' "$value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$' || fail "$label 格式错误"
  case "$value" in *..*|/*|*/) fail "$label 包含不安全路径" ;; esac
  case "/$value/" in *"/$TARGET_ENVIRONMENT/"*) ;; *) fail "$label 未隔离目标环境" ;; esac
}

require_prefix() {
  value=$1
  label=$2
  test "${#value}" -le 950 || fail "$label 超过安全长度"
  printf '%s\n' "$value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$' || fail "$label 格式错误"
  case "$value" in *..*|/*|*/) fail "$label 包含不安全路径" ;; esac
  case "/$value/" in *"/$TARGET_ENVIRONMENT/"*) ;; *) fail "$label 未隔离目标环境" ;; esac
}

require_kms() {
  printf '%s\n' "$1" | grep -Eq \
    "^arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$" || \
    fail 'KMS key 不是固定账号和区域的完整 CMK ARN'
}

require_role() {
  printf '%s\n' "$1" | grep -Eq \
    "^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$" || fail 'OIDC role ARN 不合法'
}

for name in INPUT_OPERATION TARGET_ENVIRONMENT AWS_ACCOUNT_ID AWS_REGION AWS_HMAC_QUIESCE_ROLE_ARN \
  AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF \
  AWS_EKS_CLUSTER_NAME AWS_EKS_NAMESPACE AWS_HELM_RELEASE_NAME \
  AWS_TERRAFORM_DELIVERY_BUCKET AWS_TERRAFORM_DELIVERY_KEY AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN \
  AWS_HMAC_QUIESCE_EVIDENCE_BUCKET AWS_HMAC_QUIESCE_EVIDENCE_KEY AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN \
  AWS_HMAC_QUIESCE_CANCELLATION_PREFIX AWS_HMAC_QUIESCE_COMPLETION_PREFIX \
  GITHUB_REPOSITORY GITHUB_REF GITHUB_REF_PROTECTED
do
  require_value "$name"
done

case "$TARGET_ENVIRONMENT" in dev|staging|prod-primary|prod-dr) ;; *) fail '目标环境不在允许列表中' ;; esac
printf '%s\n' "$AWS_ACCOUNT_ID" | grep -Eq '^[0-9]{12}$' || fail 'AWS_ACCOUNT_ID 格式错误'
printf '%s\n' "$AWS_REGION" | grep -Eq '^[a-z]{2}(-[a-z]+)+-[0-9]+$' || fail 'AWS_REGION 格式错误'
require_role "$AWS_HMAC_QUIESCE_ROLE_ARN"
require_role "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN"
test "$AWS_HMAC_QUIESCE_ROLE_ARN" = "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN" || \
  fail '证据内容绑定的 producer role 必须等于当前独立 OIDC role'
test "$GITHUB_REF" = refs/heads/main || fail '证据只能从 main 分支生成或恢复'
test "$GITHUB_REF_PROTECTED" = true || fail 'main 必须受分支保护'
printf '%s\n' "$GITHUB_REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail 'GitHub repository 格式错误'
test "$AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF" = \
  "$GITHUB_REPOSITORY/.github/workflows/aws-hmac-quiesce-evidence.yml@refs/heads/main" || \
  fail 'producer workflow ref 必须固定到本仓库 main'

printf '%s\n' "$AWS_EKS_CLUSTER_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$' || \
  fail 'EKS 集群名格式错误'
printf '%s\n' "$AWS_EKS_NAMESPACE" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$' || \
  fail 'namespace 不是严格 DNS label'
printf '%s\n' "$AWS_HELM_RELEASE_NAME" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$' || \
  fail 'Helm release 不是严格 DNS label'

require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"
require_bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET"
require_key "$AWS_TERRAFORM_DELIVERY_KEY" 'Terraform delivery key'
require_key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" 'HMAC evidence key'
require_prefix "$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX" 'HMAC cancellation marker prefix'
require_prefix "$AWS_HMAC_QUIESCE_COMPLETION_PREFIX" 'HMAC completion marker prefix'
require_kms "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"
require_kms "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN"
test "$AWS_TERRAFORM_DELIVERY_BUCKET/$AWS_TERRAFORM_DELIVERY_KEY" != \
  "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET/$AWS_HMAC_QUIESCE_EVIDENCE_KEY" || \
  fail '证据对象不得覆盖 Terraform delivery'
test "$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX" != "$AWS_HMAC_QUIESCE_COMPLETION_PREFIX" || \
  fail 'cancellation 与 completion 必须使用不同的不可变 marker prefix'

case "$INPUT_OPERATION" in
  quiesce)
    test -z "${INPUT_EVIDENCE_VERSION_ID:-}" || fail 'quiesce 禁止接受旧证据 VersionId'
    test -z "${INPUT_EVIDENCE_SHA256:-}" || fail 'quiesce 禁止接受调用者提供的旧证据 SHA-256'
    ;;
  resume)
    require_value INPUT_EVIDENCE_VERSION_ID
    require_value INPUT_EVIDENCE_SHA256
    test "${#INPUT_EVIDENCE_VERSION_ID}" -le 1024 || fail 'resume evidence VersionId 过长'
    printf '%s\n' "$INPUT_EVIDENCE_VERSION_ID" | grep -Eq '^[A-Za-z0-9._~+/=-]+$' || \
      fail 'resume evidence VersionId 格式错误'
    test "$INPUT_EVIDENCE_VERSION_ID" != null || fail 'resume 禁止未版本化对象'
    printf '%s\n' "$INPUT_EVIDENCE_SHA256" | grep -Eq '^[0-9a-f]{64}$' || \
      fail 'resume evidence SHA-256 格式错误'
    ;;
  *) fail 'operation 只能是 quiesce 或 resume' ;;
esac

printf '%s\n' 'HMAC 停机证据固定环境边界校验通过。'
