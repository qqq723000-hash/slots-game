variable "name_prefix" {
  description = "KMS alias 名称前缀"
  type        = string
}

variable "deletion_window_in_days" {
  description = "KMS key 待删除保护窗口"
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_in_days >= 20 && var.deletion_window_in_days <= 30
    error_message = "KMS 删除保护窗口必须是 20 到 30 天。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
