output "endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.this.address
}

output "port" {
  description = "RDS PostgreSQL port"
  value       = aws_db_instance.this.port
}

output "resource_id" {
  description = "RDS 资源 ID"
  value       = aws_db_instance.this.resource_id
}

output "master_user_secret_arn" {
  description = "RDS 托管管理员 Secret ARN，仅供受控 DBA 初始化使用"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  sensitive   = true
}

output "security_group_id" {
  description = "RDS 安全组 ID"
  value       = aws_security_group.this.id
}

output "reader_endpoint" {
  description = "可选同区域 PostgreSQL 只读副本 endpoint；关闭时为 null，不能替代 writer endpoint"
  value       = try(aws_db_instance.reader[0].address, null)
}

output "read_scaling_contract" {
  description = "可选同区域只读副本、继承边界、容量告警和应用尚未采用读写路由的机器合同"
  value = {
    contract_version                = "1.0.0"
    enabled                         = var.read_replica.enabled
    topology                        = var.read_replica.enabled ? "single-writer-one-same-region-read-replica" : "single-writer"
    same_region_only                = true
    source_db_instance_identifier   = aws_db_instance.this.identifier
    reader_db_instance_identifier   = try(aws_db_instance.reader[0].identifier, null)
    reader_endpoint                 = try(aws_db_instance.reader[0].address, null)
    port                            = aws_db_instance.this.port
    engine_version                  = var.read_replica.enabled ? var.engine_version : null
    instance_class                  = var.read_replica.enabled ? var.read_replica.instance_class : null
    storage_type                    = var.read_replica.enabled ? "gp3" : null
    minimum_allocated_storage_gib   = var.read_replica.enabled ? var.allocated_storage_gib : null
    max_allocated_storage_gib       = var.read_replica.enabled ? var.max_allocated_storage_gib : null
    application_routing_adopted     = false
    connection_pooler_implemented   = false
    rds_proxy_implemented           = false
    cross_region_dr_implemented     = false
    read_replica_is_backup          = false
    source_multi_az                 = var.multi_az
    reader_multi_az                 = var.read_replica.enabled ? var.read_replica.multi_az : null
    backup_retention_days           = var.read_replica.enabled ? var.backup_retention_days : null
    deletion_protection             = var.read_replica.enabled ? var.deletion_protection : null
    db_subnet_group_name            = aws_db_subnet_group.this.name
    parameter_group_name            = aws_db_parameter_group.this.name
    vpc_security_group_ids          = [aws_security_group.this.id]
    expected_storage_encrypted      = true
    expected_kms_key_arn            = var.kms_key_arn
    same_region_kms_inheritance     = true
    live_inheritance_check_required = var.read_replica.enabled
    log_group_names = var.read_replica.enabled ? sort([
      for log_group in values(aws_cloudwatch_log_group.reader) : log_group.name
    ]) : []
    alert_topic_arn = var.alert_topic_arn
    alarm_names = var.read_replica.enabled ? sort(concat(
      [for alarm in values(aws_cloudwatch_metric_alarm.reader_capacity_high) : alarm.alarm_name],
      [for alarm in values(aws_cloudwatch_metric_alarm.reader_capacity_low) : alarm.alarm_name],
      [aws_cloudwatch_metric_alarm.reader_replica_lag[0].alarm_name],
    )) : []
    metrics = var.read_replica.enabled ? merge(
      {
        for key, metric in local.reader_capacity_high_alarm_metrics : metric.metric_name => {
          alarm_name          = aws_cloudwatch_metric_alarm.reader_capacity_high[key].alarm_name
          statistic           = metric.statistic
          unit                = metric.unit
          threshold           = metric.threshold
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
        }
      },
      {
        for key, metric in local.reader_capacity_low_alarm_metrics : metric.metric_name => {
          alarm_name          = aws_cloudwatch_metric_alarm.reader_capacity_low[key].alarm_name
          statistic           = metric.statistic
          unit                = metric.unit
          threshold           = metric.threshold
          comparison_operator = "LessThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
        }
      },
      {
        ReplicaLag = {
          alarm_name          = aws_cloudwatch_metric_alarm.reader_replica_lag[0].alarm_name
          statistic           = "Maximum"
          unit                = "Seconds"
          threshold           = var.read_replica.alarm_thresholds.replica_lag_seconds
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "breaching"
        }
      },
    ) : {}
  }
}

output "alarm_contract" {
  description = "发布与目标账号实时回读消费的单实例 RDS 告警和死锁证据合同"
  value = {
    contract_version       = "2.0.0"
    database_topology      = "single-db-instance"
    multi_az               = var.multi_az
    namespace              = "AWS/RDS"
    db_instance_identifier = aws_db_instance.this.identifier
    alert_topic_arn        = var.alert_topic_arn
    missing_data_policy    = "notBreaching"
    alarm_names = sort(concat(
      [for alarm in values(aws_cloudwatch_metric_alarm.capacity_high) : alarm.alarm_name],
      [for alarm in values(aws_cloudwatch_metric_alarm.capacity_low) : alarm.alarm_name],
      [aws_cloudwatch_metric_alarm.total_iops.alarm_name],
      [aws_cloudwatch_metric_alarm.total_throughput.alarm_name],
      [aws_cloudwatch_metric_alarm.deadlocks.alarm_name],
    ))
    metrics = merge(
      {
        for key, metric in local.capacity_high_alarm_metrics : metric.metric_name => {
          alarm_name          = aws_cloudwatch_metric_alarm.capacity_high[key].alarm_name
          statistic           = metric.statistic
          unit                = metric.unit
          threshold           = metric.threshold
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
        }
      },
      {
        for key, metric in local.capacity_low_alarm_metrics : metric.metric_name => {
          alarm_name          = aws_cloudwatch_metric_alarm.capacity_low[key].alarm_name
          statistic           = metric.statistic
          unit                = metric.unit
          threshold           = metric.threshold
          comparison_operator = "LessThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
        }
      },
      {
        TotalIOPS = {
          alarm_name          = aws_cloudwatch_metric_alarm.total_iops.alarm_name
          unit                = "Count/Second"
          threshold           = var.alarm_thresholds.total_iops_per_second
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
          metric_data_queries = [
            {
              id          = "e1"
              expression  = "m1 + m2"
              label       = "Total RDS IOPS"
              return_data = true
            },
            {
              id              = "m1"
              metric_name     = "ReadIOPS"
              namespace       = "AWS/RDS"
              statistic       = "Average"
              unit            = "Count/Second"
              period_seconds  = 60
              dimension_name  = "DBInstanceIdentifier"
              dimension_value = aws_db_instance.this.identifier
              return_data     = false
            },
            {
              id              = "m2"
              metric_name     = "WriteIOPS"
              namespace       = "AWS/RDS"
              statistic       = "Average"
              unit            = "Count/Second"
              period_seconds  = 60
              dimension_name  = "DBInstanceIdentifier"
              dimension_value = aws_db_instance.this.identifier
              return_data     = false
            },
          ]
        }
        TotalThroughput = {
          alarm_name          = aws_cloudwatch_metric_alarm.total_throughput.alarm_name
          unit                = "Bytes/Second"
          threshold           = var.alarm_thresholds.total_throughput_bytes_per_second
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 3
          datapoints_to_alarm = 2
          treat_missing_data  = "notBreaching"
          metric_data_queries = [
            {
              id          = "e1"
              expression  = "m1 + m2"
              label       = "Total RDS throughput"
              return_data = true
            },
            {
              id              = "m1"
              metric_name     = "ReadThroughput"
              namespace       = "AWS/RDS"
              statistic       = "Average"
              unit            = "Bytes/Second"
              period_seconds  = 60
              dimension_name  = "DBInstanceIdentifier"
              dimension_value = aws_db_instance.this.identifier
              return_data     = false
            },
            {
              id              = "m2"
              metric_name     = "WriteThroughput"
              namespace       = "AWS/RDS"
              statistic       = "Average"
              unit            = "Bytes/Second"
              period_seconds  = 60
              dimension_name  = "DBInstanceIdentifier"
              dimension_value = aws_db_instance.this.identifier
              return_data     = false
            },
          ]
        }
      },
      {
        Deadlocks = {
          alarm_name          = aws_cloudwatch_metric_alarm.deadlocks.alarm_name
          statistic           = "Sum"
          unit                = "Count"
          threshold           = var.alarm_thresholds.deadlocks_per_minute
          comparison_operator = "GreaterThanOrEqualToThreshold"
          period_seconds      = 60
          evaluation_periods  = 1
          datapoints_to_alarm = 1
          treat_missing_data  = "notBreaching"
        }
      },
    )
    deadlock_metric_filter = {
      filter_name      = aws_cloudwatch_log_metric_filter.deadlocks.name
      log_group_name   = aws_cloudwatch_log_metric_filter.deadlocks.log_group_name
      filter_pattern   = aws_cloudwatch_log_metric_filter.deadlocks.pattern
      metric_namespace = local.deadlock_metric_namespace
      metric_name      = local.deadlock_metric_name
      metric_value     = "1"
      default_value    = 0
      unit             = "Count"
    }
    deadlock_evidence = {
      alarm_name                          = aws_cloudwatch_metric_alarm.deadlocks.alarm_name
      postgresql_log_group_name           = aws_cloudwatch_log_group.this["postgresql"].name
      automatic_snapshot_implemented      = false
      external_evidence_consumer_required = true
    }
  }
}
