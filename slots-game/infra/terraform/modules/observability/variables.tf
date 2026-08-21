variable "name_prefix" {
  description = "可观测资源名称前缀"
  type        = string
}

variable "cluster_name" {
  description = "EKS 集群名称"
  type        = string
}

variable "cloudwatch_addon_version" {
  description = "经平台批准的 CloudWatch Observability EKS add-on 精确版本"
  type        = string

  validation {
    condition     = can(regex("^v[0-9]", var.cloudwatch_addon_version))
    error_message = "CloudWatch Observability add-on 必须使用 v 开头的精确版本。"
  }
}

variable "kms_key_arn" {
  description = "日志和 SNS 的 KMS key ARN"
  type        = string
}

variable "log_retention_days" {
  description = "应用与容器日志保留天数"
  type        = number
}

variable "alert_delivery_principal_arns" {
  description = "可以订阅告警 topic 的受控值班角色 ARN"
  type        = set(string)

  validation {
    condition = length(var.alert_delivery_principal_arns) > 0 && alltrue([
      for arn in var.alert_delivery_principal_arns : can(regex("^arn:(aws|aws-us-gov):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "至少提供一个有效的受控告警交付 IAM role ARN。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
