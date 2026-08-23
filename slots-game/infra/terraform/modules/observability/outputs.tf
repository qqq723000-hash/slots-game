output "alert_topic_arn" {
  description = "基础设施与应用告警 SNS topic ARN"
  value       = aws_sns_topic.alerts.arn
  depends_on  = [aws_sns_topic_policy.alerts]
}

output "amp_workspace_id" {
  description = "AMP workspace ID"
  value       = aws_prometheus_workspace.this.id
}

output "amp_remote_write_endpoint" {
  description = "AMP remote write endpoint"
  value       = aws_prometheus_workspace.this.prometheus_endpoint
}

output "amp_writer_role_arn" {
  description = "Prometheus Agent Pod Identity role ARN"
  value       = aws_iam_role.amp_writer.arn
}
