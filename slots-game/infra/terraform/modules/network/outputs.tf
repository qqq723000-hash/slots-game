output "vpc_id" {
  description = "应用 VPC ID"
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "应用 VPC CIDR"
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "按可用区排序的公网子网 ID"
  value       = [for zone in var.availability_zones : aws_subnet.public[zone].id]
}

output "public_subnet_cidrs" {
  description = "按可用区排序的公网 ALB 节点来源 CIDR"
  value       = [for zone in var.availability_zones : aws_subnet.public[zone].cidr_block]
}

output "private_subnet_ids" {
  description = "按可用区排序的应用私有子网 ID"
  value       = [for zone in var.availability_zones : aws_subnet.private[zone].id]
}

output "data_subnet_ids" {
  description = "按可用区排序的数据隔离子网 ID"
  value       = [for zone in var.availability_zones : aws_subnet.data[zone].id]
}

output "alb_security_group_id" {
  description = "公网 ALB 专用安全组 ID"
  value       = aws_security_group.alb.id
}

output "alb_egress_target_ports" {
  description = "ALB 安全组向 VPC target 精确开放的业务与 operations health 端口"
  value       = [8080, 8081]
}
