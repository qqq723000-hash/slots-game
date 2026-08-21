output "endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.this.address
}

output "port" {
  description = "RDS PostgreSQL port"
  value       = aws_db_instance.this.port
}

output "resource_id" {
  description = "RDS 资源 ID"
  value       = aws_db_instance.this.resource_id
}

output "master_user_secret_arn" {
  description = "RDS 托管管理员 Secret ARN，仅供受控 DBA 初始化使用"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  sensitive   = true
}

output "security_group_id" {
  description = "RDS 安全组 ID"
  value       = aws_security_group.this.id
}
