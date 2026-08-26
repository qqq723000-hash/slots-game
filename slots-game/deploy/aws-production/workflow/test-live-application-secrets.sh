#!/bin/sh

# 使用纯本地 fixture 证明缺 key、可变 Secret 和 delivery 漂移都会在 Helm 前被拒绝。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../../.." && pwd)
verifier="$script_directory/verify-live-application-secrets.sh"
renderer="$repository_root/slots-game/deploy/aws-production/render-external-secrets.rb"
platform_verifier="$repository_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
alb_verifier="$repository_root/slots-game/deploy/aws-production/verify-live-alb-edge.sh"
evidence_verifier="$repository_root/slots-game/deploy/aws-production/verify-waf-rollout-evidence.rb"
mock_kubectl="$script_directory/fixtures/mock-kubectl.sh"
mock_live_kubectl="$script_directory/fixtures/mock-live-kubectl.sh"
mock_live_aws="$script_directory/fixtures/mock-live-aws.sh"
values_file="$script_directory/fixtures/live-values.yaml"
chart_defaults="$repository_root/slots-game/deploy/cluster-production/chart/values.yaml"
delivery_file="$script_directory/fixtures/live-delivery.json"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-live-secret-test.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "AWS 平台与应用 Secret 负向 fixture 失败：$*" >&2
  exit 1
}

KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null || \
  fail '完整平台实时门禁 fixture 未通过'

for addon in \
  aws-load-balancer-controller \
  cluster-autoscaler \
  external-secrets \
  kube-prometheus-stack-operator
do
  for unsafe_state in zero partial unobserved extra-old-replica deleting
  do
    if MOCK_PLATFORM_MODE="addon-$addon-$unsafe_state" \
      KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
      "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
      fail "平台门禁未拒绝未收敛的关键 add-on Deployment：$addon/$unsafe_state"
    fi
  done
done

ALB_LIVE_MAX_ATTEMPTS=1 KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$alb_verifier" "$delivery_file" slots-production >/dev/null || \
  fail '完整 ALB/WAF/target-health 发布后实时门禁 fixture 未通过'

for unsafe_alb_mode in \
  alb-subnet-drift \
  alb-security-group-drift \
  alb-waf-drift \
  alb-listener-drift \
  alb-attribute-drift \
  alb-waf-fail-open \
  alb-log-bucket-drift \
  alb-log-prefix-drift \
  alb-health-port-drift \
  alb-target-unhealthy \
  alb-current-target-missing \
  alb-stale-target-unhealthy \
  alb-tls-policy-drift \
  alb-certificate-drift \
  alb-host-rule-drift \
  alb-path-rule-drift \
  alb-target-rule-drift \
  alb-http-extra-rule \
  alb-http-redirect-host-drift \
  alb-http-rule-redirect-path-drift \
  alb-http-rule-redirect-query-drift \
  alb-https-default-forward \
  alb-https-extra-rule \
  alb-egress-health-missing \
  alb-egress-health-internet \
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
  if ALB_LIVE_MAX_ATTEMPTS=1 MOCK_PLATFORM_MODE=$unsafe_alb_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$alb_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "发布后 ALB 实时门禁未拒绝危险漂移：$unsafe_alb_mode"
  fi
done

# Block 阶段必须读取精确 S3 version、核对对象 SHA-256，并验证对象内的环境、ACL、配置、
# 七天观测、双人审批与回滚 schema。任意内容篡改都必须在接触 WAF 状态前失败关闭。
evidence_file="$fixture_root/waf-rollout-evidence.json"
tampered_evidence_file="$fixture_root/waf-rollout-evidence-tampered.json"
block_delivery="$fixture_root/waf-managed-block-delivery.json"
block_plan="$fixture_root/waf-managed-block-plan.json"
incomplete_block_plan="$fixture_root/waf-managed-block-plan-incomplete.json"
expired_evidence_file="$fixture_root/waf-rollout-evidence-expired.json"
expired_block_delivery="$fixture_root/waf-managed-block-expired-delivery.json"
expired_promotion_plan="$fixture_root/waf-managed-block-expired-promotion-plan.json"
expired_steady_plan="$fixture_root/waf-managed-block-expired-steady-plan.json"
expired_steady_prior_state_plan="$fixture_root/waf-managed-block-expired-prior-state-plan.json"
rate_evidence_file="$fixture_root/waf-launch-rate-evidence.json"
rate_block_delivery="$fixture_root/waf-launch-rate-block-delivery.json"
configuration_hash=$(ruby "$evidence_verifier" --configuration-sha256 \
  "$delivery_file" api-managed-rules) || fail '无法生成 WAF evidence 配置绑定摘要'
ruby -rjson -rtime -e '
  output, configuration_hash = ARGV
  now = Time.now.utc
  ended_at = now - 3600
  evidence = {
    "schema_version" => "slots-game/waf-rollout-evidence/v1",
    "environment" => "prod-primary",
    "web_acl_arn" => "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/slots-prod-primary-api/00000000-0000-4000-8000-000000000000",
    "control_id" => "api-managed-rules",
    "rule_names" => ["amazon-ip-reputation", "common", "known-bad-inputs", "sqli"],
    "proposed_action" => "block",
    "configuration_sha256" => configuration_hash,
    "source_commit_sha" => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "observation" => {
      "started_at" => (ended_at - 8 * 24 * 60 * 60).iso8601,
      "ended_at" => ended_at.iso8601,
      "evaluated_requests" => 1_000_000,
      "matched_requests" => 1_000,
      "false_positive_requests" => 0,
      "legitimate_survival_rate" => 0.9999,
      "origin_capacity_headroom_percent" => 35,
    },
    "reviews" => {
      "normal_peak_observed" => true,
      "planned_peak_or_equivalent_observed" => true,
      "nat_cgnat_reviewed" => true,
      "header_envelope_reviewed" => true,
      "managed_rule_versions_reviewed" => true,
    },
    "approvals" => [
      {"principal" => "security-reviewer", "approved_at" => (ended_at + 60).iso8601, "change_id" => "CHG-1001"},
      {"principal" => "service-owner", "approved_at" => (ended_at + 120).iso8601, "change_id" => "CHG-1001"},
    ],
    "rollback" => {
      "owner" => "slots-oncall",
      "trigger" => "legitimate survival or origin headroom breaches approved threshold",
      "runbook" => "https://runbooks.example.com/slots/waf-count-rollback",
    },
    "expires_at" => (now + 7 * 24 * 60 * 60).iso8601,
  }
  File.binwrite(output, JSON.generate(evidence) << "\n")
' "$evidence_file" "$configuration_hash" || fail '无法生成 WAF evidence 正样例'
ruby -e 'File.binwrite(ARGV.fetch(1), File.binread(ARGV.fetch(0)) << " ")' \
  "$evidence_file" "$tampered_evidence_file" || fail '无法生成 WAF evidence 篡改变体'
evidence_sha=$(ruby -rdigest -e 'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$evidence_file")
evidence_reference="s3://slots-waf-evidence/production/api-managed-rules.json?versionId=fixture-version-1#$evidence_sha"
jq --arg reference "$evidence_reference" '
  .api_edge_security_contract.managed_rule_rollout = {
    action: "block", evidence_reference: $reference
  } |
  .application_handoff.api_edge_security.managed_rule_rollout = {
    action: "block", evidence_reference: $reference
  }
' "$delivery_file" >"$block_delivery" || fail '无法生成 WAF managed Block delivery'
jq -n --slurpfile delivery "$block_delivery" '
  ($delivery[0]) as $value |
  {
    variables: {configuration: {value: {
      api_waf_managed_rule_rollout: $value.api_edge_security_contract.managed_rule_rollout,
      api_waf_header_size_rule_rollout: $value.api_edge_security_contract.header_size_rule_rollout,
      api_waf_rate_rule_rollouts: $value.api_edge_security_contract.rate_rule_rollouts,
      cloudfront_waf_managed_rule_rollout: $value.cloudfront_edge_security_contract.managed_rule_rollout,
      cloudfront_waf_rate_rule_rollout: $value.cloudfront_edge_security_contract.rate_rule_rollout
    }}},
    planned_values: {outputs: {delivery: {value: $value}}}
  }
' > "$block_plan" || fail '无法生成 Terraform planned WAF Block fixture'
jq 'del(.planned_values.outputs.delivery.value)' "$block_plan" > "$incomplete_block_plan" || \
  fail '无法生成缺失 planned delivery 的 WAF Block fixture'

MOCK_WAF_EVIDENCE_FILE=$evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa < "$block_plan" >/dev/null || \
  fail 'Terraform apply 前 planned WAF Block evidence 正样例被错误拒绝'
if MOCK_WAF_EVIDENCE_FILE=$evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa < "$incomplete_block_plan" >/dev/null 2>&1; then
  fail 'Terraform apply 前门禁未拒绝缺少 planned delivery 的 WAF Block'
fi
if MOCK_WAF_EVIDENCE_FILE=$evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb < "$block_plan" >/dev/null 2>&1; then
  fail 'Terraform apply 前门禁未拒绝与当前受保护 infrastructure source SHA 不一致的晋级证据'
fi

MOCK_PLATFORM_MODE=waf-managed-block-evidence-valid \
  MOCK_WAF_EVIDENCE_FILE=$evidence_file \
  GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$block_delivery" slots-production >/dev/null || \
  fail '绑定 versionId、SHA-256、当前规则配置和双人审批的 WAF Block evidence 被错误拒绝'

# 证据有效期约束 Count→Block/配置变更，不租赁已经批准的稳态 Block。应用发布和
# 无关 Terraform apply 继续重验精确 version、SHA、KMS/Object Lock、schema 与配置绑定。
ruby -rjson -rtime -e '
  value = JSON.parse(File.binread(ARGV.fetch(0)))
  ended_at = Time.iso8601(value.fetch("observation").fetch("ended_at"))
  value["expires_at"] = (ended_at + 30 * 60).iso8601
  File.binwrite(ARGV.fetch(1), JSON.generate(value) << "\n")
' "$evidence_file" "$expired_evidence_file" || fail '无法生成已过期 WAF evidence fixture'
expired_evidence_sha=$(ruby -rdigest -e 'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$expired_evidence_file")
expired_evidence_reference="s3://slots-waf-evidence/production/api-managed-rules.json?versionId=fixture-version-1#$expired_evidence_sha"
jq --arg reference "$expired_evidence_reference" '
  .api_edge_security_contract.managed_rule_rollout.evidence_reference = $reference |
  .application_handoff.api_edge_security.managed_rule_rollout.evidence_reference = $reference
' "$block_delivery" > "$expired_block_delivery" || fail '无法生成已过期稳态 Block delivery'
jq -n --slurpfile delivery "$expired_block_delivery" '
  ($delivery[0]) as $value |
  {
    variables: {configuration: {value: {
      api_waf_managed_rule_rollout: $value.api_edge_security_contract.managed_rule_rollout,
      api_waf_header_size_rule_rollout: $value.api_edge_security_contract.header_size_rule_rollout,
      api_waf_rate_rule_rollouts: $value.api_edge_security_contract.rate_rule_rollouts,
      cloudfront_waf_managed_rule_rollout: $value.cloudfront_edge_security_contract.managed_rule_rollout,
      cloudfront_waf_rate_rule_rollout: $value.cloudfront_edge_security_contract.rate_rule_rollout
    }}},
    planned_values: {outputs: {delivery: {value: $value}}}
  }
' > "$expired_promotion_plan" || fail '无法生成已过期 promotion plan'
jq --slurpfile delivery "$expired_block_delivery" '
  .output_changes = {delivery: {before: $delivery[0], after: $delivery[0]}}
' "$expired_promotion_plan" > "$expired_steady_plan" || fail '无法生成已过期 steady Block plan'
jq --slurpfile delivery "$expired_block_delivery" '
  .prior_state = {values: {outputs: {delivery: {value: $delivery[0]}}}}
' "$expired_promotion_plan" > "$expired_steady_prior_state_plan" || fail '无法生成 prior_state steady Block plan'
if MOCK_WAF_EVIDENCE_FILE=$expired_evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa < "$expired_promotion_plan" >/dev/null 2>&1; then
  fail 'Terraform apply 前门禁未拒绝使用已过期证据晋级 Count→Block'
fi
MOCK_WAF_EVIDENCE_FILE=$expired_evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb < "$expired_steady_plan" >/dev/null || \
  fail '无关 Terraform apply 被已过期但不可变且配置一致的稳态 Block 证据错误阻断'
MOCK_WAF_EVIDENCE_FILE=$expired_evidence_file \
  "$evidence_verifier" --terraform-plan "$mock_live_aws" ap-southeast-1 \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb < "$expired_steady_prior_state_plan" >/dev/null || \
  fail 'Terraform 未输出 no-op output_changes 时没有从 prior_state 识别稳态 Block'
MOCK_PLATFORM_MODE=waf-managed-block-evidence-valid \
  MOCK_WAF_EVIDENCE_FILE=$expired_evidence_file \
  GITHUB_SHA=cccccccccccccccccccccccccccccccccccccccc \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$expired_block_delivery" slots-production >/dev/null || \
  fail '应用发布被已过期但不可变且配置一致的稳态 Block 证据错误阻断'

# WAF 自定义 429 必须携带浏览器可读的 Retry-After 与固定泛化 marker；否则客户端会把
# 空 body 误判为未知网络错误并制造重试羊群。
rate_configuration_hash=$(ruby "$evidence_verifier" --configuration-sha256 \
  "$delivery_file" api-rate:launch-rate-limit) || fail '无法生成 launch rate evidence 配置摘要'
jq --arg configuration_hash "$rate_configuration_hash" '
  .control_id = "api-rate:launch-rate-limit" |
  .rule_names = ["launch-rate-limit"] |
  .configuration_sha256 = $configuration_hash
' "$evidence_file" > "$rate_evidence_file" || fail '无法生成 launch rate evidence'
rate_evidence_sha=$(ruby -rdigest -e 'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$rate_evidence_file")
rate_evidence_reference="s3://slots-waf-evidence/production/api-launch-rate.json?versionId=fixture-version-1#$rate_evidence_sha"
jq --arg reference "$rate_evidence_reference" '
  .api_edge_security_contract.rate_rule_rollouts["launch-rate-limit"] = {
    action: "block", evidence_reference: $reference
  } |
  .application_handoff.api_edge_security.rate_rule_rollouts["launch-rate-limit"] = {
    action: "block", evidence_reference: $reference
  }
' "$delivery_file" > "$rate_block_delivery" || fail '无法生成 launch rate Block delivery'
MOCK_PLATFORM_MODE=waf-rate-block-valid \
  MOCK_WAF_EVIDENCE_FILE=$rate_evidence_file \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$rate_block_delivery" slots-production >/dev/null || \
  fail '带浏览器可读 Retry-After 与 edge marker 的 WAF rate Block 被错误拒绝'
if MOCK_PLATFORM_MODE=waf-rate-block-browser-response-drift \
  MOCK_WAF_EVIDENCE_FILE=$rate_evidence_file \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$rate_block_delivery" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝浏览器不可识别的 WAF 429 marker 漂移'
fi

if MOCK_PLATFORM_MODE=waf-managed-block-evidence-tampered \
  MOCK_WAF_EVIDENCE_FILE=$evidence_file \
  MOCK_WAF_EVIDENCE_TAMPERED_FILE=$tampered_evidence_file \
  GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$block_delivery" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝内容 SHA-256 与 versioned 引用不一致的 WAF Block evidence'
fi

for unsafe_evidence_mode in \
  waf-managed-block-evidence-unencrypted \
  waf-managed-block-evidence-wrong-kms \
  waf-managed-block-evidence-unlocked
do
  if MOCK_PLATFORM_MODE=$unsafe_evidence_mode \
    MOCK_WAF_EVIDENCE_FILE=$evidence_file \
    GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$block_delivery" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝不满足批准 KMS/COMPLIANCE Object Lock 的证据：$unsafe_evidence_mode"
  fi
done

if MOCK_PLATFORM_MODE=waf-rule-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺失 spin 分层限速的实际 WAF'
fi

if ! MOCK_PLATFORM_MODE=valkey-target-after-page KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁没有聚合 Valkey AWS CLI 自动分页后的目标节点和参数'
fi

for unsafe_valkey_mode in \
  valkey-replication-pending \
  valkey-cluster-pending \
  valkey-parameter-group-drift \
  valkey-parameter-applying \
  valkey-eviction-policy-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_valkey_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 Valkey noeviction 未实际收敛：$unsafe_valkey_mode"
  fi
done

if MOCK_PLATFORM_MODE=waf-unknown-allow-rule KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝插入 priority=0 的未知 terminating Allow 规则'
fi

if MOCK_PLATFORM_MODE=waf-priority-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 WAF 规则 priority 漂移'
fi

if MOCK_PLATFORM_MODE=waf-low-rate-scope-widened KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝把 launch 低阈值扩大到状态/恢复路由的实际 WAF'
fi

if MOCK_PLATFORM_MODE=waf-low-rate-method-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝把 OPTIONS/GET 计入 launch/spin 新意图低阈值规则'
fi

if MOCK_PLATFORM_MODE=waf-public-rate-method-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 OPTIONS 预检绕过公网高阈值规则'
fi

if MOCK_PLATFORM_MODE=waf-public-healthz-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝未在 WAF 精确隐藏公网 /healthz 的实际规则'
fi

if MOCK_PLATFORM_MODE=waf-protocol-surface-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝把 API path allowlist 扩大到任意 URI 的实际 WAF'
fi

if MOCK_PLATFORM_MODE=waf-managed-stage-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝无观测证据提前 Block 的区域 WAF managed rule'
fi

if MOCK_PLATFORM_MODE=waf-managed-version-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝区域 WAF managed rule group 精确版本漂移'
fi

for unsafe_managed_mode in \
  waf-managed-excluded-rules \
  waf-managed-action-override \
  waf-managed-scope-down
do
  if MOCK_PLATFORM_MODE=$unsafe_managed_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝区域 WAF managed statement 隐藏绕过：$unsafe_managed_mode"
  fi
done

if MOCK_PLATFORM_MODE=waf-rate-stage-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝无校准证据提前 Block 的区域 WAF rate rule'
fi

if MOCK_PLATFORM_MODE=waf-header-stage-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝无最大合法请求头证据提前 Block 的 aggregate header rule'
fi

for unsafe_size_mode in \
  waf-body-size-transform-drift \
  waf-header-size-transform-drift \
  waf-header-match-scope-drift \
  waf-header-match-pattern-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_size_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝缩小 8KiB 完整检查面的 WAF size 规则：$unsafe_size_mode"
  fi
done

for unsafe_visibility_mode in \
  waf-web-acl-metrics-disabled \
  waf-web-acl-metric-name-drift \
  waf-rule-metrics-disabled \
  waf-rule-metric-name-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_visibility_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝区域 WAF visibility 指标静默漂移：$unsafe_visibility_mode"
  fi
done

if MOCK_PLATFORM_MODE=waf-logging-unredacted KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝泄漏 Authorization 的 WAF 日志配置'
fi

if MOCK_PLATFORM_MODE=waf-logging-query-visible KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝未脱敏 query string 的区域 WAF 日志配置'
fi

for unsafe_logging_mode in waf-logging-behavior-drift waf-logging-requirement-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_logging_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝会丢弃 BLOCK/COUNT 的区域 WAF logging filter：$unsafe_logging_mode"
  fi
done

if MOCK_PLATFORM_MODE=waf-sampled-requests-enabled KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝可能泄漏敏感请求内容的区域 WAF sampled requests'
fi

if MOCK_PLATFORM_MODE=waf-alarm-disabled KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝已停用动作的 WAF 告警'
fi

if MOCK_PLATFORM_MODE=waf-alarm-metric-dimension-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝使用 Web ACL 资源名而不是 visibility metric name 的无数据告警'
fi

for unsafe_alarm_mode in \
  waf-alarm-metric-name-drift \
  waf-alarm-statistic-drift \
  waf-alarm-comparison-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_alarm_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝区域 WAF 告警无数据/错误聚合漂移：$unsafe_alarm_mode"
  fi
done

for unsafe_rds_alarm_mode in \
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
  if MOCK_PLATFORM_MODE=$unsafe_rds_alarm_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝单实例 RDS 告警合同或实时状态漂移：$unsafe_rds_alarm_mode"
  fi
done

for unsafe_rds_reader_mode in \
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
  if MOCK_PLATFORM_MODE=$unsafe_rds_reader_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 RDS 同区域只读副本或告警实时漂移：$unsafe_rds_reader_mode"
  fi
done

if MOCK_PLATFORM_MODE=cloudfront-waf-rate-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 CloudFront WAF 限额漂移'
fi

if MOCK_PLATFORM_MODE=cloudfront-managed-stage-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝无观测证据提前 Block 的 CloudFront managed rule'
fi

if MOCK_PLATFORM_MODE=cloudfront-managed-version-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 CloudFront WAF managed rule group 精确版本漂移'
fi

for unsafe_managed_mode in \
  cloudfront-managed-excluded-rules \
  cloudfront-managed-action-override \
  cloudfront-managed-scope-down
do
  if MOCK_PLATFORM_MODE=$unsafe_managed_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 CloudFront WAF managed statement 隐藏绕过：$unsafe_managed_mode"
  fi
done

if MOCK_PLATFORM_MODE=cloudfront-rate-stage-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝无校准证据提前 Block 的 CloudFront rate rule'
fi

if MOCK_PLATFORM_MODE=cloudfront-rate-scope-down KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 CloudFront 全站 rate rule 被 ScopeDownStatement 缩窄'
fi

for unsafe_visibility_mode in \
  cloudfront-web-acl-metrics-disabled \
  cloudfront-web-acl-metric-name-drift \
  cloudfront-rule-metrics-disabled \
  cloudfront-rule-metric-name-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_visibility_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 CloudFront WAF visibility 指标静默漂移：$unsafe_visibility_mode"
  fi
done

if MOCK_PLATFORM_MODE=cloudfront-origin-bypass KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 CloudFront 私有 S3 OAC 漂移'
fi

for unsafe_origin_mode in \
  cloudfront-origin-public-access-block-missing \
  cloudfront-origin-public-acls-enabled \
  cloudfront-origin-public-policy-enabled \
  cloudfront-origin-bucket-policy-missing \
  cloudfront-origin-source-arn-drift \
  cloudfront-origin-external-principal
do
  if MOCK_PLATFORM_MODE=$unsafe_origin_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 CloudFront S3 源站公网访问漂移：$unsafe_origin_mode"
  fi
done

for unsafe_distribution_mode in \
  cloudfront-http-version-drift \
  cloudfront-lambda-association \
  cloudfront-extra-cache-behavior \
  cloudfront-extra-function-association \
  cloudfront-response-function-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_distribution_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 CloudFront behavior/function 绕过：$unsafe_distribution_mode"
  fi
done

if MOCK_PLATFORM_MODE=cloudfront-logging-query-visible KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝未脱敏 query string 的 CloudFront WAF 日志配置'
fi

for unsafe_logging_mode in cloudfront-logging-behavior-drift cloudfront-logging-requirement-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_logging_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝会丢弃 BLOCK/COUNT 的 CloudFront WAF logging filter：$unsafe_logging_mode"
  fi
done

if MOCK_PLATFORM_MODE=cloudfront-sampled-requests-enabled KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝可能泄漏 Cookie/query 的 CloudFront WAF sampled requests'
fi

if MOCK_PLATFORM_MODE=pod-identity-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail 'External Secrets Pod Identity role 漂移未被拒绝'
fi

if MOCK_PLATFORM_MODE=missing-api-key KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 API 必需 key 的不可变 Secret'
fi

if MOCK_PLATFORM_MODE=missing-shared-username KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 Valkey ACL username 的共享准入 Secret'
fi

if MOCK_PLATFORM_MODE=metrics-server-degraded KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝非 ACTIVE 的 metrics-server EKS add-on'
fi

if MOCK_PLATFORM_MODE=vpc-cni-network-policy-disabled KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝未启用 NetworkPolicy 的 vpc-cni add-on'
fi

if MOCK_PLATFORM_MODE=vpc-cni-degraded KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝非 ACTIVE 的 vpc-cni add-on'
fi

if MOCK_PLATFORM_MODE=vpc-cni-pod-identity-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 aws-node Pod Identity role 漂移'
fi

for unsafe_cloudwatch_mode in \
  cloudwatch-container-logs-disabled \
  cloudwatch-observability-degraded \
  cloudwatch-observability-config-drift \
  cloudwatch-pod-identity-drift \
  cloudwatch-agent-workload-not-ready \
  cloudwatch-fluent-bit-not-ready \
  cloudwatch-fluent-bit-sa-drift \
  cloudwatch-fluent-bit-container-drift
do
  if MOCK_PLATFORM_MODE=$unsafe_cloudwatch_mode KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
    "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
    fail "平台门禁未拒绝 CloudWatch Observability 执行面漂移：$unsafe_cloudwatch_mode"
  fi
done

if MOCK_PLATFORM_MODE=autoscaler-policy-missing-describe-tags \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 autoscaling:DescribeTags 的实际 IAM 策略'
fi

if MOCK_PLATFORM_MODE=autoscaler-policy-wildcard \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 Cluster Autoscaler 通配 IAM 权限'
fi

KUBECTL_BIN=$mock_kubectl "$verifier" "$values_file" "$chart_defaults" \
  slots-production "$delivery_file" >/dev/null || \
  fail '完整不可变 Secret fixture 未通过'

rendered_file="$fixture_root/external-secrets.yaml"
ruby "$renderer" "$delivery_file" slots-production > "$rendered_file" || \
  fail 'ExternalSecret renderer 正样例未通过'
ruby -ryaml -e '
  documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
  abort unless documents.count { |item| item["kind"] == "SecretStore" } == 1
  external = documents.select { |item| item["kind"] == "ExternalSecret" }
  abort unless external.length == 6
  abort unless external.all? { |item|
    item.dig("spec", "refreshPolicy") == "CreatedOnce" &&
      item.dig("spec", "target", "immutable") == true &&
      item.dig("spec", "secretStoreRef", "kind") == "SecretStore"
  }
' "$rendered_file" || fail 'ExternalSecret renderer 没有生成六个不可变 CreatedOnce 目标'

unversioned_delivery="$fixture_root/unversioned-delivery.json"
jq '.valkey_secret_name = "slots-rgs-shared-admission"' "$delivery_file" > "$unversioned_delivery"
if ruby "$renderer" "$unversioned_delivery" slots-production >/dev/null 2>&1; then
  fail 'ExternalSecret renderer 未拒绝无版本 Secret 名'
fi

if MOCK_SECRET_MODE=missing-key KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail 'API 运行素材 Secret 缺少必需 key 未被拒绝'
fi

if MOCK_SECRET_MODE=missing-worker-key KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail 'Worker 运行素材 Secret 缺少必需 key 未被拒绝'
fi

if MOCK_SECRET_MODE=missing-username KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail '共享准入 Secret 缺少 Valkey ACL username 未被拒绝'
fi

if MOCK_SECRET_MODE=mutable KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail '可变 Secret 未被拒绝'
fi

mismatched_delivery="$fixture_root/mismatched-delivery.json"
jq '.application_secret_names["runtime-database"] = "slots-wrong-runtime-database-v9"' \
  "$delivery_file" > "$mismatched_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$mismatched_delivery" >/dev/null 2>&1; then
  fail 'Helm values 与 Terraform delivery 的 Secret 名漂移未被拒绝'
fi

wrong_endpoint_values="$fixture_root/wrong-endpoint-values.yaml"
ruby -ryaml -e '
  value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: false)
  value.fetch("rgs").fetch("sharedAdmission")["endpointURL"] =
    "rediss://wrong-valkey.example.cache.amazonaws.com:6379"
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$values_file" "$wrong_endpoint_values"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$wrong_endpoint_values" "$chart_defaults" slots-production "$delivery_file" \
  >/dev/null 2>&1; then
  fail 'Helm values 的 Valkey endpoint 与 Terraform delivery 漂移未被拒绝'
fi

drifted_valkey_delivery="$fixture_root/drifted-valkey-delivery.json"
jq '.valkey_active_slot = "b"' "$delivery_file" > "$drifted_valkey_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$drifted_valkey_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey A/B active slot 与用户名、轮换契约漂移未被拒绝'
fi

missing_fingerprint_delivery="$fixture_root/missing-fingerprint-delivery.json"
jq 'del(.valkey_rotation_contract.password_fingerprints.b)' \
  "$delivery_file" > "$missing_fingerprint_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$missing_fingerprint_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey B 槽 password fingerprint 缺失未被拒绝'
fi

missing_acl_command_profile_delivery="$fixture_root/missing-acl-command-profile-delivery.json"
jq 'del(.valkey_rotation_contract.acl_command_profile)' \
  "$delivery_file" > "$missing_acl_command_profile_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$missing_acl_command_profile_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey v2-economic ACL 命令 profile 缺失未被拒绝'
fi

missing_acl_transition_delivery="$fixture_root/missing-acl-transition-delivery.json"
jq 'del(.valkey_rotation_contract.acl_schema_transition)' \
  "$delivery_file" > "$missing_acl_transition_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$missing_acl_transition_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey ACL v2 维护迁移模式缺失未被拒绝'
fi

rolling_acl_delivery="$fixture_root/rolling-acl-delivery.json"
jq '.valkey_rotation_contract.acl_schema_rolling_compatible = true' \
  "$delivery_file" > "$rolling_acl_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$rolling_acl_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey ACL v1 到 v2 被篡改为普通 rolling 兼容后未被拒绝'
fi

dual_acl_delivery="$fixture_root/dual-acl-delivery.json"
jq '.valkey_rotation_contract.acl_schema_dual_permissions_allowed = true' \
  "$delivery_file" > "$dual_acl_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$dual_acl_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey ACL v1/v2 永久双权限被启用后未被拒绝'
fi

reordered_acl_delivery="$fixture_root/reordered-acl-delivery.json"
jq '.valkey_rotation_contract.acl_schema_migration_order[1:3] |= reverse' \
  "$delivery_file" > "$reordered_acl_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$reordered_acl_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey ACL v2 在排空旧 Pod 前应用的迁移顺序未被拒绝'
fi

hmac_maintenance_delivery="$fixture_root/hmac-maintenance-delivery.json"
jq '.valkey_rotation_mode = "hmac-maintenance" |
  .valkey_rotation_contract.rotation_mode = "hmac-maintenance"' \
  "$delivery_file" > "$hmac_maintenance_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$hmac_maintenance_delivery" \
  >/dev/null 2>&1; then
  fail 'HMAC 停机维护期间仍允许应用发布'
fi

collapsed_delivery="$fixture_root/collapsed-delivery.json"
collapsed_values="$fixture_root/collapsed-values.yaml"
jq '.application_secret_names["worker-runtime-assets"] = .application_secret_names["api-runtime-assets"]' \
  "$delivery_file" > "$collapsed_delivery"
ruby -ryaml -e '
  value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: false)
  value.fetch("externalSecrets").fetch("workerRuntimeAssets")["name"] =
    value.fetch("externalSecrets").fetch("apiRuntimeAssets").fetch("name")
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$values_file" "$collapsed_values"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$collapsed_values" "$chart_defaults" slots-production "$collapsed_delivery" \
  >/dev/null 2>&1; then
  fail 'API 与 Worker 运行素材复用同一 Secret 未被拒绝'
fi

printf '%s\n' 'AWS 平台与应用 Secret 实时门禁负向 fixture 通过。'
