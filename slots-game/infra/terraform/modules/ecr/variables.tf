variable "name_prefix" {
  description = "ECR repository 名称前缀"
  type        = string
}

variable "kms_key_arn" {
  description = "ECR 静态加密 KMS key ARN"
  type        = string
}

variable "repository_names" {
  description = "应用交付仓库名称"
  type        = set(string)
  default     = ["rgs-runtime", "rgs-migrator", "web-runtime"]

  validation {
    condition = var.repository_names == toset([
      "rgs-runtime",
      "rgs-migrator",
      "web-runtime",
    ])
    error_message = "必须分别提供 rgs-runtime、rgs-migrator 和 web-runtime 三个仓库。"
  }
}

variable "untagged_retention_days" {
  description = "无标签制品最短保留天数"
  type        = number

  validation {
    condition     = var.untagged_retention_days >= 90
    error_message = "无标签制品至少保留 90 天，避免破坏发布回退。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
