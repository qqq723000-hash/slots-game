data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  alert_source_arns = {
    backup     = "arn:${data.aws_partition.current.partition}:backup:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:backup-vault:${var.name_prefix}-vault"
    cloudwatch = "arn:${data.aws_partition.current.partition}:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.name_prefix}-*"
    rds        = "arn:${data.aws_partition.current.partition}:rds:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:db:${var.name_prefix}-postgresql"
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = var.kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AllowAccountAdministration"
    effect    = "Allow"
    actions   = ["sns:*"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowBackupPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.alert_source_arns.backup]
    }
  }

  statement {
    sid       = "AllowRDSEventPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.rds.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.alert_source_arns.rds]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarmPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.alert_source_arns.cloudwatch]
    }
  }

  statement {
    sid       = "AllowControlledSubscriptions"
    effect    = "Allow"
    actions   = ["sns:Subscribe"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "AWS"
      identifiers = sort(tolist(var.alert_delivery_principal_arns))
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

resource "aws_prometheus_workspace" "this" {
  alias = replace(var.name_prefix, "-", "_")
  tags  = var.tags
}

locals {
  container_log_groups = toset([
    "application",
    "dataplane",
    "host",
    "performance",
  ])
}

resource "aws_cloudwatch_log_group" "container_insights" {
  for_each = local.container_log_groups

  name              = "/aws/containerinsights/${var.cluster_name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "pod_identity_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "amp_writer_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-namespace"
      values   = ["monitoring"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-service-account"
      values   = ["prometheus-agent"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/eks-cluster-name"
      values   = [var.cluster_name]
    }
  }
}

resource "aws_iam_role" "cloudwatch_agent" {
  name               = "${var.name_prefix}-cloudwatch-agent"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "xray_writer" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXrayWriteOnlyAccess"
}

resource "aws_eks_addon" "cloudwatch" {
  cluster_name  = var.cluster_name
  addon_name    = "amazon-cloudwatch-observability"
  addon_version = var.cloudwatch_addon_version
  preserve      = true

  configuration_values = jsonencode({
    agent = {
      config = {
        logs = {
          metrics_collected = {
            kubernetes = {
              enhanced_container_insights = true
            }
          }
        }
      }
    }
    containerLogs = {
      enabled = true
    }
  })

  pod_identity_association {
    role_arn        = aws_iam_role.cloudwatch_agent.arn
    service_account = "cloudwatch-agent"
  }

  tags = var.tags

  depends_on = [
    aws_cloudwatch_log_group.container_insights,
    aws_iam_role_policy_attachment.cloudwatch_agent,
    aws_iam_role_policy_attachment.xray_writer,
  ]
}

resource "aws_iam_role" "amp_writer" {
  name               = "${var.name_prefix}-amp-writer"
  assume_role_policy = data.aws_iam_policy_document.amp_writer_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "amp_writer" {
  statement {
    effect = "Allow"
    actions = [
      "aps:GetLabels",
      "aps:GetMetricMetadata",
      "aps:GetSeries",
      "aps:RemoteWrite",
    ]
    resources = [aws_prometheus_workspace.this.arn]
  }
}

resource "aws_iam_role_policy" "amp_writer" {
  name   = "write-application-metrics"
  role   = aws_iam_role.amp_writer.id
  policy = data.aws_iam_policy_document.amp_writer.json
}

resource "aws_eks_pod_identity_association" "amp_writer" {
  cluster_name    = var.cluster_name
  namespace       = "monitoring"
  service_account = "prometheus-agent"
  role_arn        = aws_iam_role.amp_writer.arn
  tags            = var.tags

  depends_on = [aws_iam_role_policy.amp_writer]
}
