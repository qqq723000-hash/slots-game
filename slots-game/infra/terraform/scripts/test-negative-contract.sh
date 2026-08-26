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
reject_mutation false-api-origin-bypass-model contracts/landing-zone-interface.v1.yaml \
  'sourceBypassModel: not-applicable-alb-is-authoritative-origin' 'sourceBypassModel: cloudfront-secret-header'
reject_mutation include-recovery-in-low-rate-scope contracts/landing-zone-interface.v1.yaml \
  'statusResultAckExcludedFromLowRateRules: true' 'statusResultAckExcludedFromLowRateRules: false'
reject_mutation allow-options-to-bypass-api-high-rate contracts/landing-zone-interface.v1.yaml \
  'optionsPreflightCoveredByHighRateRule: true' 'optionsPreflightCoveredByHighRateRule: false'
reject_mutation treat-source-ip-as-identity-authority contracts/landing-zone-interface.v1.yaml \
  'sourceIpRateRulesAreNotIdentityAuthority: true' 'sourceIpRateRulesAreNotIdentityAuthority: false'
reject_mutation claim-unverified-edge-enhancement contracts/landing-zone-interface.v1.yaml \
  'noneMayBeClaimedWithoutLiveEvidence: true' 'noneMayBeClaimedWithoutLiveEvidence: false'
reject_mutation allow-waf-sampled-request-data-plane contracts/landing-zone-interface.v1.yaml \
  'sampledRequestsEnabled: false' 'sampledRequestsEnabled: true'
reject_mutation allow-unapproved-waf-evidence-kms contracts/landing-zone-interface.v1.yaml \
  'blockPromotionRequiresApprovedKmsKey: true' 'blockPromotionRequiresApprovedKmsKey: false'
reject_mutation allow-unlocked-waf-evidence contracts/landing-zone-interface.v1.yaml \
  'blockPromotionRequiresComplianceObjectLock: true' 'blockPromotionRequiresComplianceObjectLock: false'
reject_mutation omit-waf-object-retention-read contracts/landing-zone-interface.v1.yaml \
  's3:GetObjectRetention' 's3:GetRetentionRemoved'
reject_mutation omit-web-origin-public-access-read contracts/landing-zone-interface.v1.yaml \
  's3:GetBucketPublicAccessBlock' 's3:GetBucketPublicAccessRemoved'
reject_mutation omit-web-origin-policy-read contracts/landing-zone-interface.v1.yaml \
  's3:GetBucketPolicy' 's3:ReadBucketPolicyRemoved'
reject_mutation omit-alb-listener-rule-read contracts/landing-zone-interface.v1.yaml \
  'elasticloadbalancing:DescribeRules' 'elasticloadbalancing:GetRules'
reject_mutation omit-eks-addon-read contracts/landing-zone-interface.v1.yaml \
  'eks:DescribeAddon' 'eks:GetAddon'
reject_mutation omit-eks-pod-identity-read contracts/landing-zone-interface.v1.yaml \
  'eks:DescribePodIdentityAssociation' 'eks:GetPodIdentityAssociation'
reject_mutation omit-eks-pod-identity-list contracts/landing-zone-interface.v1.yaml \
  'eks:ListPodIdentityAssociations' 'eks:GetPodIdentityAssociations'
reject_mutation omit-rds-reader-live-read contracts/landing-zone-interface.v1.yaml \
  'rds:DescribeDBInstances' 'rds:GetDBInstances'
reject_mutation omit-rds-deadlock-filter-live-read contracts/landing-zone-interface.v1.yaml \
  'logs:DescribeMetricFilters' 'logs:GetMetricFilters'
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
reject_mutation omit-encrypted-cloudwatch-alarm-kms-principal modules/kms/main.tf \
  'principal  = "cloudwatch.amazonaws.com"' 'principal  = "events.amazonaws.com"'
reject_mutation broaden-encrypted-cloudwatch-alarm-kms-source modules/kms/main.tf \
  'source_arn = "arn:${data.aws_partition.current.partition}:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.name_prefix}-*"' 'source_arn = "*"'
reject_mutation omit-alert-topic-sns-kms-principal modules/kms/main.tf \
  'identifiers = ["sns.amazonaws.com"]' 'identifiers = ["events.amazonaws.com"]'
reject_mutation remove-alert-topic-kms-encryption-context modules/kms/main.tf \
  'variable = "kms:EncryptionContext:aws:sns:topicArn"' 'variable = "kms:EncryptionContext:other"'
reject_mutation remove-api-waf-managed-common modules/api-edge-security/main.tf \
  'AWSManagedRulesCommonRuleSet' 'DisabledCommonRuleGroup'
reject_mutation expose-public-healthz modules/api-edge-security/main.tf \
  'search_string         = "/healthz"' 'search_string         = "/readyz"'
reject_mutation widen-api-waf-protocol-surface modules/api-edge-security/main.tf \
  'search_string         = "/operator/"' 'search_string         = "/"'
reject_mutation widen-api-waf-launch-to-all-operator modules/api-edge-security/main.tf \
  'search_string         = "/operator/v1/launches"' 'search_string         = "/operator/"'
reject_mutation weaken-api-waf-low-rate-match modules/api-edge-security/main.tf \
  'positional_constraint = "EXACTLY"' 'positional_constraint = "STARTS_WITH"'
reject_mutation count-options-as-api-new-intent modules/api-edge-security/main.tf \
  'search_string         = "POST"' 'search_string         = "OPTIONS"'
reject_mutation remove-api-high-rate-get-recovery modules/api-edge-security/main.tf \
  'search_string         = "GET"' 'search_string         = "OPTIONS"'
reject_mutation remove-api-high-rate-options-protection modules/api-edge-security/main.tf \
  'search_string         = "OPTIONS"' 'search_string         = "HEAD"'
reject_mutation remove-api-rate-edge-marker modules/api-edge-security/main.tf \
  'value = "RATE_LIMITED"' 'value = "UNMARKED"'
reject_mutation exceed-client-api-rate-retry-window modules/api-edge-security/main.tf \
  'value = "30"' 'value = "60"'
reject_mutation hide-api-rate-retry-from-browser modules/api-edge-security/main.tf \
  'value = "Retry-After, X-RGS-Edge-Error"' 'value = "X-RGS-Edge-Error"'
reject_mutation collapse-api-waf-public-budget modules/api-edge-security/main.tf \
  'limit                 = var.rate_limits.public_requests_per_minute' 'limit                 = var.rate_limits.launch_requests_per_minute'
reject_mutation bypass-api-managed-count-stage modules/api-edge-security/main.tf \
  'for_each = var.managed_rule_rollout.action == "count" ? [1] : []' 'for_each = []'
reject_mutation bypass-api-rate-count-stage modules/api-edge-security/main.tf \
  'for_each = var.rate_rule_rollouts["launch-rate-limit"].action == "count" ? [1] : []' 'for_each = []'
reject_mutation bypass-api-header-count-stage modules/api-edge-security/main.tf \
  'for_each = var.header_size_rule_rollout.action == "count" ? [1] : []' 'for_each = []'
reject_mutation allow-unknown-api-rate-rollout-key modules/api-edge-security/variables.tf \
  '["launch-rate-limit", "public-api-rate-limit", "spin-rate-limit"]' '["launch-rate-limit", "public-api-rate-limit", "unknown-rate-limit"]'
reject_mutation permit-api-managed-block-without-evidence modules/api-edge-security/variables.tf \
  'can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", var.managed_rule_rollout.evidence_reference))' 'var.managed_rule_rollout.evidence_reference == "observation-pending"'
reject_mutation bypass-api-waf-body-oversize modules/api-edge-security/main.tf \
  'oversize_handling = "MATCH"' 'oversize_handling = "NO_MATCH"'
reject_mutation weaken-api-waf-rate-window modules/api-edge-security/main.tf \
  'evaluation_window_sec = 60' 'evaluation_window_sec = 300'
reject_mutation retain-all-api-waf-logs modules/api-edge-security/main.tf \
  'default_behavior = "DROP"' 'default_behavior = "KEEP"'
reject_mutation leak-api-waf-authorization modules/api-edge-security/main.tf \
  'name = "authorization"' 'name = "unredacted-secret-header"'
reject_mutation leak-api-waf-query-string modules/api-edge-security/main.tf \
  'query_string {}' 'uri_path {}'
reject_mutation enable-api-waf-sampled-requests modules/api-edge-security/main.tf \
  'sampled_requests_enabled   = false' 'sampled_requests_enabled   = true'
reject_mutation unpin-api-managed-rule-version modules/api-edge-security/main.tf \
  'version     = var.managed_rule_versions[rule.key]' 'version     = null'
reject_mutation disable-api-waf-alarm-delivery modules/api-edge-security/main.tf \
  'alarm_actions       = [var.alert_topic_arn]' 'alarm_actions       = []'
reject_mutation use-resource-name-for-waf-alarm-dimension modules/api-edge-security/main.tf \
  'WebACL = local.web_acl_metric' 'WebACL = local.web_acl_name'
reject_mutation falsely-claim-api-cloudfront-proxy modules/api-edge-security/outputs.tf \
  'cloudfront_is_api_proxy      = false' 'cloudfront_is_api_proxy      = true'
reject_mutation falsely-claim-public-web-origin-private modules/web-edge/outputs.tf \
  'origin_public_access_blocked = true' 'origin_public_access_blocked = false'
reject_mutation falsely-use-cloudfront-as-api-proxy modules/web-edge/outputs.tf \
  'api_proxy                    = false' 'api_proxy                    = true'
reject_mutation claim-cloudfront-sampled-requests-safe modules/web-edge/outputs.tf \
  'sampled_requests_enabled     = false' 'sampled_requests_enabled     = true'
reject_mutation omit-cloudfront-waf-metric-contract modules/web-edge/outputs.tf \
  'web_acl_metric_name          = replace("${var.name_prefix}-web", "-", "_")' \
  'web_acl_metric_name          = "unbound"'
reject_mutation omit-cloudfront-response-function-delivery stacks/environment/outputs.tf \
  '    cloudfront_release_response_function_arn  = module.platform.cloudfront_release_response_function_arn' \
  '    cloudfront_release_response_function_arn  = ""'
reject_mutation omit-cloudfront-managed-rule-versions modules/web-edge/outputs.tf \
  'managed_rule_versions           = var.waf_managed_rule_versions' 'managed_rule_versions           = {}'
reject_mutation bypass-cloudfront-managed-count-stage modules/web-edge/variables.tf \
  'var.waf_managed_rule_rollout.action == "count"' 'var.waf_managed_rule_rollout.action == "block"'
reject_mutation bypass-cloudfront-rate-count-stage modules/web-edge/variables.tf \
  'var.waf_rate_rule_rollout.action == "count"' 'var.waf_rate_rule_rollout.action == "block"'
reject_mutation promote-managed-rules-without-evidence environments/prod-primary/terraform.tfvars.example \
  'action             = "count"' 'action             = "block"'
reject_mutation public-rds modules/rds/main.tf \
  'publicly_accessible    = false' 'publicly_accessible    = true'
reject_mutation unencrypted-rds-logs modules/rds/main.tf \
  'kms_key_id        = var.log_kms_key_arn' 'kms_key_id        = null'
reject_mutation mismatched-rds-parameter-family modules/rds/main.tf \
  'var.parameter_group_family == "postgres${split(".", var.engine_version)[0]}"' 'var.parameter_group_family != "postgres${split(".", var.engine_version)[0]}"'
reject_mutation disable-rds-cpu-capacity-alarm modules/rds/main.tf \
  'metric_name = "CPUUtilization"' 'metric_name = "CPUUtilizationDisabled"'
reject_mutation use-nonexistent-native-rds-deadlock-metric modules/rds/main.tf \
  'metric_name         = local.deadlock_metric_name' 'metric_name         = "Deadlocks"'
reject_mutation corrupt-rds-deadlock-filter-pattern modules/rds/main.tf \
  'deadlock_filter_pattern   = "\"deadlock detected\""' 'deadlock_filter_pattern   = "\"deadlock_detected\""'
reject_mutation detach-rds-deadlock-filter-log-group modules/rds/main.tf \
  'log_group_name = aws_cloudwatch_log_group.this["postgresql"].name' 'log_group_name = aws_cloudwatch_log_group.this["upgrade"].name'
reject_mutation corrupt-rds-deadlock-custom-namespace modules/rds/main.tf \
  'deadlock_metric_namespace = "Slots/RDSLogEvents"' 'deadlock_metric_namespace = "AWS/RDS"'
reject_mutation disable-rds-deadlock-filter-count modules/rds/main.tf \
  'value         = "1"' 'value         = "0"'
reject_mutation corrupt-rds-deadlock-filter-default modules/rds/main.tf \
  'default_value = 0' 'default_value = 1'
reject_mutation misunit-rds-deadlock-filter modules/rds/main.tf \
  'unit          = "Count"' 'unit          = "Bytes"'
reject_mutation defer-single-rds-deadlock modules/rds/main.tf \
  'evaluation_periods  = 1' 'evaluation_periods  = 3'
reject_mutation misunit-rds-iops modules/rds/main.tf \
  'unit        = "Count/Second"' 'unit        = "Count"'
reject_mutation disable-rds-swap-usage modules/rds/main.tf \
  'metric_name = "SwapUsage"' 'metric_name = "SwapUsageDisabled"'
reject_mutation fabricate-rds-replica-lag modules/rds/main.tf \
  'metric_name = "ReadIOPS"' 'metric_name = "ReplicaLag"'
reject_mutation drop-rds-total-iops-write-side modules/rds/main.tf \
  'expression  = "m1 + m2"' 'expression  = "m1"'
reject_mutation disable-rds-total-expression-return-data modules/rds/main.tf \
  'return_data = true' 'return_data = false'
reject_mutation enable-rds-total-source-return-data modules/rds/main.tf \
  'return_data = false' 'return_data = true'
reject_mutation corrupt-rds-total-source-period modules/rds/main.tf \
  'period      = 60' 'period      = 300'
reject_mutation corrupt-rds-total-source-statistic modules/rds/main.tf \
  'stat        = "Average"' 'stat        = "Sum"'
reject_mutation corrupt-rds-total-source-namespace modules/rds/main.tf \
  'namespace   = "AWS/RDS"' 'namespace   = "AWS/EC2"'
reject_mutation disable-rds-high-capacity-alarm-set modules/rds/main.tf \
  'for_each = local.capacity_high_alarm_metrics' 'for_each = {}'
reject_mutation corrupt-rds-high-capacity-namespace modules/rds/main.tf \
  'namespace           = "AWS/RDS"' 'namespace           = "AWS/RDS_DISABLED"'
reject_mutation invert-rds-low-capacity-comparator modules/rds/main.tf \
  'comparison_operator = "LessThanOrEqualToThreshold"' 'comparison_operator = "GreaterThanOrEqualToThreshold"'
reject_mutation invert-rds-low-capacity-statistic modules/rds/main.tf \
  'statistic   = "Minimum"' 'statistic   = "Maximum"'
reject_mutation weaken-rds-capacity-alarm-debounce modules/rds/main.tf \
  'datapoints_to_alarm = 2' 'datapoints_to_alarm = 1'
reject_mutation remove-rds-capacity-recovery-notification modules/rds/main.tf \
  'ok_actions          = [var.alert_topic_arn]' 'ok_actions          = []'
reject_mutation bypass-rds-connection-threshold-validation modules/rds/variables.tf \
  'var.alarm_thresholds.database_connections <= 1000000' 'true'
reject_mutation weaken-rds-deadlock-threshold-validation modules/rds/variables.tf \
  'var.alarm_thresholds.deadlocks_per_minute == 1' 'var.alarm_thresholds.deadlocks_per_minute >= 1'
reject_mutation weaken-rds-total-iops-threshold-validation modules/rds/variables.tf \
  'floor(var.alarm_thresholds.total_iops_per_second) == var.alarm_thresholds.total_iops_per_second' 'true'
reject_mutation omit-explicit-rds-connection-threshold environments/dev/terraform.tfvars.example \
  '  rds_alarm_thresholds = {
    cpu_utilization_percent   = 70
    database_connections     = 100' \
  '  rds_alarm_thresholds = {
    cpu_utilization_percent   = 70
    removed_connections      = 100'
reject_mutation omit-explicit-rds-throughput-threshold environments/dev/terraform.tfvars.example \
  'total_throughput_bytes_per_second = 104857600' 'removed_total_throughput            = 104857600'
reject_mutation understate-prod-rds-gp3-iops-threshold environments/prod-primary/terraform.tfvars.example \
  'total_iops_per_second             = 9600' 'total_iops_per_second             = 2400'
reject_mutation understate-prod-rds-gp3-throughput-threshold environments/prod-dr/terraform.tfvars.example \
  'total_throughput_bytes_per_second = 419430400' 'total_throughput_bytes_per_second = 104857600'
reject_mutation omit-rds-alarm-threshold-wiring stacks/application-platform/main.tf \
  'alarm_thresholds          = var.rds_alarm_thresholds' 'removed_alarm_thresholds  = var.rds_alarm_thresholds'
reject_mutation claim-automatic-rds-deadlock-snapshot modules/rds/outputs.tf \
  'automatic_snapshot_implemented      = false' 'automatic_snapshot_implemented      = true'
reject_mutation omit-rds-alarm-delivery stacks/environment/outputs.tf \
  'rds_alarm_contract                        = module.platform.rds_alarm_contract' \
  'rds_alarm_contract                        = {}'
reject_mutation enable-unreviewed-prod-rds-reader environments/prod-primary/terraform.tfvars.example \
  '  rds_read_replica = {
    enabled        = false' \
  '  rds_read_replica = {
    enabled        = true'
reject_mutation force-rds-reader-when-disabled modules/rds/main.tf \
  'count = var.read_replica.enabled ? 1 : 0' 'count = 1'
reject_mutation allow-single-az-production-rds-reader stacks/application-platform/main.tf \
  '(!var.rds_read_replica.enabled || var.rds_read_replica.multi_az)' 'true'
reject_mutation weaken-same-region-rds-reader-source modules/rds/main.tf \
  'replicate_source_db = aws_db_instance.this.arn' 'replicate_source_db = aws_db_instance.this.identifier'
reject_mutation detach-rds-reader-vpc-security-group modules/rds/main.tf \
  '  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]' \
  '  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = []'
reject_mutation detach-rds-reader-security-group modules/rds/main.tf \
  'DBInstanceIdentifier = aws_db_instance.reader[0].identifier' \
  'DBInstanceIdentifier = aws_db_instance.this.identifier'
reject_mutation remove-rds-reader-version-backup-gate modules/rds/main.tf \
  'tonumber(split(".", var.engine_version)[0]) > 14' 'true'
reject_mutation allow-rds-reader-lag-silence modules/rds/main.tf \
  'treat_missing_data  = "breaching"' 'treat_missing_data  = "notBreaching"'
reject_mutation claim-rds-reader-application-routing modules/rds/outputs.tf \
  'application_routing_adopted     = false' 'application_routing_adopted     = true'
reject_mutation claim-rds-reader-cross-region-dr modules/rds/outputs.tf \
  'cross_region_dr_implemented     = false' 'cross_region_dr_implemented     = true'
reject_mutation misdeclare-rds-reader-storage-type modules/rds/outputs.tf \
  'storage_type                    = var.read_replica.enabled ? "gp3" : null' \
  'storage_type                    = var.read_replica.enabled ? "gp2" : null'
reject_mutation omit-rds-read-scaling-delivery stacks/environment/outputs.tf \
  'rds_read_scaling_contract                 = module.platform.rds_read_scaling_contract' \
  'rds_read_scaling_contract                 = {}'
reject_mutation omit-cloudwatch-alarm-sns-principal modules/observability/main.tf \
  'identifiers = ["cloudwatch.amazonaws.com"]' 'identifiers = ["events.amazonaws.com"]'
reject_mutation broaden-cloudwatch-alarm-sns-source modules/observability/main.tf \
  'values   = [local.alert_source_arns.cloudwatch]' 'values   = ["*"]'
reject_mutation broaden-cloudwatch-alarm-sns-source-binding modules/observability/main.tf \
  'cloudwatch = "arn:${data.aws_partition.current.partition}:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.name_prefix}-*"' 'cloudwatch = "*"'
reject_mutation use-wrong-rds-event-publisher modules/observability/main.tf \
  'identifiers = ["events.rds.amazonaws.com"]' 'identifiers = ["rds.amazonaws.com"]'
reject_mutation omit-alert-topic-policy-dependency modules/observability/outputs.tf \
  'depends_on  = [aws_sns_topic_policy.alerts]' 'depends_on  = []'
reject_mutation weak-valkey-tls modules/cache/main.tf \
  'transit_encryption_mode    = "required"' 'transit_encryption_mode    = "preferred"'
reject_mutation allow-valkey-admission-eviction modules/cache/main.tf \
  'value = "noeviction"' 'value = "volatile-lru"'
reject_mutation detach-valkey-noeviction-parameter-group modules/cache/main.tf \
  'parameter_group_name = aws_elasticache_parameter_group.noeviction.name' 'parameter_group_name = null'
reject_mutation hardcode-wrong-valkey-parameter-family modules/cache/main.tf \
  'family      = local.valkey_parameter_group_family' 'family      = "valkey7"'
reject_mutation omit-valkey-live-parameter-group-handoff stacks/environment/outputs.tf \
  'valkey_parameter_group_name               = module.platform.valkey_parameter_group_name' 'removed_valkey_parameter_group_name       = module.platform.valkey_parameter_group_name'
reject_mutation omit-valkey-live-policy-read-permission contracts/landing-zone-interface.v1.yaml \
  '        - elasticache:DescribeCacheParameters' '        - elasticache:DescribeCacheParameterGroups'
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
reject_mutation allow-steady-valkey-v1-schema-change scripts/verify-valkey-rotation-plan.rb \
  'assert(transition == :hmac_entry, "Valkey v1 keyspace 迁移只能进入有静默证据的 HMAC 维护计划")' \
  'assert(true, "Valkey v1 keyspace 迁移只能进入有静默证据的 HMAC 维护计划")'
reject_mutation allow-economic-acl-expansion-during-password-rotation scripts/verify-valkey-rotation-plan.rb \
  'assert(transition == :steady, "Valkey v2 economic ACL 追加只能在 steady 计划中先于新 runtime 应用")' \
  'assert(true, "Valkey v2 economic ACL 追加只能在 steady 计划中先于新 runtime 应用")'
reject_mutation broad-valkey-keyspace modules/cache/main.tf \
  '~rgs:shared-admission:v2:*' '~*'
reject_mutation legacy-valkey-keyspace modules/cache/main.tf \
  '~rgs:shared-admission:v2:*' '~rgs:shared-admission:v1:*'
reject_mutation missing-valkey-pttl modules/cache/main.tf \
  '+evalsha +eval +get +pttl +set' '+evalsha +eval +get +set'
reject_mutation missing-valkey-economic-time modules/cache/main.tf \
  '+set +time +mset +pexpire' '+set +mset +pexpire'
reject_mutation missing-valkey-economic-mset modules/cache/main.tf \
  '+set +time +mset +pexpire' '+set +time +pexpire'
reject_mutation missing-valkey-economic-expiry modules/cache/main.tf \
  '+set +time +mset +pexpire' '+set +time +mset'
reject_mutation reintroduce-legacy-valkey-commands modules/cache/main.tf \
  '+set +time +mset +pexpire' '+set +time +mset +pexpire +hmget +hset'
reject_mutation bypass-valkey-acl-maintenance-transition modules/cache/outputs.tf \
  'acl_schema_transition                  = "maintenance-quiesced"' 'acl_schema_transition                  = "rolling"'
reject_mutation allow-rolling-valkey-acl-schema modules/cache/outputs.tf \
  'acl_schema_rolling_compatible          = false' 'acl_schema_rolling_compatible          = true'
reject_mutation allow-dual-valkey-acl-schema modules/cache/outputs.tf \
  'acl_schema_dual_permissions_allowed    = false' 'acl_schema_dual_permissions_allowed    = true'
reject_mutation bypass-valkey-acl-quiesce modules/cache/outputs.tf \
  'acl_schema_migration_requires_quiesced = true' 'acl_schema_migration_requires_quiesced = false'
reject_mutation omit-valkey-acl-contract-from-handoff stacks/application-platform/outputs.tf \
  'valkey_rotation_contract        = module.cache.rotation_contract' 'removed_valkey_rotation_contract = module.cache.rotation_contract'
reject_mutation invalid-valkey-alarm-dimension modules/cache/main.tf \
  'CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"' 'ReplicationGroupId = aws_elasticache_replication_group.this.id'
reject_mutation invalid-valkey-capacity-alarm-dimension modules/cache/main.tf \
  'ReplicationGroupId = aws_elasticache_replication_group.this.id' 'CacheClusterId = aws_elasticache_replication_group.this.id'
reject_mutation disable-valkey-traffic-management-alarm modules/cache/main.tf \
  'metric_name         = "TrafficManagementActive"' 'metric_name         = "TrafficManagementInactive"'
reject_mutation disable-valkey-eval-latency-alarm modules/cache/main.tf \
  'metric_name         = "EvalBasedCmdsLatency"' 'metric_name         = "EvalBasedCmds"'
reject_mutation weaken-valkey-binary-alarm-threshold modules/cache/main.tf \
  'threshold           = 0' 'threshold           = 1'
reject_mutation weaken-valkey-alarm-debounce modules/cache/main.tf \
  'datapoints_to_alarm = 2' 'datapoints_to_alarm = 1'
reject_mutation remove-valkey-alarm-recovery-notification modules/cache/main.tf \
  'ok_actions          = [var.alert_topic_arn]' 'ok_actions          = []'
reject_mutation bypass-valkey-engine-cpu-threshold-validation modules/cache/variables.tf \
  'var.valkey_alarm_thresholds.engine_cpu_utilization_percent <= 100' 'true'
reject_mutation omit-explicit-valkey-connection-threshold environments/dev/terraform.tfvars.example \
  '    current_connections                               = 100' '    removed_connections                               = 100'
reject_mutation allow-rolling-valkey-v1-v2-migration README.md \
  '该协议迁移禁止作为普通 Helm rolling upgrade' '该协议迁移允许作为普通 Helm rolling upgrade'
reject_mutation remove-valkey-acl-maintenance-state README.md \
  '`acl_schema_transition=maintenance-quiesced`' '`acl_schema_transition=rolling`'
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
reject_mutation omit-alb-operations-health-egress modules/network/main.tf \
  'from_port         = 8081' 'from_port         = 8080'
reject_mutation widen-alb-health-egress-to-internet modules/network/main.tf \
  'cidr_ipv4         = var.vpc_cidr
  from_port         = 8081' 'cidr_ipv4         = "0.0.0.0/0"
  from_port         = 8081'
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
reject_mutation disable-cloudfront-http3 modules/web-edge/main.tf \
  'http_version        = "http2and3"' 'http_version        = "http2"'
reject_mutation writable-archive-marker modules/archive/main.tf \
  'AutomatedExportReady = "false"' 'AutomatedExportReady = "true"'
reject_mutation public-account-provider environments/dev/main.tf \
  'allowed_account_ids = [var.configuration.expected_account_id]' 'allowed_account_ids = []'
reject_mutation secret-in-tfvars environments/dev/terraform.tfvars.example \
  'configuration = {' 'configuration = {\n  password = "unsafe"'

printf '%s\n' 'Terraform negative contract: passed'
