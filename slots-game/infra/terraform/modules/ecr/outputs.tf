output "repository_urls" {
  description = "按组件索引的 ECR repository URL"
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "repository_arns" {
  description = "按组件索引的 ECR repository ARN"
  value       = { for name, repository in aws_ecr_repository.this : name => repository.arn }
}
