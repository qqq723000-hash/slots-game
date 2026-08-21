#!/bin/sh
# 对高风险边界逐项制造危险变体，证明静态契约会失败关闭。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
terraform_root=${1:-$(CDPATH='' cd -- "$script_directory/.." && pwd)}
temporary_parent=${TMPDIR:-/tmp}
temporary_root=$(mktemp -d "${temporary_parent%/}/slots-terraform-negative.XXXXXX")

cleanup() {
  case "$temporary_root" in
    "${temporary_parent%/}"/slots-terraform-negative.*) rm -rf -- "$temporary_root" ;;
    *) printf '%s\n' "拒绝清理异常路径 $temporary_root" >&2; exit 1 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

reject_mutation() {
  name=$1
  relative_file=$2
  original=$3
  replacement=$4
  candidate="$temporary_root/$name"

  cp -R -- "$terraform_root" "$candidate"
  source_file="$candidate/$relative_file"
  test -f "$source_file" || {
    printf '%s\n' "Terraform negative contract: 缺少 $relative_file" >&2
    exit 1
  }

  ORIGINAL="$original" REPLACEMENT="$replacement" ruby -e '
    path = ARGV.fetch(0)
    content = File.binread(path)
    original = ENV.fetch("ORIGINAL").b
    replacement = ENV.fetch("REPLACEMENT").b
    abort "负测没有找到预期原文" unless content.include?(original)
    File.binwrite(path, content.sub(original, replacement))
  ' "$source_file"

  if "$candidate/scripts/verify-static-contract.sh" "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "Terraform negative contract: 危险变体被错误接受: $name" >&2
    exit 1
  fi
}

reject_mutation public-eks-api modules/eks/main.tf \
  'endpoint_public_access  = false' 'endpoint_public_access  = true'
reject_mutation reset-autoscaled-desired-size modules/eks/main.tf \
  'ignore_changes = [scaling_config[0].desired_size]' 'ignore_changes = []'
reject_mutation ignore-autoscaler-boundaries modules/eks/main.tf \
  'ignore_changes = [scaling_config[0].desired_size]' 'ignore_changes = [scaling_config]'
reject_mutation broad-autoscaler-scale-role modules/eks/main.tf \
  'aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name_prefix}' 'aws:ResourceTag/k8s.io/cluster-autoscaler/other'
reject_mutation missing-autoscaler-describe-tags modules/eks/main.tf \
  '"autoscaling:DescribeTags"' '"autoscaling:DescribeTagsRemoved"'
reject_mutation wildcard-autoscaler-read modules/eks/main.tf \
  '"autoscaling:DescribeTags"' '"autoscaling:DescribeTags", "autoscaling:*"'
reject_mutation wrong-autoscaler-service-account modules/eks/main.tf \
  'service_account = "cluster-autoscaler"' 'service_account = "default"'
reject_mutation missing-autoscaling-kms-grant modules/kms/main.tf \
  'kms:GrantIsForAWSResource' 'kms:GrantIsForOtherResource'
reject_mutation unscoped-cloudwatch-kms modules/kms/main.tf \
  'kms:EncryptionContext:aws:logs:arn' 'kms:EncryptionContext:other'
reject_mutation public-rds modules/rds/main.tf \
  'publicly_accessible    = false' 'publicly_accessible    = true'
reject_mutation unencrypted-rds-logs modules/rds/main.tf \
  'kms_key_id        = var.log_kms_key_arn' 'kms_key_id        = null'
reject_mutation mismatched-rds-parameter-family modules/rds/main.tf \
  'var.parameter_group_family == "postgres${split(".", var.engine_version)[0]}"' 'var.parameter_group_family != "postgres${split(".", var.engine_version)[0]}"'
reject_mutation weak-valkey-tls modules/cache/main.tf \
  'transit_encryption_mode    = "required"' 'transit_encryption_mode    = "preferred"'
reject_mutation authoritative-cache modules/cache/main.tf \
  'AuthoritativeEconomicState = "false"' 'AuthoritativeEconomicState = "true"'
reject_mutation stateful-valkey-password-a modules/cache/main.tf \
  'passwords_wo  = var.valkey_password_a' 'passwords     = [var.valkey_password_a]'
reject_mutation stateful-valkey-password-b modules/cache/main.tf \
  'passwords_wo  = var.valkey_password_b' 'passwords     = [var.valkey_password_b]'
reject_mutation collapse-valkey-user-group modules/cache/main.tf \
  '    aws_elasticache_user.rate_limiter_b.user_id,' '    aws_elasticache_user.rate_limiter_a.user_id,'
reject_mutation reset-a-on-secret-publish modules/cache/main.tf \
  'passwords_wo_version = var.valkey_password_version_a' 'passwords_wo_version = var.secret_version'
reject_mutation wrong-active-password-selector modules/cache/main.tf \
  'var.valkey_active_slot == "a" ? var.valkey_password_a : var.valkey_password_b' 'var.valkey_active_slot == "a" ? var.valkey_password_b : var.valkey_password_a'
reject_mutation missing-active-username-secret modules/cache/main.tf \
  '    username = local.active_user_name' '    removed_username = local.active_user_name'
reject_mutation bypass-valkey-slot-parity modules/cache/main.tf \
  '(var.valkey_active_slot == "a" && var.secret_version % 2 == 1)' '(var.valkey_active_slot == "a")'
reject_mutation bypass-valkey-reset-approval modules/cache/main.tf \
  'local.slots_requiring_reset_approval == toset(keys(var.valkey_password_reset_approvals))' 'toset([]) == toset([])'
reject_mutation omit-valkey-live-evidence modules/cache/variables.tf \
  '        approval.old_slot_connections_drained &&' '        true &&'
reject_mutation allow-hmac-reset-with-password modules/cache/variables.tf \
  '        approval.hmac_key_unchanged &&' '        true &&'
reject_mutation allow-application-release-during-hmac-maintenance modules/cache/outputs.tf \
  'application_release_allowed                   = var.valkey_rotation_mode != "hmac-maintenance"' 'application_release_allowed                   = true'
reject_mutation hide-hmac-maintenance-state modules/cache/outputs.tf \
  'maintenance_in_progress                       = var.valkey_rotation_mode == "hmac-maintenance"' 'maintenance_in_progress                       = false'
reject_mutation bypass-hmac-evidence-hash modules/cache/variables.tf \
  'can(regex("^[0-9a-f]{64}$", var.valkey_hmac_maintenance_approval.evidence_reference.sha256))' 'true'
reject_mutation allow-comma-in-valkey-password modules/cache/variables.tf \
  '[,\\\"/@]' '[\\\"/@]'
reject_mutation bypass-valkey-password-fingerprint modules/cache/main.tf \
  'sha256(var.valkey_password_a) == var.valkey_password_fingerprint_a' 'true'
reject_mutation omit-valkey-plan-state-machine scripts/verify.sh \
  'ruby "$script_directory/test-valkey-rotation-plan.rb"' 'true'
reject_mutation allow-active-slot-reset scripts/verify-valkey-rotation-plan.rb \
  'version_changed_slots == [inactive_slot]' 'version_changed_slots.length == 1'
reject_mutation allow-hmac-maintenance-without-evidence scripts/verify-valkey-rotation-plan.rb \
  'assert(!evidence_payload.nil?, "HMAC 单计划维护缺少 --evidence 静默证据")' 'assert(true, "HMAC 单计划维护缺少 --evidence 静默证据")'
reject_mutation bypass-hmac-evidence-target-binding scripts/verify-valkey-rotation-plan.rb \
  'assert(target == before.fetch("target_identity")' 'assert(target == target'
reject_mutation allow-expired-hmac-evidence scripts/verify-valkey-rotation-plan.rb \
  'assert(expires_at > now, "HMAC 静默证据已过期")' 'assert(true, "HMAC 静默证据已过期")'
reject_mutation reject-normal-terraform-data-computed-fields scripts/verify-valkey-rotation-plan.rb \
  'after_unknown.fetch("input", false)' 'after_unknown'
reject_mutation allow-extra-resource-in-hmac-plan scripts/verify-valkey-rotation-plan.rb \
  'assert(actual_addresses.sort == expected_addresses.sort, "HMAC #{transition == :hmac_entry ? "入口" : "出口"} plan 的非 no-op 资源集合不符合精确 allowlist")' \
  'assert(true, "HMAC #{transition == :hmac_entry ? "入口" : "出口"} plan 的非 no-op 资源集合不符合精确 allowlist")'
reject_mutation broad-valkey-keyspace modules/cache/main.tf \
  '~rgs:shared-admission:v1:*' '~*'
reject_mutation invalid-valkey-alarm-dimension modules/cache/main.tf \
  'CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"' 'ReplicationGroupId = aws_elasticache_replication_group.this.id'
reject_mutation mutable-valkey-secret-name modules/cache/main.tf \
  'rgs-shared-admission-v${var.secret_version}' 'rgs-shared-admission-v1'
reject_mutation mutable-application-secret-name modules/secrets/main.tf \
  'var.secret_versions[each.key]' '1'
reject_mutation stateful-shared-admission-secret modules/cache/main.tf \
  'secret_string_wo = jsonencode({' 'secret_string = jsonencode({'
reject_mutation noncanonical-shared-admission-hmac modules/cache/variables.tf \
  'base64encode(base64decode(var.shared_admission_hmac_key)) == var.shared_admission_hmac_key' 'can(base64decode(var.shared_admission_hmac_key))'
reject_mutation collapsed-runtime-secret-boundary modules/secrets/main.tf \
  'worker-runtime-assets = "rgs-worker-runtime-assets"' 'runtime-assets = "rgs-runtime-assets"'
reject_mutation broad-shared-admission-secret-sync modules/secrets/main.tf \
  'secret:${var.shared_admission_secret_name_prefix}-v*' 'secret:*'
reject_mutation overlapping-subnet-guard modules/network/main.tf \
  'left_index >= right_index || !try(' 'true || !try('
reject_mutation same-region-backup modules/delivery-contract/variables.tf \
  'split(":", var.backup_copy_destination_vault_arn)[3] != var.aws_region' 'split(":", var.backup_copy_destination_vault_arn)[3] == var.aws_region'
reject_mutation broad-alb-egress modules/network/main.tf \
  'ip_protocol       = "tcp"' 'ip_protocol       = "-1"'
reject_mutation false-application-ready stacks/application-platform/outputs.tf \
  'foundation_apply_is_application_ready = false' 'foundation_apply_is_application_ready = true'
reject_mutation public-runner-contract contracts/cluster-addons-interface.v1.yaml \
  'requiresPrivateVpcRunner: true' 'requiresPrivateVpcRunner: false'
reject_mutation allow-iam-change-during-hmac-maintenance contracts/cluster-addons-interface.v1.yaml \
  'hmacMaintenanceAllowsIamPolicyChanges: false' 'hmacMaintenanceAllowsIamPolicyChanges: true'
reject_mutation missing-metrics-server-deployment stacks/application-platform/outputs.tf \
  'metrics_server               = "kube-system/metrics-server"' 'metrics_server               = "kube-system/other"'
reject_mutation missing-kube-state-metrics-deployment stacks/application-platform/outputs.tf \
  'kube_state_metrics           = "monitoring/kube-prometheus-stack-kube-state-metrics"' 'kube_state_metrics           = "monitoring/other"'
reject_mutation unavailable-resource-metrics-api contracts/cluster-addons-interface.v1.yaml \
  'requiredApiServiceCondition: Available=True' 'requiredApiServiceCondition: Available=False'
reject_mutation disable-hpa-condition-alert-source contracts/cluster-addons-interface.v1.yaml \
  'requiredForHpaConditionAlerts: true' 'requiredForHpaConditionAlerts: false'
reject_mutation public-web-bucket modules/web-edge/main.tf \
  'block_public_acls       = true' 'block_public_acls       = false'
reject_mutation writable-archive-marker modules/archive/main.tf \
  'AutomatedExportReady = "false"' 'AutomatedExportReady = "true"'
reject_mutation public-account-provider environments/dev/main.tf \
  'allowed_account_ids = [var.configuration.expected_account_id]' 'allowed_account_ids = []'
reject_mutation secret-in-tfvars environments/dev/terraform.tfvars.example \
  'configuration = {' 'configuration = {\n  password = "unsafe"'

printf '%s\n' 'Terraform negative contract: passed'
