variable "name_prefix" {
  description = "API 边缘安全资源名称前缀"
  type        = string
}

variable "kms_key_arn" {
  description = "WAF 日志 CloudWatch Log Group 使用的 KMS key ARN"
  type        = string
}

variable "evidence_kms_key_arn" {
  description = "WAF Block 晋级证据对象必须使用的采用方批准 KMS key ARN"
  type        = string

  validation {
    condition     = can(regex("^arn:(aws|aws-us-gov):kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$", var.evidence_kms_key_arn))
    error_message = "WAF evidence KMS key 必须是精确 key ARN，禁止 alias、空值或占位符。"
  }
}

variable "alert_topic_arn" {
  description = "WAF 容量与攻击告警投递的 SNS topic ARN"
  type        = string
}

variable "log_retention_days" {
  description = "WAF 拒绝日志保留天数"
  type        = number
}

variable "rate_limits" {
  description = "区域 WAF 每来源 IP 的一分钟初始限额；必须由真实流量与 NAT 分布重新校准"
  type = object({
    public_requests_per_minute = number
    spin_requests_per_minute   = number
    launch_requests_per_minute = number
  })

  validation {
    condition = (
      var.rate_limits.public_requests_per_minute >= 100 &&
      var.rate_limits.public_requests_per_minute <= 1000000 &&
      floor(var.rate_limits.public_requests_per_minute) == var.rate_limits.public_requests_per_minute &&
      var.rate_limits.spin_requests_per_minute >= 10 &&
      var.rate_limits.spin_requests_per_minute <= var.rate_limits.public_requests_per_minute &&
      floor(var.rate_limits.spin_requests_per_minute) == var.rate_limits.spin_requests_per_minute &&
      var.rate_limits.launch_requests_per_minute >= 10 &&
      var.rate_limits.launch_requests_per_minute <= var.rate_limits.public_requests_per_minute &&
      floor(var.rate_limits.launch_requests_per_minute) == var.rate_limits.launch_requests_per_minute
    )
    error_message = "WAF 限额必须是合理正整数，且 launch/spin 新意图限额不得高于公网总保护限额。"
  }
}

variable "managed_rule_rollout" {
  description = "AWS Managed Rules 的 Count→Block 分阶段状态与不可变观测证据引用"
  type = object({
    action             = string
    evidence_reference = string
  })

  validation {
    condition = (
      (var.managed_rule_rollout.action == "count" &&
      var.managed_rule_rollout.evidence_reference == "observation-pending") ||
      (var.managed_rule_rollout.action == "block" &&
      can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", var.managed_rule_rollout.evidence_reference)))
    )
    error_message = "managed rules 在 count 阶段必须声明 observation-pending；切到 block 必须绑定 s3://...?versionId=...#sha256 不可变观测证据。"
  }
}

variable "managed_rule_versions" {
  description = "API regional WAF 四个 AWS Managed Rule Group 的精确版本"
  type        = map(string)

  validation {
    condition = (
      length(setsubtract(
        toset(keys(var.managed_rule_versions)),
        toset(["amazon-ip-reputation", "common", "known-bad-inputs", "sqli"])
      )) == 0 &&
      length(setsubtract(
        toset(["amazon-ip-reputation", "common", "known-bad-inputs", "sqli"]),
        toset(keys(var.managed_rule_versions))
      )) == 0 &&
      alltrue([
        for version in values(var.managed_rule_versions) :
        can(regex("^Version_[0-9]+\\.[0-9]+$", version))
      ])
    )
    error_message = "API managed rule versions 必须精确包含四个规则键并使用 Version_x.y。"
  }
}

variable "rate_rule_rollouts" {
  description = "三条按来源 IP 的粗粒度 rate rule 分阶段状态；未经真实 NAT/出口流量校准不得 Block"
  type = map(object({
    action             = string
    evidence_reference = string
  }))

  validation {
    condition = (
      length(setsubtract(
        toset(keys(var.rate_rule_rollouts)),
        toset(["launch-rate-limit", "public-api-rate-limit", "spin-rate-limit"])
      )) == 0 &&
      length(setsubtract(
        toset(["launch-rate-limit", "public-api-rate-limit", "spin-rate-limit"]),
        toset(keys(var.rate_rule_rollouts))
      )) == 0 &&
      alltrue([
        for rollout in values(var.rate_rule_rollouts) :
        (rollout.action == "count" && rollout.evidence_reference == "observation-pending") ||
        (rollout.action == "block" &&
        can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", rollout.evidence_reference)))
      ])
    )
    error_message = "rate rule 必须精确包含 launch/public-api/spin；count 阶段声明 observation-pending，block 阶段绑定 s3://...?versionId=...#sha256 校准证据。"
  }
}

variable "header_size_rule_rollout" {
  description = "8 KiB aggregate header 规则的 Count→Block 状态；Block 前必须证明最大合法 token 与签名头集合可容纳"
  type = object({
    action             = string
    evidence_reference = string
  })

  validation {
    condition = (
      (var.header_size_rule_rollout.action == "count" &&
      var.header_size_rule_rollout.evidence_reference == "observation-pending") ||
      (var.header_size_rule_rollout.action == "block" &&
      can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}$", var.header_size_rule_rollout.evidence_reference)))
    )
    error_message = "header size rule 在 count 阶段声明 observation-pending；切到 block 必须绑定 s3://...?versionId=...#sha256 最大合法请求头证据。"
  }
}

variable "alarm_thresholds" {
  description = "WAF 一分钟攻击量与成本异常初始阈值"
  type = object({
    blocked_requests_per_minute = number
    allowed_requests_per_minute = number
  })

  validation {
    condition = (
      var.alarm_thresholds.blocked_requests_per_minute >= 1 &&
      var.alarm_thresholds.allowed_requests_per_minute >= 100 &&
      floor(var.alarm_thresholds.blocked_requests_per_minute) == var.alarm_thresholds.blocked_requests_per_minute &&
      floor(var.alarm_thresholds.allowed_requests_per_minute) == var.alarm_thresholds.allowed_requests_per_minute
    )
    error_message = "WAF 告警阈值必须是一分钟窗口内的正整数请求数。"
  }
}

variable "tags" {
  description = "统一资源标签"
  type        = map(string)
  default     = {}
}
