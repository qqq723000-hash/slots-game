terraform {
  required_version = "= 1.15.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.61.0"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

variable "configuration" {
  description = "prod-dr 非秘密环境配置"
  type        = any
}

variable "valkey_password_a" {
  description = "Valkey A 槽 ACL 密码；由受保护部署 Secret 注入"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_password_b" {
  description = "Valkey B 槽 ACL 密码；由受保护部署 Secret 注入"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "shared_admission_hmac_key" {
  description = "共享准入 HMAC key；由受保护部署 Secret 注入"
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "valkey_root_ca_pem" {
  description = "Valkey TLS 根证书 PEM；由受保护部署 Secret 注入"
  type        = string
  sensitive   = true
  ephemeral   = true
}

provider "aws" {
  region              = var.configuration.aws_region
  allowed_account_ids = [var.configuration.expected_account_id]

  default_tags {
    tags = {
      Application = var.configuration.project_name
      Environment = "prod-dr"
      ManagedBy   = "terraform"
      Repository  = "slots-game"
    }
  }
}

module "environment" {
  source = "../../stacks/environment"

  environment               = "prod-dr"
  configuration             = var.configuration
  valkey_password_a         = var.valkey_password_a
  valkey_password_b         = var.valkey_password_b
  shared_admission_hmac_key = var.shared_admission_hmac_key
  valkey_root_ca_pem        = var.valkey_root_ca_pem
}

output "delivery" {
  value = module.environment.delivery
}

output "rds_master_user_secret_arn" {
  value     = module.environment.rds_master_user_secret_arn
  sensitive = true
}
