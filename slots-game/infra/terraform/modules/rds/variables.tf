variable "name_prefix" {
  description = "RDS 资源名称前缀"
  type        = string
}

variable "vpc_id" {
  description = "RDS 所在 VPC ID"
  type        = string
}

variable "data_subnet_ids" {
  description = "三个隔离数据子网 ID"
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) == 3
    error_message = "RDS subnet group 必须覆盖三个数据子网。"
  }
}

variable "client_security_group_id" {
  description = "允许连接 PostgreSQL 的 EKS 安全组 ID"
  type        = string
}

variable "kms_key_arn" {
  description = "RDS 存储和托管主密码的 KMS key ARN"
  type        = string
}

variable "log_kms_key_arn" {
  description = "RDS 导出日志使用的 CloudWatch KMS key ARN"
  type        = string
}

variable "alert_topic_arn" {
  description = "RDS 事件告警 SNS topic ARN"
  type        = string
}

variable "engine_version" {
  description = "经批准的 PostgreSQL 精确引擎版本"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+$", var.engine_version))
    error_message = "engine_version 必须是精确的 PostgreSQL major.minor 版本。"
  }
}

variable "parameter_group_family" {
  description = "与引擎主版本匹配的参数组 family"
  type        = string
}

variable "instance_class" {
  description = "RDS 实例类型"
  type        = string
}

variable "allocated_storage_gib" {
  description = "RDS 初始存储容量"
  type        = number

  validation {
    condition     = var.allocated_storage_gib >= 20 && floor(var.allocated_storage_gib) == var.allocated_storage_gib
    error_message = "RDS 初始存储容量必须是大于等于 20 GiB 的整数。"
  }
}

variable "max_allocated_storage_gib" {
  description = "RDS 自动扩容上限"
  type        = number

  validation {
    condition     = var.max_allocated_storage_gib <= 65536 && floor(var.max_allocated_storage_gib) == var.max_allocated_storage_gib
    error_message = "RDS 自动扩容上限必须是不超过 65536 GiB 的整数。"
  }
}

variable "alarm_thresholds" {
  description = "经容量测试批准的 RDS CloudWatch 告警阈值"
  type = object({
    cpu_utilization_percent  = number
    database_connections     = number
    freeable_memory_bytes    = number
    free_storage_space_bytes = number
    read_latency_seconds     = number
    write_latency_seconds    = number
    disk_queue_depth         = number
  })

  validation {
    condition = (
      var.alarm_thresholds.cpu_utilization_percent > 0 &&
      var.alarm_thresholds.cpu_utilization_percent <= 100 &&
      var.alarm_thresholds.database_connections >= 1 &&
      var.alarm_thresholds.database_connections <= 1000000 &&
      floor(var.alarm_thresholds.database_connections) == var.alarm_thresholds.database_connections &&
      var.alarm_thresholds.freeable_memory_bytes >= 67108864 &&
      floor(var.alarm_thresholds.freeable_memory_bytes) == var.alarm_thresholds.freeable_memory_bytes &&
      var.alarm_thresholds.free_storage_space_bytes >= 1073741824 &&
      floor(var.alarm_thresholds.free_storage_space_bytes) == var.alarm_thresholds.free_storage_space_bytes &&
      var.alarm_thresholds.read_latency_seconds > 0 &&
      var.alarm_thresholds.read_latency_seconds <= 60 &&
      var.alarm_thresholds.write_latency_seconds > 0 &&
      var.alarm_thresholds.write_latency_seconds <= 60 &&
      var.alarm_thresholds.disk_queue_depth > 0 &&
      var.alarm_thresholds.disk_queue_depth <= 1000000
    )
    error_message = "RDS 告警阈值必须使用有效百分比、正整数连接/字节预算，以及最多 60 秒的正延迟阈值。"
  }
}

variable "multi_az" {
  description = "是否启用 Multi-AZ DB instance"
  type        = bool
}

variable "backup_retention_days" {
  description = "RDS PITR 备份保留天数"
  type        = number

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35 && floor(var.backup_retention_days) == var.backup_retention_days
    error_message = "RDS PITR 保留期必须是 7 到 35 天的整数。"
  }
}

variable "deletion_protection" {
  description = "是否开启 RDS 删除保护"
  type        = bool
}

variable "log_retention_days" {
  description = "RDS 导出日志保留天数"
  type        = number
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
