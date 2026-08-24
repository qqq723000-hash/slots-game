output "cluster_name" {
  description = "EKS 集群名称"
  value       = aws_eks_cluster.this.name
}

output "cluster_arn" {
  description = "EKS 集群 ARN"
  value       = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  description = "EKS 私网 API endpoint"
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_ca_data" {
  description = "EKS CA 数据"
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}

output "cluster_security_group_id" {
  description = "EKS 集群安全组 ID"
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "cluster_autoscaler_role_arn" {
  description = "Cluster Autoscaler 专用 Pod Identity role ARN"
  value       = aws_iam_role.cluster_autoscaler.arn
}

output "cluster_autoscaler_inline_policy_name" {
  description = "实时门禁读取的 Cluster Autoscaler 最小内联策略名"
  value       = aws_iam_role_policy.cluster_autoscaler.name
}

output "vpc_cni_role_arn" {
  description = "vpc-cni aws-node 专用 Pod Identity role ARN"
  value       = aws_iam_role.vpc_cni.arn
}
