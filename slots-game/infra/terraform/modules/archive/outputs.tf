output "bucket_name" {
  description = "RDS snapshot export 冷归档 bucket"
  value       = aws_s3_bucket.archive.id
}

output "kms_key_arn" {
  description = "RDS snapshot export 冷归档 KMS key ARN"
  value       = aws_kms_key.archive.arn
}

output "rds_export_role_arn" {
  description = "由独立归档作业传给 StartExportTask 的 IAM role ARN"
  value       = aws_iam_role.rds_export.arn
}
