variable "name_prefix" {
  description = "AWS Backup 资源名称前缀"
  type        = string
}

variable "kms_key_arn" {
  description = "Backup vault KMS key ARN"
  type        = string
}

variable "alert_topic_arn" {
  description = "备份事件告警 SNS topic ARN"
  type        = string
}

variable "retention_days" {
  description = "恢复点保留天数"
  type        = number

  validation {
    condition     = var.retention_days >= 35
    error_message = "备份恢复点至少保留 35 天。"
  }
}

variable "enable_vault_lock" {
  description = "是否启用不可逆转的 Backup Vault Lock 合规倒计时"
  type        = bool
}

variable "vault_lock_changeable_for_days" {
  description = "Vault Lock 进入不可变状态前的复核窗口"
  type        = number
  default     = 7

  validation {
    condition     = var.vault_lock_changeable_for_days >= 3
    error_message = "Vault Lock 复核窗口至少为 3 天。"
  }
}

variable "copy_destination_vault_arn" {
  description = "可选跨区域或跨账号目标 vault ARN"
  type        = string
  default     = ""
}

variable "copy_source_account_ids" {
  description = "允许向本 vault 复制恢复点的源账号 ID"
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for account_id in var.copy_source_account_ids : can(regex("^[0-9]{12}$", account_id)) && account_id != "123456789012"
    ])
    error_message = "跨账号复制源必须是非示例的 12 位账号 ID。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
