data "aws_partition" "current" {}

locals {
  identifier        = "${var.name_prefix}-postgresql"
  reader_identifier = "${var.name_prefix}-postgresql-reader"
  log_exports = toset([
    "postgresql",
    "upgrade",
  ])
  deadlock_filter_name      = "${var.name_prefix}-postgresql-deadlock-detected"
  deadlock_filter_pattern   = "\"deadlock detected\""
  deadlock_metric_namespace = "Slots/RDSLogEvents"
  deadlock_metric_name      = "${var.name_prefix}-postgresql-deadlock-detected"
  capacity_high_alarm_metrics = {
    cpu = {
      suffix      = "cpu-high"
      description = "RDS CPU 持续高负载；需检查慢查询、锁竞争和实例容量"
      metric_name = "CPUUtilization"
      statistic   = "Average"
      unit        = "Percent"
      threshold   = var.alarm_thresholds.cpu_utilization_percent
    }
    connections = {
      suffix      = "connections-high"
      description = "RDS 连接数持续超出经容量评审的应用与运维总预算"
      metric_name = "DatabaseConnections"
      statistic   = "Maximum"
      unit        = "Count"
      threshold   = var.alarm_thresholds.database_connections
    }
    read_latency = {
      suffix      = "read-latency-high"
      description = "RDS 平均读取延迟持续超出经压测批准的阈值"
      metric_name = "ReadLatency"
      statistic   = "Average"
      unit        = "Seconds"
      threshold   = var.alarm_thresholds.read_latency_seconds
    }
    write_latency = {
      suffix      = "write-latency-high"
      description = "RDS 平均写入延迟持续超出经压测批准的阈值"
      metric_name = "WriteLatency"
      statistic   = "Average"
      unit        = "Seconds"
      threshold   = var.alarm_thresholds.write_latency_seconds
    }
    disk_queue = {
      suffix      = "disk-queue-high"
      description = "RDS 磁盘队列持续堆积；需检查 IOPS、吞吐和写放大"
      metric_name = "DiskQueueDepth"
      statistic   = "Maximum"
      unit        = "Count"
      threshold   = var.alarm_thresholds.disk_queue_depth
    }
    swap_usage = {
      suffix      = "swap-usage-high"
      description = "RDS SwapUsage 持续超出内存容量评审阈值；需关联 FreeableMemory 与负载"
      metric_name = "SwapUsage"
      statistic   = "Maximum"
      unit        = "Bytes"
      threshold   = var.alarm_thresholds.swap_usage_bytes
    }
  }
  capacity_low_alarm_metrics = {
    freeable_memory = {
      suffix      = "freeable-memory-low"
      description = "RDS 可用内存持续低于经容量评审的安全余量"
      metric_name = "FreeableMemory"
      statistic   = "Minimum"
      unit        = "Bytes"
      threshold   = var.alarm_thresholds.freeable_memory_bytes
    }
    free_storage = {
      suffix      = "free-storage-low"
      description = "RDS 可用存储持续低于安全余量；自动扩容不能替代人工容量处置"
      metric_name = "FreeStorageSpace"
      statistic   = "Minimum"
      unit        = "Bytes"
      threshold   = var.alarm_thresholds.free_storage_space_bytes
    }
  }
  reader_capacity_high_alarm_metrics = {
    cpu = {
      suffix      = "cpu-high"
      description = "RDS PostgreSQL 只读副本 CPU 持续高负载；需限制分析查询或扩容"
      metric_name = "CPUUtilization"
      statistic   = "Average"
      unit        = "Percent"
      threshold   = var.read_replica.alarm_thresholds.cpu_utilization_percent
    }
    connections = {
      suffix      = "connections-high"
      description = "RDS PostgreSQL 只读副本连接数持续超出独立容量预算"
      metric_name = "DatabaseConnections"
      statistic   = "Maximum"
      unit        = "Count"
      threshold   = var.read_replica.alarm_thresholds.database_connections
    }
    read_latency = {
      suffix      = "read-latency-high"
      description = "RDS PostgreSQL 只读副本读取延迟持续超出经压测批准的阈值"
      metric_name = "ReadLatency"
      statistic   = "Average"
      unit        = "Seconds"
      threshold   = var.read_replica.alarm_thresholds.read_latency_seconds
    }
    disk_queue = {
      suffix      = "disk-queue-high"
      description = "RDS PostgreSQL 只读副本磁盘队列持续堆积"
      metric_name = "DiskQueueDepth"
      statistic   = "Maximum"
      unit        = "Count"
      threshold   = var.read_replica.alarm_thresholds.disk_queue_depth
    }
    swap_usage = {
      suffix      = "swap-usage-high"
      description = "RDS PostgreSQL 只读副本 SwapUsage 持续超出独立容量预算"
      metric_name = "SwapUsage"
      statistic   = "Maximum"
      unit        = "Bytes"
      threshold   = var.read_replica.alarm_thresholds.swap_usage_bytes
    }
  }
  reader_capacity_low_alarm_metrics = {
    freeable_memory = {
      suffix      = "freeable-memory-low"
      description = "RDS PostgreSQL 只读副本可用内存持续低于安全余量"
      metric_name = "FreeableMemory"
      statistic   = "Minimum"
      unit        = "Bytes"
      threshold   = var.read_replica.alarm_thresholds.freeable_memory_bytes
    }
    free_storage = {
      suffix      = "free-storage-low"
      description = "RDS PostgreSQL 只读副本可用存储持续低于安全余量"
      metric_name = "FreeStorageSpace"
      statistic   = "Minimum"
      unit        = "Bytes"
      threshold   = var.read_replica.alarm_thresholds.free_storage_space_bytes
    }
  }
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-postgresql"
  subnet_ids = var.data_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name_prefix}-postgresql" })
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name_prefix}-postgresql-"
  description = "RGS PostgreSQL 私网入口"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-postgresql" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "postgresql" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.client_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "只接受 EKS 集群工作负载"
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name_prefix}-postgresql-"
  family      = var.parameter_group_family
  description = "Slots RGS PostgreSQL 安全与审计参数"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "this" {
  for_each = local.log_exports

  name              = "/aws/rds/instance/${local.identifier}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "reader" {
  for_each = var.read_replica.enabled ? local.log_exports : toset([])

  name              = "/aws/rds/instance/${local.reader_identifier}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = var.tags
}

# RDS PostgreSQL DB instance 不发布 AWS/RDS Deadlocks 指标；必须从已导出的 PostgreSQL 日志派生。
# 这里只把受控的精确错误短语转换为低基数自定义 Count 指标。
resource "aws_cloudwatch_log_metric_filter" "deadlocks" {
  name           = local.deadlock_filter_name
  log_group_name = aws_cloudwatch_log_group.this["postgresql"].name
  pattern        = local.deadlock_filter_pattern

  metric_transformation {
    name          = local.deadlock_metric_name
    namespace     = local.deadlock_metric_namespace
    value         = "1"
    default_value = 0
    unit          = "Count"
  }
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${var.name_prefix}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier = local.identifier

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  db_name        = "rgs"
  username       = "rgs_admin"
  port           = 5432

  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  allocated_storage     = var.allocated_storage_gib
  max_allocated_storage = var.max_allocated_storage_gib
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  publicly_accessible    = false
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name

  backup_retention_period = var.backup_retention_days
  backup_window           = "18:00-19:00"
  maintenance_window      = "sun:19:30-sun:20:30"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade          = false
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name_prefix}-postgresql-final"
  iam_database_authentication_enabled = true

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.monitoring.arn

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = sort(tolist(local.log_exports))

  tags = merge(var.tags, {
    Name               = "${var.name_prefix}-postgresql"
    Backup             = "required"
    LogRetentionInDays = tostring(var.log_retention_days)
  })

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy_attachment.monitoring,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.parameter_group_family == "postgres${split(".", var.engine_version)[0]}"
      error_message = "RDS 参数组 family 必须与 PostgreSQL 引擎主版本一致。"
    }

    precondition {
      condition     = var.max_allocated_storage_gib >= var.allocated_storage_gib * 2
      error_message = "RDS 自动扩容上限至少应为初始容量的两倍。"
    }
  }
}

# 该资源只提供一个同区域异步只读副本。显式指定 subnet group 时，AWS provider 要求
# replicate_source_db 使用源实例 ARN；同区域加密副本由 RDS 强制继承源 KMS key，不能在此伪装成跨区 DR。
resource "aws_db_instance" "reader" {
  count = var.read_replica.enabled ? 1 : 0

  identifier          = local.reader_identifier
  replicate_source_db = aws_db_instance.this.arn
  instance_class      = var.read_replica.instance_class
  port                = 5432

  multi_az               = var.read_replica.multi_az
  publicly_accessible    = false
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]

  max_allocated_storage   = var.max_allocated_storage_gib
  backup_retention_period = var.backup_retention_days
  backup_window           = "20:30-21:30"
  maintenance_window      = "sun:22:00-sun:23:00"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade          = false
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name_prefix}-postgresql-reader-final"
  iam_database_authentication_enabled = true

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.monitoring.arn

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = sort(tolist(local.log_exports))

  tags = merge(var.tags, {
    Name               = local.reader_identifier
    Backup             = "required"
    DatabaseRole       = "read-replica"
    LogRetentionInDays = tostring(var.log_retention_days)
  })

  depends_on = [
    aws_cloudwatch_log_group.reader,
    aws_iam_role_policy_attachment.monitoring,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        tonumber(split(".", var.engine_version)[0]) > 14 ||
        (
          tonumber(split(".", var.engine_version)[0]) == 14 &&
          tonumber(split(".", var.engine_version)[1]) >= 1
        )
      )
      error_message = "启用带自动备份的 PostgreSQL 只读副本要求 RDS PostgreSQL 14.1 或更高版本。"
    }

    precondition {
      condition     = var.backup_retention_days > 0
      error_message = "PostgreSQL 只读副本的源实例必须启用自动备份。"
    }

    precondition {
      condition     = !startswith(var.name_prefix, "slots-prod-") || var.deletion_protection
      error_message = "生产只读副本必须继承已启用的删除保护边界。"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "capacity_high" {
  for_each = local.capacity_high_alarm_metrics

  alarm_name          = "${var.name_prefix}-postgresql-${each.value.suffix}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  unit                = each.value.unit
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "capacity_low" {
  for_each = local.capacity_low_alarm_metrics

  alarm_name          = "${var.name_prefix}-postgresql-${each.value.suffix}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  unit                = each.value.unit
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = each.value.threshold
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "reader_capacity_high" {
  for_each = var.read_replica.enabled ? local.reader_capacity_high_alarm_metrics : {}

  alarm_name          = "${local.reader_identifier}-${each.value.suffix}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  unit                = each.value.unit
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.reader[0].identifier
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "reader_capacity_low" {
  for_each = var.read_replica.enabled ? local.reader_capacity_low_alarm_metrics : {}

  alarm_name          = "${local.reader_identifier}-${each.value.suffix}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  unit                = each.value.unit
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = each.value.threshold
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.reader[0].identifier
  }

  tags = var.tags
}

# ReplicaLag 缺失本身需要值班确认，因此它与普通容量指标不同，缺失数据按 breaching 处理。
resource "aws_cloudwatch_metric_alarm" "reader_replica_lag" {
  count = var.read_replica.enabled ? 1 : 0

  alarm_name          = "${local.reader_identifier}-replica-lag-high"
  alarm_description   = "RDS PostgreSQL 同区域只读副本复制延迟持续超出批准上限，或 ReplicaLag 指标缺失"
  namespace           = "AWS/RDS"
  metric_name         = "ReplicaLag"
  statistic           = "Maximum"
  unit                = "Seconds"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.read_replica.alarm_thresholds.replica_lag_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.reader[0].identifier
  }

  tags = var.tags
}

# 存储 IOPS 上限由读写共享，必须按 ReadIOPS + WriteIOPS 总量告警，不能分别套用完整预算。
resource "aws_cloudwatch_metric_alarm" "total_iops" {
  alarm_name          = "${var.name_prefix}-postgresql-total-iops-high"
  alarm_description   = "RDS 读写总 IOPS 持续接近经批准的存储或实例预算"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alarm_thresholds.total_iops_per_second
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  metric_query {
    id          = "e1"
    expression  = "m1 + m2"
    label       = "Total RDS IOPS"
    return_data = true
  }

  metric_query {
    id          = "m1"
    return_data = false

    metric {
      metric_name = "ReadIOPS"
      namespace   = "AWS/RDS"
      period      = 60
      stat        = "Average"
      unit        = "Count/Second"
      dimensions = {
        DBInstanceIdentifier = aws_db_instance.this.identifier
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false

    metric {
      metric_name = "WriteIOPS"
      namespace   = "AWS/RDS"
      period      = 60
      stat        = "Average"
      unit        = "Count/Second"
      dimensions = {
        DBInstanceIdentifier = aws_db_instance.this.identifier
      }
    }
  }

  tags = var.tags
}

# gp3 的 I/O channel 带宽同样由读写共享，按 ReadThroughput + WriteThroughput 总量告警。
resource "aws_cloudwatch_metric_alarm" "total_throughput" {
  alarm_name          = "${var.name_prefix}-postgresql-total-throughput-high"
  alarm_description   = "RDS 读写总吞吐持续接近经批准的存储或实例带宽预算"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alarm_thresholds.total_throughput_bytes_per_second
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  metric_query {
    id          = "e1"
    expression  = "m1 + m2"
    label       = "Total RDS throughput"
    return_data = true
  }

  metric_query {
    id          = "m1"
    return_data = false

    metric {
      metric_name = "ReadThroughput"
      namespace   = "AWS/RDS"
      period      = 60
      stat        = "Average"
      unit        = "Bytes/Second"
      dimensions = {
        DBInstanceIdentifier = aws_db_instance.this.identifier
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false

    metric {
      metric_name = "WriteThroughput"
      namespace   = "AWS/RDS"
      period      = 60
      stat        = "Average"
      unit        = "Bytes/Second"
      dimensions = {
        DBInstanceIdentifier = aws_db_instance.this.identifier
      }
    }
  }

  tags = var.tags
}

# PostgreSQL deadlock 日志是经济事务正确性的离散异常；单次匹配必须立即进入值班链路，不能套用容量告警的 2/3 debounce。
resource "aws_cloudwatch_metric_alarm" "deadlocks" {
  alarm_name          = "${var.name_prefix}-postgresql-deadlocks"
  alarm_description   = "RDS PostgreSQL 导出日志匹配 deadlock detected；需保全日志并执行受控事务证据调查"
  namespace           = local.deadlock_metric_namespace
  metric_name         = local.deadlock_metric_name
  statistic           = "Sum"
  unit                = "Count"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = var.alarm_thresholds.deadlocks_per_minute
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  tags = var.tags

  depends_on = [aws_cloudwatch_log_metric_filter.deadlocks]
}

resource "aws_db_event_subscription" "this" {
  name      = "${var.name_prefix}-postgresql"
  sns_topic = var.alert_topic_arn

  source_type = "db-instance"
  source_ids  = [aws_db_instance.this.identifier]
  event_categories = [
    "availability",
    "backup",
    "configuration change",
    "deletion",
    "failover",
    "failure",
    "low storage",
    "maintenance",
    "notification",
    "recovery",
  ]

  tags = var.tags
}
