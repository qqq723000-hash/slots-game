output "web_acl_arn" {
  description = "必须精确绑定到公网 RGS ALB 的区域 WAFv2 Web ACL ARN"
  value       = aws_wafv2_web_acl.api.arn
}

output "web_acl_name" {
  description = "区域 API WAFv2 Web ACL 名称"
  value       = aws_wafv2_web_acl.api.name
}

output "web_acl_metric_name" {
  description = "AWS/WAFV2 CloudWatch WebACL 维度使用的 visibility metric name"
  value       = local.web_acl_metric
}

output "log_group_name" {
  description = "仅保留 BLOCK/COUNT 且已脱敏的 WAF 日志组"
  value       = aws_cloudwatch_log_group.waf.name
}

output "contract" {
  description = "应用发布与实时核验消费的 API DDoS 防护合同"
  value = {
    contract_version             = "1.0.0"
    authoritative_public_entry   = "internet-facing-alb"
    web_acl_arn                  = aws_wafv2_web_acl.api.arn
    web_acl_name                 = aws_wafv2_web_acl.api.name
    web_acl_metric_name          = local.web_acl_metric
    web_acl_scope                = "REGIONAL"
    default_action               = "ALLOW"
    shield_standard_automatic    = true
    cloudfront_is_api_proxy      = false
    origin_bypass_model          = "not-applicable-alb-is-authoritative-origin"
    body_inspection_limit_bytes  = 8192
    application_body_limit_bytes = 8192
    oversized_body_action        = "BLOCK_AT_WAF_AND_APPLICATION"
    public_health_path           = "/healthz"
    public_health_path_action    = "BLOCK_AT_WAF"
    alb_target_health_port       = 8081
    header_size_rule_rollout     = var.header_size_rule_rollout
    log_group_name               = aws_cloudwatch_log_group.waf.name
    log_filter                   = "BLOCK_AND_COUNT_ONLY"
    query_string_redacted        = true
    sampled_requests_enabled     = false
    evidence_kms_key_arn         = var.evidence_kms_key_arn
    required_managed_rule_groups = sort([for rule in values(local.managed_rules) : rule.name])
    required_size_rule_names     = ["body-size-limit", "header-size-limit"]
    required_path_rule_names     = ["public-healthz-block", "public-protocol-surface-block"]
    allowed_public_path_prefixes = ["/client/", "/operator/"]
    allowed_public_methods       = ["GET", "OPTIONS", "POST"]
    required_rate_rule_names     = ["launch-rate-limit", "public-api-rate-limit", "spin-rate-limit"]
    low_rate_rule_method         = "POST"
    public_rate_rule_methods     = ["GET", "OPTIONS", "POST"]
    rate_limit_response = {
      status_code                  = 429
      retry_after_seconds          = 30
      access_control_allow_origin  = "*"
      access_control_expose_header = "Retry-After, X-RGS-Edge-Error"
      edge_error_header            = "X-RGS-Edge-Error"
      edge_error_value             = "RATE_LIMITED"
    }
    rate_limits           = var.rate_limits
    rate_rule_rollouts    = var.rate_rule_rollouts
    managed_rule_rollout  = var.managed_rule_rollout
    managed_rule_versions = var.managed_rule_versions
    alarm_thresholds      = var.alarm_thresholds
    alarm_names = [
      aws_cloudwatch_metric_alarm.waf_allowed_requests.alarm_name,
      aws_cloudwatch_metric_alarm.waf_blocked_requests.alarm_name,
    ]
    cloudfront_api_proxy_optional   = true
    global_accelerator_optional     = true
    shield_advanced_optional        = true
    advanced_features_live_verified = false
  }
}
