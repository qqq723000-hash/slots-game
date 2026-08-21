output "vault_arn" {
  description = "供跨区域复制使用的 Backup vault ARN"
  value       = aws_backup_vault.this.arn
}

output "plan_id" {
  description = "AWS Backup plan ID"
  value       = aws_backup_plan.this.id
}
