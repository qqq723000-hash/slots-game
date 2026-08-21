#!/bin/sh
# 静态证明关键 AWS 边界存在；可传入复制后的目录供危险变体负测。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
terraform_root=${1:-$(CDPATH='' cd -- "$script_directory/.." && pwd)}

fail() {
  printf '%s\n' "Terraform static contract: $*" >&2
  exit 1
}

require_file() {
  test -f "$terraform_root/$1" || fail "缺少 $1"
}

require_text() {
  pattern=$1
  file=$2
  grep -F "$pattern" "$terraform_root/$file" >/dev/null || fail "$file 缺少契约: $pattern"
}

require_count() {
  expected=$1
  pattern=$2
  file=$3
  actual=$(grep -F -c "$pattern" "$terraform_root/$file" || true)
  test "$actual" -eq "$expected" || fail "${file} 中契约数量错误: ${pattern}，预期 ${expected}，实际 ${actual}"
}

forbid_text() {
  pattern=$1
  file=$2
  if grep -F "$pattern" "$terraform_root/$file" >/dev/null; then
    fail "$file 包含被禁止的契约: $pattern"
  fi
}

for environment in dev staging prod-primary prod-dr; do
  require_file "environments/$environment/main.tf"
  require_file "environments/$environment/backend.example.hcl"
  require_file "environments/$environment/terraform.tfvars.example"
  require_file "environments/$environment/.terraform.lock.hcl"
  require_text 'allowed_account_ids = [var.configuration.expected_account_id]' "environments/$environment/main.tf"
  require_text 'use_lockfile = true' "environments/$environment/main.tf"
  require_text 'version = "= 6.57.1"' "environments/$environment/main.tf"
  require_text 'variable "valkey_password_a"' "environments/$environment/main.tf"
  require_text 'variable "valkey_password_b"' "environments/$environment/main.tf"
  require_text 'valkey_password_a         = var.valkey_password_a' "environments/$environment/main.tf"
  require_text 'valkey_password_b         = var.valkey_password_b' "environments/$environment/main.tf"
  require_text 'valkey_active_slot' "environments/$environment/terraform.tfvars.example"
  require_text 'valkey_rotation_mode' "environments/$environment/terraform.tfvars.example"
  require_text 'valkey_password_version_a' "environments/$environment/terraform.tfvars.example"
  require_text 'valkey_password_version_b' "environments/$environment/terraform.tfvars.example"
  require_text 'valkey_password_reset_approvals = {}' "environments/$environment/terraform.tfvars.example"
  require_text 'valkey_hmac_maintenance_approval = null' "environments/$environment/terraform.tfvars.example"
  require_text 'application_namespace' "environments/$environment/terraform.tfvars.example"
  require_text 'helm_release_name' "environments/$environment/terraform.tfvars.example"
done

require_file 'contracts/landing-zone-interface.v1.yaml'
require_file 'contracts/cluster-addons-interface.v1.yaml'
require_file 'scripts/verify-valkey-rotation-plan.rb'
require_file 'scripts/test-valkey-rotation-plan.rb'
test -x "$terraform_root/scripts/verify-valkey-rotation-plan.rb" || fail 'Valkey plan 门禁不可执行'
test -x "$terraform_root/scripts/test-valkey-rotation-plan.rb" || fail 'Valkey plan 状态机测试不可执行'
require_text 'ruby "$script_directory/test-valkey-rotation-plan.rb"' 'scripts/verify.sh'
require_text 'contractVersion: 1.0.0' 'contracts/landing-zone-interface.v1.yaml'
require_text 'iam:GetRolePolicy' 'contracts/landing-zone-interface.v1.yaml'
require_text 's3:GetObjectVersion' 'contracts/landing-zone-interface.v1.yaml'
require_text 'eksAccessAllowedForHmacMaintenance: false' 'contracts/landing-zone-interface.v1.yaml'
require_text 'applyMeansApplicationReady: false' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'requiresPrivateVpcRunner: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'requiredBeforeHelmUpgrade: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'expected_account_id' 'modules/delivery-contract/variables.tf'
require_text 'bootstrap_cluster_creator_admin_permissions = false' 'modules/eks/main.tf'
require_text 'endpoint_public_access  = false' 'modules/eks/main.tf'
require_text 'http_tokens                 = "required"' 'modules/eks/main.tf'
require_text 'ignore_changes = [scaling_config[0].desired_size]' 'modules/eks/main.tf'
require_count 1 'ignore_changes = [scaling_config[0].desired_size]' 'modules/eks/main.tf'
require_text 'min_size     = var.node_min_size' 'modules/eks/main.tf'
require_text 'max_size     = var.node_max_size' 'modules/eks/main.tf'
forbid_text 'ignore_changes = [scaling_config]' 'modules/eks/main.tf'
require_text 'resource "aws_eks_pod_identity_association" "cluster_autoscaler"' 'modules/eks/main.tf'
require_text 'service_account = "cluster-autoscaler"' 'modules/eks/main.tf'
require_text 'aws:RequestTag/kubernetes-service-account' 'modules/eks/main.tf'
require_text 'autoscaling:SetDesiredCapacity' 'modules/eks/main.tf'
require_text '"autoscaling:DescribeTags"' 'modules/eks/main.tf'
forbid_text '"autoscaling:*"' 'modules/eks/main.tf'
require_text 'aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name_prefix}' 'modules/eks/main.tf'
require_text '"k8s.io/cluster-autoscaler/${var.name_prefix}" = "owned"' 'modules/eks/main.tf'
require_text 'addon_version = var.cloudwatch_addon_version' 'modules/observability/main.tf'
require_text 'AWSServiceRoleForAutoScaling' 'modules/kms/main.tf'
require_text 'kms:GrantIsForAWSResource' 'modules/kms/main.tf'
require_text 'kms:EncryptionContext:aws:logs:arn' 'modules/kms/main.tf'
require_text 'prevent_destroy = true' 'modules/kms/main.tf'
require_text 'publicly_accessible    = false' 'modules/rds/main.tf'
require_text 'prevent_destroy = true' 'modules/rds/main.tf'
require_text 'manage_master_user_password   = true' 'modules/rds/main.tf'
require_text 'name              = "/aws/rds/instance/${local.identifier}/${each.key}"' 'modules/rds/main.tf'
require_text 'kms_key_id        = var.log_kms_key_arn' 'modules/rds/main.tf'
require_text 'var.parameter_group_family == "postgres${split(".", var.engine_version)[0]}"' 'modules/rds/main.tf'
require_text 'transit_encryption_mode    = "required"' 'modules/cache/main.tf'
require_text 'AuthoritativeEconomicState = "false"' 'modules/cache/main.tf'
require_count 2 'resource "aws_elasticache_user" "rate_limiter_' 'modules/cache/main.tf'
require_text 'passwords_wo  = var.valkey_password_a' 'modules/cache/main.tf'
require_text 'passwords_wo  = var.valkey_password_b' 'modules/cache/main.tf'
require_text 'passwords_wo_version = var.valkey_password_version_a' 'modules/cache/main.tf'
require_text 'passwords_wo_version = var.valkey_password_version_b' 'modules/cache/main.tf'
require_count 2 'on ~rgs:shared-admission:v1:* -@all +evalsha +eval +time +hmget +hset +pexpire +ping +hello +auth +client|setname +client|setinfo' 'modules/cache/main.tf'
require_text 'aws_elasticache_user.rate_limiter_a.user_id' 'modules/cache/main.tf'
require_text 'aws_elasticache_user.rate_limiter_b.user_id' 'modules/cache/main.tf'
require_text 'active_password  = var.valkey_active_slot == "a" ? var.valkey_password_a : var.valkey_password_b' 'modules/cache/main.tf'
require_text 'sha256(var.valkey_password_a) == var.valkey_password_fingerprint_a' 'modules/cache/main.tf'
require_text 'sha256(var.valkey_password_b) == var.valkey_password_fingerprint_b' 'modules/cache/main.tf'
require_text 'sha256(var.shared_admission_hmac_key) == var.shared_admission_hmac_key_fingerprint' 'modules/cache/main.tf'
require_text 'var.valkey_hmac_maintenance_approval.bucket_reset_accepted' 'modules/cache/variables.tf'
require_text 'var.valkey_hmac_maintenance_approval.evidence_reference.bucket' 'modules/cache/variables.tf'
require_text 'var.valkey_hmac_maintenance_approval.evidence_reference.key' 'modules/cache/variables.tf'
require_text 'var.valkey_hmac_maintenance_approval.evidence_reference.version_id' 'modules/cache/variables.tf'
require_text '^[A-Za-z0-9._~+/=-]{1,1024}$' 'modules/cache/variables.tf'
require_text 'var.valkey_hmac_maintenance_approval.evidence_reference.sha256' 'modules/cache/variables.tf'
require_text 'target_identity = {' 'modules/cache/main.tf'
require_text 'kubernetes_namespace = var.application_namespace' 'modules/cache/main.tf'
require_text 'helm_release_name    = var.helm_release_name' 'modules/cache/main.tf'
require_count 2 'can(regex("^[!-~]+$", var.valkey_password_' 'modules/cache/variables.tf'
require_count 2 '!can(regex("[,\\\"/@]", var.valkey_password_' 'modules/cache/variables.tf'
require_text '    username = local.active_user_name' 'modules/cache/main.tf'
require_text '(var.valkey_active_slot == "a" && var.secret_version % 2 == 1)' 'modules/cache/main.tf'
require_text '(var.valkey_active_slot == "b" && var.secret_version % 2 == 0)' 'modules/cache/main.tf'
require_text 'local.slots_requiring_reset_approval == toset(keys(var.valkey_password_reset_approvals))' 'modules/cache/main.tf'
require_text 'approval.old_slot_connections_drained &&' 'modules/cache/variables.tf'
require_text 'approval.hmac_key_unchanged &&' 'modules/cache/variables.tf'
require_text 'approval.live_evidence_reference' 'modules/cache/variables.tf'
require_text 'old_slot_reset_requires_live_evidence         = true' 'modules/cache/outputs.tf'
require_text 'hmac_bucket_reset_requires_separate_change    = true' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_requires_zero_replicas' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_forbids_parallel_rollout' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_single_attested_plan         = true' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_exit_requires_separate_plan  = true' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_attestation_schema           = "slots-game/hmac-quiesce-attestation/v1"' 'modules/cache/outputs.tf'
require_text 'hmac_maintenance_persistent_lock_name' 'modules/cache/outputs.tf'
require_text 'application_release_allowed                   = var.valkey_rotation_mode != "hmac-maintenance"' 'modules/cache/outputs.tf'
require_text 'maintenance_in_progress                       = var.valkey_rotation_mode == "hmac-maintenance"' 'modules/cache/outputs.tf'
require_text '禁止重置当前活动槽；一次 apply 只能准备唯一非活动槽' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'assert(version_changed_slots == [inactive_slot],' 'scripts/verify-valkey-rotation-plan.rb'
require_text '切换活动槽的同一次 apply 禁止修改任何密码' 'scripts/verify-valkey-rotation-plan.rb'
require_text '普通 A/B 密码轮换禁止改变 HMAC' 'scripts/verify-valkey-rotation-plan.rb'
require_text '用 tfvars 自证后重置活动 A 槽' 'scripts/test-valkey-rotation-plan.rb'
require_text '进入 HMAC 维护的同一个保存 plan 必须完成换 key' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'assert(!evidence_payload.nil?, "HMAC 单计划维护缺少 --evidence 静默证据")' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'assert(target == before.fetch("target_identity")' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'expires_at - observed_at <= 3600' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'assert(expires_at > now, "HMAC 静默证据已过期")' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'api[key] == 0' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'worker["ready"] == worker["desired"]' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'HPA 恢复 spec SHA-256 与 manifest 不一致' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'lock["name"] == "slots-hmac-maintenance-lock"' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'Digest::SHA256.hexdigest(raw) == reference.fetch("sha256")' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'arguments.on("--evidence FILE"' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'after_unknown.fetch("input", false)' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'HMAC_SECRET_REPLACEMENT_ACTIONS = [["create", "delete"]].freeze' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'HMAC_SECRET_VERSION_REPLACEMENT_ACTIONS = [["delete", "create"]].freeze' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'actual_addresses.sort == expected_addresses.sort' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'plan 的非 no-op 资源集合不符合精确 allowlist' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'HMAC 维护 Secret 替换混入普通配置变化' 'scripts/verify-valkey-rotation-plan.rb'
require_text 'HMAC 维护 SecretVersion 替换混入普通配置变化' 'scripts/verify-valkey-rotation-plan.rb'
require_text '首次 A 到 B 切换同时更换 HMAC' 'scripts/test-valkey-rotation-plan.rb'
require_text '单个已保存 plan 内执行受证据绑定的 HMAC 维护' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 入口夹带 RDS 变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 入口夹带 EKS 变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 入口夹带 IAM 变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 入口夹带网络变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 入口夹带其他 Secret 变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'HMAC 出口夹带网络变化' 'scripts/test-valkey-rotation-plan.rb'
require_text 'API 实际仍有 Pod' 'scripts/test-valkey-rotation-plan.rb'
require_text '证据已过期' 'scripts/test-valkey-rotation-plan.rb'
forbid_text 'application_replicas_scaled_to_zero' 'modules/cache/variables.tf'
forbid_text 'parallel_rollout_forbidden' 'modules/cache/variables.tf'
forbid_text 'live_evidence_reference             = string' 'modules/cache/variables.tf'
forbid_text 'variable "valkey_password"' 'modules/cache/variables.tf'
forbid_text 'var.valkey_password)' 'modules/cache/main.tf'
forbid_text '+script|load' 'modules/cache/main.tf'
forbid_text '~ratelimit:*' 'modules/cache/main.tf'
forbid_text '~dedupe:*' 'modules/cache/main.tf'
require_text 'secret_string_wo = jsonencode({' 'modules/cache/main.tf'
require_text 'secret_string_wo_version = var.secret_version' 'modules/cache/main.tf'
require_text 'base64encode(base64decode(var.shared_admission_hmac_key)) == var.shared_admission_hmac_key' 'modules/cache/variables.tf'
require_count 4 'CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"' 'modules/cache/main.tf'
require_text 'metric_name         = "CommandAuthorizationFailures"' 'modules/cache/main.tf'
require_text 'metric_name         = "KeyAuthorizationFailures"' 'modules/cache/main.tf'
require_text '"rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"' 'modules/cache/outputs.tf'
forbid_text 'type = "iam"' 'modules/cache/main.tf'
forbid_text 'elasticache:Connect' 'modules/cache/main.tf'
forbid_text 'aws_eks_pod_identity_association' 'modules/cache/main.tf'
forbid_text 'resource "aws_security_group" "rgs_workload"' 'stacks/application-platform/main.tf'
forbid_text 'resource "aws_security_group" "rate_limiter_workload"' 'stacks/application-platform/main.tf'
require_count 2 'module.eks.cluster_security_group_id' 'stacks/application-platform/main.tf'
require_text 'foundation_apply_is_application_ready = false' 'stacks/application-platform/outputs.tf'
require_text 'private_vpc_runner_required' 'stacks/application-platform/outputs.tf'
require_text 'AutomatedExportReady = "false"' 'modules/archive/main.tf'
require_text 'object_lock_enabled = true' 'modules/archive/main.tf'
require_text 'aws_backup_vault_lock_configuration' 'modules/backup/main.tf'
require_text 'block_public_acls       = true' 'modules/web-edge/main.tf'
forbid_text 'block_public_acls       = false' 'modules/web-edge/main.tf'
require_text 'origin_access_control_origin_type = "s3"' 'modules/web-edge/main.tf'
require_text "store.get('active-release')" 'modules/web-edge/release-request.js'
require_text 'HttpOnly; SameSite=Strict' 'modules/web-edge/release-response.js'
require_text 'var.backup_enable_vault_lock' 'stacks/application-platform/main.tf'
require_text 'var.rds_multi_az' 'stacks/application-platform/main.tf'
require_text 'ephemeral   = true' 'modules/cache/variables.tf'
require_text 'rgs-shared-admission-v${var.secret_version}' 'modules/cache/main.tf'
require_text 'activeSlotOutput: valkey_active_slot' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'aclUserNamesOutput: valkey_user_names' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'bothUsersAlwaysInUserGroup: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'oldSlotResetRequiresLiveEvidence: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacBucketContinuityRequiredDuringPasswordRotation: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceEntryAndKeyChangeInSingleAttestedPlan: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceEvidenceSchema: slots-game/hmac-quiesce-attestation/v1' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceEvidenceMaximumTtlSeconds: 3600' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenancePersistentLockName: slots-hmac-maintenance-lock' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceExitRequiresSeparatePlan: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'maintenanceDeliveryMustStillBePublished: true' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'maintenanceInProgressOutput: maintenance_in_progress' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceNonNoopResourceAllowlist:' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'addressSuffix: module.cache.aws_secretsmanager_secret.shared_admission' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'addressSuffix: module.cache.aws_secretsmanager_secret_version.shared_admission' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceAllowsIamPolicyChanges: false' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'hmacMaintenanceParallelRolloutAllowed: false' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'valkey_rotation_contract' 'stacks/environment/outputs.tf'
require_text 'valkey_rotation_mode' 'stacks/environment/outputs.tf'
require_text 'application_release_allowed' 'stacks/environment/outputs.tf'
require_text 'maintenance_in_progress' 'stacks/environment/outputs.tf'
require_text 'valkey_user_names' 'stacks/environment/outputs.tf'
require_text 'valkey_password_versions' 'stacks/environment/outputs.tf'
require_text 'var.secret_versions[each.key]' 'modules/secrets/main.tf'
require_text 'api-runtime-assets' 'modules/secrets/main.tf'
require_text 'worker-runtime-assets' 'modules/secrets/main.tf'
require_text 'shared_admission_secret_arn_pattern = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.shared_admission_secret_name_prefix}-v*"' 'modules/secrets/main.tf'
require_text 'resources = concat(values(aws_secretsmanager_secret.application)[*].arn, [local.shared_admission_secret_arn_pattern])' 'modules/secrets/main.tf'
require_text 'shared_admission_secret_name_prefix = "${local.name_prefix}-rgs-shared-admission"' 'stacks/application-platform/main.tf'
forbid_text 'additional_secret_arns' 'modules/secrets/variables.tf'
forbid_text 'additional_secret_arns' 'stacks/application-platform/main.tf'
forbid_text 'module.cache.secret_arn' 'stacks/application-platform/main.tf'
forbid_text '"runtime-assets"' 'modules/secrets/main.tf'
require_text '九个子网 CIDR 之间不得存在任何重叠。' 'modules/network/main.tf'
require_text 'left_index >= right_index || !try(' 'modules/network/main.tf'
require_text 'local.vpc_network_address' 'modules/network/main.tf'
require_text 'from_port         = 8080' 'modules/network/main.tf'
require_text 'to_port           = 8080' 'modules/network/main.tf'
forbid_text 'ip_protocol       = "-1"' 'modules/network/main.tf'
require_text 'split(":", var.backup_copy_destination_vault_arn)[3] != var.aws_region' 'modules/delivery-contract/variables.tf'
require_text '"cluster-autoscaler"' 'stacks/application-platform/variables.tf'
require_text 'cluster_autoscaler_image_tag' 'stacks/application-platform/outputs.tf'
require_text 'cluster_autoscaler_role_arn' 'stacks/environment/outputs.tf'
require_text 'cluster_autoscaler_inline_policy_name' 'stacks/environment/outputs.tf'
require_text 'application_namespace' 'stacks/environment/outputs.tf'
require_text 'helm_release_name' 'stacks/environment/outputs.tf'
require_text 'id: cluster-autoscaler' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'metrics_server_addon_version          = var.eks_addon_versions["metrics-server"]' 'stacks/application-platform/outputs.tf'
require_text 'metrics_server               = "kube-system/metrics-server"' 'stacks/application-platform/outputs.tf'
require_text 'kube_state_metrics           = "monitoring/kube-prometheus-stack-kube-state-metrics"' 'stacks/application-platform/outputs.tf'
require_text 'resource_metrics = "v1beta1.metrics.k8s.io"' 'stacks/application-platform/outputs.tf'
require_text 'kube_state_metrics_release_name = "kube-prometheus-stack"' 'stacks/application-platform/outputs.tf'
require_text 'id: metrics-server' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'requiredApiServiceCondition: Available=True' 'contracts/cluster-addons-interface.v1.yaml'
require_text 'requiredForHpaConditionAlerts: true' 'contracts/cluster-addons-interface.v1.yaml'
forbid_text 'resource "aws_cloudfront_cache_policy" "entry"' 'modules/web-edge/main.tf'

if find "$terraform_root/environments" -name '*.tfvars*' -type f -exec \
  grep -Eil '(password[[:space:]]*=|secret_value[[:space:]]*=|access_key[[:space:]]*=|private_key[[:space:]]*=|auth_token[[:space:]]*=)' {} + |
  grep . >/dev/null; then
  fail 'tfvars 示例中出现 Secret 值字段'
fi

if grep -Ril --include='*.tf' --include='*.tfvars*' --include='*.yaml' --include='*.js' \
  -E '(^|[^A-Za-z])(kafka|msk)([^A-Za-z]|$)' "$terraform_root" >/dev/null; then
  fail '基础设施错误引入 Kafka/MSK 钱包正确性依赖'
fi

printf '%s\n' 'Terraform static contract: passed'
