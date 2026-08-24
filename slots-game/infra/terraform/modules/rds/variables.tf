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
    cpu_utilization_percent           = number
    database_connections              = number
    freeable_memory_bytes             = number
    free_storage_space_bytes          = number
    read_latency_seconds              = number
    write_latency_seconds             = number
    disk_queue_depth                  = number
    deadlocks_per_minute              = number
    total_iops_per_second             = number
    total_throughput_bytes_per_second = number
    swap_usage_bytes                  = number
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
      var.alarm_thresholds.disk_queue_depth <= 1000000 &&
      var.alarm_thresholds.deadlocks_per_minute == 1 &&
      var.alarm_thresholds.total_iops_per_second >= 1 &&
      var.alarm_thresholds.total_iops_per_second <= 1000000000 &&
      floor(var.alarm_thresholds.total_iops_per_second) == var.alarm_thresholds.total_iops_per_second &&
      var.alarm_thresholds.total_throughput_bytes_per_second >= 1 &&
      var.alarm_thresholds.total_throughput_bytes_per_second <= 1000000000000000 &&
      floor(var.alarm_thresholds.total_throughput_bytes_per_second) == var.alarm_thresholds.total_throughput_bytes_per_second &&
      var.alarm_thresholds.swap_usage_bytes >= 1048576 &&
      floor(var.alarm_thresholds.swap_usage_bytes) == var.alarm_thresholds.swap_usage_bytes
    )
    error_message = "RDS 告警阈值必须使用有效百分比、整数连接/总 IOPS/总吞吐字节预算、最多 60 秒的正延迟，并固定单次 deadlock 日志匹配即告警。"
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

variable "read_replica" {
  description = "同区域 PostgreSQL 只读副本的显式开关、容量和告警边界；关闭时不创建任何副本或副本告警"
  type = object({
    enabled        = bool
    instance_class = string
    multi_az       = bool
    alarm_thresholds = object({
      replica_lag_seconds      = number
      cpu_utilization_percent  = number
      database_connections     = number
      freeable_memory_bytes    = number
      free_storage_space_bytes = number
      read_latency_seconds     = number
      disk_queue_depth         = number
      swap_usage_bytes         = number
    })
  })

  default = {
    enabled        = false
    instance_class = "db.t4g.medium"
    multi_az       = false
    alarm_thresholds = {
      replica_lag_seconds      = 30
      cpu_utilization_percent  = 80
      database_connections     = 100
      freeable_memory_bytes    = 268435456
      free_storage_space_bytes = 10737418240
      read_latency_seconds     = 0.1
      disk_queue_depth         = 64
      swap_usage_bytes         = 268435456
    }
  }

  validation {
    condition = (
      !var.read_replica.enabled || (
        can(regex("^db\\.[a-z0-9]+[a-z0-9.-]*$", var.read_replica.instance_class)) &&
        var.read_replica.alarm_thresholds.replica_lag_seconds >= 1 &&
        var.read_replica.alarm_thresholds.replica_lag_seconds <= 3600 &&
        var.read_replica.alarm_thresholds.cpu_utilization_percent > 0 &&
        var.read_replica.alarm_thresholds.cpu_utilization_percent <= 100 &&
        var.read_replica.alarm_thresholds.database_connections >= 1 &&
        floor(var.read_replica.alarm_thresholds.database_connections) == var.read_replica.alarm_thresholds.database_connections &&
        var.read_replica.alarm_thresholds.freeable_memory_bytes >= 67108864 &&
        floor(var.read_replica.alarm_thresholds.freeable_memory_bytes) == var.read_replica.alarm_thresholds.freeable_memory_bytes &&
        var.read_replica.alarm_thresholds.free_storage_space_bytes >= 1073741824 &&
        floor(var.read_replica.alarm_thresholds.free_storage_space_bytes) == var.read_replica.alarm_thresholds.free_storage_space_bytes &&
        var.read_replica.alarm_thresholds.read_latency_seconds > 0 &&
        var.read_replica.alarm_thresholds.read_latency_seconds <= 60 &&
        var.read_replica.alarm_thresholds.disk_queue_depth > 0 &&
        var.read_replica.alarm_thresholds.disk_queue_depth <= 1000000 &&
        var.read_replica.alarm_thresholds.swap_usage_bytes >= 1048576 &&
        floor(var.read_replica.alarm_thresholds.swap_usage_bytes) == var.read_replica.alarm_thresholds.swap_usage_bytes
      )
    )
    error_message = "启用 RDS 只读副本时必须提供有效 db.* 实例类型，以及经容量评审的 ReplicaLag、CPU、连接、内存、存储、读取延迟、队列和 swap 阈值。"
  }
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
