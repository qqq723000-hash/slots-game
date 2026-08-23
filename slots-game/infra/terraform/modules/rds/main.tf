data "aws_partition" "current" {}

locals {
  identifier = "${var.name_prefix}-postgresql"
  log_exports = toset([
    "postgresql",
    "upgrade",
  ])
  capacity_high_alarm_metrics = {
    cpu = {
      suffix      = "cpu-high"
      description = "RDS CPU 持续高负载；需检查慢查询、锁竞争和实例容量"
      metric_name = "CPUUtilization"
      statistic   = "Average"
      threshold   = var.alarm_thresholds.cpu_utilization_percent
    }
    connections = {
      suffix      = "connections-high"
      description = "RDS 连接数持续超出经容量评审的应用与运维总预算"
      metric_name = "DatabaseConnections"
      statistic   = "Maximum"
      threshold   = var.alarm_thresholds.database_connections
    }
    read_latency = {
      suffix      = "read-latency-high"
      description = "RDS 平均读取延迟持续超出经压测批准的阈值"
      metric_name = "ReadLatency"
      statistic   = "Average"
      threshold   = var.alarm_thresholds.read_latency_seconds
    }
    write_latency = {
      suffix      = "write-latency-high"
      description = "RDS 平均写入延迟持续超出经压测批准的阈值"
      metric_name = "WriteLatency"
      statistic   = "Average"
      threshold   = var.alarm_thresholds.write_latency_seconds
    }
    disk_queue = {
      suffix      = "disk-queue-high"
      description = "RDS 磁盘队列持续堆积；需检查 IOPS、吞吐和写放大"
      metric_name = "DiskQueueDepth"
      statistic   = "Maximum"
      threshold   = var.alarm_thresholds.disk_queue_depth
    }
  }
  capacity_low_alarm_metrics = {
    freeable_memory = {
      suffix      = "freeable-memory-low"
      description = "RDS 可用内存持续低于经容量评审的安全余量"
      metric_name = "FreeableMemory"
      statistic   = "Minimum"
      threshold   = var.alarm_thresholds.freeable_memory_bytes
    }
    free_storage = {
      suffix      = "free-storage-low"
      description = "RDS 可用存储持续低于安全余量；自动扩容不能替代人工容量处置"
      metric_name = "FreeStorageSpace"
      statistic   = "Minimum"
      threshold   = var.alarm_thresholds.free_storage_space_bytes
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

resource "aws_cloudwatch_metric_alarm" "capacity_high" {
  for_each = local.capacity_high_alarm_metrics

  alarm_name          = "${var.name_prefix}-postgresql-${each.value.suffix}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
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
