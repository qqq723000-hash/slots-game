#!/bin/sh

# 该脚本只验证受保护 GitHub Environment 注入的固定边界，不调用 AWS。
# English: This script only verifies the fixed boundaries of the protected GitHub Environment injection and does
# not make calls to AWS.
set -eu

fail() {
  printf '%s\n' "AWS 工作流环境校验失败：$*" >&2
  exit 1
}

test "$#" -eq 1 || fail '必须指定 terraform-plan、terraform-apply、artifact-verify 或 application-deploy'
mode=$1

require_value() {
  variable_name=$1
  variable_value=$(printenv "$variable_name" 2>/dev/null || true)
  test -n "$variable_value" || fail "$variable_name 未配置"
}

require_account() {
  printf '%s\n' "$AWS_ACCOUNT_ID" | grep -Eq '^[0-9]{12}$' || fail 'AWS_ACCOUNT_ID 格式错误'
}

require_region() {
  printf '%s\n' "$AWS_REGION" | grep -Eq '^[a-z]{2}(-[a-z]+)+-[0-9]+$' || fail 'AWS_REGION 格式错误'
}

require_role() {
  role_value=$1
  printf '%s\n' "$role_value" | \
    grep -Eq "^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$" || \
    fail '角色 ARN 必须属于固定 AWS 账号'
}

require_kms_key() {
  key_value=$1
  printf '%s\n' "$key_value" | \
    grep -Eq "^arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$" || \
    fail 'KMS key 必须是本账号本区域的完整 CMK ARN'
}

require_bucket() {
  bucket_value=$1
  printf '%s\n' "$bucket_value" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' || \
    fail 'S3 bucket 名格式错误'
  case "$bucket_value" in *..*|*.-*|*-.*) fail 'S3 bucket 名格式错误' ;; esac
  if printf '%s\n' "$bucket_value" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail 'S3 bucket 名不得伪装为 IP 地址'
  fi
}

require_delivery_key() {
  key_value=$1
  test "${#key_value}" -le 1024 || fail 'Terraform delivery S3 key 超过 1024 字符'
  printf '%s\n' "$key_value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$' || \
    fail 'Terraform delivery S3 key 必须是规范 JSON 对象路径'
  case "$key_value" in *..*|/*|*/) fail 'Terraform delivery S3 key 包含不安全路径' ;; esac
}

require_object_prefix() {
  prefix_value=$1
  test "${#prefix_value}" -le 950 || fail 'HMAC marker S3 prefix 过长'
  printf '%s\n' "$prefix_value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$' || \
    fail 'HMAC marker S3 prefix 格式错误'
  case "$prefix_value" in *..*|/*|*/) fail 'HMAC marker S3 prefix 包含不安全路径' ;; esac
}

require_state_key() {
  key_value=$1
  test "${#key_value}" -le 1024 || fail 'Terraform state S3 key 超过 1024 字符'
  printf '%s\n' "$key_value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*\.tfstate$' || \
    fail 'Terraform state S3 key 必须是规范 tfstate 对象路径'
  case "$key_value" in *..*|/*|*/) fail 'Terraform state S3 key 包含不安全路径' ;; esac
}

require_repository() {
  repository_value=$1
  test "${#repository_value}" -le 256 || fail 'ECR 仓库名超过 256 字符'
  printf '%s\n' "$repository_value" | grep -Eq '^[a-z0-9]+([._/-][a-z0-9]+)*$' || \
    fail 'ECR 仓库名格式错误'
}

require_version_id() {
  version_value=$1
  version_label=$2
  test "$version_value" != null || fail "$version_label 不得是未版本化对象的 null"
  test "${#version_value}" -le 1024 || fail "$version_label 超过 1024 字符"
  printf '%s\n' "$version_value" | grep -Eq '^[A-Za-z0-9._~+/=-]+$' || \
    fail "$version_label 格式错误"
}

require_target_environment() {
  case "$1" in
    dev|staging|prod-primary|prod-dr) ;;
    *) fail '目标环境不在允许列表中' ;;
  esac
}

require_environment_segment() {
  object_key=$1
  target_environment=$2
  boundary_label=$3
  case "/$object_key/" in
    *"/$target_environment/"*) ;;
    *) fail "$boundary_label 未使用目标环境独立路径" ;;
  esac
}

validate_state_boundary() {
  require_bucket "$AWS_TF_STATE_BUCKET"
  require_state_key "$AWS_TF_STATE_KEY"
  require_kms_key "$AWS_TF_STATE_KMS_KEY_ARN"
}

validate_repositories() {
  require_repository "$AWS_ECR_RGS_RUNTIME_REPOSITORY"
  require_repository "$AWS_ECR_RGS_MIGRATOR_REPOSITORY"
  require_repository "$AWS_ECR_WEB_REPOSITORY"
  test "$AWS_ECR_RGS_RUNTIME_REPOSITORY" != "$AWS_ECR_RGS_MIGRATOR_REPOSITORY" || \
    fail 'RGS 与 Migrator 必须使用不同 ECR 仓库'
  test "$AWS_ECR_RGS_RUNTIME_REPOSITORY" != "$AWS_ECR_WEB_REPOSITORY" || \
    fail 'RGS 与 Web 必须使用不同 ECR 仓库'
  test "$AWS_ECR_RGS_MIGRATOR_REPOSITORY" != "$AWS_ECR_WEB_REPOSITORY" || \
    fail 'Migrator 与 Web 必须使用不同 ECR 仓库'
}

validate_eks_application_identity() {
  printf '%s\n' "$AWS_EKS_CLUSTER_NAME" | \
    grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$' || fail 'EKS 集群名格式错误'
  printf '%s\n' "$AWS_EKS_NAMESPACE" | \
    grep -Eq '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$' || fail 'EKS namespace 不是严格 DNS label'
  test "${#AWS_EKS_NAMESPACE}" -le 63 || fail 'EKS namespace 超过 63 字符'
  printf '%s\n' "$AWS_HELM_RELEASE_NAME" | \
    grep -Eq '^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$' || fail 'Helm release 名不是严格 DNS label'
  test "${#AWS_HELM_RELEASE_NAME}" -le 53 || fail 'Helm release 名超过 53 字符'
}

validate_hmac_evidence_consumer_boundary() {
  for name in AWS_HMAC_QUIESCE_EVIDENCE_BUCKET AWS_HMAC_QUIESCE_EVIDENCE_KEY \
    AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN \
    AWS_HMAC_QUIESCE_CANCELLATION_PREFIX AWS_HMAC_QUIESCE_COMPLETION_PREFIX \
    AWS_TERRAFORM_DELIVERY_BUCKET AWS_TERRAFORM_DELIVERY_KEY AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN \
    AWS_EKS_CLUSTER_NAME AWS_EKS_NAMESPACE AWS_HELM_RELEASE_NAME; do
    require_value "$name"
  done
  require_bucket "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET"
  require_delivery_key "$AWS_HMAC_QUIESCE_EVIDENCE_KEY"
  require_object_prefix "$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX"
  require_object_prefix "$AWS_HMAC_QUIESCE_COMPLETION_PREFIX"
  require_kms_key "$AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN"
  require_role "$AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN"
  require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"
  require_delivery_key "$AWS_TERRAFORM_DELIVERY_KEY"
  require_kms_key "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"
  require_environment_segment "$AWS_HMAC_QUIESCE_EVIDENCE_KEY" "$target_environment" \
    'HMAC quiesce evidence S3 key'
  require_environment_segment "$AWS_HMAC_QUIESCE_CANCELLATION_PREFIX" "$target_environment" \
    'HMAC quiesce cancellation S3 prefix'
  require_environment_segment "$AWS_HMAC_QUIESCE_COMPLETION_PREFIX" "$target_environment" \
    'HMAC quiesce completion S3 prefix'
  require_environment_segment "$AWS_TERRAFORM_DELIVERY_KEY" "$target_environment" \
    'Terraform delivery S3 key'
  test "$AWS_HMAC_QUIESCE_EVIDENCE_BUCKET/$AWS_HMAC_QUIESCE_EVIDENCE_KEY" != \
    "$AWS_TERRAFORM_DELIVERY_BUCKET/$AWS_TERRAFORM_DELIVERY_KEY" || \
    fail 'HMAC evidence 不得覆盖 Terraform delivery'
  validate_eks_application_identity
}

require_value AWS_ACCOUNT_ID
require_value AWS_REGION
require_account
require_region

case "$mode" in
  terraform-plan)
    require_value TARGET_ENVIRONMENT
    target_environment=$(printenv TARGET_ENVIRONMENT)
    require_target_environment "$target_environment"
    for name in AWS_TERRAFORM_PLAN_ROLE_ARN AWS_TF_STATE_BUCKET AWS_TF_STATE_KEY AWS_TF_STATE_KMS_KEY_ARN; do
      require_value "$name"
    done
    require_role "$AWS_TERRAFORM_PLAN_ROLE_ARN"
    validate_state_boundary
    require_environment_segment "$AWS_TF_STATE_KEY" "$target_environment" 'Terraform state S3 key'
    validate_hmac_evidence_consumer_boundary
    ;;
  terraform-apply)
    require_value TARGET_ENVIRONMENT
    target_environment=$(printenv TARGET_ENVIRONMENT)
    require_target_environment "$target_environment"
    for name in AWS_TERRAFORM_APPLY_ROLE_ARN AWS_TF_STATE_BUCKET AWS_TF_STATE_KEY AWS_TF_STATE_KMS_KEY_ARN \
      AWS_TERRAFORM_DELIVERY_BUCKET AWS_TERRAFORM_DELIVERY_KEY AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN; do
      require_value "$name"
    done
    require_role "$AWS_TERRAFORM_APPLY_ROLE_ARN"
    validate_state_boundary
    require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"
    require_delivery_key "$AWS_TERRAFORM_DELIVERY_KEY"
    require_kms_key "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"
    require_environment_segment "$AWS_TF_STATE_KEY" "$target_environment" 'Terraform state S3 key'
    require_environment_segment "$AWS_TERRAFORM_DELIVERY_KEY" "$target_environment" \
      'Terraform delivery S3 key'
    validate_hmac_evidence_consumer_boundary
    ;;
  artifact-verify)
    for name in AWS_ARTIFACT_VERIFY_ROLE_ARN AWS_ECR_RGS_RUNTIME_REPOSITORY \
      AWS_ECR_RGS_MIGRATOR_REPOSITORY AWS_ECR_WEB_REPOSITORY; do
      require_value "$name"
    done
    require_role "$AWS_ARTIFACT_VERIFY_ROLE_ARN"
    validate_repositories
    ;;
  application-deploy)
    require_value INPUT_TARGET_ENVIRONMENT
    input_target_environment=$(printenv INPUT_TARGET_ENVIRONMENT)
    require_target_environment "$input_target_environment"
    for name in AWS_APPLICATION_DEPLOY_ROLE_ARN AWS_ECR_RGS_RUNTIME_REPOSITORY \
      AWS_ECR_RGS_MIGRATOR_REPOSITORY AWS_ECR_WEB_REPOSITORY AWS_EKS_CLUSTER_NAME \
      AWS_EKS_NAMESPACE AWS_HELM_RELEASE_NAME \
      AWS_HELM_VALUES_BUCKET AWS_HELM_VALUES_KEY AWS_HELM_VALUES_VERSION_ID AWS_WEB_BUCKET AWS_WEB_KMS_KEY_ARN \
      AWS_TERRAFORM_DELIVERY_BUCKET AWS_TERRAFORM_DELIVERY_KEY AWS_TERRAFORM_DELIVERY_VERSION_ID \
      AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN \
      AWS_HMAC_QUIESCE_EVIDENCE_BUCKET AWS_HMAC_QUIESCE_EVIDENCE_KEY \
      AWS_HMAC_QUIESCE_EVIDENCE_KMS_KEY_ARN AWS_HMAC_QUIESCE_CANCELLATION_PREFIX \
      AWS_HMAC_QUIESCE_COMPLETION_PREFIX AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN \
      AWS_CLOUDFRONT_DISTRIBUTION_ID AWS_CLOUDFRONT_DOMAIN_NAME \
      AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID AWS_CLOUDFRONT_KVS_ARN \
      AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME; do
      require_value "$name"
    done
    require_role "$AWS_APPLICATION_DEPLOY_ROLE_ARN"
    validate_repositories
    validate_eks_application_identity
    require_bucket "$AWS_HELM_VALUES_BUCKET"
    printf '%s\n' "$AWS_HELM_VALUES_KEY" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*\.ya?ml$' || \
      fail 'Helm values S3 key 必须是规范 YAML 对象路径'
    case "$AWS_HELM_VALUES_KEY" in *..*|/*|*/) fail 'Helm values S3 key 包含不安全路径' ;; esac
    require_environment_segment "$AWS_HELM_VALUES_KEY" "$input_target_environment" 'Helm values S3 key'
    require_version_id "$AWS_HELM_VALUES_VERSION_ID" 'Helm values S3 version ID'
    require_bucket "$AWS_WEB_BUCKET"
    require_kms_key "$AWS_WEB_KMS_KEY_ARN"
    require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"
    require_delivery_key "$AWS_TERRAFORM_DELIVERY_KEY"
    require_kms_key "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"
    require_environment_segment "$AWS_TERRAFORM_DELIVERY_KEY" "$input_target_environment" \
      'Terraform delivery S3 key'
    require_version_id "$AWS_TERRAFORM_DELIVERY_VERSION_ID" 'Terraform delivery S3 version ID'
    printf '%s\n' "$AWS_CLOUDFRONT_DISTRIBUTION_ID" | \
      grep -Eq '^E[A-Z0-9]{10,31}$' || fail 'CloudFront distribution ID 格式错误'
    printf '%s\n' "$AWS_CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID" | \
      grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || \
      fail 'CloudFront Response Headers Policy ID 格式错误'
    printf '%s\n' "$AWS_CLOUDFRONT_KVS_ARN" | \
      grep -Eq "^arn:aws:cloudfront::${AWS_ACCOUNT_ID}:key-value-store/[0-9a-fA-F-]{36}$" || \
      fail 'CloudFront KeyValueStore 必须属于固定 AWS 账号'
    printf '%s\n' "$AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME" | \
      grep -Eq '^[A-Za-z0-9_-]{1,64}$' || fail 'CloudFront router function 名称格式错误'
    printf '%s\n' "$AWS_CLOUDFRONT_DOMAIN_NAME" | \
      grep -Eq '^[a-z0-9-]+\.cloudfront\.net$' || fail 'CloudFront 域名格式错误'
    target_environment=$input_target_environment
    validate_hmac_evidence_consumer_boundary
    ;;
  *)
    fail '未知校验模式'
    ;;
esac

printf '%s\n' 'AWS 工作流固定环境边界校验通过。'
