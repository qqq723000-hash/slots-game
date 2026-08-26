variable "contract_version" {
  description = "企业落地区接口版本"
  type        = string
  default     = "1.0.0"
}

variable "project_name" {
  description = "应用资源前缀"
  type        = string
  default     = "slots"
}

variable "environment" {
  description = "环境名称"
  type        = string
}

variable "expected_account_id" {
  description = "目标 AWS 账号 ID"
  type        = string
}

variable "aws_region" {
  description = "目标 AWS 区域"
  type        = string
}

variable "application_namespace" {
  description = "应用 Helm release 所在 namespace；同时用于绑定 HMAC 静默证据"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$", var.application_namespace))
    error_message = "application_namespace 必须是不超过 63 字符的严格 DNS label。"
  }
}

variable "helm_release_name" {
  description = "应用 Helm release 名；同时用于绑定 HMAC 静默证据"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$", var.helm_release_name))
    error_message = "helm_release_name 必须是不超过 53 字符的严格 DNS label。"
  }
}

variable "availability_zones" {
  description = "三个明确可用区"
  type        = list(string)
}

variable "vpc_cidr" {
  description = "应用 VPC CIDR"
  type        = string
}

variable "public_subnet_cidrs" {
  description = "三个公网入口子网 CIDR"
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "三个 EKS 私有子网 CIDR"
  type        = list(string)
}

variable "data_subnet_cidrs" {
  description = "三个 RDS 隔离子网 CIDR"
  type        = list(string)
}

variable "edge_ingress_cidrs" {
  description = "公网 ALB 入口来源 CIDR"
  type        = list(string)
}

variable "enable_nat_gateway_per_az" {
  description = "是否每个可用区建立独立 NAT Gateway"
  type        = bool
}

variable "cluster_admin_principal_arns" {
  description = "EKS 管理角色 ARN"
  type        = set(string)
}

variable "alert_delivery_principal_arns" {
  description = "值班告警交付角色 ARN"
  type        = set(string)
}

variable "kubernetes_version" {
  description = "经批准的 EKS Kubernetes 次版本"
  type        = string
}

variable "eks_addon_versions" {
  description = "经批准的 EKS add-on 精确版本"
  type        = map(string)
}

variable "platform_addon_versions" {
  description = "由私网平台流水线安装的集群组件精确版本；prometheus-agent 表示 Prometheus 二进制版本"
  type        = map(string)

  validation {
    condition = (
      length(setsubtract(
        toset(keys(var.platform_addon_versions)),
        toset([
          "aws-load-balancer-controller",
          "cluster-autoscaler",
          "external-secrets",
          "kube-prometheus-stack",
          "prometheus-agent",
        ])
      )) == 0 &&
      length(setsubtract(
        toset([
          "aws-load-balancer-controller",
          "cluster-autoscaler",
          "external-secrets",
          "kube-prometheus-stack",
          "prometheus-agent",
        ]),
        toset(keys(var.platform_addon_versions))
      )) == 0 &&
      alltrue([
        for version in values(var.platform_addon_versions) :
        can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$", version))
      ])
    )
    error_message = "必须为五个集群 add-on 提供不含范围符号的精确 SemVer。"
  }
}

variable "cluster_autoscaler_image_tag" {
  description = "Cluster Autoscaler 精确镜像版本，Kubernetes 主次版本必须一致"
  type        = string

  validation {
    condition     = can(regex("^v1\\.[0-9]{2}\\.[0-9]+$", var.cluster_autoscaler_image_tag))
    error_message = "cluster_autoscaler_image_tag 必须是 v1.xx.patch 精确版本。"
  }
}

variable "node_instance_types" {
  description = "EKS 节点实例类型"
  type        = list(string)
}

variable "node_min_size" {
  description = "EKS 节点最小容量"
  type        = number
}

variable "node_desired_size" {
  description = "EKS 节点期望容量"
  type        = number
}

variable "node_max_size" {
  description = "EKS 节点最大容量"
  type        = number
}

variable "node_volume_size_gib" {
  description = "EKS 节点根卷容量"
  type        = number
}

variable "rds_engine_version" {
  description = "PostgreSQL 精确版本"
  type        = string
}

variable "rds_parameter_group_family" {
  description = "PostgreSQL 参数组 family"
  type        = string
}

variable "rds_instance_class" {
  description = "RDS 实例类型"
  type        = string
}

variable "rds_allocated_storage_gib" {
  description = "RDS 初始存储容量"
  type        = number
}

variable "rds_max_allocated_storage_gib" {
  description = "RDS 自动扩容上限"
  type        = number
}

variable "rds_multi_az" {
  description = "是否启用 RDS Multi-AZ"
  type        = bool
}

variable "rds_deletion_protection" {
  description = "是否启用 RDS 删除保护"
  type        = bool
}

variable "rds_backup_retention_days" {
  description = "RDS PITR 保留天数"
  type        = number
}

variable "rds_read_replica" {
  description = "默认关闭的同区域 PostgreSQL 只读副本及独立容量告警配置"
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
}

variable "rds_alarm_thresholds" {
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
      var.rds_alarm_thresholds.cpu_utilization_percent > 0 &&
      var.rds_alarm_thresholds.cpu_utilization_percent <= 100 &&
      var.rds_alarm_thresholds.database_connections >= 1 &&
      var.rds_alarm_thresholds.database_connections <= 1000000 &&
      floor(var.rds_alarm_thresholds.database_connections) == var.rds_alarm_thresholds.database_connections &&
      var.rds_alarm_thresholds.freeable_memory_bytes >= 67108864 &&
      floor(var.rds_alarm_thresholds.freeable_memory_bytes) == var.rds_alarm_thresholds.freeable_memory_bytes &&
      var.rds_alarm_thresholds.free_storage_space_bytes >= 1073741824 &&
      floor(var.rds_alarm_thresholds.free_storage_space_bytes) == var.rds_alarm_thresholds.free_storage_space_bytes &&
      var.rds_alarm_thresholds.read_latency_seconds > 0 &&
      var.rds_alarm_thresholds.read_latency_seconds <= 60 &&
      var.rds_alarm_thresholds.write_latency_seconds > 0 &&
      var.rds_alarm_thresholds.write_latency_seconds <= 60 &&
      var.rds_alarm_thresholds.disk_queue_depth > 0 &&
      var.rds_alarm_thresholds.disk_queue_depth <= 1000000 &&
      var.rds_alarm_thresholds.deadlocks_per_minute == 1 &&
      var.rds_alarm_thresholds.total_iops_per_second >= 1 &&
      var.rds_alarm_thresholds.total_iops_per_second <= 1000000000 &&
      floor(var.rds_alarm_thresholds.total_iops_per_second) == var.rds_alarm_thresholds.total_iops_per_second &&
      var.rds_alarm_thresholds.total_throughput_bytes_per_second >= 1 &&
      var.rds_alarm_thresholds.total_throughput_bytes_per_second <= 1000000000000000 &&
      floor(var.rds_alarm_thresholds.total_throughput_bytes_per_second) == var.rds_alarm_thresholds.total_throughput_bytes_per_second &&
      var.rds_alarm_thresholds.swap_usage_bytes >= 1048576 &&
      floor(var.rds_alarm_thresholds.swap_usage_bytes) == var.rds_alarm_thresholds.swap_usage_bytes
    )
    error_message = "RDS 告警阈值必须使用有效百分比、整数连接/总 IOPS/总吞吐字节预算、最多 60 秒的正延迟，并固定单次 deadlock 日志匹配即告警。"
  }
}

variable "valkey_engine_version" {
  description = "Valkey 精确 major.minor 版本"
  type        = string
}

variable "valkey_node_type" {
  description = "Valkey 节点类型"
  type        = string
}

variable "valkey_alarm_thresholds" {
  description = "经容量测试批准的 Valkey CloudWatch 告警阈值；延迟单位分别为秒和微秒"
  type = object({
    engine_cpu_utilization_percent                    = number
    database_capacity_usage_counted_for_evict_percent = number
    current_connections                               = number
    replication_lag_seconds                           = number
    eval_based_commands_latency_microseconds          = number
  })

  validation {
    condition = (
      var.valkey_alarm_thresholds.engine_cpu_utilization_percent > 0 &&
      var.valkey_alarm_thresholds.engine_cpu_utilization_percent <= 100 &&
      var.valkey_alarm_thresholds.database_capacity_usage_counted_for_evict_percent > 0 &&
      var.valkey_alarm_thresholds.database_capacity_usage_counted_for_evict_percent < 100 &&
      var.valkey_alarm_thresholds.current_connections >= 1 &&
      var.valkey_alarm_thresholds.current_connections <= 1000000 &&
      floor(var.valkey_alarm_thresholds.current_connections) == var.valkey_alarm_thresholds.current_connections &&
      var.valkey_alarm_thresholds.replication_lag_seconds > 0 &&
      var.valkey_alarm_thresholds.replication_lag_seconds <= 60 &&
      var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds >= 1 &&
      var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds <= 1000000 &&
      floor(var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds) == var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds
    )
    error_message = "Valkey 告警阈值必须使用有效百分比、正整数连接预算、最多 60 秒复制延迟及最多 1000000 微秒 EVAL 延迟。"
  }
}

variable "valkey_active_slot" {
  description = "当前发布给新工作负载的 Valkey ACL 凭据槽位"
  type        = string
}

variable "valkey_rotation_mode" {
  description = "Valkey 密码轮换、稳定态或独立 HMAC 停机维护模式"
  type        = string
}

variable "valkey_password_a" {
  description = "Valkey A 槽 ACL 密码；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_password_b" {
  description = "Valkey B 槽 ACL 密码；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_password_fingerprint_a" {
  description = "Valkey A 槽实际 ephemeral 密码字符串的 SHA-256"
  type        = string
}

variable "valkey_password_fingerprint_b" {
  description = "Valkey B 槽实际 ephemeral 密码字符串的 SHA-256"
  type        = string
}

variable "valkey_password_version_a" {
  description = "Valkey A 槽 write-only 密码版本"
  type        = number
}

variable "valkey_password_version_b" {
  description = "Valkey B 槽 write-only 密码版本"
  type        = number
}

variable "valkey_password_reset_approvals" {
  description = "版本大于 1 的 Valkey 槽位重置批准与 live evidence"
  type = map(object({
    approved_password_version    = number
    observed_active_slot         = string
    observed_secret_version      = number
    old_slot_connections_drained = bool
    hmac_key_unchanged           = bool
    live_evidence_reference      = string
  }))
}

variable "valkey_hmac_maintenance_approval" {
  description = "共享准入 HMAC 桶重置的独立停机维护批准"
  type = object({
    bucket_reset_accepted = bool
    evidence_reference = object({
      bucket     = string
      key        = string
      version_id = string
      sha256     = string
    })
  })
  nullable = true
}

variable "shared_admission_hmac_key" {
  description = "共享准入 HMAC key；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "shared_admission_hmac_key_fingerprint" {
  description = "共享准入实际 ephemeral HMAC Base64 字符串的 SHA-256"
  type        = string
}

variable "valkey_root_ca_pem" {
  description = "Valkey TLS 根证书 PEM；仅透传至 write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_secret_version" {
  description = "共享准入不可变 Secret 版本；奇数发布 A 槽，偶数发布 B 槽"
  type        = number
}

variable "application_secret_versions" {
  description = "五个职责隔离应用 Secret 的不可变名称版本"
  type        = map(number)
}

variable "api_waf_rate_limits" {
  description = "公网 API 区域 WAF 每来源 IP 的一分钟初始限额"
  type = object({
    public_requests_per_minute = number
    spin_requests_per_minute   = number
    launch_requests_per_minute = number
  })
}

variable "api_waf_alarm_thresholds" {
  description = "公网 API WAF 一分钟攻击量与成本异常阈值"
  type = object({
    blocked_requests_per_minute = number
    allowed_requests_per_minute = number
  })
}

variable "api_waf_rate_rule_rollouts" {
  description = "API regional WAF 三条按来源 IP rate rule 的 Count→Block 状态"
  type = map(object({
    action             = string
    evidence_reference = string
  }))
}

variable "api_waf_header_size_rule_rollout" {
  description = "API regional WAF 8 KiB aggregate header rule 的 Count→Block 状态"
  type = object({
    action             = string
    evidence_reference = string
  })
}

variable "api_waf_managed_rule_rollout" {
  description = "API regional WAF managed rules 的 Count→Block 发布状态"
  type = object({
    action             = string
    evidence_reference = string
  })
}

variable "api_waf_managed_rule_versions" {
  description = "API regional WAF managed rule group 精确版本"
  type        = map(string)
}

variable "waf_rollout_evidence_kms_key_arn" {
  description = "API 与 CloudFront WAF Block 晋级证据的批准 KMS key ARN"
  type        = string
}

variable "web_bucket_name" {
  description = "Web release bucket 名称"
  type        = string
}

variable "cloudfront_log_bucket_name" {
  description = "CloudFront 访问日志 bucket 名称"
  type        = string
}

variable "web_domain_name" {
  description = "Web 正式域名"
  type        = string
}

variable "cloudfront_acm_certificate_arn" {
  description = "CloudFront ACM certificate ARN"
  type        = string
}

variable "regional_acm_certificate_arn" {
  description = "公网 API ALB HTTPS listener 使用的区域 ACM certificate ARN"
  type        = string
}

variable "alb_access_log_bucket_name" {
  description = "企业落地区批准的 ALB access log S3 bucket 名称；legacy ALB 日志使用 SSE-S3"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.alb_access_log_bucket_name))
    error_message = "ALB access log bucket 名称不合法。"
  }
}

variable "alb_access_log_prefix" {
  description = "当前环境独占的 ALB access log S3 prefix"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9/_-]{1,127}$", var.alb_access_log_prefix))
    error_message = "ALB access log prefix 必须是 2-128 字符的规范环境路径。"
  }
}

variable "cloudfront_waf_web_acl_arn" {
  description = "CloudFront WAFv2 Web ACL ARN"
  type        = string
}

variable "cloudfront_waf_rate_limit_per_minute" {
  description = "CloudFront global WAF 每来源 IP 一分钟请求限额"
  type        = number
}

variable "cloudfront_waf_log_group_name" {
  description = "CloudFront global WAF 在 us-east-1 的日志组名"
  type        = string
}

variable "cloudfront_waf_rate_rule_rollout" {
  description = "CloudFront global WAF 按来源 IP rate rule 的 Count→Block 状态"
  type = object({
    action             = string
    evidence_reference = string
  })
}

variable "cloudfront_waf_managed_rule_rollout" {
  description = "CloudFront global WAF managed rules 的 Count→Block 企业交接状态"
  type = object({
    action             = string
    evidence_reference = string
  })
}

variable "cloudfront_waf_managed_rule_versions" {
  description = "CloudFront global WAF managed rule group 精确版本"
  type        = map(string)
}

variable "web_content_security_policy" {
  description = "从已验证 Web 制品提取的 CSP"
  type        = string
}

variable "cloudfront_price_class" {
  description = "CloudFront 价格等级"
  type        = string
}

variable "archive_bucket_name" {
  description = "RDS 冷归档 bucket 名称"
  type        = string
}

variable "archive_retention_days" {
  description = "冷归档对象锁默认保留天数"
  type        = number
}

variable "archive_deep_after_days" {
  description = "转入 Deep Archive 前的天数"
  type        = number
}

variable "backup_retention_days" {
  description = "AWS Backup 恢复点保留天数"
  type        = number
}

variable "backup_enable_vault_lock" {
  description = "是否启用 Backup Vault Lock"
  type        = bool
}

variable "backup_vault_lock_changeable_for_days" {
  description = "Vault Lock 进入不可变状态前的复核天数"
  type        = number
}

variable "backup_copy_destination_vault_arn" {
  description = "跨区域或跨账号 Backup vault ARN"
  type        = string
  default     = ""
}

variable "backup_copy_source_account_ids" {
  description = "允许复制到本 vault 的源账号 ID"
  type        = set(string)
  default     = []
}

variable "ecr_untagged_retention_days" {
  description = "无标签 OCI 制品保留天数"
  type        = number
}

variable "log_retention_days" {
  description = "CloudWatch 运行日志保留天数"
  type        = number

  validation {
    condition = contains([
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
    ], var.log_retention_days)
    error_message = "CloudWatch 日志保留期必须是 AWS 支持的明确天数。"
  }
}

variable "cloudfront_log_retention_days" {
  description = "CloudFront 访问日志保留天数"
  type        = number

  validation {
    condition     = var.cloudfront_log_retention_days >= 90 && floor(var.cloudfront_log_retention_days) == var.cloudfront_log_retention_days
    error_message = "CloudFront 访问日志至少保留 90 天。"
  }
}

variable "additional_tags" {
  description = "平台附加标签"
  type        = map(string)
  default     = {}
}
