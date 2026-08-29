locals {
  valkey_parameter_group_families = {
    "7" = "valkey7"
    "8" = "valkey8"
    "9" = "valkey9"
  }
  valkey_engine_major           = split(".", var.engine_version)[0]
  valkey_parameter_group_family = local.valkey_parameter_group_families[local.valkey_engine_major]
  acl_user_ids = {
    a = "${replace(var.name_prefix, "-", "")}-rgs-a"
    b = "${replace(var.name_prefix, "-", "")}-rgs-b"
  }
  active_user_name = local.acl_user_ids[var.valkey_active_slot]
  active_password  = var.valkey_active_slot == "a" ? var.valkey_password_a : var.valkey_password_b
  password_versions = {
    a = var.valkey_password_version_a
    b = var.valkey_password_version_b
  }
  password_fingerprints = {
    a = var.valkey_password_fingerprint_a
    b = var.valkey_password_fingerprint_b
  }
  target_identity = {
    environment          = var.environment
    aws_account_id       = var.aws_account_id
    aws_region           = var.aws_region
    eks_cluster_name     = var.eks_cluster_name
    kubernetes_namespace = var.application_namespace
    helm_release_name    = var.helm_release_name
  }
  slots_requiring_reset_approval = toset([
    for slot, version in local.password_versions : slot if version > 1
  ])
  reset_approvals_complete = (
    local.slots_requiring_reset_approval == toset(keys(var.valkey_password_reset_approvals)) &&
    alltrue([
      for slot, version in local.password_versions :
      version == 1 || try(
        var.valkey_password_reset_approvals[slot].approved_password_version == version &&
        var.valkey_password_reset_approvals[slot].observed_secret_version <= var.secret_version,
        false,
      )
    ])
  )
}

resource "terraform_data" "rotation_guard" {
  input = {
    contract_version          = "1.0.0"
    active_slot               = var.valkey_active_slot
    rotation_mode             = var.valkey_rotation_mode
    password_versions         = local.password_versions
    password_fingerprints     = local.password_fingerprints
    reset_approvals           = var.valkey_password_reset_approvals
    published_secret_version  = var.secret_version
    hmac_key_fingerprint      = var.shared_admission_hmac_key_fingerprint
    hmac_maintenance_approval = var.valkey_hmac_maintenance_approval
    hmac_bucket_continuity    = "密码轮换期间禁止改变 HMAC key"
    target_identity           = local.target_identity
  }

  lifecycle {
    precondition {
      condition = (
        (var.valkey_active_slot == "a" && var.secret_version % 2 == 1) ||
        (var.valkey_active_slot == "b" && var.secret_version % 2 == 0)
      )
      error_message = "共享准入 Secret 版本必须按奇数 A、偶数 B 发布，确保切换活动槽必然创建新版本 Secret。"
    }

    precondition {
      condition     = local.reset_approvals_complete
      error_message = "每个密码版本大于 1 的槽位都必须有匹配版本的二阶段排空批准；不得在缺少 live evidence 时重置旧槽。"
    }

    precondition {
      condition = (
        (var.valkey_rotation_mode == "hmac-maintenance" && var.valkey_hmac_maintenance_approval != null) ||
        (var.valkey_rotation_mode != "hmac-maintenance" && var.valkey_hmac_maintenance_approval == null)
      )
      error_message = "HMAC 维护模式必须携带唯一版本化静默证据引用，其他模式禁止携带该批准。"
    }

    precondition {
      condition = (
        sha256(var.valkey_password_a) == var.valkey_password_fingerprint_a &&
        sha256(var.valkey_password_b) == var.valkey_password_fingerprint_b &&
        sha256(var.shared_admission_hmac_key) == var.shared_admission_hmac_key_fingerprint
      )
      error_message = "Valkey 密码或 HMAC 的受保护 fingerprint 与实际 ephemeral 值不一致。"
    }
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name_prefix}-valkey"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

# 共享/经济 token bucket 都带 TTL。任何 LRU/LFU 逐出都会把被删桶在下一次请求
# 重建为满额，形成内存压力下的准入 fail-open；noeviction 让写入显式 OOM，应用
# 将脚本错误映射为新经济意图 503 fail-closed，资金恢复读路径不依赖此缓存。
# English: Sharing/economic token buckets all have TTL. Any LRU/LFU eviction will cause the deleted bucket to be
# used in the next request Rebuild to full, causing admission fail-open under memory pressure; noeviction allows
# explicit OOM writes, application Map script errors to new economic intent 503 fail-closed, funds recovery read
# path does not rely on this cache.
resource "aws_elasticache_parameter_group" "noeviction" {
  name        = "${var.name_prefix}-valkey-noeviction"
  family      = local.valkey_parameter_group_family
  description = "RGS admission state must fail closed instead of resetting evicted token buckets"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = merge(var.tags, {
    AdmissionFailureMode = "fail-closed"
  })
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name_prefix}-valkey-"
  description = "共享身份限流 Valkey 私网入口"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-valkey" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "valkey" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.client_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "只接受实际 EKS 工作负载安全组"
}

resource "aws_cloudwatch_log_group" "engine" {
  name              = "/aws/elasticache/${var.name_prefix}/engine"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "slow" {
  name              = "/aws/elasticache/${var.name_prefix}/slow"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_elasticache_user" "rate_limiter_a" {
  user_id       = local.acl_user_ids.a
  user_name     = local.acl_user_ids.a
  engine        = "valkey"
  access_string = "on ~rgs:shared-admission:v2:* -@all +evalsha +eval +get +pttl +set +time +mset +pexpire +ping +hello +auth +client|setname +client|setinfo"
  passwords_wo  = var.valkey_password_a

  passwords_wo_version = var.valkey_password_version_a

  tags = var.tags

  depends_on = [terraform_data.rotation_guard]
}

resource "aws_elasticache_user" "rate_limiter_b" {
  user_id       = local.acl_user_ids.b
  user_name     = local.acl_user_ids.b
  engine        = "valkey"
  access_string = "on ~rgs:shared-admission:v2:* -@all +evalsha +eval +get +pttl +set +time +mset +pexpire +ping +hello +auth +client|setname +client|setinfo"
  passwords_wo  = var.valkey_password_b

  passwords_wo_version = var.valkey_password_version_b

  tags = var.tags

  depends_on = [terraform_data.rotation_guard]
}

resource "aws_secretsmanager_secret" "shared_admission" {
  name                    = "${var.name_prefix}-rgs-shared-admission-v${var.secret_version}"
  description             = "RGS 共享准入使用的 Valkey ACL、HMAC 与显式根证书；值通过 write-only 参数写入"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 30

  tags = merge(var.tags, {
    Boundary                = "rgs-shared-admission"
    ManagedValueByTerraform = "write-only"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "shared_admission" {
  secret_id = aws_secretsmanager_secret.shared_admission.id
  secret_string_wo = jsonencode({
    hmacKey  = var.shared_admission_hmac_key
    password = local.active_password
    rootCA   = var.valkey_root_ca_pem
    username = local.active_user_name
  })
  secret_string_wo_version = var.secret_version

  depends_on = [
    aws_elasticache_user.rate_limiter_a,
    aws_elasticache_user.rate_limiter_b,
    terraform_data.rotation_guard,
  ]
}

resource "aws_elasticache_user_group" "this" {
  engine        = "valkey"
  user_group_id = "${var.name_prefix}-valkey"
  user_ids = [
    aws_elasticache_user.rate_limiter_a.user_id,
    aws_elasticache_user.rate_limiter_b.user_id,
  ]
  tags = var.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name_prefix}-valkey"
  description          = "共享身份限流和可丢弃重复抑制；禁止作为资金幂等权威"

  engine               = "valkey"
  engine_version       = var.engine_version
  parameter_group_name = aws_elasticache_parameter_group.noeviction.name
  node_type            = var.node_type
  port                 = 6379

  num_cache_clusters         = 3
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]
  user_group_ids     = [aws_elasticache_user_group.this.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"

  auto_minor_version_upgrade = false
  apply_immediately          = false
  maintenance_window         = "sun:20:30-sun:21:30"
  snapshot_retention_limit   = 0

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = merge(var.tags, {
    AuthoritativeEconomicState = "false"
    DataClass                  = "discardable-control-state"
  })
}

resource "aws_cloudwatch_metric_alarm" "evictions" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-evictions"
  alarm_description   = "Valkey 出现逐出会削弱限流和重复抑制效果"
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "authentication_failures" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-authentication-failures"
  alarm_description   = "Valkey ACL 认证失败"
  namespace           = "AWS/ElastiCache"
  metric_name         = "AuthenticationFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "command_authorization_failures" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-command-authorization-failures"
  alarm_description   = "Valkey ACL 命令权限拒绝"
  namespace           = "AWS/ElastiCache"
  metric_name         = "CommandAuthorizationFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "key_authorization_failures" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-key-authorization-failures"
  alarm_description   = "Valkey ACL keyspace 权限拒绝"
  namespace           = "AWS/ElastiCache"
  metric_name         = "KeyAuthorizationFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "engine_cpu_utilization" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-engine-cpu-high"
  alarm_description   = "Valkey 引擎线程持续高负载；需扩容或降低共享准入脚本压力"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.valkey_alarm_thresholds.engine_cpu_utilization_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "database_capacity_usage" {
  alarm_name          = "${var.name_prefix}-valkey-database-capacity-high"
  alarm_description   = "Valkey 可逐出数据容量持续逼近上限；需扩容并检查 TTL 和流量基数"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseCapacityUsageCountedForEvictPercentage"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.valkey_alarm_thresholds.database_capacity_usage_counted_for_evict_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.this.id
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "current_connections" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-connections-high"
  alarm_description   = "Valkey 当前连接数持续超出经容量评审的客户端连接预算"
  namespace           = "AWS/ElastiCache"
  metric_name         = "CurrConnections"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.valkey_alarm_thresholds.current_connections
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "traffic_management_active" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-traffic-management-active"
  alarm_description   = "ElastiCache 持续主动整形 Valkey 流量，表明节点无法及时处理进入的命令"
  namespace           = "AWS/ElastiCache"
  metric_name         = "TrafficManagementActive"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "replication_lag" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-replication-lag-high"
  alarm_description   = "Valkey 只读副本持续落后；三个固定节点都建告警以覆盖自动故障转移后的角色变化"
  namespace           = "AWS/ElastiCache"
  metric_name         = "ReplicationLag"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.valkey_alarm_thresholds.replication_lag_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "eval_command_latency" {
  count = 3

  alarm_name          = "${var.name_prefix}-valkey-${format("%03d", count.index + 1)}-eval-latency-high"
  alarm_description   = "共享准入 EVAL/EVALSHA 命令平均延迟持续超出容量预算"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EvalBasedCmdsLatency"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.valkey_alarm_thresholds.eval_based_commands_latency_microseconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    CacheClusterId = "${aws_elasticache_replication_group.this.id}-${format("%03d", count.index + 1)}"
    CacheNodeId    = "0001"
  }

  tags = var.tags
}
