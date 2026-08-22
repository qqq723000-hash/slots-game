variable "name_prefix" {
  description = "Web 边缘资源名称前缀"
  type        = string
}

variable "bucket_name" {
  description = "全局唯一的私有 Web S3 bucket 名称"
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) &&
      !startswith(var.bucket_name, "replace-")
    )
    error_message = "web bucket 必须是真实、全局唯一且非占位的 S3 名称。"
  }
}

variable "log_bucket_name" {
  description = "全局唯一的 CloudFront 访问日志 bucket 名称"
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.log_bucket_name)) &&
      !startswith(var.log_bucket_name, "replace-")
    )
    error_message = "CloudFront 日志 bucket 必须是真实、全局唯一且非占位的 S3 名称。"
  }
}

variable "domain_name" {
  description = "CloudFront 对外正式域名"
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.domain_name)) &&
      !endswith(var.domain_name, ".example.com")
    )
    error_message = "domain_name 必须是真实域名，example.com 占位域名会被拒绝。"
  }
}

variable "acm_certificate_arn" {
  description = "us-east-1 中供 CloudFront 使用的 ACM certificate ARN"
  type        = string

  validation {
    condition     = can(regex("^arn:(aws|aws-us-gov):acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$", var.acm_certificate_arn))
    error_message = "CloudFront ACM certificate 必须来自 us-east-1。"
  }
}

variable "waf_web_acl_arn" {
  description = "CloudFront scope 的 WAFv2 Web ACL ARN"
  type        = string

  validation {
    condition     = can(regex("^arn:(aws|aws-us-gov):wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+$", var.waf_web_acl_arn))
    error_message = "CloudFront 必须绑定 us-east-1 global scope WAFv2 Web ACL。"
  }
}

variable "content_security_policy" {
  description = "从已验证 Web OCI digest 提取并经审批的精确 CSP"
  type        = string

  validation {
    condition     = startswith(trimspace(var.content_security_policy), "default-src") && strcontains(var.content_security_policy, "object-src 'none'")
    error_message = "CSP 必须来自发布制品，并至少包含 default-src 和 object-src 'none'。"
  }
}

variable "price_class" {
  description = "CloudFront 价格等级"
  type        = string
  default     = "PriceClass_All"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class 必须是 CloudFront 支持的价格等级。"
  }
}

variable "log_retention_days" {
  description = "CloudFront 访问日志保留天数"
  type        = number
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
