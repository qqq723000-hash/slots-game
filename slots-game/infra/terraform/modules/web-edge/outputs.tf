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
