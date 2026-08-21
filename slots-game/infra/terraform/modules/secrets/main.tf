data "aws_partition" "current" {}

locals {
  secret_boundaries = {
    api-runtime-assets    = "rgs-api-runtime-assets"
    migrator-database     = "rgs-migrator-database"
    operations-bearer     = "rgs-operations-bearer"
    runtime-database      = "rgs-runtime-database"
    worker-runtime-assets = "rgs-worker-runtime-assets"
  }
  shared_admission_secret_arn_pattern = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.shared_admission_secret_name_prefix}-v*"
}

resource "aws_secretsmanager_secret" "application" {
  for_each = local.secret_boundaries

  name                    = "${var.name_prefix}-${each.value}-v${var.secret_versions[each.key]}"
  description             = "${var.name_prefix} ${each.key} 职责隔离 Secret；值由受控轮换流程写入"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Boundary                = each.key
    ManagedValueByTerraform = "false"
  })
}

data "aws_iam_policy_document" "pod_identity_assume" {
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
      values   = [var.controller_namespace]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-service-account"
      values   = [var.controller_service_account]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/eks-cluster-name"
      values   = [var.cluster_name]
    }
  }
}

resource "aws_iam_role" "controller" {
  name               = "${var.name_prefix}-secret-sync"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "controller" {
  statement {
    sid    = "ReadOnlyNamedSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:ListSecretVersionIds",
    ]
    resources = concat(values(aws_secretsmanager_secret.application)[*].arn, [local.shared_admission_secret_arn_pattern])
  }

  statement {
    sid       = "DecryptOnlyThroughSecretsManager"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values   = ["secretsmanager.*.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "controller" {
  name   = "read-slots-secrets"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller.json
}

resource "aws_eks_pod_identity_association" "controller" {
  cluster_name    = var.cluster_name
  namespace       = var.controller_namespace
  service_account = var.controller_service_account
  role_arn        = aws_iam_role.controller.arn

  tags = var.tags

  depends_on = [aws_iam_role_policy.controller]
}
