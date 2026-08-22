variable "name_prefix" {
  description = "网络资源名称前缀"
  type        = string
}

variable "vpc_cidr" {
  description = "应用 VPC CIDR"
  type        = string

  validation {
    condition = try(
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", cidrhost(var.vpc_cidr, 0))) &&
      split("/", var.vpc_cidr)[0] == cidrhost(var.vpc_cidr, 0) &&
      tonumber(split("/", var.vpc_cidr)[1]) >= 16 &&
      tonumber(split("/", var.vpc_cidr)[1]) <= 28,
      false,
    )
    error_message = "vpc_cidr 必须是规范网络地址形式的 /16 到 /28 IPv4 CIDR。"
  }
}

variable "availability_zones" {
  description = "三个明确可用区"
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "三个公网入口子网 CIDR"
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "三个 EKS 私有子网 CIDR"
  type        = list(string)
}

variable "data_subnet_cidrs" {
  description = "三个 RDS 隔离子网 CIDR"
  type        = list(string)
}

variable "edge_ingress_cidrs" {
  description = "允许访问公网 ALB 的来源 CIDR"
  type        = list(string)

  validation {
    condition = length(var.edge_ingress_cidrs) > 0 && alltrue([
      for cidr in var.edge_ingress_cidrs : try(
        can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", cidrhost(cidr, 0))) &&
        split("/", cidr)[0] == cidrhost(cidr, 0),
        false,
      )
    ])
    error_message = "edge_ingress_cidrs 必须至少包含一个有效 IPv4 CIDR。"
  }
}

variable "flow_log_kms_key_arn" {
  description = "VPC Flow Logs 的 KMS key ARN"
  type        = string
}

variable "log_retention_days" {
  description = "Flow Logs 保存天数"
  type        = number
}

variable "enable_nat_gateway_per_az" {
  description = "是否每个可用区建立独立 NAT Gateway"
  type        = bool
  default     = true
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
