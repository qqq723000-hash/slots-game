data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  service_principals = {
    backup        = ["backup.amazonaws.com"]
    compute       = ["autoscaling.amazonaws.com", "ec2.amazonaws.com"]
    ecr           = ["ecr.amazonaws.com"]
    eks           = ["eks.amazonaws.com"]
    elasticache   = ["elasticache.amazonaws.com"]
    observability = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    rds           = ["rds.amazonaws.com"]
    secrets       = ["secretsmanager.amazonaws.com"]
  }
  alert_topic_arn = "arn:${data.aws_partition.current.partition}:sns:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-alerts"
  observability_alert_publishers = {
    backup = {
      sid        = "AllowEncryptedBackupNotifications"
      principal  = "backup.amazonaws.com"
      source_arn = "arn:${data.aws_partition.current.partition}:backup:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:backup-vault:${var.name_prefix}-vault"
    }
    cloudwatch = {
      sid        = "AllowEncryptedCloudWatchAlarms"
      principal  = "cloudwatch.amazonaws.com"
      source_arn = "arn:${data.aws_partition.current.partition}:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.name_prefix}-*"
    }
    rds = {
      sid        = "AllowEncryptedRDSEvents"
      principal  = "events.rds.amazonaws.com"
      source_arn = "arn:${data.aws_partition.current.partition}:rds:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:db:${var.name_prefix}-postgresql"
    }
  }
}

data "aws_iam_policy_document" "key" {
  for_each = local.service_principals

  statement {
    sid       = "EnableAccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid    = "AllowServiceUse"
    effect = "Allow"
    actions = [
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = each.value
    }

    dynamic "condition" {
      for_each = each.key == "observability" ? [] : [1]
      content {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }
    }

    dynamic "condition" {
      for_each = each.key == "observability" ? [1] : []
      content {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values = [
          "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:*",
        ]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "observability" ? local.observability_alert_publishers : {}
    iterator = publisher
    content {
      sid       = publisher.value.sid
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = [publisher.value.principal]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = [publisher.value.source_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "observability" ? [1] : []
    content {
      sid       = "AllowAlertTopicSNSUse"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["sns.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:aws:sns:topicArn"
        values   = [local.alert_topic_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "compute" ? [1] : []
    content {
      sid    = "AllowAutoScalingServiceLinkedRoleUse"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:ReEncrypt*",
      ]
      resources = ["*"]

      principals {
        type = "AWS"
        identifiers = [
          "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling",
        ]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "compute" ? [1] : []
    content {
      sid       = "AllowAutoScalingPersistentResourceGrant"
      effect    = "Allow"
      actions   = ["kms:CreateGrant"]
      resources = ["*"]

      principals {
        type = "AWS"
        identifiers = [
          "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling",
        ]
      }

      condition {
        test     = "Bool"
        variable = "kms:GrantIsForAWSResource"
        values   = ["true"]
      }
    }
  }
}

resource "aws_kms_key" "service" {
  for_each = local.service_principals

  description             = "${var.name_prefix} ${each.key} 数据加密"
  deletion_window_in_days = var.deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key[each.key].json

  tags = merge(var.tags, {
    Name    = "${var.name_prefix}-${each.key}"
    Purpose = each.key
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "service" {
  for_each = aws_kms_key.service

  name          = "alias/${var.name_prefix}/${each.key}"
  target_key_id = each.value.key_id
}
