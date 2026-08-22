output "validated" {
  description = "落地区契约已通过 Terraform 变量校验"
  value       = terraform_data.contract.id != ""
}
