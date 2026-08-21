variable "name_prefix" {
  description = "EKS 资源名称前缀"
  type        = string
}

variable "kubernetes_version" {
  description = "经平台确认仍受 EKS 支持的 Kubernetes 次版本"
  type        = string

  validation {
    condition     = can(regex("^1\\.[0-9]{2}$", var.kubernetes_version))
    error_message = "kubernetes_version 必须使用 1.xx 次版本格式并由平台在 plan 前确认支持状态。"
  }
}

variable "vpc_id" {
  description = "EKS 所在 VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "三个应用私有子网 ID"
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) == 3
    error_message = "EKS 必须使用三个应用私有子网。"
  }
}

variable "secrets_kms_key_arn" {
  description = "Kubernetes Secret 信封加密 KMS key ARN"
  type        = string
}

variable "node_kms_key_arn" {
  description = "EKS 节点根卷 KMS key ARN"
  type        = string
}

variable "observability_kms_key_arn" {
  description = "EKS 控制面日志 KMS key ARN"
  type        = string
}

variable "cluster_admin_principal_arns" {
  description = "受保护 EKS 管理角色 ARN"
  type        = set(string)
}

variable "production_mode" {
  description = "是否启用生产容量失败闭合检查"
  type        = bool
}

variable "addon_versions" {
  description = "由平台查询并批准的 EKS add-on 精确版本"
  type        = map(string)

  validation {
    condition = toset(keys(var.addon_versions)) == toset([
      "amazon-cloudwatch-observability",
      "coredns",
      "eks-pod-identity-agent",
      "kube-proxy",
      "metrics-server",
      "vpc-cni",
    ]) && alltrue([for version in values(var.addon_versions) : can(regex("^v[0-9]", version))])
    error_message = "addon_versions 必须精确包含六个必需 add-on，并使用 v 开头的精确版本。"
  }
}

variable "node_instance_types" {
  description = "受批准的 EKS 节点实例类型"
  type        = list(string)

  validation {
    condition = length(var.node_instance_types) >= 1 && length(var.node_instance_types) <= 4 && alltrue([
      for instance_type in var.node_instance_types : can(regex("^[a-z0-9]+[a-z0-9-]*\\.[a-z0-9]+$", instance_type))
    ])
    error_message = "节点实例类型必须提供 1 到 4 个合法且形状相容的 EC2 类型。"
  }
}

variable "node_min_size" {
  description = "节点组最小容量"
  type        = number

  validation {
    condition     = var.node_min_size >= 1 && floor(var.node_min_size) == var.node_min_size
    error_message = "节点组最小容量必须是大于等于 1 的整数。"
  }
}

variable "node_desired_size" {
  description = "节点组期望容量"
  type        = number

  validation {
    condition     = var.node_desired_size >= 1 && floor(var.node_desired_size) == var.node_desired_size
    error_message = "节点组初始期望容量必须是大于等于 1 的整数。"
  }
}

variable "node_max_size" {
  description = "节点组最大容量"
  type        = number

  validation {
    condition     = var.node_max_size >= 1 && floor(var.node_max_size) == var.node_max_size
    error_message = "节点组最大容量必须是大于等于 1 的整数。"
  }
}

variable "node_volume_size_gib" {
  description = "加密节点根卷容量"
  type        = number

  validation {
    condition     = var.node_volume_size_gib >= 50 && floor(var.node_volume_size_gib) == var.node_volume_size_gib
    error_message = "节点加密根卷必须是大于等于 50 GiB 的整数。"
  }
}

variable "control_plane_log_retention_days" {
  description = "EKS 控制面日志保留天数"
  type        = number
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
