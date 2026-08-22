resource "terraform_data" "contract" {
  input = {
    contract_version                  = var.contract_version
    project_name                      = var.project_name
    environment                       = var.environment
    expected_account_id               = var.expected_account_id
    aws_region                        = var.aws_region
    availability_zones                = var.availability_zones
    cluster_admin_principal_arns      = sort(tolist(var.cluster_admin_principal_arns))
    backup_copy_destination_vault_arn = var.backup_copy_destination_vault_arn
  }
}
