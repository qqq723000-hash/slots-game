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
