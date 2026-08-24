#!/usr/bin/env ruby

# Read-only verifier for every WAF rule promoted from Count to Block. It fetches the exact
# versioned S3 object, checks its content digest, and validates that the approved observation
# is bound to the current Web ACL and rule configuration. It never prints evidence contents.

require "digest"
require "json"
require "open3"
require "tempfile"
require "time"
require "uri"

SCHEMA_VERSION = "slots-game/waf-rollout-evidence/v1"
MAX_EVIDENCE_BYTES = 256 * 1024
MIN_OBSERVATION_SECONDS = 7 * 24 * 60 * 60
MAX_EVIDENCE_VALIDITY_SECONDS = 30 * 24 * 60 * 60
MIN_EVALUATED_REQUESTS = 1_000
MIN_LEGITIMATE_SURVIVAL_RATE = 0.999
MAX_FALSE_POSITIVE_RATE = 0.001

def canonical(value)
  case value
  when Hash
    value.keys.sort.to_h { |key| [key, canonical(value.fetch(key))] }
  when Array
    value.map { |item| canonical(item) }
  else
    value
  end
end

def configuration_sha256(value)
  Digest::SHA256.hexdigest(JSON.generate(canonical(value)))
end

def controls_for(delivery)
  api = delivery.fetch("api_edge_security_contract")
  web = delivery.fetch("cloudfront_edge_security_contract")
  controls = {}

  controls["api-managed-rules"] = {
    "rollout" => api.fetch("managed_rule_rollout"),
    "web_acl_arn" => api.fetch("web_acl_arn"),
    "configuration" => {
      "scope" => "REGIONAL",
      "managed_rule_groups" => api.fetch("required_managed_rule_groups").sort,
      "managed_rule_versions" => api.fetch("managed_rule_versions").sort.to_h,
    },
    "required_review" => "managed_rule_versions_reviewed",
    "rule_names" => %w[amazon-ip-reputation common known-bad-inputs sqli],
  }
  controls["api-header-size-limit"] = {
    "rollout" => api.fetch("header_size_rule_rollout"),
    "web_acl_arn" => api.fetch("web_acl_arn"),
    "configuration" => {
      "scope" => "REGIONAL",
      "rule_name" => "header-size-limit",
      "aggregate_size_bytes" => 8192,
      "oversize_handling" => "MATCH",
    },
    "required_review" => "header_envelope_reviewed",
    "rule_names" => ["header-size-limit"],
  }
  api_rate_scopes = {
    "launch-rate-limit" => {"match" => "EXACTLY", "method" => "POST", "paths" => ["/operator/v1/launches"]},
    "spin-rate-limit" => {"match" => "EXACTLY", "method" => "POST", "paths" => ["/client/v1/spins"]},
    "public-api-rate-limit" => {
      "match" => "STARTS_WITH",
      "methods" => api.fetch("public_rate_rule_methods"),
      "paths" => ["/client/", "/operator/"],
    },
  }
  api_rate_limits = {
    "launch-rate-limit" => api.fetch("rate_limits").fetch("launch_requests_per_minute"),
    "spin-rate-limit" => api.fetch("rate_limits").fetch("spin_requests_per_minute"),
    "public-api-rate-limit" => api.fetch("rate_limits").fetch("public_requests_per_minute"),
  }
  api.fetch("rate_rule_rollouts").each do |rule_name, rollout|
    controls["api-rate:#{rule_name}"] = {
      "rollout" => rollout,
      "web_acl_arn" => api.fetch("web_acl_arn"),
      "configuration" => {
        "scope" => "REGIONAL",
        "rule_name" => rule_name,
        "aggregate_key_type" => "IP",
        "evaluation_window_seconds" => 60,
        "limit" => api_rate_limits.fetch(rule_name),
        "path_scope" => api_rate_scopes.fetch(rule_name),
        "block_response" => api.fetch("rate_limit_response"),
      },
      "required_review" => "nat_cgnat_reviewed",
      "rule_names" => [rule_name],
    }
  end
  controls["web-managed-rules"] = {
    "rollout" => web.fetch("managed_rule_rollout"),
    "web_acl_arn" => web.fetch("web_acl_arn"),
    "configuration" => {
      "scope" => "CLOUDFRONT",
      "managed_rule_groups" => web.fetch("required_managed_rule_groups").sort,
      "managed_rule_versions" => web.fetch("managed_rule_versions").sort.to_h,
    },
    "required_review" => "managed_rule_versions_reviewed",
    "rule_names" => %w[amazon-ip-reputation common known-bad-inputs],
  }
  controls["web-rate:web-rate-limit"] = {
    "rollout" => web.fetch("rate_rule_rollout"),
    "web_acl_arn" => web.fetch("web_acl_arn"),
    "configuration" => {
      "scope" => "CLOUDFRONT",
      "rule_name" => "web-rate-limit",
      "aggregate_key_type" => "IP",
      "evaluation_window_seconds" => 60,
      "limit" => web.fetch("rate_limit_per_minute"),
    },
    "required_review" => "nat_cgnat_reviewed",
    "rule_names" => ["web-rate-limit"],
  }

  controls.each do |control_id, control|
    edge = control_id.start_with?("web-") ? web : api
    evidence_kms_key_arn = edge.fetch("evidence_kms_key_arn")
    abort "#{control_id} evidence KMS key ARN 不合法" unless
      evidence_kms_key_arn.match?(%r{\Aarn:(aws|aws-us-gov):kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}\z})
    control["evidence_kms_key_arn"] = evidence_kms_key_arn
    control.fetch("configuration")["evidence_storage"] = {
      "kms_key_arn" => evidence_kms_key_arn,
      "object_lock_mode" => "COMPLIANCE",
    }
    control["configuration_sha256"] = configuration_sha256(control.fetch("configuration"))
  end
  controls
end

def terraform_plan_rollouts(plan)
  configuration = plan.fetch("variables").fetch("configuration").fetch("value")
  rollouts = {
    "api-managed-rules" => configuration.fetch("api_waf_managed_rule_rollout"),
    "api-header-size-limit" => configuration.fetch("api_waf_header_size_rule_rollout"),
    "web-managed-rules" => configuration.fetch("cloudfront_waf_managed_rule_rollout"),
    "web-rate:web-rate-limit" => configuration.fetch("cloudfront_waf_rate_rule_rollout"),
  }
  configuration.fetch("api_waf_rate_rule_rollouts").each do |rule_name, rollout|
    rollouts["api-rate:#{rule_name}"] = rollout
  end
  abort "Terraform plan 的 WAF rollout 控制集合不完整" unless rollouts.keys.sort == %w[
    api-header-size-limit
    api-managed-rules
    api-rate:launch-rate-limit
    api-rate:public-api-rate-limit
    api-rate:spin-rate-limit
    web-managed-rules
    web-rate:web-rate-limit
  ].sort
  rollouts.each do |control_id, rollout|
    abort "#{control_id} Terraform plan rollout action 不合法" unless
      rollout.is_a?(Hash) && %w[block count].include?(rollout.fetch("action", nil))
  end
  rollouts
end

def delivery_from_terraform_plan(plan, planned_rollouts)
  # First-time Count-only deployments can contain provider-computed output values. They need no
  # promotion evidence. Any requested Block must have a fully materialized delivery contract so
  # evidence is bound to the exact Web ACL, thresholds, paths and rule names before apply.
  return [nil, []] unless planned_rollouts.values.any? { |rollout| rollout.fetch("action") == "block" }

  delivery = plan.dig("planned_values", "outputs", "delivery", "value")
  abort "Block Terraform plan 缺少完整 planned delivery，拒绝在 apply 前跳过证据绑定" unless delivery.is_a?(Hash)
  delivery_rollouts = controls_for(delivery).transform_values { |control| control.fetch("rollout") }
  abort "Terraform plan 变量与 planned delivery 的 WAF rollout 不一致" unless
    delivery_rollouts == planned_rollouts

  # Approval validity is a promotion gate, not a lease on an already-approved Block rule. A
  # steady Block keeps rechecking the exact immutable object, digest, schema and configuration,
  # but an unrelated apply must not fail forever after the original 30-day approval expires.
  # Any Count→Block transition, evidence-reference replacement or bound configuration change
  # still requires a currently valid approval tied to this protected infrastructure source SHA.
  previous_delivery = plan.dig("output_changes", "delivery", "before") ||
    plan.dig("prior_state", "values", "outputs", "delivery", "value")
  if previous_delivery.is_a?(Hash)
    previous_controls = controls_for(previous_delivery)
    current_controls = controls_for(delivery)
    require_current = current_controls.each_with_object([]) do |(control_id, current), result|
      next unless current.fetch("rollout").fetch("action") == "block"
      previous = previous_controls[control_id]
      result << control_id unless
        previous && previous.fetch("rollout").fetch("action") == "block" &&
          previous.fetch("rollout").fetch("evidence_reference") == current.fetch("rollout").fetch("evidence_reference") &&
          previous.fetch("configuration_sha256") == current.fetch("configuration_sha256")
    end
  else
    require_current = controls_for(delivery).each_with_object([]) do |(control_id, control), result|
      result << control_id if control.fetch("rollout").fetch("action") == "block"
    end
  end
  [delivery, require_current]
end

def exact_keys!(value, keys, label)
  abort "#{label} 字段集合不符合证据 schema" unless value.is_a?(Hash) && value.keys.sort == keys.sort
end

def parse_time!(value, label)
  Time.iso8601(value)
rescue ArgumentError, TypeError
  abort "#{label} 不是 RFC3339 时间"
end

def parse_reference!(reference)
  uri = URI.parse(reference)
  abort "Block 证据引用不是 versioned S3 URI" unless uri.scheme == "s3" && uri.host && !uri.host.empty?
  parameters = URI.decode_www_form(uri.query.to_s).to_h
  version_id = parameters.fetch("versionId", "")
  digest = uri.fragment.to_s
  key = URI::DEFAULT_PARSER.unescape(uri.path.sub(%r{\A/}, ""))
  abort "Block 证据 S3 key、versionId 或 SHA-256 不合法" unless
    !key.empty? && version_id.match?(/\A[A-Za-z0-9._~+\/=\-]{1,1024}\z/) && digest.match?(/\A[0-9a-f]{64}\z/)
  [uri.host, key, version_id, digest]
rescue URI::InvalidURIError
  abort "Block 证据引用不是合法 URI"
end

def aws_json!(aws_binary, arguments, label)
  stdout, _stderr, status = Open3.capture3(aws_binary, *arguments)
  abort "#{label} 无法通过只读 AWS API 验证" unless status.success?
  JSON.parse(stdout)
rescue JSON::ParserError
  abort "#{label} 的 AWS 响应不是 JSON"
end

def validate_evidence!(evidence, delivery, control_id, control, expected_source_commit, retain_until,
                       require_current_approval:)
  exact_keys!(evidence, %w[
    schema_version environment web_acl_arn control_id rule_names proposed_action
    configuration_sha256 source_commit_sha observation reviews approvals rollback expires_at
  ], control_id)
  abort "#{control_id} 证据未绑定当前环境、Web ACL 或配置" unless
    evidence.fetch("schema_version") == SCHEMA_VERSION &&
      evidence.fetch("environment") == delivery.fetch("environment") &&
      evidence.fetch("web_acl_arn") == control.fetch("web_acl_arn") &&
      evidence.fetch("control_id") == control_id &&
      evidence.fetch("rule_names") == control.fetch("rule_names") &&
      evidence.fetch("proposed_action") == "block" &&
      evidence.fetch("configuration_sha256") == control.fetch("configuration_sha256") &&
      (expected_source_commit ? evidence.fetch("source_commit_sha") == expected_source_commit :
        evidence.fetch("source_commit_sha").match?(/\A[0-9a-f]{40}\z/))

  observation = evidence.fetch("observation")
  exact_keys!(observation, %w[
    started_at ended_at evaluated_requests matched_requests false_positive_requests
    legitimate_survival_rate origin_capacity_headroom_percent
  ], "#{control_id}.observation")
  started_at = parse_time!(observation.fetch("started_at"), "#{control_id}.observation.started_at")
  ended_at = parse_time!(observation.fetch("ended_at"), "#{control_id}.observation.ended_at")
  expires_at = parse_time!(evidence.fetch("expires_at"), "#{control_id}.expires_at")
  now = Time.now.utc
  abort "#{control_id} 观测窗口不足七天、尚未结束或原始证据有效期不合法" unless
    ended_at - started_at >= MIN_OBSERVATION_SECONDS && ended_at <= now &&
      expires_at > ended_at && expires_at - ended_at <= MAX_EVIDENCE_VALIDITY_SECONDS
  abort "#{control_id} 晋级或配置变更使用了已过期证据" if require_current_approval && expires_at <= now
  abort "#{control_id} Object Lock 保留期短于证据有效期" unless retain_until >= expires_at

  evaluated = observation.fetch("evaluated_requests")
  matched = observation.fetch("matched_requests")
  false_positives = observation.fetch("false_positive_requests")
  survival = observation.fetch("legitimate_survival_rate")
  headroom = observation.fetch("origin_capacity_headroom_percent")
  abort "#{control_id} 观测样本或误杀指标不满足 Block 最低门禁" unless
    evaluated.is_a?(Integer) && evaluated >= MIN_EVALUATED_REQUESTS &&
      matched.is_a?(Integer) && matched >= 0 && matched <= evaluated &&
      false_positives.is_a?(Integer) && false_positives >= 0 && false_positives <= matched &&
      false_positives.fdiv(evaluated) <= MAX_FALSE_POSITIVE_RATE &&
      survival.is_a?(Numeric) && survival >= MIN_LEGITIMATE_SURVIVAL_RATE && survival <= 1 &&
      headroom.is_a?(Numeric) && headroom > 0 && headroom <= 100

  reviews = evidence.fetch("reviews")
  exact_keys!(reviews, %w[
    normal_peak_observed planned_peak_or_equivalent_observed nat_cgnat_reviewed
    header_envelope_reviewed managed_rule_versions_reviewed
  ], "#{control_id}.reviews")
  abort "#{control_id} 缺少正常峰值、活动峰值或规则专属评审" unless
    reviews.fetch("normal_peak_observed") == true &&
      reviews.fetch("planned_peak_or_equivalent_observed") == true &&
      reviews.fetch(control.fetch("required_review")) == true

  approvals = evidence.fetch("approvals")
  abort "#{control_id} 必须有两个不同审批主体" unless approvals.is_a?(Array) && approvals.length >= 2
  principals = approvals.map.with_index do |approval, index|
    exact_keys!(approval, %w[principal approved_at change_id], "#{control_id}.approvals[#{index}]")
    approved_at = parse_time!(approval.fetch("approved_at"), "#{control_id}.approvals[#{index}].approved_at")
    abort "#{control_id} 审批早于观测结束或审批标识为空" unless
      approved_at >= ended_at && !approval.fetch("principal").to_s.empty? && !approval.fetch("change_id").to_s.empty?
    approval.fetch("principal")
  end
  abort "#{control_id} 审批主体重复" unless principals.uniq.length == principals.length

  rollback = evidence.fetch("rollback")
  exact_keys!(rollback, %w[owner trigger runbook], "#{control_id}.rollback")
  abort "#{control_id} 回滚 owner、trigger 或 HTTPS runbook 缺失" unless
    !rollback.fetch("owner").to_s.empty? && !rollback.fetch("trigger").to_s.empty? &&
      rollback.fetch("runbook").to_s.match?(%r{\Ahttps://[^\s]+\z})
end

if ARGV.first == "--configuration-sha256"
  ARGV.shift
  delivery = JSON.parse(File.binread(ARGV.fetch(0)))
  control = controls_for(delivery).fetch(ARGV.fetch(1))
  puts control.fetch("configuration_sha256")
  exit 0
end

if ARGV.first == "--terraform-plan"
  terraform_plan_mode = true
  ARGV.shift
  aws_binary, aws_region, expected_source_commit = ARGV
  abort "用法: terraform show -json <plan> | verify-waf-rollout-evidence.rb --terraform-plan <aws-bin> <region> <source-commit-sha>" unless
    aws_binary && aws_region && expected_source_commit
  plan = JSON.parse(STDIN.read)
  planned_rollouts = terraform_plan_rollouts(plan)
  delivery, require_current_controls = delivery_from_terraform_plan(plan, planned_rollouts)
  exit 0 unless delivery
else
  terraform_plan_mode = false
  delivery_path, aws_binary, aws_region, expected_source_commit = ARGV
  abort "用法: verify-waf-rollout-evidence.rb <delivery.json> <aws-bin> <region> [source-commit-sha]" unless
    delivery_path && aws_binary && aws_region
  delivery = JSON.parse(File.binread(delivery_path))
  require_current_controls = []
end

controls_for(delivery).each do |control_id, control|
  rollout = control.fetch("rollout")
  next unless rollout.fetch("action") == "block"

  require_current_approval = require_current_controls.include?(control_id)
  control_source_commit = terraform_plan_mode && !require_current_approval ? nil : expected_source_commit
  abort "Block evidence 缺少受保护部署源码 commit 绑定" unless
    control_source_commit.nil? || control_source_commit.to_s.match?(/\A[0-9a-f]{40}\z/)

  bucket, key, version_id, expected_digest = parse_reference!(rollout.fetch("evidence_reference"))
  common_arguments = [
    "--bucket", bucket,
    "--key", key,
    "--version-id", version_id,
    "--region", aws_region,
    "--no-cli-pager",
    "--output", "json",
  ]
  head = aws_json!(aws_binary, ["s3api", "head-object", *common_arguments], "#{control_id} evidence head")
  abort "#{control_id} evidence version 或大小不满足" unless
    head.fetch("VersionId", "") == version_id &&
      head.fetch("ContentLength", MAX_EVIDENCE_BYTES + 1).between?(1, MAX_EVIDENCE_BYTES)
  retain_until = parse_time!(head.fetch("ObjectLockRetainUntilDate", nil), "#{control_id}.ObjectLockRetainUntilDate")
  abort "#{control_id} evidence 未使用批准 KMS key 或 COMPLIANCE Object Lock" unless
    head.fetch("ServerSideEncryption", nil) == "aws:kms" &&
      head.fetch("SSEKMSKeyId", nil) == control.fetch("evidence_kms_key_arn") &&
      head.fetch("ObjectLockMode", nil) == "COMPLIANCE"

  Tempfile.create(["slots-waf-evidence", ".json"]) do |file|
    file.close
    get = aws_json!(aws_binary, [
      "s3api", "get-object", *common_arguments, file.path,
    ], "#{control_id} evidence get")
    abort "#{control_id} evidence get 返回了错误对象版本" unless get.fetch("VersionId", "") == version_id
    abort "#{control_id} evidence 下载大小超过上限" unless File.size(file.path).between?(1, MAX_EVIDENCE_BYTES)
    actual_digest = Digest::SHA256.file(file.path).hexdigest
    abort "#{control_id} evidence 内容 SHA-256 不匹配" unless actual_digest == expected_digest
    evidence = JSON.parse(File.binread(file.path))
    validate_evidence!(
      evidence, delivery, control_id, control, control_source_commit, retain_until,
      require_current_approval: require_current_approval
    )
  rescue JSON::ParserError
    abort "#{control_id} evidence 内容不是 JSON"
  end
end
