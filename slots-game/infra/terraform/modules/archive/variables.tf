variable "name_prefix" {
  description = "冷归档资源名称前缀"
  type        = string
}

variable "bucket_name" {
  description = "全局唯一的冷归档 S3 bucket 名称"
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) &&
      !startswith(var.bucket_name, "replace-")
    )
    error_message = "archive bucket 必须是真实、全局唯一且非占位的 S3 名称。"
  }
}

variable "governance_retention_days" {
  description = "对象锁治理模式默认保留天数"
  type        = number

  validation {
    condition     = var.governance_retention_days >= 365
    error_message = "冷归档默认保留期至少为 365 天。"
  }
}

variable "deep_archive_after_days" {
  description = "转入 S3 Deep Archive 前的天数"
  type        = number

  validation {
    condition     = var.deep_archive_after_days >= 90
    error_message = "至少保留 90 天后才能转入 Deep Archive。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
