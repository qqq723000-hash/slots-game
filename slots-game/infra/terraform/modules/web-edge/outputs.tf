output "bucket_name" {
  description = "不可变 Web release 私有 bucket 名称"
  value       = aws_s3_bucket.web.id
}

output "kms_key_arn" {
  description = "Web release KMS key ARN"
  value       = aws_kms_key.web.arn
}

output "distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.web.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.web.arn
}

output "distribution_domain_name" {
  description = "CloudFront distribution 域名"
  value       = aws_cloudfront_distribution.web.domain_name
}

output "alias_domain_name" {
  description = "CloudFront distribution 唯一受保护 alias"
  value       = var.domain_name
}

output "acm_certificate_arn" {
  description = "CloudFront viewer certificate 的 us-east-1 ACM ARN"
  value       = var.acm_certificate_arn
}

output "origin_access_control_id" {
  description = "私有 Web S3 origin 的精确 OAC ID"
  value       = aws_cloudfront_origin_access_control.web.id
}

output "cache_policy_id" {
  description = "默认与不可变 release behavior 共用的精确 Cache Policy ID"
  value       = aws_cloudfront_cache_policy.immutable_release.id
}

output "log_bucket_domain_name" {
  description = "CloudFront access log 精确 bucket domain"
  value       = aws_s3_bucket.logs.bucket_domain_name
}

output "log_prefix" {
  description = "CloudFront access log 精确环境前缀"
  value       = "cloudfront/"
}

output "waf_web_acl_arn" {
  description = "CloudFront distribution 绑定的采用方 global WAFv2 Web ACL ARN"
  value       = var.waf_web_acl_arn
}

output "edge_security_contract" {
  description = "CloudFront 静态 Web 边缘的外部 WAF 与抗 DDoS 验收合同"
  value = {
    contract_version             = "1.0.0"
    authoritative_public_entry   = "cloudfront"
    origin_type                  = "private-s3-oac"
    origin_public_access_blocked = true
    api_proxy                    = false
    viewer_http_version          = "http2and3"
    web_acl_arn                  = var.waf_web_acl_arn
    web_acl_scope                = "CLOUDFRONT"
    waf_ownership                = "enterprise-platform"
    waf_home_region              = "us-east-1"
    waf_log_group_name           = var.waf_log_group_name
    waf_log_filter               = "BLOCK_AND_COUNT_ONLY"
    query_string_redacted        = true
    sampled_requests_enabled     = false
    web_acl_metric_name          = replace("${var.name_prefix}-web", "-", "_")
    rule_metric_names = {
      amazon-ip-reputation = "${replace("${var.name_prefix}-web", "-", "_")}_amazon_ip_reputation"
      common               = "${replace("${var.name_prefix}-web", "-", "_")}_common"
      known-bad-inputs     = "${replace("${var.name_prefix}-web", "-", "_")}_known_bad_inputs"
      web-rate-limit       = "${replace("${var.name_prefix}-web", "-", "_")}_web_rate"
    }
    evidence_kms_key_arn  = var.waf_evidence_kms_key_arn
    rate_limit_per_minute = var.waf_rate_limit_per_minute
    required_managed_rule_groups = [
      "AWSManagedRulesAmazonIpReputationList",
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
    ]
    required_rate_rule_names        = ["web-rate-limit"]
    rate_rule_rollout               = var.waf_rate_rule_rollout
    managed_rule_rollout            = var.waf_managed_rule_rollout
    managed_rule_versions           = var.waf_managed_rule_versions
    shield_standard_automatic       = true
    shield_advanced_optional        = true
    route53_alias_ownership         = "enterprise-platform"
    route53_health_live_verified    = false
    advanced_features_live_verified = false
  }
}

output "response_headers_policy_id" {
  description = "与发布 CSP 绑定的 Response Headers Policy ID"
  value       = aws_cloudfront_response_headers_policy.security.id
}

output "release_key_value_store_arn" {
  description = "受保护发布流水线原子更新 active-release 的 CloudFront KeyValueStore ARN"
  value       = aws_cloudfront_key_value_store.release_router.arn
}

output "release_request_function_arn" {
  description = "执行浏览器 release 固定的 CloudFront Function ARN"
  value       = aws_cloudfront_function.release_request.arn
}

output "release_request_function_name" {
  description = "发布门禁验证 LIVE 状态时使用的 CloudFront Function 名称"
  value       = aws_cloudfront_function.release_request.name
}

output "release_response_function_arn" {
  description = "设置固定 release cookie 的 viewer-response CloudFront Function ARN"
  value       = aws_cloudfront_function.release_response.arn
}

output "release_response_function_name" {
  description = "viewer-response CloudFront Function 精确名称"
  value       = aws_cloudfront_function.release_response.name
}
