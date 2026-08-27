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

variable "waf_evidence_kms_key_arn" {
  description = "CloudFront WAF Block 晋级证据对象必须使用的采用方批准 KMS key ARN"
  type        = string

  validation {
    condition     = can(regex("^arn:(aws|aws-us-gov):kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", var.waf_evidence_kms_key_arn))
    error_message = "CloudFront WAF evidence KMS key 必须是精确 key ARN，禁止 alias、空值或占位符。"
  }
}

variable "waf_rate_limit_per_minute" {
  description = "采用方 CloudFront WAF 的每来源 IP 一分钟静态请求限额"
  type        = number

  validation {
    condition = (
      var.waf_rate_limit_per_minute >= 100 &&
      var.waf_rate_limit_per_minute <= 1000000 &&
      floor(var.waf_rate_limit_per_minute) == var.waf_rate_limit_per_minute
    )
    error_message = "CloudFront WAF 一分钟限额必须是 100 到 1000000 的整数。"
  }
}

variable "waf_rate_rule_rollout" {
  description = "采用方 CloudFront WAF 按来源 IP rate rule 的 Count→Block 校准状态"
  type = object({
    action             = string
    evidence_reference = string
  })

  validation {
    condition = (
      (var.waf_rate_rule_rollout.action == "count" &&
      var.waf_rate_rule_rollout.evidence_reference == "observation-pending") ||
      (var.waf_rate_rule_rollout.action == "block" &&
      can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", var.waf_rate_rule_rollout.evidence_reference)))
    )
    error_message = "CloudFront rate rule 在 count 阶段必须声明 observation-pending；切到 block 必须绑定 s3://...?versionId=...#sha256 校准证据。"
  }
}

variable "waf_log_group_name" {
  description = "采用方 CloudFront WAF 的 us-east-1 CloudWatch Log Group 名"
  type        = string

  validation {
    condition = (
      can(regex("^aws-waf-logs-[a-z0-9][a-z0-9_-]{2,120}$", var.waf_log_group_name)) &&
      !strcontains(var.waf_log_group_name, "replace")
    )
    error_message = "CloudFront WAF 日志组必须使用 aws-waf-logs- 前缀且不能是占位值。"
  }
}

variable "waf_managed_rule_rollout" {
  description = "采用方 CloudFront WAF managed rules 的 Count→Block 状态与观测证据"
  type = object({
    action             = string
    evidence_reference = string
  })

  validation {
    condition = (
      (var.waf_managed_rule_rollout.action == "count" &&
      var.waf_managed_rule_rollout.evidence_reference == "observation-pending") ||
      (var.waf_managed_rule_rollout.action == "block" &&
      can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", var.waf_managed_rule_rollout.evidence_reference)))
    )
    error_message = "CloudFront managed rules 在 count 阶段必须声明 observation-pending；切到 block 必须绑定 s3://...?versionId=...#sha256 证据。"
  }
}

variable "waf_managed_rule_versions" {
  description = "采用方 CloudFront WAF 三个 AWS Managed Rule Group 的精确版本交接"
  type        = map(string)

  validation {
    condition = (
      length(setsubtract(
        toset(keys(var.waf_managed_rule_versions)),
        toset(["amazon-ip-reputation", "common", "known-bad-inputs"])
      )) == 0 &&
      length(setsubtract(
        toset(["amazon-ip-reputation", "common", "known-bad-inputs"]),
        toset(keys(var.waf_managed_rule_versions))
      )) == 0 &&
      alltrue([
        for version in values(var.waf_managed_rule_versions) :
        can(regex("^Version_[0-9]+\\.[0-9]+$", version))
      ])
    )
    error_message = "CloudFront managed rule versions 必须精确包含三个规则键并使用 Version_x.y。"
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
