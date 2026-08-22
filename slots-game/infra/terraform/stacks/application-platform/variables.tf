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

variable "valkey_engine_version" {
  description = "Valkey 精确 major.minor 版本"
  type        = string
}

variable "valkey_node_type" {
  description = "Valkey 节点类型"
  type        = string
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

variable "cloudfront_waf_web_acl_arn" {
  description = "CloudFront WAFv2 Web ACL ARN"
  type        = string
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
