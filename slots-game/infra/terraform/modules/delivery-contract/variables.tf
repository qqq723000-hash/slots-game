variable "contract_version" {
  description = "外部运行环境接口版本"
  type        = string

  validation {
    condition     = var.contract_version == "1.0.0"
    error_message = "只接受外部运行环境接口 1.0.0。"
  }
}

variable "project_name" {
  description = "资源名称前缀"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.project_name))
    error_message = "project_name 必须是 3 到 20 位小写字母、数字或连字符。"
  }
}

variable "environment" {
  description = "受支持的环境名称"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod-primary", "prod-dr"], var.environment)
    error_message = "environment 必须是 dev、staging、prod-primary 或 prod-dr。"
  }
}

variable "expected_account_id" {
  description = "Provider 必须匹配的 AWS 账号 ID"
  type        = string

  validation {
    condition = can(regex("^[0-9]{12}$", var.expected_account_id)) && !contains([
      "000000000000",
      "111111111111",
      "123456789012",
    ], var.expected_account_id)
    error_message = "expected_account_id 必须是真实的 12 位账号 ID，示例账号会被拒绝。"
  }
}

variable "aws_region" {
  description = "环境所在 AWS 区域"
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region 必须是有效的 AWS 区域名称。"
  }
}

variable "availability_zones" {
  description = "三个明确且互不重复的可用区"
  type        = list(string)

  validation {
    condition = length(var.availability_zones) == 3 && length(distinct(var.availability_zones)) == 3 && alltrue([
      for zone in var.availability_zones : can(regex("^${var.aws_region}[a-z]$", zone))
    ])
    error_message = "availability_zones 必须是目标区域内三个不同可用区。"
  }
}

variable "cluster_admin_principal_arns" {
  description = "获得 EKS 管理访问条目的受保护角色 ARN"
  type        = set(string)

  validation {
    condition = length(var.cluster_admin_principal_arns) > 0 && alltrue([
      for arn in var.cluster_admin_principal_arns : can(regex("^arn:(aws|aws-us-gov):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "至少提供一个 IAM role ARN，禁止用户 ARN、账号 root 或空集合。"
  }
}

variable "backup_copy_destination_vault_arn" {
  description = "主生产区域复制到灾备区域的 Backup vault ARN"
  type        = string
  default     = ""

  validation {
    condition = var.environment != "prod-primary" || (
      can(regex(
        "^arn:(aws|aws-us-gov):backup:[a-z0-9-]+:[0-9]{12}:backup-vault:[A-Za-z0-9_-]+$",
        var.backup_copy_destination_vault_arn,
      )) &&
      try(split(":", var.backup_copy_destination_vault_arn)[3] != var.aws_region, false)
    )
    error_message = "prod-primary 必须配置有效的跨区域 Backup vault ARN。"
  }
}
