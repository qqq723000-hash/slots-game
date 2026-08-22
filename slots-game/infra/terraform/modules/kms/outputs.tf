output "key_arns" {
  description = "按用途索引的 KMS key ARN"
  value       = { for purpose, key in aws_kms_key.service : purpose => key.arn }
}

output "key_ids" {
  description = "按用途索引的 KMS key ID"
  value       = { for purpose, key in aws_kms_key.service : purpose => key.key_id }
}
