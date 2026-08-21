data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_backup_vault" "this" {
  name        = "${var.name_prefix}-vault"
  kms_key_arn = var.kms_key_arn
  tags        = var.tags
}

resource "aws_backup_vault_lock_configuration" "this" {
  count = var.enable_vault_lock ? 1 : 0

  backup_vault_name   = aws_backup_vault.this.name
  changeable_for_days = var.vault_lock_changeable_for_days
  min_retention_days  = var.retention_days
  max_retention_days  = var.retention_days * 4
}

data "aws_iam_policy_document" "vault" {
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["backup:DescribeBackupVault", "backup:DeleteBackupVault", "backup:PutBackupVaultAccessPolicy"]
    resources = [aws_backup_vault.this.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = length(var.copy_source_account_ids) > 0 ? [1] : []
    content {
      sid       = "AllowApprovedCrossAccountCopies"
      effect    = "Allow"
      actions   = ["backup:CopyIntoBackupVault"]
      resources = [aws_backup_vault.this.arn]

      principals {
        type = "AWS"
        identifiers = [for account_id in var.copy_source_account_ids :
          "arn:${data.aws_partition.current.partition}:iam::${account_id}:root"
        ]
      }
    }
  }
}

resource "aws_backup_vault_policy" "this" {
  backup_vault_name = aws_backup_vault.this.name
  policy            = data.aws_iam_policy_document.vault.json
}

resource "aws_backup_plan" "this" {
  name = "${var.name_prefix}-daily"

  rule {
    rule_name                = "daily"
    target_vault_name        = aws_backup_vault.this.name
    schedule                 = "cron(0 17 * * ? *)"
    start_window             = 60
    completion_window        = 360
    enable_continuous_backup = true

    lifecycle {
      delete_after = var.retention_days
    }

    dynamic "copy_action" {
      for_each = var.copy_destination_vault_arn == "" ? [] : [var.copy_destination_vault_arn]
      content {
        destination_vault_arn = copy_action.value

        lifecycle {
          delete_after = var.retention_days
        }
      }
    }
  }

  tags = var.tags
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name_prefix}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_selection" "tagged" {
  name         = "${var.name_prefix}-tagged"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.this.id

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "Backup"
    value = "required"
  }

  depends_on = [
    aws_iam_role_policy_attachment.backup,
    aws_iam_role_policy_attachment.restore,
  ]
}

resource "aws_backup_vault_notifications" "this" {
  backup_vault_name = aws_backup_vault.this.name
  sns_topic_arn     = var.alert_topic_arn
  backup_vault_events = [
    "BACKUP_JOB_COMPLETED",
    "BACKUP_JOB_FAILED",
    "COPY_JOB_FAILED",
    "RESTORE_JOB_COMPLETED",
    "RESTORE_JOB_FAILED",
  ]
}
