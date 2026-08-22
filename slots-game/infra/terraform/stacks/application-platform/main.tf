locals {
  name_prefix     = "${var.project_name}-${var.environment}"
  production_mode = startswith(var.environment, "prod-")
  tags = merge(var.additional_tags, {
    Application = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Repository  = "slots-game"
  })
}

module "delivery_contract" {
  source = "../../modules/delivery-contract"

  contract_version                  = var.contract_version
  project_name                      = var.project_name
  environment                       = var.environment
  expected_account_id               = var.expected_account_id
  aws_region                        = var.aws_region
  availability_zones                = var.availability_zones
  cluster_admin_principal_arns      = var.cluster_admin_principal_arns
  backup_copy_destination_vault_arn = var.backup_copy_destination_vault_arn
}

resource "terraform_data" "production_guardrails" {
  input = {
    production_mode         = local.production_mode
    nat_gateway_per_az      = var.enable_nat_gateway_per_az
    rds_multi_az            = var.rds_multi_az
    rds_deletion_protection = var.rds_deletion_protection
    backup_vault_lock       = var.backup_enable_vault_lock
    ecr_retention_days      = var.ecr_untagged_retention_days
  }

  lifecycle {
    precondition {
      condition     = startswith(var.cluster_autoscaler_image_tag, "v${var.kubernetes_version}.")
      error_message = "Cluster Autoscaler 镜像主次版本必须与 EKS Kubernetes 版本一致。"
    }

    precondition {
      condition = !local.production_mode || (
        var.enable_nat_gateway_per_az &&
        var.rds_multi_az &&
        var.rds_deletion_protection &&
        var.rds_backup_retention_days == 35 &&
        var.backup_enable_vault_lock &&
        var.ecr_untagged_retention_days >= 365 &&
        var.node_max_size >= var.node_min_size * 2
      )
      error_message = "生产环境必须启用每区 NAT、RDS Multi-AZ/删除保护/35 天 PITR、Vault Lock、至少两倍节点扩容边界，并将无标签 OCI 保留至少 365 天。"
    }
  }

  depends_on = [module.delivery_contract]
}

module "kms" {
  source = "../../modules/kms"

  name_prefix = local.name_prefix
  tags        = local.tags

  depends_on = [terraform_data.production_guardrails]
}

module "network" {
  source = "../../modules/network"

  name_prefix               = local.name_prefix
  vpc_cidr                  = var.vpc_cidr
  availability_zones        = var.availability_zones
  public_subnet_cidrs       = var.public_subnet_cidrs
  private_subnet_cidrs      = var.private_subnet_cidrs
  data_subnet_cidrs         = var.data_subnet_cidrs
  edge_ingress_cidrs        = var.edge_ingress_cidrs
  flow_log_kms_key_arn      = module.kms.key_arns["observability"]
  log_retention_days        = var.log_retention_days
  enable_nat_gateway_per_az = var.enable_nat_gateway_per_az
  tags                      = local.tags
}

module "ecr" {
  source = "../../modules/ecr"

  name_prefix             = local.name_prefix
  kms_key_arn             = module.kms.key_arns["ecr"]
  untagged_retention_days = var.ecr_untagged_retention_days
  tags                    = local.tags
}

module "eks" {
  source = "../../modules/eks"

  name_prefix                      = local.name_prefix
  production_mode                  = local.production_mode
  kubernetes_version               = var.kubernetes_version
  vpc_id                           = module.network.vpc_id
  private_subnet_ids               = module.network.private_subnet_ids
  secrets_kms_key_arn              = module.kms.key_arns["eks"]
  node_kms_key_arn                 = module.kms.key_arns["compute"]
  observability_kms_key_arn        = module.kms.key_arns["observability"]
  cluster_admin_principal_arns     = var.cluster_admin_principal_arns
  addon_versions                   = var.eks_addon_versions
  node_instance_types              = var.node_instance_types
  node_min_size                    = var.node_min_size
  node_desired_size                = var.node_desired_size
  node_max_size                    = var.node_max_size
  node_volume_size_gib             = var.node_volume_size_gib
  control_plane_log_retention_days = var.log_retention_days
  tags                             = local.tags
}

module "observability" {
  source = "../../modules/observability"

  name_prefix                   = local.name_prefix
  cluster_name                  = module.eks.cluster_name
  cloudwatch_addon_version      = var.eks_addon_versions["amazon-cloudwatch-observability"]
  kms_key_arn                   = module.kms.key_arns["observability"]
  log_retention_days            = var.log_retention_days
  alert_delivery_principal_arns = var.alert_delivery_principal_arns
  tags                          = local.tags

  depends_on = [module.eks]
}

module "rds" {
  source = "../../modules/rds"

  name_prefix               = local.name_prefix
  vpc_id                    = module.network.vpc_id
  data_subnet_ids           = module.network.data_subnet_ids
  client_security_group_id  = module.eks.cluster_security_group_id
  kms_key_arn               = module.kms.key_arns["rds"]
  log_kms_key_arn           = module.kms.key_arns["observability"]
  alert_topic_arn           = module.observability.alert_topic_arn
  engine_version            = var.rds_engine_version
  parameter_group_family    = var.rds_parameter_group_family
  instance_class            = var.rds_instance_class
  allocated_storage_gib     = var.rds_allocated_storage_gib
  max_allocated_storage_gib = var.rds_max_allocated_storage_gib
  multi_az                  = var.rds_multi_az
  backup_retention_days     = var.rds_backup_retention_days
  deletion_protection       = var.rds_deletion_protection
  log_retention_days        = var.log_retention_days
  tags                      = local.tags
}

module "cache" {
  source = "../../modules/cache"

  name_prefix                           = local.name_prefix
  environment                           = var.environment
  aws_account_id                        = var.expected_account_id
  aws_region                            = var.aws_region
  eks_cluster_name                      = module.eks.cluster_name
  application_namespace                 = var.application_namespace
  helm_release_name                     = var.helm_release_name
  vpc_id                                = module.network.vpc_id
  private_subnet_ids                    = module.network.private_subnet_ids
  client_security_group_id              = module.eks.cluster_security_group_id
  kms_key_arn                           = module.kms.key_arns["elasticache"]
  secrets_kms_key_arn                   = module.kms.key_arns["secrets"]
  log_kms_key_arn                       = module.kms.key_arns["observability"]
  alert_topic_arn                       = module.observability.alert_topic_arn
  engine_version                        = var.valkey_engine_version
  node_type                             = var.valkey_node_type
  valkey_alarm_thresholds               = var.valkey_alarm_thresholds
  valkey_active_slot                    = var.valkey_active_slot
  valkey_rotation_mode                  = var.valkey_rotation_mode
  valkey_password_a                     = var.valkey_password_a
  valkey_password_b                     = var.valkey_password_b
  valkey_password_fingerprint_a         = var.valkey_password_fingerprint_a
  valkey_password_fingerprint_b         = var.valkey_password_fingerprint_b
  valkey_password_version_a             = var.valkey_password_version_a
  valkey_password_version_b             = var.valkey_password_version_b
  valkey_password_reset_approvals       = var.valkey_password_reset_approvals
  valkey_hmac_maintenance_approval      = var.valkey_hmac_maintenance_approval
  shared_admission_hmac_key             = var.shared_admission_hmac_key
  shared_admission_hmac_key_fingerprint = var.shared_admission_hmac_key_fingerprint
  valkey_root_ca_pem                    = var.valkey_root_ca_pem
  secret_version                        = var.valkey_secret_version
  log_retention_days                    = var.log_retention_days
  tags                                  = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  name_prefix                         = local.name_prefix
  aws_account_id                      = var.expected_account_id
  aws_region                          = var.aws_region
  kms_key_arn                         = module.kms.key_arns["secrets"]
  cluster_name                        = module.eks.cluster_name
  secret_versions                     = var.application_secret_versions
  shared_admission_secret_name_prefix = "${local.name_prefix}-rgs-shared-admission"
  tags                                = local.tags

  depends_on = [module.eks]
}

module "web_edge" {
  source = "../../modules/web-edge"

  name_prefix             = local.name_prefix
  bucket_name             = var.web_bucket_name
  log_bucket_name         = var.cloudfront_log_bucket_name
  domain_name             = var.web_domain_name
  acm_certificate_arn     = var.cloudfront_acm_certificate_arn
  waf_web_acl_arn         = var.cloudfront_waf_web_acl_arn
  content_security_policy = var.web_content_security_policy
  price_class             = var.cloudfront_price_class
  log_retention_days      = var.cloudfront_log_retention_days
  tags                    = local.tags

  depends_on = [terraform_data.production_guardrails]
}

module "archive" {
  source = "../../modules/archive"

  name_prefix               = local.name_prefix
  bucket_name               = var.archive_bucket_name
  governance_retention_days = var.archive_retention_days
  deep_archive_after_days   = var.archive_deep_after_days
  tags                      = local.tags

  depends_on = [terraform_data.production_guardrails]
}

module "backup" {
  source = "../../modules/backup"

  name_prefix                    = local.name_prefix
  kms_key_arn                    = module.kms.key_arns["backup"]
  alert_topic_arn                = module.observability.alert_topic_arn
  retention_days                 = var.backup_retention_days
  enable_vault_lock              = var.backup_enable_vault_lock
  vault_lock_changeable_for_days = var.backup_vault_lock_changeable_for_days
  copy_destination_vault_arn     = var.backup_copy_destination_vault_arn
  copy_source_account_ids        = var.backup_copy_source_account_ids
  tags                           = local.tags

  depends_on = [module.rds]
}
