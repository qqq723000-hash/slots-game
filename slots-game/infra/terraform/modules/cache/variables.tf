variable "name_prefix" {
  description = "ElastiCache 资源名称前缀"
  type        = string
}

variable "environment" {
  description = "HMAC 静默证据绑定的部署环境"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.environment))
    error_message = "HMAC 静默证据环境必须是严格 DNS label。"
  }
}

variable "aws_account_id" {
  description = "HMAC 静默证据绑定的 AWS 账号"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "HMAC 静默证据 AWS 账号必须是 12 位数字。"
  }
}

variable "aws_region" {
  description = "HMAC 静默证据绑定的 AWS 区域"
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "HMAC 静默证据 AWS 区域不合法。"
  }
}

variable "eks_cluster_name" {
  description = "HMAC 静默证据绑定的 EKS 集群"
  type        = string

  validation {
    condition     = can(regex("^[0-9A-Za-z][0-9A-Za-z_-]{0,99}$", var.eks_cluster_name))
    error_message = "HMAC 静默证据 EKS 集群名不合法。"
  }
}

variable "application_namespace" {
  description = "HMAC 静默证据绑定的应用 namespace"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$", var.application_namespace))
    error_message = "应用 namespace 必须是不超过 63 字符的严格 DNS label。"
  }
}

variable "helm_release_name" {
  description = "HMAC 静默证据绑定的 Helm release"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$", var.helm_release_name))
    error_message = "Helm release 必须是不超过 53 字符的严格 DNS label。"
  }
}

variable "vpc_id" {
  description = "Valkey 所在 VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "三个应用私有子网 ID"
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) == 3
    error_message = "Valkey subnet group 必须覆盖三个应用私有子网。"
  }
}

variable "client_security_group_id" {
  description = "实际承载 RGS API Pod 的 EKS 工作负载安全组"
  type        = string
}

variable "kms_key_arn" {
  description = "Valkey 静态加密 KMS key ARN"
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "共享准入 Secret 使用的 KMS key ARN"
  type        = string
}

variable "valkey_active_slot" {
  description = "当前发布给新工作负载的 Valkey ACL 凭据槽位"
  type        = string

  validation {
    condition     = contains(["a", "b"], var.valkey_active_slot)
    error_message = "Valkey active slot 只能是 a 或 b。"
  }
}

variable "valkey_rotation_mode" {
  description = "Valkey 凭据变更模式；HMAC 维护与普通密码轮换互斥"
  type        = string

  validation {
    condition     = contains(["steady", "password-rotation", "hmac-maintenance"], var.valkey_rotation_mode)
    error_message = "Valkey rotation mode 只能是 steady、password-rotation 或 hmac-maintenance。"
  }
}

variable "valkey_password_a" {
  description = "Valkey A 槽 ACL 密码；只允许进入 provider write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      length(var.valkey_password_a) >= 32 &&
      length(var.valkey_password_a) <= 128 &&
      can(regex("^[!-~]+$", var.valkey_password_a)) &&
      !can(regex("[,\\\"/@]", var.valkey_password_a))
    )
    error_message = "Valkey A 槽密码必须为 32 到 128 个字符，且不得包含空白、逗号、双引号、斜杠或 @。"
  }
}

variable "valkey_password_b" {
  description = "Valkey B 槽 ACL 密码；只允许进入 provider write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      length(var.valkey_password_b) >= 32 &&
      length(var.valkey_password_b) <= 128 &&
      can(regex("^[!-~]+$", var.valkey_password_b)) &&
      !can(regex("[,\\\"/@]", var.valkey_password_b))
    )
    error_message = "Valkey B 槽密码必须为 32 到 128 个字符，且不得包含空白、逗号、双引号、斜杠或 @。"
  }
}

variable "valkey_password_fingerprint_a" {
  description = "A 槽密码规范字符串的 SHA-256；用于把 plan 状态机绑定到实际 ephemeral 值"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.valkey_password_fingerprint_a))
    error_message = "Valkey A 槽密码 fingerprint 必须是 64 位小写十六进制 SHA-256。"
  }
}

variable "valkey_password_fingerprint_b" {
  description = "B 槽密码规范字符串的 SHA-256；用于把 plan 状态机绑定到实际 ephemeral 值"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.valkey_password_fingerprint_b))
    error_message = "Valkey B 槽密码 fingerprint 必须是 64 位小写十六进制 SHA-256。"
  }
}

variable "valkey_password_version_a" {
  description = "A 槽 write-only 密码版本；仅在 A 槽已排空并获批后递增"
  type        = number

  validation {
    condition     = var.valkey_password_version_a >= 1 && floor(var.valkey_password_version_a) == var.valkey_password_version_a
    error_message = "Valkey A 槽密码版本必须为大于等于 1 的整数。"
  }
}

variable "valkey_password_version_b" {
  description = "B 槽 write-only 密码版本；仅在 B 槽已排空并获批后递增"
  type        = number

  validation {
    condition     = var.valkey_password_version_b >= 1 && floor(var.valkey_password_version_b) == var.valkey_password_version_b
    error_message = "Valkey B 槽密码版本必须为大于等于 1 的整数。"
  }
}

variable "valkey_password_reset_approvals" {
  description = "版本大于 1 的槽位密码重置证据；证明重置时另一槽已激活且旧连接已排空"
  type = map(object({
    approved_password_version    = number
    observed_active_slot         = string
    observed_secret_version      = number
    old_slot_connections_drained = bool
    hmac_key_unchanged           = bool
    live_evidence_reference      = string
  }))
  default = {}

  validation {
    condition = (
      length(setsubtract(toset(keys(var.valkey_password_reset_approvals)), toset(["a", "b"]))) == 0 &&
      alltrue([
        for slot, approval in var.valkey_password_reset_approvals :
        approval.approved_password_version >= 2 &&
        floor(approval.approved_password_version) == approval.approved_password_version &&
        contains(["a", "b"], approval.observed_active_slot) &&
        approval.observed_active_slot != slot &&
        approval.observed_secret_version >= 1 &&
        floor(approval.observed_secret_version) == approval.observed_secret_version &&
        approval.old_slot_connections_drained &&
        approval.hmac_key_unchanged &&
        can(regex("^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$", approval.live_evidence_reference))
      ])
    )
    error_message = "每份 Valkey 槽位重置批准都必须指向另一活动槽、已排空旧连接、确认 HMAC 未变并包含受控证据引用。"
  }
}

variable "valkey_hmac_maintenance_approval" {
  description = "HMAC 桶重置的独立停机维护批准；只引用受保护的版本化静默证据"
  type = object({
    bucket_reset_accepted = bool
    evidence_reference = object({
      bucket     = string
      key        = string
      version_id = string
      sha256     = string
    })
  })
  default  = null
  nullable = true

  validation {
    condition = try(
      var.valkey_hmac_maintenance_approval == null ? true : (
        var.valkey_hmac_maintenance_approval.bucket_reset_accepted &&
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.valkey_hmac_maintenance_approval.evidence_reference.bucket)) &&
        can(regex("^[A-Za-z0-9!_.*'()/=-][A-Za-z0-9!_.*'()/+=:@ -]{0,1022}$", var.valkey_hmac_maintenance_approval.evidence_reference.key)) &&
        can(regex("^[A-Za-z0-9._~+/=-]{1,1024}$", var.valkey_hmac_maintenance_approval.evidence_reference.version_id)) &&
        can(regex("^[0-9a-f]{64}$", var.valkey_hmac_maintenance_approval.evidence_reference.sha256))
      ),
      false,
    )
    error_message = "HMAC 维护批准必须接受桶重置，并精确引用受保护 S3 对象的 bucket、key、VersionId 和 SHA-256。"
  }
}

variable "shared_admission_hmac_key" {
  description = "共享准入 HMAC-SHA256 密钥的规范 Base64；只允许进入 provider write-only 参数"
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = try(
      length(base64decode(var.shared_admission_hmac_key)) == 32 &&
      base64encode(base64decode(var.shared_admission_hmac_key)) == var.shared_admission_hmac_key,
      false,
    )
    error_message = "共享准入 HMAC key 必须是 32 字节密钥的规范 Base64 编码。"
  }
}

variable "shared_admission_hmac_key_fingerprint" {
  description = "规范 Base64 HMAC key 字符串的 SHA-256；密码轮换状态机禁止其同时改变"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.shared_admission_hmac_key_fingerprint))
    error_message = "共享准入 HMAC fingerprint 必须是 64 位小写十六进制 SHA-256。"
  }
}

variable "valkey_root_ca_pem" {
  description = "RGS 显式校验 Valkey TLS 时使用的根证书 PEM；只写入受管 Secret"
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      startswith(trimspace(var.valkey_root_ca_pem), "-----BEGIN CERTIFICATE-----") &&
      endswith(trimspace(var.valkey_root_ca_pem), "-----END CERTIFICATE-----") &&
      length(var.valkey_root_ca_pem) <= 60000
    )
    error_message = "Valkey 根证书必须是完整且不超过 60000 字符的 PEM 证书。"
  }
}

variable "secret_version" {
  description = "共享准入不可变 Secret 版本；奇数发布 A 槽，偶数发布 B 槽"
  type        = number

  validation {
    condition     = var.secret_version >= 1 && floor(var.secret_version) == var.secret_version
    error_message = "共享准入 Secret 版本必须为大于等于 1 的整数。"
  }
}

variable "log_kms_key_arn" {
  description = "Valkey 日志 KMS key ARN"
  type        = string
}

variable "alert_topic_arn" {
  description = "Valkey 告警 SNS topic ARN"
  type        = string
}

variable "engine_version" {
  description = "支持 ACL 密码认证的 Valkey 精确 major.minor 版本"
  type        = string

  validation {
    condition     = can(regex("^(7\\.[2-9]|[89]\\.[0-9])$", var.engine_version))
    error_message = "Valkey ACL 基线要求 7.2 或更高 major.minor 版本。"
  }
}

variable "node_type" {
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
      var.valkey_alarm_thresholds.engine_cpu_utilization_percent <= 100
    )
    error_message = "Valkey 引擎 CPU 告警阈值必须大于 0 且不超过 100%。"
  }

  validation {
    condition = (
      var.valkey_alarm_thresholds.database_capacity_usage_counted_for_evict_percent > 0 &&
      var.valkey_alarm_thresholds.database_capacity_usage_counted_for_evict_percent < 100
    )
    error_message = "Valkey 可逐出容量告警阈值必须大于 0 且小于 100%。"
  }

  validation {
    condition = (
      var.valkey_alarm_thresholds.current_connections >= 1 &&
      var.valkey_alarm_thresholds.current_connections <= 1000000 &&
      floor(var.valkey_alarm_thresholds.current_connections) == var.valkey_alarm_thresholds.current_connections
    )
    error_message = "Valkey 连接数告警阈值必须是 1 到 1000000 的整数。"
  }

  validation {
    condition = (
      var.valkey_alarm_thresholds.replication_lag_seconds > 0 &&
      var.valkey_alarm_thresholds.replication_lag_seconds <= 60
    )
    error_message = "Valkey 复制延迟告警阈值必须大于 0 且不超过 60 秒。"
  }

  validation {
    condition = (
      var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds >= 1 &&
      var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds <= 1000000 &&
      floor(var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds) == var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds
    )
    error_message = "Valkey EVAL 命令延迟告警阈值必须是 1 到 1000000 微秒的整数。"
  }
}

variable "log_retention_days" {
  description = "Valkey engine/slow log 保留天数"
  type        = number
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
