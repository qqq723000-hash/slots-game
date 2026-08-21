output "secret_arns" {
  description = "按职责索引的 Secret ARN"
  value       = { for boundary, secret in aws_secretsmanager_secret.application : boundary => secret.arn }
}

output "secret_names" {
  description = "写入 Helm values 的版本化 Secret 名称"
  value       = { for boundary, secret in aws_secretsmanager_secret.application : boundary => secret.name }
}

output "sync_role_arn" {
  description = "Secret 同步控制器 Pod Identity role ARN"
  value       = aws_iam_role.controller.arn
}
