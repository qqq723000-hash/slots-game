#!/bin/sh
# shellcheck disable=SC1003,SC2016

# 该门禁只读取源码，不需要 GitHub Environment、OIDC、Registry 或 AWS 凭据。
# English: The gate only reads source code and does not require GitHub Environment, OIDC, Registry or AWS
# credentials.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=${AWS_WORKFLOW_REPOSITORY_ROOT:-$(CDPATH='' cd -- "$script_directory/../../../.." && pwd)}
infrastructure_workflow="$repository_root/.github/workflows/aws-infrastructure.yml"
application_workflow="$repository_root/.github/workflows/aws-application-deploy.yml"
hmac_workflow="$repository_root/.github/workflows/aws-hmac-quiesce-evidence.yml"
workflow_directory="$repository_root/slots-game/deploy/aws-production/workflow"
production_directory="$repository_root/slots-game/deploy/aws-production"
addon_contract="$repository_root/slots-game/infra/terraform/contracts/cluster-addons-interface.v1.yaml"
rotation_plan_verifier="$repository_root/slots-game/infra/terraform/scripts/verify-valkey-rotation-plan.rb"

fail() {
  printf '%s\n' "AWS 工作流静态契约失败：$*" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "缺少文件：$1"
}

require_fixed() {
  needle=$1
  file=$2
  grep -F -- "$needle" "$file" >/dev/null || fail "缺少固定契约：$needle"
}

require_pattern() {
  pattern=$1
  file=$2
  grep -E -- "$pattern" "$file" >/dev/null || fail "缺少契约模式：$pattern"
}

reject_fixed() {
  needle=$1
  file=$2
  if grep -F -- "$needle" "$file" >/dev/null; then
    fail "包含禁止契约：$needle"
  fi
}

for file in "$infrastructure_workflow" "$application_workflow" "$hmac_workflow" \
  "$workflow_directory/validate-environment.sh" "$workflow_directory/validate-release-inputs.sh" \
  "$workflow_directory/README.md" \
  "$workflow_directory/fingerprint-terraform-ephemeral-inputs.sh" \
  "$workflow_directory/verify-live-application-secrets.sh" \
  "$workflow_directory/verify-live-definition-identity.sh" \
  "$workflow_directory/verify-hmac-quiesce-evidence.rb" \
  "$workflow_directory/verify-hmac-finalize-attestation.rb" \
  "$workflow_directory/manage-hmac-quiesce-evidence.sh" \
  "$workflow_directory/hmac-evidence-marker.sh" \
  "$workflow_directory/hmac-application-maintenance-gate.sh" \
  "$workflow_directory/verify-hmac-only-release-diff.rb" \
  "$workflow_directory/verify-latest-terraform-delivery.sh" \
  "$workflow_directory/test-hmac-quiesce-evidence.sh" \
  "$workflow_directory/test-hmac-application-maintenance.sh" \
  "$workflow_directory/test-hmac-only-release-diff.sh" \
  "$workflow_directory/test-latest-terraform-delivery.sh" \
  "$workflow_directory/test-live-application-secrets.sh" \
  "$workflow_directory/test-rendered-release-network.sh" \
  "$workflow_directory/test-web-rgs-origin.sh" \
  "$workflow_directory/test-live-definition-identity.sh" \
  "$workflow_directory/test-web-release-switch-faults.sh" \
  "$workflow_directory/fixtures/mock-kubectl.sh" \
  "$workflow_directory/fixtures/mock-live-kubectl.sh" \
  "$workflow_directory/fixtures/mock-live-aws.sh" \
  "$workflow_directory/fixtures/mock-definition-kubectl.sh" \
  "$workflow_directory/fixtures/mock-web-release-command.sh" \
  "$workflow_directory/fixtures/live-delivery.json" \
  "$workflow_directory/fixtures/live-values.yaml" \
  "$workflow_directory/fixtures/definition-rendered.yaml" \
  "$workflow_directory/verify-ecr-release.sh" "$workflow_directory/publish-web-release.sh" \
  "$workflow_directory/verify-rendered-release.rb" "$workflow_directory/verify-web-rgs-origin.rb" \
  "$production_directory/render-external-secrets.rb" \
  "$production_directory/verify-live-alb-edge.sh" \
  "$production_directory/verify-live-platform-prerequisites.sh" \
  "$production_directory/verify-waf-rollout-evidence.rb" "$addon_contract" \
  "$rotation_plan_verifier"; do
  require_file "$file"
done

require_fixed 'ruby "$script_directory/verify-waf-rollout-evidence.rb"' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 's3api", "head-object"' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 's3api", "get-object"' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'Digest::SHA256.file' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'ServerSideEncryption' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'SSEKMSKeyId' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'ObjectLockMode' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'ObjectLockRetainUntilDate' "$production_directory/verify-waf-rollout-evidence.rb"
if grep -F -- '--checksum-mode' "$production_directory/verify-waf-rollout-evidence.rb" >/dev/null; then
  fail 'WAF evidence 本地 SHA 校验不得请求未使用且扩大 KMS 权限的 S3 checksum mode'
fi
require_fixed 'configuration_sha256' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'source_commit_sha' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'require_current_approval: require_current_approval' \
  "$production_directory/verify-waf-rollout-evidence.rb"
reject_fixed 'GITHUB_SHA' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'rule_names' "$production_directory/verify-waf-rollout-evidence.rb"
require_fixed 'slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb' "$application_workflow"
require_fixed 'slots-game/deploy/aws-production/verify-live-alb-edge.sh' "$application_workflow"
require_fixed 'deploy/aws-production/workflow/test-rendered-release-network.sh' "$application_workflow"
require_fixed 'elbv2 describe-target-health' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'elbv2 describe-rules' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'delivery.fetch("regional_acm_certificate_arn")' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'delivery.fetch("api_alb_tls_policy")' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'get networkpolicy \' "$production_directory/verify-live-alb-edge.sh"
require_fixed '-o json > "$network_policies_json"' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'wafv2 get-web-acl-for-resource' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'ec2 describe-security-group-rules' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'get networkpolicy' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'default-deny ingress/egress NetworkPolicy 缺失或不精确' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed '实际 RGS NetworkPolicy ALB 来源未精确绑定 Terraform 公网子网 CIDR' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed 'actual_cidrs.length == expected_cidrs.length && actual_cidrs.sort == expected_cidrs.sort' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed '"kubernetes.io/metadata.name" => "monitoring"' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed '"app.kubernetes.io/name" => "prometheus-agent"' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed 'RGS NetworkPolicy monitoring 来源未绑定批准的 Prometheus agent' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'assert_mutation_rejected wrong-monitoring-selector' \
  "$workflow_directory/test-rendered-release-network.sh"
require_fixed '检测到额外 NetworkPolicy 对当前 RGS Pod 放宽 ingress' \
  "$production_directory/verify-live-alb-edge.sh"
for network_policy_negative_mode in \
  networkpolicy-default-deny-missing \
  networkpolicy-alb-cidr-drift \
  networkpolicy-alb-port-drift \
  networkpolicy-rgs-selector-widened \
  networkpolicy-monitoring-selector-empty \
  networkpolicy-monitoring-selector-drift \
  networkpolicy-extra-ingress \
  networkpolicy-extra-rgs-policy \
  networkpolicy-unlabeled-rgs-policy \
  networkpolicy-foreign-instance-rgs-policy
do
  require_fixed "$network_policy_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
done
require_fixed 'managed.keys.sort == %w[Name VendorName Version]' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'managed_statement.keys.sort == %w[Name VendorName Version]' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'header_match.fetch("MatchScope") == "ALL"' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'header_match.fetch("MatchPattern") == {"All" => {}}' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'size.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'rate.keys.sort == %w[AggregateKeyType EvaluationWindowSec Limit]' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'visibility.fetch("CloudWatchMetricsEnabled") == true' \
  "$production_directory/verify-live-platform-prerequisites.sh"
test "$(grep -F -c 'web_acl_visibility.fetch("CloudWatchMetricsEnabled") == true' \
  "$production_directory/verify-live-platform-prerequisites.sh" || true)" -eq 2 || \
  fail 'Regional 与 CloudFront WAF WebACL visibility 都必须启用精确 CloudWatch metric'
test "$(grep -E -c '^[[:space:]]+visibility\.fetch\("CloudWatchMetricsEnabled"\) == true' \
  "$production_directory/verify-live-platform-prerequisites.sh" || true)" -eq 2 || \
  fail 'Regional 与 CloudFront WAF 每条规则 visibility 都必须启用精确 CloudWatch metric'
require_fixed 'alarm.fetch("MetricName") == expected_metrics.fetch(name)' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'alarm.fetch("ComparisonOperator") == "GreaterThanOrEqualToThreshold"' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'filter.fetch("Behavior") == "KEEP" && filter.fetch("Requirement") == "MEETS_ANY"' \
  "$production_directory/verify-live-platform-prerequisites.sh"
test "$(grep -F -c 'filter.fetch("Behavior") == "KEEP" && filter.fetch("Requirement") == "MEETS_ANY"' \
  "$production_directory/verify-live-platform-prerequisites.sh" || true)" -eq 2 || \
  fail 'Regional 与 CloudFront WAF logging filter 都必须精确 KEEP+MEETS_ANY'
require_fixed 'cloudfront_release_response_function_arn' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'default_behavior.fetch("LambdaFunctionAssociations")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'ordered.fetch("LambdaFunctionAssociations")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cache_behaviors.fetch("Quantity") == 1' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'web_edge.fetch("viewer_http_version") == "http2and3"' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'config.fetch("HttpVersion") == delivery.fetch("cloudfront_edge_security_contract").fetch("viewer_http_version")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '"viewer_http_version": "http2and3"' \
  "$workflow_directory/fixtures/live-delivery.json"
require_fixed 'cloudfront-http-version-drift' \
  "$workflow_directory/fixtures/mock-live-aws.sh"
for cloudfront_negative_mode in \
  cloudfront-http-version-drift \
  cloudfront-lambda-association \
  cloudfront-extra-cache-behavior \
  cloudfront-extra-function-association \
  cloudfront-response-function-drift \
  cloudfront-managed-excluded-rules \
  cloudfront-managed-action-override \
  cloudfront-managed-scope-down \
  cloudfront-logging-behavior-drift \
  cloudfront-logging-requirement-drift
do
  require_fixed "$cloudfront_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
done
for regional_negative_mode in \
  waf-managed-excluded-rules \
  waf-managed-action-override \
  waf-managed-scope-down \
  waf-logging-behavior-drift \
  waf-logging-requirement-drift
do
  require_fixed "$regional_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
done
for final_execution_negative_mode in \
  waf-body-size-transform-drift \
  waf-header-size-transform-drift \
  waf-header-match-scope-drift \
  waf-header-match-pattern-drift \
  waf-web-acl-metrics-disabled \
  waf-web-acl-metric-name-drift \
  waf-rule-metrics-disabled \
  waf-rule-metric-name-drift \
  waf-alarm-metric-name-drift \
  waf-alarm-statistic-drift \
  waf-alarm-comparison-drift \
  cloudfront-rate-scope-down \
  cloudfront-web-acl-metrics-disabled \
  cloudfront-web-acl-metric-name-drift \
  cloudfront-rule-metrics-disabled \
  cloudfront-rule-metric-name-drift
do
  require_fixed "$final_execution_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
done
for rds_alarm_negative_mode in \
  rds-alarm-missing \
  rds-alarm-action-drift \
  rds-alarm-metric-drift \
  rds-alarm-unit-drift \
  rds-alarm-threshold-drift \
  rds-alarm-missing-data-drift \
  rds-alarm-dimension-drift \
  rds-deadlock-window-drift \
  rds-deadlock-statistic-drift \
  rds-deadlock-alarm-namespace-drift \
  rds-deadlock-alarm-metric-name-drift \
  rds-deadlock-alarm-dimension-drift \
  rds-deadlock-filter-missing \
  rds-deadlock-filter-log-group-drift \
  rds-deadlock-filter-pattern-drift \
  rds-deadlock-filter-namespace-drift \
  rds-deadlock-filter-metric-name-drift \
  rds-deadlock-filter-value-drift \
  rds-deadlock-filter-default-drift \
  rds-deadlock-filter-unit-drift \
  rds-deadlock-filter-dimension-drift \
  rds-math-expression-drift \
  rds-math-expression-return-data-drift \
  rds-math-source-return-data-drift \
  rds-math-source-statistic-drift \
  rds-math-source-period-drift \
  rds-math-source-namespace-drift \
  rds-math-source-dimension-drift \
  rds-math-extra-query
do
  require_fixed "$rds_alarm_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
  require_fixed "$rds_alarm_negative_mode" "$workflow_directory/fixtures/mock-live-aws.sh"
done
for rds_reader_negative_mode in \
  rds-reader-missing \
  rds-reader-status-drift \
  rds-reader-source-drift \
  rds-reader-endpoint-drift \
  rds-reader-engine-version-drift \
  rds-reader-instance-class-drift \
  rds-reader-storage-type-drift \
  rds-reader-allocated-storage-drift \
  rds-reader-max-storage-drift \
  rds-reader-public \
  rds-reader-multi-az-drift \
  rds-reader-subnet-drift \
  rds-reader-parameter-drift \
  rds-reader-parameter-pending \
  rds-reader-security-group-drift \
  rds-reader-unencrypted \
  rds-reader-kms-drift \
  rds-reader-backup-drift \
  rds-reader-deletion-protection-drift \
  rds-reader-log-export-drift \
  rds-reader-pending-modification \
  rds-reader-alarm-missing \
  rds-reader-alarm-action-drift \
  rds-reader-alarm-metric-drift \
  rds-reader-alarm-statistic-drift \
  rds-reader-alarm-threshold-drift \
  rds-reader-alarm-missing-data-drift \
  rds-reader-alarm-dimension-drift
do
  require_fixed "$rds_reader_negative_mode" "$workflow_directory/test-live-application-secrets.sh"
  require_fixed "$rds_reader_negative_mode" "$workflow_directory/fixtures/mock-live-aws.sh"
done
require_fixed 'rds_alarm_contract' "$workflow_directory/fixtures/live-delivery.json"
require_fixed 'rds = value.fetch("rds_alarm_contract")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'rds_read_scaling_contract' "$workflow_directory/fixtures/live-delivery.json"
require_fixed 'read_scaling = value.fetch("rds_read_scaling_contract")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'rds describe-db-instances' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'application_routing_adopted' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cross_region_dr_implemented' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'alarm.fetch("Unit") == expected.fetch("unit")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'actual_queries = alarm.fetch("Metrics")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'actual.fetch("Expression") == query.fetch("expression")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'actual.fetch("ReturnData") == query.fetch("return_data")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'metric_stat.fetch("Unit") == query.fetch("unit")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '%w[Namespace MetricName Statistic Unit Dimensions Period].none?' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'metric.fetch("threshold") == 1 && metric.fetch("evaluation_periods") == 1' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'logs describe-metric-filters' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'transformation.fetch("defaultValue") == expected.fetch("default_value")' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'deadlock_filter.fetch("filter_pattern") == %q{"deadlock detected"}' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'deadlock_evidence.fetch("automatic_snapshot_implemented") == false' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'HTTP listener 必须仅包含默认规则' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'HTTPS listener 规则集合必须精确为默认 404 与唯一 API host forward' \
  "$production_directory/verify-live-alb-edge.sh"
require_fixed 'alb-http-extra-rule' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-http-redirect-host-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-http-rule-redirect-path-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-http-rule-redirect-query-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-https-default-forward' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-https-extra-rule' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-log-bucket-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'alb-log-prefix-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'delivery.fetch("alb_access_log_bucket_name")' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'delivery.fetch("alb_access_log_prefix")' "$production_directory/verify-live-alb-edge.sh"
require_fixed 'slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb' "$infrastructure_workflow"
require_fixed '--terraform-plan aws "$AWS_REGION" "$source_sha"' "$infrastructure_workflow"
require_fixed 'ruby -c deploy/aws-production/verify-waf-rollout-evidence.rb' "$infrastructure_workflow"

workflow_readme="$workflow_directory/README.md"
require_fixed '本目录由三个 GitHub Actions 工作流调用' "$workflow_readme"
require_fixed 'aws-<环境>-hmac-quiesce-evidence' "$workflow_readme"
require_fixed 'slots-game/hmac-finalize-attestation/v1' "$workflow_readme"
require_fixed 'Phase A：同一镜像、定义、values、delivery、evidence' "$workflow_readme"
require_fixed 'Phase B：--no-hooks --atomic' "$workflow_readme"
require_fixed '三条 workflow 的 `pull_request` 触发器禁止配置 `paths`' "$workflow_readme"
require_fixed '非滚动 PostgreSQL 迁移边界' "$workflow_readme"
require_fixed '普通应用升级中的 Migrator hook 固定执行 `verify`' "$workflow_readme"
require_fixed '尚未交付一个能同时证明 PostgreSQL 旧 writer 活动事务归零' "$workflow_readme"
require_fixed '仍是明确的外部上线阻断' "$workflow_readme"
require_fixed '应用部署与 HMAC 停机在接触 Kubernetes 前都会实时回读 EKS' "$workflow_readme"
require_fixed '`endpointPrivateAccess=true`、`endpointPublicAccess=false`' "$workflow_readme"
require_fixed '不构成 EKS、S3 与 CloudFront 之间的' "$workflow_readme"
require_fixed '禁止宣称“全栈原子发布”' "$workflow_readme"
require_fixed 'KVS 写命令返回非零不能直接退出' "$workflow_readme"
require_fixed '`get-key` 进行第一次权威回读' "$workflow_readme"
require_fixed '`kvs-manual-intervention.env`' "$workflow_readme"

for context_binding in \
  "$infrastructure_workflow|    name: AWS infrastructure static contract" \
  "$application_workflow|    name: AWS application static contract" \
  "$hmac_workflow|    name: AWS HMAC quiesce static contract"
do
  context_file=${context_binding%%|*}
  context_name=${context_binding#*|}
  test "$(grep -F -x -c "$context_name" "$context_file" || true)" -eq 1 || \
    fail "Branch Protection required context 缺少唯一 job 显示名：$context_name"
done
for required_context in \
  'AWS infrastructure static contract' \
  'AWS application static contract' \
  'AWS HMAC quiesce static contract'
do
  require_fixed "\`$required_context\`" "$workflow_readme"
done
if grep -F 'AWS infrastructure delivery / static-contract' "$workflow_readme" >/dev/null; then
  fail 'required context 不得错误包含 workflow display name'
fi

invalid_actions=$(grep -E '^[[:space:]]*uses:[[:space:]]+' \
  "$infrastructure_workflow" "$application_workflow" "$hmac_workflow" | \
  grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' || true)
test -z "$invalid_actions" || fail '所有 GitHub Action 都必须固定完整提交 SHA'

if grep -E 'AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|secrets\.(AWS_ACCESS|AWS_SECRET)' \
  "$infrastructure_workflow" "$application_workflow" "$hmac_workflow" >/dev/null; then
  fail '禁止长期 AWS 密钥和静态 session token'
fi

for workflow in "$infrastructure_workflow" "$application_workflow" "$hmac_workflow"; do
  require_fixed '  pull_request:' "$workflow"
  require_fixed '  workflow_dispatch:' "$workflow"
  require_fixed '          persist-credentials: false' "$workflow"
  pull_request_trigger=$(awk '
    /^  pull_request:/ { capture = 1 }
    /^  workflow_dispatch:/ { capture = 0 }
    capture { print }
  ' "$workflow")
  test "$(printf '%s\n' "$pull_request_trigger" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')" -eq 1 || \
    fail 'Branch Protection required context 要求三条 AWS workflow 对所有 PR 无过滤运行'
done
if grep -E '^[[:space:]]*push:' "$application_workflow" >/dev/null; then
  fail '应用变更工作流不得由普通 push 自动取得生产权限'
fi

infrastructure_push=$(awk '
  /^  push:/ { capture = 1 }
  /^  pull_request:/ { capture = 0 }
  capture { print }
' "$infrastructure_workflow")
for push_binding in \
  '  push:' \
  '    branches:' \
  '      - main' \
  '    paths:' \
  '      - .github/workflows/aws-infrastructure.yml' \
  '      - .github/workflows/aws-application-deploy.yml' \
  '      - .github/workflows/aws-hmac-quiesce-evidence.yml' \
  '      - slots-game/infra/terraform/**' \
  '      - slots-game/deploy/aws-production/workflow/**'
do
  test "$(printf '%s\n' "$infrastructure_push" | grep -F -x -c -- "$push_binding" || true)" -eq 1 || \
    fail "基础设施 push 静态门禁缺少或重复固定边界：$push_binding"
done
test "$(printf '%s\n' "$infrastructure_push" | grep -E -c '^[[:space:]]+- ' || true)" -eq 6 || \
  fail '基础设施 push 静态门禁只能覆盖 main 与五个受控路径'

infrastructure_static=$(awk '
  /^  static-contract:/ { capture = 1 }
  /^  terraform-plan:/ { capture = 0 }
  capture { print }
' "$infrastructure_workflow")
application_static=$(awk '
  /^  static-contract:/ { capture = 1 }
  /^  bind-deployment-source:/ { capture = 0 }
  capture { print }
' "$application_workflow")
application_source_binding=$(awk '
  /^  bind-deployment-source:/ { capture = 1 }
  /^  verify-release:/ { capture = 0 }
  capture { print }
' "$application_workflow")
application_verify=$(awk '
  /^  verify-release:/ { capture = 1 }
  /^  bind-deployment-artifacts:/ { capture = 0 }
  capture { print }
' "$application_workflow")
application_artifact_binding=$(awk '
  /^  bind-deployment-artifacts:/ { capture = 1 }
  /^  deploy:/ { capture = 0 }
  capture { print }
' "$application_workflow")
application_deploy=$(awk '
  /^  deploy:/ { capture = 1 }
  capture { print }
' "$application_workflow")
hmac_static=$(awk '
  /^  static-contract:/ { capture = 1 }
  /^  manage-evidence:/ { capture = 0 }
  capture { print }
' "$hmac_workflow")
hmac_manage=$(awk '
  /^  manage-evidence:/ { capture = 1 }
  capture { print }
' "$hmac_workflow")
infrastructure_apply=$(awk '
  /^  terraform-apply:/ { capture = 1 }
  capture { print }
' "$infrastructure_workflow")
infrastructure_plan=$(awk '
  /^  terraform-plan:/ { capture = 1 }
  /^  bind-terraform-plan:/ { capture = 0 }
  capture { print }
' "$infrastructure_workflow")
infrastructure_artifact_binding=$(awk '
  /^  bind-terraform-plan:/ { capture = 1 }
  /^  terraform-apply:/ { capture = 0 }
  capture { print }
' "$infrastructure_workflow")
for static_job in "$infrastructure_static" "$application_static" "$hmac_static"; do
  printf '%s\n' "$static_job" | grep -F 'contents: read' >/dev/null || fail 'PR 静态 job 必须只有只读内容权限'
  if printf '%s\n' "$static_job" | grep -E 'id-token:[[:space:]]*write|^[[:space:]]+environment:|\$\{\{ secrets\.' >/dev/null; then
    fail 'PR 静态 job 禁止 Environment、OIDC 和 secret'
  fi
done
test -n "$application_artifact_binding" || fail '应用部署缺少独立 artifact 元数据绑定 job'
binding_permissions=$(printf '%s\n' "$application_artifact_binding" | awk '
  $0 == "    permissions:" { capture = 1; next }
  capture && /^    [^ ]/ { exit }
  capture && $0 !~ /^[[:space:]]*(#|$)/ { print }
')
test "$binding_permissions" = '      actions: read' || \
  fail 'artifact 元数据绑定 job 只能读取 Actions 元数据'
if printf '%s\n' "$application_artifact_binding" | \
  grep -E 'actions/checkout@|^[[:space:]]+environment:|id-token:|\$\{\{ secrets\.' >/dev/null; then
  fail 'artifact 元数据绑定 job 禁止 checkout、Environment、OIDC 与 secret'
fi
test -n "$application_source_binding" || fail 'ECR 验证前缺少独立源码 artifact 元数据绑定 job'
source_binding_permissions=$(printf '%s\n' "$application_source_binding" | awk '
  $0 == "    permissions:" { capture = 1; next }
  capture && /^    [^ ]/ { exit }
  capture && $0 !~ /^[[:space:]]*(#|$)/ { print }
')
test "$source_binding_permissions" = '      actions: read' || \
  fail '部署源码 artifact 元数据绑定 job 只能读取 Actions 元数据'
if printf '%s\n' "$application_source_binding" | \
  grep -E 'actions/checkout@|^[[:space:]]+environment:|id-token:|\$\{\{ secrets\.' >/dev/null; then
  fail '部署源码 artifact 元数据绑定 job 禁止 checkout、Environment、OIDC 与 secret'
fi
for source_binding_control in \
  'SOURCE_ARTIFACT_ID: ${{ needs.static-contract.outputs.source_artifact_id }}' \
  'SOURCE_ARTIFACT_DIGEST: ${{ needs.static-contract.outputs.source_artifact_digest }}' \
  'Authorization: Bearer $GH_TOKEN' \
  '$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$SOURCE_ARTIFACT_ID' \
  '.id == $artifact_id and .name == $name and .expired == false and' \
  '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.head_sha == $source_sha'
do
  printf '%s\n' "$application_source_binding" | grep -F -- "$source_binding_control" >/dev/null || \
    fail "部署源码 artifact 元数据绑定缺少：$source_binding_control"
done
printf '%s\n' "$application_verify" | grep -F -x '      - bind-deployment-source' >/dev/null || \
  fail 'ECR OIDC 验证必须等待部署源码 artifact 元数据绑定成功'
test -n "$infrastructure_artifact_binding" || fail 'Terraform apply 缺少独立 plan artifact 元数据绑定 job'
infrastructure_binding_permissions=$(printf '%s\n' "$infrastructure_artifact_binding" | awk '
  $0 == "    permissions:" { capture = 1; next }
  capture && /^    [^ ]/ { exit }
  capture && $0 !~ /^[[:space:]]*(#|$)/ { print }
')
test "$infrastructure_binding_permissions" = '      actions: read' || \
  fail 'Terraform plan artifact 元数据绑定 job 只能读取 Actions 元数据'
if printf '%s\n' "$infrastructure_artifact_binding" | \
  grep -E 'actions/checkout@|^[[:space:]]+environment:|id-token:|\$\{\{ secrets\.' >/dev/null; then
  fail 'Terraform plan artifact 元数据绑定 job 禁止 checkout、Environment、OIDC 与 secret'
fi
printf '%s\n' "$infrastructure_artifact_binding" | \
  grep -F -x "    if: github.event_name == 'workflow_dispatch' && !inputs.static_only && inputs.operation == 'apply'" >/dev/null || \
  fail 'Terraform plan artifact 元数据绑定只能用于 apply'
for plan_binding_control in \
  'PLAN_ARTIFACT_ID: ${{ needs.terraform-plan.outputs.artifact_id }}' \
  'PLAN_ARTIFACT_DIGEST: ${{ needs.terraform-plan.outputs.artifact_digest }}' \
  'Authorization: Bearer $GH_TOKEN' \
  '$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$PLAN_ARTIFACT_ID' \
  '.id == $artifact_id and .name == $name and .expired == false and' \
  '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.head_sha == $source_sha'
do
  printf '%s\n' "$infrastructure_artifact_binding" | grep -F -- "$plan_binding_control" >/dev/null || \
    fail "Terraform plan artifact 元数据绑定缺少：$plan_binding_control"
done
printf '%s\n' "$infrastructure_apply" | grep -F -x '      - bind-terraform-plan' >/dev/null || \
  fail 'Terraform apply 必须等待 plan artifact 元数据绑定成功'

printf '%s\n' "$infrastructure_plan" | \
  grep -F -x "    if: github.event_name == 'workflow_dispatch' && !inputs.static_only" >/dev/null || \
  fail 'Terraform plan 必须只允许非 static-only 的 workflow_dispatch 运行'
printf '%s\n' "$infrastructure_apply" | \
  grep -F -x "    if: github.event_name == 'workflow_dispatch' && !inputs.static_only && inputs.operation == 'apply'" >/dev/null || \
  fail 'Terraform apply 必须只允许非 static-only 的 workflow_dispatch apply 运行'
for credential_job in "$infrastructure_plan" "$infrastructure_apply"; do
  printf '%s\n' "$credential_job" | grep -F 'id-token: write' >/dev/null || \
    fail 'Terraform 凭据 job 缺少 OIDC 权限'
done
printf '%s\n' "$hmac_manage" | \
  grep -F -x "    if: github.event_name == 'workflow_dispatch' && !inputs.static_only" >/dev/null || \
  fail 'HMAC 停机证据 job 必须只允许非 static-only 的 workflow_dispatch'
printf '%s\n' "$hmac_manage" | grep -F 'id-token: write' >/dev/null || \
  fail 'HMAC 停机证据 job 缺少 OIDC 权限'
require_fixed "      - \${{ 'slots-aws-private-hmac-quiescer' }}" "$hmac_workflow"
require_fixed 'name: aws-${{ inputs.target_environment }}-hmac-quiesce-evidence' "$hmac_workflow"
require_fixed 'AWS_HMAC_QUIESCE_ROLE_ARN: ${{ vars.AWS_HMAC_QUIESCE_ROLE_ARN }}' "$hmac_workflow"
require_fixed 'role-to-assume: ${{ vars.AWS_HMAC_QUIESCE_ROLE_ARN }}' "$hmac_workflow"
require_fixed 'AWS_HMAC_QUIESCE_CANCELLATION_PREFIX: ${{ vars.AWS_HMAC_QUIESCE_CANCELLATION_PREFIX }}' \
  "$hmac_workflow"
require_fixed 'AWS_HMAC_QUIESCE_COMPLETION_PREFIX: ${{ vars.AWS_HMAC_QUIESCE_COMPLETION_PREFIX }}' \
  "$hmac_workflow"
hmac_manager="$workflow_directory/manage-hmac-quiesce-evidence.sh"
for hmac_cluster_control in \
  'eks describe-cluster --name "$AWS_EKS_CLUSTER_NAME" --region "$AWS_REGION"' \
  '.cluster.arn == $cluster_arn and' \
  '.cluster.status == "ACTIVE" and' \
  '.cluster.resourcesVpcConfig.endpointPrivateAccess == true and' \
  '.cluster.resourcesVpcConfig.endpointPublicAccess == false'
do
  require_fixed "$hmac_cluster_control" "$hmac_manager"
done
for workflow in "$infrastructure_workflow" "$application_workflow" "$hmac_workflow"; do
  require_fixed '      static_only:' "$workflow"
  require_fixed '        default: true' "$workflow"
  require_fixed '        type: boolean' "$workflow"
  require_fixed "group: \${{ github.event_name == 'workflow_dispatch' && !inputs.static_only && format('slots-aws-environment-mutation-{0}', inputs.target_environment) || format('slots-aws-static-{0}-{1}', github.workflow, github.ref) }}" "$workflow"
  require_fixed 'cancel-in-progress: false' "$workflow"
done

for protected_application_job in \
  "$application_source_binding" \
  "$application_verify" \
  "$application_artifact_binding" \
  "$application_deploy"
do
  printf '%s\n' "$protected_application_job" | \
    grep -F -x "    if: github.event_name == 'workflow_dispatch' && !inputs.static_only" >/dev/null || \
    fail '应用凭据 job 必须拒绝 static-only dispatch'
done
printf '%s\n' "$application_static" | \
  grep -F -x "        if: github.event_name == 'workflow_dispatch' && !inputs.static_only" >/dev/null || \
  fail '应用部署源码 artifact 必须拒绝 static-only dispatch'

require_fixed 'name: aws-${{ inputs.target_environment }}-terraform-plan' "$infrastructure_workflow"
require_fixed 'name: aws-${{ inputs.target_environment }}-terraform-apply' "$infrastructure_workflow"
require_fixed 'AWS_TERRAFORM_PLAN_ROLE_ARN: ${{ vars.AWS_TERRAFORM_PLAN_ROLE_ARN }}' "$infrastructure_workflow"
require_fixed 'AWS_TERRAFORM_APPLY_ROLE_ARN: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}' "$infrastructure_workflow"
require_fixed '          test "$GITHUB_REF_PROTECTED" = true' "$infrastructure_workflow"
require_fixed 'uses: aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708 # v5.1.1' "$infrastructure_workflow"
test "$(grep -F -c '          terraform_version: 1.15.9' "$infrastructure_workflow" || true)" -eq 3 || \
  fail 'Terraform validate、plan、apply 必须使用同一个精确版本 1.15.9'
require_fixed 'terraform plan -input=false -lock-timeout=10m -var-file="$TFVARS_FILE" \' "$infrastructure_workflow"
for actual_fingerprint_binding in \
  'valkey_password_fingerprint_a=$(printf '\''%s'\'' "$TF_VAR_valkey_password_a" | sha256sum | awk '\''{ print $1 }'\'')' \
  'valkey_password_fingerprint_b=$(printf '\''%s'\'' "$TF_VAR_valkey_password_b" | sha256sum | awk '\''{ print $1 }'\'')' \
  'shared_admission_hmac_key_fingerprint=$(printf '\''%s'\'' "$TF_VAR_shared_admission_hmac_key" | sha256sum | awk '\''{ print $1 }'\'')' \
  '.configuration.valkey_password_fingerprint_a = $valkey_password_fingerprint_a |' \
  '.configuration.valkey_password_fingerprint_b = $valkey_password_fingerprint_b |' \
  '.configuration.shared_admission_hmac_key_fingerprint = $shared_admission_hmac_key_fingerprint'
do
  test "$(grep -F -c -- "$actual_fingerprint_binding" "$infrastructure_workflow" || true)" -eq 1 || \
    fail "Terraform plan 必须由实际 ephemeral 值唯一覆盖指纹：$actual_fingerprint_binding"
done
require_fixed 'fingerprinted_tfvars="${TFVARS_FILE}.fingerprinted"' "$infrastructure_workflow"
require_fixed 'mv "$fingerprinted_tfvars" "$TFVARS_FILE"' "$infrastructure_workflow"
require_fixed 'rm -f "$TF_BACKEND_FILE" "$TFVARS_FILE" "${TFVARS_FILE}.fingerprinted"' "$infrastructure_workflow"
rotation_gate='verify-valkey-rotation-plan.rb'
test "$(grep -F -c -- "$rotation_gate" "$infrastructure_workflow" || true)" -eq 4 || \
  fail 'Valkey A/B 状态机必须在 plan/apply 的普通与 HMAC 分支都验证同一精确 plan'
test "$(grep -F -c -- '--evidence "$HMAC_EVIDENCE_FILE" -' "$infrastructure_workflow" || true)" -eq 2 || \
  fail 'HMAC plan/apply 必须各自消费 artifact 内同一份停机证据'
test "$(grep -F -c 'consume "' "$infrastructure_workflow" || true)" -eq 3 || \
  fail 'Terraform plan/apply 必须始终以未过期 consume 语义读取 HMAC 停机证据'
if grep -F 'finalize "' "$infrastructure_workflow" >/dev/null; then
  fail 'Terraform 禁止使用 application 专属 finalize 语义绕过原停机证据 TTL'
fi
plan_command_line=$(printf '%s\n' "$infrastructure_plan" | grep -nF 'terraform plan -input=false' | head -n 1 | cut -d: -f1)
plan_rotation_line=$(printf '%s\n' "$infrastructure_plan" | grep -nF -- "$rotation_gate" | head -n 1 | cut -d: -f1)
plan_upload_line=$(printf '%s\n' "$infrastructure_plan" | grep -nF 'name: 上传只供本次应用消费的精确计划' | head -n 1 | cut -d: -f1)
test "$plan_command_line" -lt "$plan_rotation_line" -a "$plan_rotation_line" -lt "$plan_upload_line" || \
  fail 'Valkey A/B plan 状态机门禁必须位于 plan 生成后、artifact 上传前'
apply_init_line=$(printf '%s\n' "$infrastructure_apply" | grep -nF 'terraform init -input=false' | head -n 1 | cut -d: -f1)
apply_rotation_line=$(printf '%s\n' "$infrastructure_apply" | grep -nF -- "$rotation_gate" | head -n 1 | cut -d: -f1)
apply_waf_evidence_line=$(printf '%s\n' "$infrastructure_apply" | grep -nF -- 'verify-waf-rollout-evidence.rb' | head -n 1 | cut -d: -f1)
apply_command_line=$(printf '%s\n' "$infrastructure_apply" | grep -nF 'terraform apply -input=false' | head -n 1 | cut -d: -f1)
test "$apply_init_line" -lt "$apply_rotation_line" -a \
  "$apply_rotation_line" -lt "$apply_waf_evidence_line" -a \
  "$apply_waf_evidence_line" -lt "$apply_command_line" || \
  fail 'apply 必须在初始化后复核 Valkey 状态及 planned WAF Block evidence，才允许执行 apply'
require_fixed 'source_sha=$(sed -n '\''s/^SOURCE_SHA=//p'\'' "$TF_PLAN_DIR/plan-metadata.env")' "$infrastructure_workflow"
require_fixed 'test "$source_sha" = "$GITHUB_SHA"' "$infrastructure_workflow"
require_fixed 'artifact_id: ${{ steps.upload.outputs.artifact-id }}' "$infrastructure_workflow"
require_fixed 'artifact_digest: ${{ steps.upload.outputs.artifact-digest }}' "$infrastructure_workflow"
require_fixed 'artifact-ids: ${{ needs.terraform-plan.outputs.artifact_id }}' "$infrastructure_workflow"
require_fixed 'grep -F -x "PLAN_SHA256=$plan_sha256" "$metadata"' "$infrastructure_workflow"
test "$(grep -F -c 'type == "object" and keys == ["configuration"] and' "$infrastructure_workflow" || true)" -eq 2 || \
  fail 'Terraform tfvars 在 OIDC 前和写入文件前都必须只允许 configuration 顶层键'
for forbidden_password_key in valkey_password_a valkey_password_b; do
  test "$(grep -F -c ". != \"$forbidden_password_key\" and" "$infrastructure_workflow" || true)" -eq 2 || \
    fail "Terraform tfvars 在凭据前和写文件前都必须拒绝 $forbidden_password_key"
done
for secret_binding in \
  'TF_VAR_valkey_password_a: ${{ secrets.TERRAFORM_VALKEY_PASSWORD_A }}' \
  'TF_VAR_valkey_password_b: ${{ secrets.TERRAFORM_VALKEY_PASSWORD_B }}' \
  'TF_VAR_shared_admission_hmac_key: ${{ secrets.TERRAFORM_SHARED_ADMISSION_HMAC_KEY }}' \
  'TF_VAR_valkey_root_ca_pem: ${{ secrets.TERRAFORM_VALKEY_ROOT_CA_PEM }}'
do
  test "$(grep -F -c -- "$secret_binding" "$infrastructure_workflow" || true)" -eq 4 || \
    fail "plan/apply 必须在验证与 Terraform 执行步骤分别注入 ephemeral secret：$secret_binding"
done
require_fixed 'fingerprint-terraform-ephemeral-inputs.sh' "$infrastructure_workflow"
fingerprint_script="$workflow_directory/fingerprint-terraform-ephemeral-inputs.sh"
for fingerprint_input in TF_VAR_valkey_password_a TF_VAR_valkey_password_b \
  TF_VAR_shared_admission_hmac_key TF_VAR_valkey_root_ca_pem; do
  require_fixed "\"$fingerprint_input\"" "$fingerprint_script"
done
require_fixed 'slots-terraform-ephemeral-v2' "$fingerprint_script"
legacy_tf_name=$(printf '%s%s' 'TF_VAR_valkey_' 'password')
legacy_secret_name=$(printf '%s%s' 'TERRAFORM_VALKEY_' 'PASSWORD')
legacy_ephemeral_pattern="${legacy_tf_name}([^_A-Za-z0-9]|$)|${legacy_secret_name}([^_A-Za-z0-9]|$)"
if grep -E "$legacy_ephemeral_pattern" "$infrastructure_workflow" "$fingerprint_script" \
  "$workflow_directory/test-negative-contract.sh" "$workflow_directory/README.md" >/dev/null; then
  fail '旧单槽 Valkey password 变量必须完全清除'
fi
require_fixed 'printf '\''EPHEMERAL_INPUTS_HMAC=%s\n'\'' "$ephemeral_fingerprint"' "$infrastructure_workflow"
require_fixed 'grep -F -x "EPHEMERAL_INPUTS_HMAC=$ephemeral_fingerprint" "$metadata"' "$infrastructure_workflow"
require_fixed 'test "$(wc -l < "$metadata" | tr -d '\'' '\'')" = 16' "$infrastructure_workflow"
require_fixed 'test "$(find "$TF_PLAN_DIR" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d '\'' '\'')" = 4' \
  "$infrastructure_workflow"
require_fixed 'terraform apply -input=false -auto-approve -lock-timeout=10m "$TF_PLAN_DIR/terraform.tfplan"' "$infrastructure_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_BUCKET: ${{ vars.AWS_TERRAFORM_DELIVERY_BUCKET }}' "$infrastructure_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_KEY: ${{ vars.AWS_TERRAFORM_DELIVERY_KEY }}' "$infrastructure_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN: ${{ vars.AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN }}' "$infrastructure_workflow"
for apply_binding in \
  'AWS_TERRAFORM_DELIVERY_BUCKET: ${{ vars.AWS_TERRAFORM_DELIVERY_BUCKET }}' \
  'AWS_TERRAFORM_DELIVERY_KEY: ${{ vars.AWS_TERRAFORM_DELIVERY_KEY }}' \
  'AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN: ${{ vars.AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN }}'
do
  printf '%s\n' "$infrastructure_apply" | grep -F -- "$apply_binding" >/dev/null || \
    fail "Terraform apply job 缺少受保护 delivery 边界：$apply_binding"
done
require_fixed 'terraform output -json delivery > "$delivery_file"' "$infrastructure_workflow"
require_fixed 'aws s3api get-bucket-versioning --bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"' "$infrastructure_workflow"
require_fixed '--server-side-encryption aws:kms --ssekms-key-id "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"' "$infrastructure_workflow"
require_fixed 'version_id=$(jq -er '\''.VersionId | select(test("^[A-Za-z0-9._~+/=-]{1,1024}$"))' "$infrastructure_workflow"
require_fixed '--key "$AWS_TERRAFORM_DELIVERY_KEY" --version-id "$version_id"' "$infrastructure_workflow"
require_fixed '$handoff.foundation_apply_is_application_ready == false' "$infrastructure_workflow"
require_fixed '              "cluster-autoscaler",' "$infrastructure_workflow"
require_fixed 'terraform-application-handoff-${{ inputs.target_environment }}-${{ github.run_id }}-${{ github.run_attempt }}' "$infrastructure_workflow"
for valkey_delivery_contract in \
  '.valkey_active_slot as $active_slot' \
  '.valkey_user_names as $user_names' \
  '.valkey_password_versions as $password_versions' \
  '.valkey_rotation_contract as $rotation' \
  '.valkey_rotation_mode as $rotation_mode' \
  '$rotation.password_versions == $password_versions' \
  '$rotation.rotation_mode == $rotation_mode' \
  '($rotation.password_fingerprints | keys | sort) == ["a", "b"]' \
  '($rotation.hmac_key_fingerprint | type == "string" and test("^[0-9a-f]{64}$"))' \
  '$rotation.published_secret_version == $secret_version' \
  '$rotation.acl_command_profile == "v2-economic"' \
  '$rotation.acl_schema_version == "v2"' \
  '$rotation.acl_schema_transition == "maintenance-quiesced"' \
  '$rotation.acl_schema_migration_requires_quiesced == true' \
  '$rotation.acl_schema_rolling_compatible == false' \
  '$rotation.acl_schema_dual_permissions_allowed == false' \
  '$rotation.acl_schema_migration_order == ['
do
  valkey_contract_count=$(awk -v needle="$valkey_delivery_contract" '
    index($0, needle) { count += 1 }
    END { print count + 0 }
  ' "$infrastructure_workflow" "$application_workflow")
  test "$valkey_contract_count" -eq 2 || \
    fail "Terraform 发布与应用消费必须共同校验 Valkey A/B delivery：$valkey_delivery_contract"
done
require_fixed '$rotation_mode == "hmac-maintenance") and' "$infrastructure_workflow"
require_fixed '($rotation_mode == "steady" or $rotation_mode == "password-rotation") and' \
  "$application_workflow"
for rotation_safety_contract in \
  '.application_release_allowed == ($rotation_mode != "hmac-maintenance")' \
  '.maintenance_in_progress == ($rotation_mode == "hmac-maintenance")' \
  '$rotation.hmac_maintenance_single_attested_plan == true' \
  '$rotation.hmac_maintenance_exit_requires_separate_plan == true' \
  '$rotation.hmac_maintenance_attestation_schema == "slots-game/hmac-quiesce-attestation/v1"' \
  '$rotation.hmac_maintenance_evidence_maximum_ttl_seconds == 3600' \
  '$rotation.hmac_maintenance_persistent_lock_name == "slots-hmac-maintenance-lock"'
do
  require_fixed "$rotation_safety_contract" "$infrastructure_workflow"
done
for application_rotation_safety in \
  '.application_release_allowed == true and .maintenance_in_progress == false' \
  '$rotation.application_release_allowed == true and $rotation.maintenance_in_progress == false'
do
  require_fixed "$application_rotation_safety" "$application_workflow"
done
for platform_delivery_contract in \
  '$handoff.alb_access_logs == {' \
  '$handoff.metrics_server_addon_version |' \
  '$handoff.vpc_cni_network_policy.expected_status == "ACTIVE"' \
  '$handoff.cloudwatch_observability == {' \
  '$handoff.cloudwatch_observability.configuration_values.containerLogs.enabled == true' \
  '$handoff.required_deployments == {' \
  '$handoff.required_api_services == {"resource_metrics": "v1beta1.metrics.k8s.io"}' \
  '$handoff.kube_state_metrics_release_name == "kube-prometheus-stack"'
do
  platform_contract_count=$(awk -v needle="$platform_delivery_contract" '
    index($0, needle) { count += 1 }
    END { print count + 0 }
  ' "$infrastructure_workflow" "$application_workflow")
  test "$platform_contract_count" -eq 2 || \
    fail "Terraform 发布与应用消费必须共同校验平台交接：$platform_delivery_contract"
done
test "$(grep -F -c '      id-token: write' "$infrastructure_workflow" || true)" -eq 2 || \
  fail '只有 Terraform plan/apply 两个 job 可以申请 OIDC'
test "$(grep -F -c '      id-token: write' "$hmac_workflow" || true)" -eq 1 || \
  fail '只有 HMAC manage-evidence job 可以申请停机 OIDC'

environment_validator="$workflow_directory/validate-environment.sh"
require_fixed 'AWS_TERRAFORM_DELIVERY_BUCKET AWS_TERRAFORM_DELIVERY_KEY AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN; do' \
  "$environment_validator"
for delivery_validation in \
  'require_bucket "$AWS_TERRAFORM_DELIVERY_BUCKET"' \
  'require_delivery_key "$AWS_TERRAFORM_DELIVERY_KEY"' \
  'require_kms_key "$AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN"'
do
  test "$(grep -F -c -- "$delivery_validation" "$environment_validator" || true)" -eq 3 || \
    fail "Terraform plan/apply 与应用部署必须分别校验 delivery 边界：$delivery_validation"
done
require_fixed 'validate_state_boundary' "$environment_validator"
require_fixed 'validate_repositories' "$environment_validator"
require_fixed '*"/$target_environment/"*) ;;' "$environment_validator"
require_fixed 'test "$version_value" != null || fail "$version_label 不得是未版本化对象的 null"' \
  "$environment_validator"
test "$(grep -F -c 'require_environment_segment "$AWS_TF_STATE_KEY" "$target_environment"' \
  "$environment_validator" || true)" -eq 2 || \
  fail 'Terraform plan/apply 必须把 state key 绑定到目标环境独立路径'

if grep -E '\$\{\{ inputs\.(account|region|role|repository|bucket|cluster)' "$infrastructure_workflow" >/dev/null; then
  fail '账号、区域、角色、仓库和 state 不得来自 dispatch 输入'
fi

require_fixed 'name: aws-${{ inputs.target_environment }}-artifact-verify' "$application_workflow"
require_fixed 'name: aws-${{ inputs.target_environment }}-application-deploy' "$application_workflow"
require_fixed "      - \${{ 'slots-aws-private-deployer' }}" "$application_workflow"
test "$(grep -F -c "\${{ 'slots-aws-private-deployer' }}" "$application_workflow" || true)" -eq 1 || \
  fail '只有应用部署 job 使用固定私网发布 runner 标签'
require_fixed 'AWS_ARTIFACT_VERIFY_ROLE_ARN: ${{ vars.AWS_ARTIFACT_VERIFY_ROLE_ARN }}' "$application_workflow"
require_fixed 'AWS_APPLICATION_DEPLOY_ROLE_ARN: ${{ vars.AWS_APPLICATION_DEPLOY_ROLE_ARN }}' "$application_workflow"
require_fixed 'AWS_EKS_NAMESPACE: ${{ vars.AWS_EKS_NAMESPACE }}' "$application_workflow"
require_fixed 'AWS_HELM_RELEASE_NAME: ${{ vars.AWS_HELM_RELEASE_NAME }}' "$application_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_BUCKET: ${{ vars.AWS_TERRAFORM_DELIVERY_BUCKET }}' "$application_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_KEY: ${{ vars.AWS_TERRAFORM_DELIVERY_KEY }}' "$application_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_VERSION_ID: ${{ vars.AWS_TERRAFORM_DELIVERY_VERSION_ID }}' "$application_workflow"
require_fixed 'AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN: ${{ vars.AWS_TERRAFORM_DELIVERY_KMS_KEY_ARN }}' "$application_workflow"
for input_binding in \
  'INPUT_RELEASE_TAG: ${{ inputs.release_tag }}|${{ inputs.release_tag }}' \
  'INPUT_RGS_DIGEST: ${{ inputs.rgs_digest }}|${{ inputs.rgs_digest }}' \
  'INPUT_MIGRATOR_DIGEST: ${{ inputs.migrator_digest }}|${{ inputs.migrator_digest }}' \
  'INPUT_WEB_DIGEST: ${{ inputs.web_digest }}|${{ inputs.web_digest }}' \
  'INPUT_CONFIGURATION_SHA256: ${{ inputs.configuration_sha256 }}|${{ inputs.configuration_sha256 }}'
do
  binding=${input_binding%%|*}
  expression=${input_binding#*|}
  require_fixed "$binding" "$application_workflow"
  test "$(grep -F -c -- "$expression" "$application_workflow" || true)" -eq 2 || \
    fail "未验证的 dispatch 输入只能绑定到两个受控 job 环境变量：$expression"
done
require_fixed 'artifact-ids: ${{ needs.static-contract.outputs.source_artifact_id }}' "$application_workflow"
require_fixed 'artifact-ids: ${{ needs.static-contract.outputs.source_artifact_id }},${{ needs.verify-release.outputs.evidence_artifact_id }}' "$application_workflow"
for artifact_binding_control in \
  'SOURCE_ARTIFACT_DIGEST: ${{ needs.static-contract.outputs.source_artifact_digest }}' \
  'EVIDENCE_ARTIFACT_DIGEST: ${{ needs.verify-release.outputs.evidence_artifact_digest }}' \
  'Authorization: Bearer $GH_TOKEN' \
  '$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id' \
  '.id == $artifact_id and .name == $name and .expired == false and' \
  '.digest == $digest and .workflow_run.id == $run_id and' \
  '.workflow_run.head_sha == $source_sha' \
  'verify_artifact "$SOURCE_ARTIFACT_ID" "$SOURCE_ARTIFACT_DIGEST"' \
  'verify_artifact "$EVIDENCE_ARTIFACT_ID" "$EVIDENCE_ARTIFACT_DIGEST"'
do
  require_fixed "$artifact_binding_control" "$application_workflow"
done
printf '%s\n' "$application_deploy" | grep -F -x '      - bind-deployment-artifacts' >/dev/null || \
  fail '私网部署必须依赖 artifact 元数据绑定成功'
require_fixed 'install -d -m 0700 "/tmp/slots-aws-deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/downloads"' \
  "$application_workflow"
test "$(grep -F -c 'if-no-files-found: warn' "$application_workflow" || true)" -eq 0 || \
  fail '应用部署审计证据缺失时不得只给 warning'
require_fixed 'umask 077' "$workflow_directory/verify-ecr-release.sh"
require_fixed 'umask 077' "$workflow_directory/manage-hmac-quiesce-evidence.sh"
require_fixed 'umask 077' "$workflow_directory/publish-web-release.sh"
require_fixed 'response_function_name=${AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME%-release-request}-release-response' \
  "$workflow_directory/publish-web-release.sh"
require_fixed '.DistributionConfig.CacheBehaviors.Quantity == 1' \
  "$workflow_directory/publish-web-release.sh"
require_fixed '.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Quantity == 0' \
  "$workflow_directory/publish-web-release.sh"
require_fixed '.DistributionConfig.CacheBehaviors.Items[0].FunctionAssociations.Quantity == 0' \
  "$workflow_directory/publish-web-release.sh"
for web_distribution_negative in \
  cloudfront-lambda-association \
  cloudfront-extra-cache-behavior \
  cloudfront-extra-function-association
do
  require_fixed "$web_distribution_negative" "$workflow_directory/test-web-release-switch-faults.sh"
done
require_fixed '"RGS_IMAGE=$registry/$AWS_ECR_RGS_RUNTIME_REPOSITORY@$INPUT_RGS_DIGEST"' "$application_workflow"
require_fixed '"MIGRATOR_IMAGE=$registry/$AWS_ECR_RGS_MIGRATOR_REPOSITORY@$INPUT_MIGRATOR_DIGEST"' "$application_workflow"
require_fixed '"WEB_IMAGE=$registry/$AWS_ECR_WEB_REPOSITORY@$INPUT_WEB_DIGEST"' "$application_workflow"
require_fixed 'grep -F -x -- "$verified_image" "$VERIFIED_RELEASE/verified-images.env"' "$application_workflow"
require_fixed 'COSIGN_IMAGE: ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8' "$application_workflow"
require_fixed 'verify-ecr-release.sh' "$application_workflow"
require_fixed 'verify-rendered-release.rb' "$application_workflow"
require_fixed 'api_runtime_assets_secret=$(jq -er '\''.application_secret_names["api-runtime-assets"]'\''' \
  "$application_workflow"
require_fixed 'worker_runtime_assets_secret=$(jq -er '\''.application_secret_names["worker-runtime-assets"]'\''' \
  "$application_workflow"
require_fixed 'shared_admission_secret=$(jq -er '\''.valkey_secret_name'\'' "$TERRAFORM_DELIVERY_FILE")' \
  "$application_workflow"
require_fixed '"$api_runtime_assets_secret" "$worker_runtime_assets_secret" "$shared_admission_secret"' \
  "$application_workflow"
require_fixed '.scanningConfiguration as $configuration' "$application_workflow"
require_fixed '$configuration.scanType == "ENHANCED"' "$application_workflow"
require_fixed 'all($repositories[];' "$application_workflow"
require_fixed '.scanFrequency == "CONTINUOUS_SCAN"' "$application_workflow"
require_fixed 'extract-aws-web-static-root.sh' "$application_workflow"
require_fixed 'publish-web-release.sh' "$application_workflow"
require_fixed 'deploy/aws-production/workflow/test-web-rgs-origin.sh' "$application_workflow"
require_fixed 'ruby -c deploy/aws-production/workflow/verify-web-rgs-origin.rb' "$application_workflow"
require_fixed 'slots-game/deploy/aws-production/workflow/verify-web-rgs-origin.rb' "$application_workflow"
require_fixed 'rgs_base_url == "https://#{api_host}"' "$workflow_directory/verify-web-rgs-origin.rb"
require_fixed 'app.kubernetes.io/component=rgs,app.kubernetes.io/instance=#{release_name}' \
  "$workflow_directory/verify-web-rgs-origin.rb"
require_fixed 'Web 提取身份记录字段集合不精确' "$workflow_directory/verify-web-rgs-origin.rb"
require_fixed "expect_rejected 'foreign RGS Origin' https://foreign.example.com" \
  "$workflow_directory/test-web-rgs-origin.sh"
web_extract_line=$(grep -nF 'extract-aws-web-static-root.sh" \' "$application_workflow" | tail -1 | cut -d: -f1)
web_origin_line=$(grep -nF 'verify-web-rgs-origin.rb" \' "$application_workflow" | tail -1 | cut -d: -f1)
web_publish_command_line=$(grep -nF 'publish-web-release.sh" \' "$application_workflow" | tail -1 | cut -d: -f1)
test "$web_extract_line" -lt "$web_origin_line" -a "$web_origin_line" -lt "$web_publish_command_line" || \
  fail '已签名 Web RGS Origin 必须在 OCI 提取后、任何 Web 发布前绑定实际 Ingress'
require_fixed '--atomic --wait --wait-for-jobs --timeout 20m' "$application_workflow"
require_fixed 'if: inputs.deployment_mode == '\''standard'\''' "$application_workflow"
require_fixed '.Key == "active-release" and .Value == $digest' "$application_workflow"
require_fixed 'verify-latest-terraform-delivery.sh' "$application_workflow"
test "$(grep -F -c 'verify-latest-terraform-delivery.sh' "$application_workflow" || true)" -eq 2 || \
  fail 'latest Terraform delivery 校验脚本必须同时进入源码 artifact 并在所有发布模式前调用'
latest_delivery_line=$(grep -nF 'verify-latest-terraform-delivery.sh" \' "$application_workflow" | tail -1 | cut -d: -f1)
maintenance_branch_line=$(grep -nF 'if test "$INPUT_DEPLOYMENT_MODE" = maintenance-complete; then' \
  "$application_workflow" | head -1 | cut -d: -f1)
test "$latest_delivery_line" -lt "$maintenance_branch_line" || \
  fail 'latest Terraform delivery 门禁必须覆盖 standard 与 maintenance-complete 两种发布'
require_fixed 'verify-hmac-only-release-diff.rb" \' "$application_workflow"
test "$(grep -F -c 'verify-hmac-finalize-attestation.rb' "$application_workflow" || true)" -eq 4 || \
  fail 'finalize 短时复证必须进入源码 artifact、通过语法检查并在生成后与 Phase A 前各验证一次'
require_fixed '              finalize "$hmac_evidence_file"' "$application_workflow"
if grep -F '              consume "$hmac_evidence_file"' "$application_workflow" >/dev/null; then
  fail 'application maintenance 不得因原证据 TTL 到期形成永久停机；必须执行私网 finalize 实时复证'
fi
test "$(grep -F -x -c '              safe "$current_manifest" "$current_hooks" "$safe_rendered" \' \
  "$application_workflow" || true)" -eq 1 || \
  fail 'maintenance Phase A 必须执行 HMAC 单一变更语义 comparator'
test "$(grep -F -x -c '              active "$current_manifest" "$current_hooks" \' \
  "$application_workflow" || true)" -eq 1 || \
  fail 'maintenance Phase B 必须执行 HMAC 单一变更语义 comparator'
require_fixed '"$HELM_BIN" get manifest "$AWS_HELM_RELEASE_NAME"' "$application_workflow"
require_fixed '"$HELM_BIN" get hooks "$AWS_HELM_RELEASE_NAME"' "$application_workflow"
require_fixed '"${common_arguments[@]}" --no-hooks --wait --timeout 20m \' "$application_workflow"
require_fixed '"${common_arguments[@]}" --no-hooks --atomic --wait --timeout 20m \' "$application_workflow"
test "$(grep -F -c -- '--no-hooks' "$application_workflow" || true)" -eq 2 || \
  fail 'maintenance-complete 两个 Helm 阶段都必须禁用 Migrator 与全部 hook'
require_fixed '--set rgs.maintenanceQuiesced=true' "$application_workflow"
require_fixed '--set rgs.maintenanceQuiesced=false' "$application_workflow"
require_fixed 'phase-a "$TERRAFORM_DELIVERY_FILE" "$HMAC_EVIDENCE_FILE"' "$application_workflow"
require_fixed 'relock-target' "$application_workflow"
test "$(grep -F -x -c '              standard' "$application_workflow" || true)" -eq 1 || \
  fail '普通发布必须在任何集群写入前执行 maintenance lock 门禁'
test "$(grep -F -x -c '              locked "$TERRAFORM_DELIVERY_FILE" "$HMAC_EVIDENCE_FILE" "$finalize_attestation"' \
  "$application_workflow" || true)" -eq 1 || \
  fail 'maintenance-complete 必须把精确 delivery 与 evidence 绑定持久 lock'
test "$(grep -F -c 'check all "$hmac_evidence_file"' "$application_workflow" || true)" -eq 1 || \
  fail 'maintenance-complete 必须在任何集群写入前检查精确证据的取消与完成 marker'
phase_a_line=$(grep -nF '"${common_arguments[@]}" --no-hooks --wait --timeout 20m \' \
  "$application_workflow" | cut -d: -f1)
phase_b_line=$(grep -nF '"${common_arguments[@]}" --no-hooks --atomic --wait --timeout 20m \' \
  "$application_workflow" | cut -d: -f1)
test "$phase_a_line" -lt "$phase_b_line" || fail 'HMAC Phase A 安全 revision 必须先于 Phase B atomic 恢复'
require_fixed '"$HELM_BIN" lint --strict "$chart" --namespace "$AWS_EKS_NAMESPACE"' "$application_workflow"
require_fixed '"$HELM_BIN" upgrade --install "$AWS_HELM_RELEASE_NAME" "$chart"' "$application_workflow"
test "$(grep -F -c 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh"' \
  "$application_workflow" || true)" -eq 1 || \
  fail '应用发布必须恰好一次执行 ALB/WAF/target-health 发布后实时门禁'
test "$(grep -F -c 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"' \
  "$application_workflow" || true)" -eq 2 || \
  fail '应用发布必须在 Helm 前与最终 mutation 后各执行一次完整平台/WAF 实时门禁'
last_helm_mutation_line=$(grep -nF '"$HELM_BIN" upgrade' "$application_workflow" | tail -1 | cut -d: -f1)
post_alb_gate_line=$(grep -nF 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-alb-edge.sh"' \
  "$application_workflow" | cut -d: -f1)
pre_platform_gate_line=$(grep -nF 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"' \
  "$application_workflow" | head -1 | cut -d: -f1)
post_platform_gate_line=$(grep -nF 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"' \
  "$application_workflow" | tail -1 | cut -d: -f1)
web_publish_line=$(grep -nF 'name: 从已验证 Web digest 提取并发布不可变 release' \
  "$application_workflow" | cut -d: -f1)
test "$pre_platform_gate_line" -lt "$last_helm_mutation_line" -a \
  "$last_helm_mutation_line" -lt "$post_alb_gate_line" -a \
  "$post_alb_gate_line" -lt "$post_platform_gate_line" -a \
  "$post_platform_gate_line" -lt "$web_publish_line" || \
  fail '完整平台/WAF 与 ALB 实时门禁必须包围 Helm，并在 Web 发布前完成最终回读'
require_fixed '"$HELM_BIN" status "$AWS_HELM_RELEASE_NAME" --namespace "$AWS_EKS_NAMESPACE"' "$application_workflow"
require_fixed 'AWS_HELM_VALUES_VERSION_ID: ${{ vars.AWS_HELM_VALUES_VERSION_ID }}' "$application_workflow"
require_fixed '--version-id "$AWS_HELM_VALUES_VERSION_ID"' "$application_workflow"
require_fixed 'AWS_CLOUDFRONT_KVS_ARN: ${{ vars.AWS_CLOUDFRONT_KVS_ARN }}' "$application_workflow"
require_fixed 'AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME: ${{ vars.AWS_CLOUDFRONT_ROUTER_FUNCTION_NAME }}' "$application_workflow"
require_fixed 'AWS_WEB_KMS_KEY_ARN: ${{ vars.AWS_WEB_KMS_KEY_ARN }}' "$application_workflow"
test "$(grep -F -c 'slots-game/deploy/aws-production/render-external-secrets.rb' "$application_workflow" || true)" -eq 2 || \
  fail 'ExternalSecret renderer 必须同时进入最小源码 artifact 并在私网 runner 调用'
test "$(grep -F -c 'slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh' "$application_workflow" || true)" -eq 3 || \
  fail '平台实时门禁必须进入最小源码 artifact，并在 Helm 前后各调用一次'
test "$(grep -F -c 'slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh' "$application_workflow" || true)" -eq 2 || \
  fail '原生 Secret 实时门禁必须同时进入最小源码 artifact 并在 Helm 前调用'
test "$(grep -F -c 'slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh' "$application_workflow" || true)" -eq 2 || \
  fail '数学定义滚动门禁必须同时进入最小源码 artifact 并在 Helm upgrade 前调用'
require_fixed 'slots-game/infra/terraform/contracts/cluster-addons-interface.v1.yaml' "$application_workflow"
require_fixed '--version-id "$AWS_TERRAFORM_DELIVERY_VERSION_ID"' "$application_workflow"
require_fixed '.SSEKMSKeyId == $kms' "$workflow_directory/verify-latest-terraform-delivery.sh"
require_fixed '$handoff.live_gate_script == "deploy/aws-production/verify-live-platform-prerequisites.sh"' "$application_workflow"
autoscaler_version_contract='startswith("v\($handoff.kubernetes_version).")'
infrastructure_autoscaler_count=$(grep -F -c "$autoscaler_version_contract" \
  "$infrastructure_workflow" || true)
application_autoscaler_count=$(grep -F -c "$autoscaler_version_contract" \
  "$application_workflow" || true)
test "$((infrastructure_autoscaler_count + application_autoscaler_count))" -eq 2 || \
  fail '基础设施交接与应用部署都必须校验 Cluster Autoscaler 和 EKS 主次版本一致'
require_fixed '.cluster_name == $cluster and .cluster_arn == $cluster_arn and' "$application_workflow"
require_fixed 'kubectl apply --server-side --field-manager=slots-aws-delivery' "$application_workflow"
require_fixed 'kinds.count("ExternalSecret") == 6 && kinds.length == 8' "$application_workflow"
require_fixed 'expected_cluster_arn="arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${AWS_EKS_CLUSTER_NAME}"' \
  "$application_workflow"
require_fixed 'test "$current_cluster" = "$expected_cluster_arn" || {' "$application_workflow"
require_fixed 'test "$(kubectl get --raw=/readyz)" = ok || {' "$application_workflow"
require_fixed '.resourcesVpcConfig.endpointPrivateAccess == true' "$application_workflow"
require_fixed '.resourcesVpcConfig.endpointPublicAccess == false' "$application_workflow"
require_fixed 'endpointPrivateAccess: .resourcesVpcConfig.endpointPrivateAccess' "$application_workflow"
require_fixed 'endpointPublicAccess: .resourcesVpcConfig.endpointPublicAccess' "$application_workflow"
require_fixed 'rm -f "$cluster_raw"' "$application_workflow"
require_fixed '          umask 077' "$application_workflow"
if grep -F -- '--alias ' "$application_workflow" >/dev/null; then
  fail 'update-kubeconfig 不得用别名掩盖精确 EKS ARN 身份'
fi
require_fixed 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh" \' \
  "$application_workflow"
require_fixed 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-application-secrets.sh" \' \
  "$application_workflow"
require_fixed 'sh "$DEPLOYMENT_SOURCE/slots-game/deploy/aws-production/workflow/verify-live-definition-identity.sh" \' \
  "$application_workflow"
require_fixed 'test-live-application-secrets.sh' "$application_workflow"
require_fixed 'test-live-definition-identity.sh' "$application_workflow"
platform_gate_line=$(grep -nF 'verify-live-platform-prerequisites.sh" \' "$application_workflow" | head -1 | cut -d: -f1)
secret_gate_line=$(grep -nF 'verify-live-application-secrets.sh" \' "$application_workflow" | tail -1 | cut -d: -f1)
definition_gate_line=$(grep -nF 'verify-live-definition-identity.sh" \' "$application_workflow" | tail -1 | cut -d: -f1)
cluster_gate_line=$(grep -nF 'test "$current_cluster" = "$expected_cluster_arn" || {' \
  "$application_workflow" | cut -d: -f1)
external_secret_apply_line=$(grep -nF 'kubectl apply --server-side --field-manager=slots-aws-delivery' \
  "$application_workflow" | cut -d: -f1)
helm_upgrade_line=$(grep -nF '"$HELM_BIN" upgrade --install "$AWS_HELM_RELEASE_NAME" "$chart"' \
  "$application_workflow" | cut -d: -f1)
test "$platform_gate_line" -lt "$helm_upgrade_line" -a "$secret_gate_line" -lt "$helm_upgrade_line" -a \
  "$definition_gate_line" -lt "$helm_upgrade_line" || \
  fail 'Terraform handoff、平台 add-on、原生 Secret 与数学定义实时门禁必须在 Helm upgrade 前完成'
test "$cluster_gate_line" -lt "$external_secret_apply_line" || \
  fail '必须在写入 ExternalSecret 之前精确验证目标 EKS ARN'
test "$(grep -F -c '      id-token: write' "$application_workflow" || true)" -eq 2 || \
  fail '只有制品验证和应用部署两个 job 可以申请 OIDC'

if grep -E '\$\{\{ (inputs\.(account|region|role|repository|bucket|cluster|distribution|namespace|release_name)|vars\.AWS_RUNNER_LABEL)' "$application_workflow" >/dev/null; then
  fail '账号、区域、角色、仓库、bucket 和 CloudFront 标识不得来自 dispatch 输入'
fi
if grep -E -- '--namespace[[:space:]]+slots-production|upgrade --install slots([[:space:]]|$)|status slots([[:space:]]|$)' \
  "$application_workflow" >/dev/null; then
  fail 'Helm release 与 namespace 不得跨环境硬编码'
fi

release_validator="$workflow_directory/validate-release-inputs.sh"
require_fixed 'for digest in "$rgs_digest" "$migrator_digest" "$web_digest"; do' "$release_validator"
require_fixed '^sha256:[0-9a-f]{64}$' "$release_validator"
require_fixed "test \"\$release_tag\" != latest" "$release_validator"

ecr_verifier="$workflow_directory/verify-ecr-release.sh"
require_fixed '.imageTagMutability == "IMMUTABLE"' "$ecr_verifier"
require_fixed '.encryptionConfiguration.encryptionType == "KMS"' "$ecr_verifier"
require_fixed '--certificate-identity "$certificate_identity"' "$ecr_verifier"
require_fixed '--certificate-oidc-issuer "$certificate_issuer"' "$ecr_verifier"
require_fixed "--type 'https://slsa.dev/provenance/v1'" "$ecr_verifier"
require_fixed "--type 'https://spdx.dev/Document'" "$ecr_verifier"

live_secret_verifier="$workflow_directory/verify-live-application-secrets.sh"
require_fixed 'configured_name.match?(/\A[a-z0-9]([-a-z0-9]{0,52}[a-z0-9])?-v[1-9][0-9]*\z/)' \
  "$live_secret_verifier"
require_fixed '$secret.immutable == true' "$live_secret_verifier"
require_fixed '($secret.data[$key] | type == "string" and length > 0)' "$live_secret_verifier"
require_fixed 'application_names.fetch("api-runtime-assets")' "$live_secret_verifier"
require_fixed 'application_names.fetch("worker-runtime-assets")' "$live_secret_verifier"
require_fixed 'shared_admission_keys.fetch("username") == "username"' "$live_secret_verifier"
require_fixed 'delivery.fetch("valkey_active_slot")' "$live_secret_verifier"
require_fixed 'delivery.fetch("valkey_user_names")' "$live_secret_verifier"
require_fixed 'delivery.fetch("valkey_password_versions")' "$live_secret_verifier"
require_fixed 'delivery.fetch("valkey_rotation_contract")' "$live_secret_verifier"
require_fixed 'delivery.fetch("valkey_rotation_mode")' "$live_secret_verifier"
require_fixed 'configured_endpoint == delivery.fetch("valkey_endpoint_url")' "$live_secret_verifier"
require_fixed 'rotation.fetch("password_fingerprints")' "$live_secret_verifier"
require_fixed 'rotation.fetch("hmac_key_fingerprint")' "$live_secret_verifier"
if grep -F 'application_names.fetch("runtime-assets")' "$live_secret_verifier" >/dev/null; then
  fail '原生 Secret 门禁禁止合并 API 与 Worker 运行素材边界'
fi
if grep -E 'Base64|strict_decode|base64[[:space:]]+-d' "$live_secret_verifier" \
  "$production_directory/verify-live-platform-prerequisites.sh" >/dev/null; then
  fail '实时 Secret 门禁不得解码或输出值'
fi
require_fixed 'immutable: true' "$production_directory/render-external-secrets.rb"
require_fixed 'refreshPolicy: CreatedOnce' "$production_directory/render-external-secrets.rb"
require_fixed 'kind: SecretStore' "$production_directory/render-external-secrets.rb"
require_fixed '      - secretKey: username' "$production_directory/render-external-secrets.rb"
require_fixed '          property: username' "$production_directory/render-external-secrets.rb"
require_fixed 'list-pod-identity-associations' "$production_directory/verify-live-platform-prerequisites.sh"
if sed -n '/eks list-pod-identity-associations/,+8p' "$production_directory/verify-live-platform-prerequisites.sh" | \
  grep -F -- '--no-paginate' >/dev/null; then
  fail 'Pod Identity association 实时门禁禁止关闭分页'
fi
require_fixed 'describe-pod-identity-association' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'elasticache describe-replication-groups' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'elasticache describe-cache-clusters' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'elasticache describe-cache-parameters' "$production_directory/verify-live-platform-prerequisites.sh"
if grep -F -- '--no-paginate' "$production_directory/verify-live-platform-prerequisites.sh" >/dev/null; then
  fail '平台实时门禁禁止关闭 AWS CLI 自动分页'
fi
require_fixed 'parameter.fetch("ParameterApplyStatus") == "in-sync"' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'vpc_cni_network_policy' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'enableNetworkPolicy' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cluster-autoscaler' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'abort "Deployment 期望副本数必须至少为 1" unless desired >= 1' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'abort "Deployment controller 尚未观测最新 generation" unless observed == generation' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'abort "Deployment 正在删除" unless workload.dig("metadata", "deletionTimestamp").nil?' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'replicas == desired && updated == desired && ready == desired && available == desired' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'abort "Deployment 仍有不可用副本" unless unavailable == 0' \
  "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'for unsafe_state in zero partial unobserved extra-old-replica deleting' \
  "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'replicas: 2,' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed '"-extra-old-replica") then' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed '"-deleting") then' "$workflow_directory/fixtures/mock-live-kubectl.sh"
for critical_addon in \
  aws-load-balancer-controller \
  cluster-autoscaler \
  external-secrets
do
  require_fixed "  $critical_addon \\" "$workflow_directory/test-live-application-secrets.sh"
done
require_fixed '  kube-prometheus-stack-operator' "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'pod-identity-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'vpc-cni-network-policy-disabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'vpc-cni-degraded' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'vpc-cni-pod-identity-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudwatch-container-logs-disabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudwatch-observability-degraded' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudwatch-observability-config-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudwatch-pod-identity-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudwatch-agent-workload-not-ready' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed 'cloudwatch-fluent-bit-not-ready' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed 'cloudwatch-fluent-bit-sa-drift' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed 'cloudwatch-fluent-bit-container-drift' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed 'autoscaler-policy-missing-describe-tags' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'autoscaler-policy-wildcard' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-rule-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-low-rate-scope-widened' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-managed-stage-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-managed-version-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-rate-stage-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-header-stage-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-logging-unredacted' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-logging-query-visible' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-sampled-requests-enabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'waf-alarm-disabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-waf-rate-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-managed-stage-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-managed-version-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-rate-stage-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-origin-bypass' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 's3api get-public-access-block' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cloudfront-origin-public-access-block-missing' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-origin-public-acls-enabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-origin-public-policy-enabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 's3api get-bucket-policy' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cloudfront get-response-headers-policy-config' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'security.key?("FrameOptions")' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'DenyUnconditionalReleaseWrites' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '"s3:ObjectCreationOperation" => "true"' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '"s3:if-none-match" => "true"' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cloudfront-origin-bucket-policy-missing' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-origin-source-arn-drift' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-origin-external-principal' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-release-write-deny-missing' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-release-unconditional-write-allowed' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-release-prefix-writable' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-frame-options-sameorigin' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-logging-query-visible' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'cloudfront-sampled-requests-enabled' "$workflow_directory/fixtures/mock-live-aws.sh"
require_fixed 'SampledRequestsEnabled' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'wafv2 get-web-acl' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'managed_rule_rollout' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '/operator/v1/launches' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed '/client/v1/spins' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'wafv2 get-logging-configuration' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'cloudwatch describe-alarms' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'iam get-role-policy' "$production_directory/verify-live-platform-prerequisites.sh"
require_fixed 'autoscaling:DescribeTags' "$production_directory/verify-live-platform-prerequisites.sh"
test "$(grep -F -c 'autoscaling:DescribeTags' \
  "$production_directory/verify-live-platform-prerequisites.sh" || true)" -eq 2 || \
  fail 'Cluster Autoscaler 实际 IAM allowlist 与错误门禁都必须锁定 DescribeTags'
require_fixed '.spec.template.metadata.annotations["slots-game.io/definition-sha256"] == $definition_sha256' \
  "$workflow_directory/verify-live-definition-identity.sh"
require_fixed 'AWS 正式发布禁止 nameOverride/fullnameOverride' \
  "$workflow_directory/verify-live-definition-identity.sh"
require_fixed 'get deployment -l "$release_selector" -o json' \
  "$workflow_directory/verify-live-definition-identity.sh"
require_fixed 'get secret -l "owner=helm,name=${helm_release}" -o json' \
  "$workflow_directory/verify-live-definition-identity.sh"
require_fixed 'Helm release 记录仍存在，拒绝把缺失 Deployment 误判为首次安装' \
  "$workflow_directory/verify-live-definition-identity.sh"
require_fixed 'partial-install missing-annotation candidate-mismatch api-worker-divergence \' \
  "$workflow_directory/test-live-definition-identity.sh"
require_fixed 'orphaned-release unexpected-component' \
  "$workflow_directory/test-live-definition-identity.sh"
require_fixed 'live-values-name-override.yaml' \
  "$workflow_directory/test-live-definition-identity.sh"
require_fixed 'MOCK_SECRET_MODE=missing-username' "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'MOCK_PLATFORM_MODE=missing-shared-username' \
  "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'valkey-eviction-policy-drift' "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'valkey-parameter-applying' "$workflow_directory/test-live-application-secrets.sh"
require_fixed 'wrong-endpoint-values.yaml' "$workflow_directory/test-live-application-secrets.sh"
require_fixed '"valkey_active_slot": "a"' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_user_names": {' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_password_versions": {' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_rotation_contract": {' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_rotation_mode": "steady"' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_maxmemory_policy": "noeviction"' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_parameter_group_name": "slots-prod-primary-valkey-noeviction"' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"valkey_replication_group_id": "slots-prod-primary-valkey"' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"password_fingerprints": {' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"hmac_key_fingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"' \
  "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"username": "Zml4dHVyZQ=="' "$workflow_directory/fixtures/mock-kubectl.sh"
require_fixed '"username": "Zml4dHVyZQ=="' "$workflow_directory/fixtures/mock-live-kubectl.sh"
require_fixed '"rgs" => expected_api_runtime_secret' "$workflow_directory/verify-rendered-release.rb"
require_fixed '"rgs-worker" => expected_worker_runtime_secret' "$workflow_directory/verify-rendered-release.rb"
require_fixed 'annotations["alb.ingress.kubernetes.io/scheme"] == "internet-facing"' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'annotations["alb.ingress.kubernetes.io/ip-address-type"] == "ipv4"' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'annotations["alb.ingress.kubernetes.io/backend-protocol"] == "HTTP"' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'listen_ports == [{"HTTP" => 80}, {"HTTPS" => 443}]' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'annotations["alb.ingress.kubernetes.io/manage-backend-security-group-rules"] == "true"' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'subnets.sort == expected_subnets.sort' "$workflow_directory/verify-rendered-release.rb"
require_fixed 'actual_alb_source_cidrs.sort == expected_alb_source_cidrs.sort' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'annotations.fetch("alb.ingress.kubernetes.io/security-groups", "") == expected_security_group' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'delivery.fetch("alb_egress_target_ports") == [8080, 8081]' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed '"alb_security_group_id": "sg-00000000000000001"' \
  "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"alb_egress_target_ports": [8080, 8081]' \
  "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"public_subnet_ids": [' "$workflow_directory/fixtures/live-delivery.json"
require_fixed '"public_subnet_cidrs": [' "$workflow_directory/fixtures/live-delivery.json"
require_fixed 'username_reference["name"] == expected_shared_admission_secret' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'username_reference["key"] == "username"' \
  "$workflow_directory/verify-rendered-release.rb"
require_fixed 'normalized.include?("launch") || normalized.include?("access")' \
  "$workflow_directory/verify-rendered-release.rb"

hmac_verifier="$workflow_directory/verify-hmac-quiesce-evidence.rb"
hmac_finalize_verifier="$workflow_directory/verify-hmac-finalize-attestation.rb"
hmac_manager="$workflow_directory/manage-hmac-quiesce-evidence.sh"
hmac_marker="$workflow_directory/hmac-evidence-marker.sh"
hmac_app_gate="$workflow_directory/hmac-application-maintenance-gate.sh"
hmac_diff="$workflow_directory/verify-hmac-only-release-diff.rb"
require_fixed 'slots-game/hmac-quiesce-attestation/v1' "$hmac_verifier"
require_fixed 'run_attempt' "$hmac_verifier"
require_fixed 'deployment_name' "$hmac_verifier"
require_fixed 'hpa_restore_manifest' "$hmac_verifier"
require_fixed '%w[consume resume finalize].include?(purpose)' "$hmac_verifier"
require_fixed 'assert(now < expires_at, "证据已过期") if purpose == "consume"' "$hmac_verifier"
require_fixed 'slots-game/hmac-finalize-attestation/v1' "$hmac_finalize_verifier"
require_fixed '复证 TTL 必须精确为 15 分钟' "$hmac_finalize_verifier"
require_fixed '复证没有绑定当前 latest delivery' "$hmac_finalize_verifier"
require_fixed '复证 API 不是无 HPA、零副本、零 Pod' "$hmac_finalize_verifier"
require_fixed '复证 Worker 没有保持全部健康' "$hmac_finalize_verifier"
require_fixed 'trap cleanup EXIT' "$hmac_manager"
require_fixed "trap 'exit 143' TERM" "$hmac_manager"
require_fixed 'hpa_spec_sha256=$(jq -j -S -c '\''.spec'\''' "$hmac_manager"
require_fixed '证据已经上传但 lock 尚未提交，先发布精确 cancellation marker' "$hmac_manager"
require_fixed 'cancellation marker 发布失败；保持 API 零副本和 maintenance lock' "$hmac_manager"
cancellation_call='"$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file"'
test "$(grep -F -c "$cancellation_call" "$hmac_manager" || true)" -eq 2 || \
  fail '孤儿证据失败恢复与显式 resume 都必须先发布当前证据的 cancellation marker'
cleanup_cancel_line=$(grep -nF '"$script_directory/hmac-evidence-marker.sh" publish cancellation "$evidence_file"' \
  "$hmac_manager" | head -1 | cut -d: -f1)
cleanup_restore_line=$(grep -nF 'restore_after_failure || true' "$hmac_manager" | cut -d: -f1)
test "$cleanup_cancel_line" -lt "$cleanup_restore_line" || \
  fail '孤儿证据 cancellation marker 必须先于旧 API/HPA 恢复'
if grep -F -- '--preconditions' "$hmac_manager" "$hmac_app_gate" >/dev/null; then
  fail 'kubectl delete 不支持 --preconditions；必须先完整回读 lock UID 再删除'
fi
require_fixed 'slots-hmac-maintenance-lock' "$hmac_manager"
require_fixed 'reference_hash=$(printf '\''%s\n%s'\''' "$hmac_marker"
require_fixed 'AWS_HMAC_QUIESCE_CANCELLATION_PREFIX' "$hmac_marker"
require_fixed 'AWS_HMAC_QUIESCE_COMPLETION_PREFIX' "$hmac_marker"
require_fixed "--if-none-match '*'" "$hmac_marker"
require_fixed 'if ! "$KUBECTL_BIN" get "configmap/$lock_name"' "$hmac_app_gate"
require_fixed 'ruby "$script_directory/verify-hmac-quiesce-evidence.rb" finalize "$evidence_file"' \
  "$hmac_app_gate"
require_fixed '  select(' "$hmac_app_gate"
require_fixed '.data.evidenceSha256 == $evidence_sha and .data.evidenceExpiresAt == $expires_at' \
  "$hmac_app_gate"
require_fixed 'write_finalize_attestation "$rendered_file"' "$hmac_app_gate"
require_fixed 'test "$GITHUB_WORKFLOW_REF" = "$expected_workflow_ref"' "$hmac_app_gate"
require_fixed '"$script_directory/hmac-evidence-marker.sh" check all "$evidence_file"' "$hmac_app_gate"
require_fixed "now + 900" "$hmac_app_gate"
require_fixed 'app.kubernetes.io/component=rgs-worker' "$hmac_app_gate"
require_fixed 'RGS_SHARED_ADMISSION_USERNAME' "$hmac_app_gate"
require_fixed 'RGS_SHARED_ADMISSION_PASSWORD_FILE' "$hmac_app_gate"
require_fixed 'RGS_SHARED_ADMISSION_HMAC_KEY_FILE' "$hmac_app_gate"
require_fixed 'RGS_SHARED_ADMISSION_ROOT_CA_FILE' "$hmac_app_gate"
require_fixed 'shared-admission-source' "$hmac_app_gate"
require_fixed 'live_hpa_sha=$(jq -j -S -c '\''.spec'\''' "$hmac_app_gate"
require_fixed 'Phase B API HPA spec 与停机证据不一致' "$hmac_app_gate"
require_fixed 'Migrator/Helm hooks 与当前成功 release 不同' "$hmac_diff"
require_fixed 'API Deployment 混入共享 HMAC 边界以外变化' "$hmac_diff"
require_fixed '证据 HPA spec SHA 与当前 Helm manifest 不一致' "$hmac_diff"
require_fixed 'evidence_hpa.fetch("spec") == current_hpa.fetch("spec")' "$hmac_diff"
require_fixed 'lock-patch-failure lock-readback-failure' \
  "$workflow_directory/test-hmac-quiesce-evidence.sh"
require_fixed 'E2 发布后 E1 cancellation 被遮蔽' "$workflow_directory/test-hmac-quiesce-evidence.sh"
require_fixed 'Phase A/B 失败注入观察到旧 Secret Pod 启动' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'Phase B live HPA spec 漂移仍通过证据 SHA 门禁' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'Terraform consume 错误接受 target 发布后已过期的原证据' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'application finalize 无法读取完整但已过期的原证据' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed '过期原证据在 latest delivery 尚未到 target steady 时仍生成 finalize 复证' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed '已取消的过期原证据仍生成 finalize 复证' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'finalize 实时复证接受 API 非零副本' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'finalize 实时复证接受已重建 API HPA' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'finalize 实时复证接受 Worker UID 漂移' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed '真实 kubectl 没有以未知参数拒绝 delete --preconditions' \
  "$workflow_directory/test-hmac-application-maintenance.sh"
require_fixed 'mock delete 拒绝未知参数' "$workflow_directory/fixtures/mock-hmac-kubectl.sh"
require_fixed 'worker-image' "$workflow_directory/test-hmac-only-release-diff.sh"
require_fixed 'migrator-hook' "$workflow_directory/test-hmac-only-release-diff.sh"
require_fixed '普通发布仍接受受保护 Environment 中的旧 VersionId' \
  "$workflow_directory/test-latest-terraform-delivery.sh"

web_publisher="$workflow_directory/publish-web-release.sh"
require_fixed "--if-none-match '*'" "$web_publisher"
require_fixed 'if ! aws s3api put-object --bucket "$AWS_WEB_BUCKET" --key "$object_key"' "$web_publisher"
require_fixed '--checksum-algorithm SHA256 --checksum-sha256 "$content_sha256_base64"' "$web_publisher"
require_fixed '--checksum-mode ENABLED --output json' "$web_publisher"
require_fixed '.Metadata == {' "$web_publisher"
require_fixed '.ChecksumSHA256 == $checksum and .ContentLength == $content_length and' "$web_publisher"
require_fixed '--metadata "release-id=${release_id},web-image-digest=${web_digest},configuration-sha256=${configuration_sha256},csp-sha256=${csp_sha256}"' "$web_publisher"
require_fixed '.ServerSideEncryption == "aws:kms"' "$web_publisher"
require_fixed '--server-side-encryption aws:kms --ssekms-key-id "$AWS_WEB_KMS_KEY_ARN"' "$web_publisher"
require_fixed '.SSEKMSKeyId == $kms_key' "$web_publisher"
require_fixed 'put_status=reconciled' "$web_publisher"
require_fixed "remote_count=\$(jq -er '(.Contents // []) | length' \"\$remote_objects\")" "$web_publisher"
require_fixed 'test "$remote_count" = "$local_count"' "$web_publisher"
reject_fixed '不可变 release 前缀已经存在' "$web_publisher"
for mime_contract in \
  '*.avif) printf '\''%s\n'\'' '\''image/avif'\''' \
  '*.m4a) printf '\''%s\n'\'' '\''audio/mp4'\''' \
  '*.woff) printf '\''%s\n'\'' '\''font/woff'\''' \
  '*.ico) printf '\''%s\n'\'' '\''image/vnd.microsoft.icon'\''' \
  '*.atlas|*.fnt|*.txt) printf '\''%s\n'\'' '\''text/plain; charset=utf-8'\''' \
  '*.skel) printf '\''%s\n'\'' '\''application/octet-stream'\''' \
  '*) return 1'
do
  require_fixed "$mime_contract" "$web_publisher"
done
require_fixed '.ContentSecurityPolicy.ContentSecurityPolicy == $csp' "$web_publisher"
require_fixed '(.ResponseHeadersPolicyConfig.SecurityHeadersConfig | has("FrameOptions") | not)' "$web_publisher"
require_fixed 'expected_origin="${AWS_WEB_BUCKET}.s3.${AWS_REGION}.amazonaws.com"' "$web_publisher"
require_fixed '.DistributionConfig.Origins.Items[0].DomainName == $origin' "$web_publisher"
require_fixed 'aws cloudfront describe-function' "$web_publisher"
require_fixed '.FunctionSummary.FunctionMetadata.Stage == "LIVE"' "$web_publisher"
require_fixed '.FunctionSummary.FunctionConfig.KeyValueStoreAssociations.Quantity == 1' "$web_publisher"
require_fixed 'aws cloudfront-keyvaluestore describe-key-value-store' "$web_publisher"
require_fixed 'if aws cloudfront-keyvaluestore put-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN"' "$web_publisher"
require_fixed '--if-match "$kvs_etag_before" --key active-release --value "$release_id"' "$web_publisher"
test "$(grep -F -c -- '--if-match "$kvs_etag_before" --key active-release --value "$release_id"' \
  "$web_publisher" || true)" -eq 2 || \
  fail 'Web KVS 必须同时保留首次 promotion 与首次发布 CAS target retry'
require_fixed 'aws cloudfront-keyvaluestore get-key --kvs-arn "$AWS_CLOUDFRONT_KVS_ARN"' "$web_publisher"
require_fixed 'read_active_release_authoritatively() {' "$web_publisher"
require_fixed 'if ! read_active_release_authoritatively "$active_json"; then' "$web_publisher"
require_fixed '--if-match "$kvs_etag_before" --key active-release --value "$previous_release"' "$web_publisher"
require_fixed 'test "$authoritative_kvs_etag" != "$kvs_etag_before"' "$web_publisher"
require_fixed 'test "$fence_release_first" = "$fence_release_confirm"' "$web_publisher"
require_fixed 'test "$fence_etag_first" = "$fence_etag_confirm"' "$web_publisher"
require_fixed 'CAS fence 已推进原 ETag 且 active-release 保持旧状态' "$web_publisher"
require_fixed 'CAS fence 在时限内未推进原 ETag，迟到写入风险仍未消除' "$web_publisher"
require_fixed 'manual_intervention promotion-reconciliation' "$web_publisher"
test "$(grep -F -c 'manual_intervention promotion-reconciliation' "$web_publisher" || true)" -eq 4 || \
  fail 'Web KVS promotion reconciliation 必须覆盖读取失败、第三状态、READY/ETag 不一致四个分支'
require_fixed 'kvs-manual-intervention.env' "$web_publisher"
require_fixed 'freeze-and-authoritatively-reconcile' "$web_publisher"
require_fixed 'promotion_command_status="${promotion_command_status}-reconciled-applied"' "$web_publisher"
require_fixed 'test "$latest_etag" = "$kvs_etag_after"' "$web_publisher"
require_fixed 'if ! read_active_release_authoritatively "$pre_rollback_active"; then' "$web_publisher"
require_fixed 'if ! read_active_release_authoritatively "$rollback_active"; then' "$web_publisher"
require_fixed 'rollback_command_status="${rollback_command_status}-reconciled-applied"' "$web_publisher"
require_fixed 'test "$authoritative_kvs_etag" != "$latest_etag"' "$web_publisher"
require_fixed 'rollback_public_ready=false' "$web_publisher"
require_fixed 'test "$rollback_status" = 503' "$web_publisher"
require_fixed "grep -F -x 'release is not ready'" "$web_publisher"
require_fixed 'jq -e --arg release "$previous_release" '\''.releaseId == $release'\''' "$web_publisher"
require_fixed 'test "$rollback_public_ready" = true' "$web_publisher"
require_fixed 'aws cloudfront get-distribution --id "$AWS_CLOUDFRONT_DISTRIBUTION_ID"' "$web_publisher"
web_switch_faults="$workflow_directory/test-web-release-switch-faults.sh"
require_fixed 'invoke_upload_scenario "$upload_root" upload-interrupt delivery-interrupted' "$web_switch_faults"
require_fixed 'invoke_upload_scenario "$upload_root" upload-resume delivery-resumed' "$web_switch_faults"
require_fixed 'for drift_mode in checksum length release image configuration csp metadata-extra content-type cache encryption kms; do' \
  "$web_switch_faults"
require_fixed '对象漂移后仍进入 KVS 或公网切换' "$web_switch_faults"
require_fixed 'invoke_upload_scenario "$count_drift_root" upload-drift-object-count delivery' \
  "$web_switch_faults"
require_fixed 'run_scenario applied-then-error "$previous_release" success' "$web_switch_faults"
require_fixed 'run_scenario delayed-apply-after-read "$previous_release" success' "$web_switch_faults"
require_fixed 'run_scenario not-applied-error "$previous_release" failure' "$web_switch_faults"
require_fixed 'run_scenario lookup-error "$previous_release" failure' "$web_switch_faults"
require_fixed 'run_scenario applied-then-error-first-release none failure' "$web_switch_faults"
require_fixed 'public-rollback-503' "$web_switch_faults"
require_fixed 'ACTION=freeze-and-authoritatively-reconcile' "$web_switch_faults"
if grep -E 'update-distribution|update-response-headers-policy|aws[[:space:]]+lambda' "$web_publisher" >/dev/null; then
  fail 'Web 应用发布不得越过 KVS 接口修改 distribution、CSP policy 或 Lambda'
fi

printf '%s\n' 'AWS 基础设施与应用交付工作流静态契约通过。'
