variable "name_prefix" {
  description = "应用 Secret 名称前缀"
  type        = string
}

variable "aws_account_id" {
  description = "构造版本化 shared-admission Secret ARN 边界的 AWS 账号"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "AWS 账号必须是 12 位数字。"
  }
}

variable "aws_region" {
  description = "构造版本化 shared-admission Secret ARN 边界的 AWS 区域"
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "AWS 区域格式不合法。"
  }
}

variable "kms_key_arn" {
  description = "Secrets Manager KMS key ARN"
  type        = string
}

variable "cluster_name" {
  description = "Secret 同步控制器所在 EKS 集群"
  type        = string
}

variable "secret_versions" {
  description = "五个职责隔离应用 Secret 的不可变名称版本"
  type        = map(number)

  validation {
    condition = (
      toset(keys(var.secret_versions)) == toset([
        "api-runtime-assets",
        "migrator-database",
        "operations-bearer",
        "runtime-database",
        "worker-runtime-assets",
      ]) &&
      alltrue([
        for version in values(var.secret_versions) :
        version >= 1 && floor(version) == version
      ])
    )
    error_message = "必须为五个应用 Secret 提供大于等于 1 的整数版本。"
  }
}

variable "controller_namespace" {
  description = "Secret 同步控制器 namespace"
  type        = string
  default     = "external-secrets"
}

variable "controller_service_account" {
  description = "Secret 同步控制器 ServiceAccount"
  type        = string
  default     = "external-secrets"
}

variable "recovery_window_in_days" {
  description = "Secret 删除恢复窗口"
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_in_days == 30
    error_message = "正式基线固定使用 30 天 Secret 删除恢复窗口。"
  }
}

variable "shared_admission_secret_name_prefix" {
  description = "允许 Secret 同步控制器读取的 shared-admission 不可变版本名称前缀"
  type        = string

  validation {
    condition = (
      length(var.shared_admission_secret_name_prefix) <= 500 &&
      can(regex("^[A-Za-z0-9/_+=.@-]+-rgs-shared-admission$", var.shared_admission_secret_name_prefix))
    )
    error_message = "shared-admission Secret 名称前缀必须固定以 -rgs-shared-admission 结尾。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
