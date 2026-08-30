data "aws_region" "current" {}

locals {
  web_acl_name   = "${var.name_prefix}-api"
  web_acl_metric = replace("${var.name_prefix}-api", "-", "_")
  managed_rules = {
    amazon-ip-reputation = {
      name     = "AWSManagedRulesAmazonIpReputationList"
      priority = 10
    }
    common = {
      name     = "AWSManagedRulesCommonRuleSet"
      priority = 20
    }
    known-bad-inputs = {
      name     = "AWSManagedRulesKnownBadInputsRuleSet"
      priority = 30
    }
    sqli = {
      name     = "AWSManagedRulesSQLiRuleSet"
      priority = 40
    }
  }
}

resource "aws_wafv2_web_acl" "api" {
  name        = local.web_acl_name
  description = "公网 RGS ALB 的区域应用层 DDoS 与常见攻击防护"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.managed_rules
    content {
      name     = rule.key
      priority = rule.value.priority

      override_action {
        dynamic "count" {
          for_each = var.managed_rule_rollout.action == "count" ? [1] : []
          content {}
        }
        dynamic "none" {
          for_each = var.managed_rule_rollout.action == "block" ? [1] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
          version     = var.managed_rule_versions[rule.key]
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.web_acl_metric}_${replace(rule.key, "-", "_")}"
        sampled_requests_enabled   = false
      }
    }
  }

  # ALB target health check 直达 Pod 的 8081 operations listener，且不经过 WAF。因此公网 listener
  # 没有理由暴露这条未鉴权路径；应在它消耗源站连接或 goroutine 容量前于边缘拒绝。
  # ALB target health checks go directly to the Pod operations listener on 8081 and never
  # traverse WAF. The public listener therefore has no reason to expose this unauthenticated
  # path; reject it at the edge before it can consume origin connection or goroutine capacity.
  rule {
    name     = "public-healthz-block"
    priority = 1

    action {
      block {
        custom_response {
          response_code = 404
        }
      }
    }

    statement {
      byte_match_statement {
        positional_constraint = "EXACTLY"
        search_string         = "/healthz"

        field_to_match {
          uri_path {}
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_public_healthz_block"
      sampled_requests_enabled   = false
    }
  }

  # 已签名公网协议仅包含两个路径命名空间和三种传输方法。应在托管规则或源站前拒绝无关扫描请求。
  # 此处不应用 URI 转换，因此门禁不会改写应用签名所使用的规范路径。
  # The signed public protocol has only two path namespaces and three transport methods.
  # Reject unrelated scanners before managed rules or the origin. No URI transformation is
  # applied, so this gate does not rewrite the canonical path used by application signatures.
  rule {
    name     = "public-protocol-surface-block"
    priority = 5

    action {
      block {
        custom_response {
          response_code = 404
        }
      }
    }

    statement {
      not_statement {
        statement {
          and_statement {
            statement {
              or_statement {
                statement {
                  byte_match_statement {
                    positional_constraint = "STARTS_WITH"
                    search_string         = "/client/"

                    field_to_match {
                      uri_path {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "STARTS_WITH"
                    search_string         = "/operator/"

                    field_to_match {
                      uri_path {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }

            statement {
              or_statement {
                dynamic "statement" {
                  for_each = toset(["GET", "OPTIONS", "POST"])
                  content {
                    byte_match_statement {
                      positional_constraint = "EXACTLY"
                      search_string         = statement.value

                      field_to_match {
                        method {}
                      }

                      text_transformation {
                        priority = 0
                        type     = "NONE"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_protocol_surface_block"
      sampled_requests_enabled   = false
    }
  }

  # 所有已定义公网业务请求的最坏合法 JSON（包含 ASCII 的 \uXXXX 展开）小于 8 KiB。
  # ALB 的 WAF body 检查窗口固定为 8 KiB，因此超过窗口必须在边缘失败闭合；RGS 同时
  # 使用相同全局硬上限，避免分块传输或 WAF 规则漂移把大 body 推给 Go 解析器。
  # English: The worst-case legal JSON (including ASCII \uXXXX expansion) for all defined public service
  # requests is less than 8 KiB. ALB's WAF body inspection window is fixed at 8 KiB, so the exceeding window
  # must fail to close at the edge; RGS also Use the same global hard cap to avoid chunked transfers or WAF rule
  # drift pushing large bodies to the Go parser.
  rule {
    name     = "body-size-limit"
    priority = 50

    action {
      block {
        custom_response {
          response_code = 413
        }
      }
    }

    statement {
      size_constraint_statement {
        comparison_operator = "GT"
        size                = 8192

        field_to_match {
          body {
            oversize_handling = "MATCH"
          }
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_body_size"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "header-size-limit"
    priority = 60

    action {
      dynamic "count" {
        for_each = var.header_size_rule_rollout.action == "count" ? [1] : []
        content {}
      }
      dynamic "block" {
        for_each = var.header_size_rule_rollout.action == "block" ? [1] : []
        content {
          custom_response {
            response_code = 431
          }
        }
      }
    }

    statement {
      size_constraint_statement {
        comparison_operator = "GT"
        size                = 8192

        field_to_match {
          headers {
            match_scope       = "ALL"
            oversize_handling = "MATCH"

            match_pattern {
              all {}
            }
          }
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_header_size"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "launch-rate-limit"
    priority = 100

    action {
      dynamic "count" {
        for_each = var.rate_rule_rollouts["launch-rate-limit"].action == "count" ? [1] : []
        content {}
      }
      dynamic "block" {
        for_each = var.rate_rule_rollouts["launch-rate-limit"].action == "block" ? [1] : []
        content {
          custom_response {
            response_code = 429
            response_header {
              name  = "Retry-After"
              value = "30"
            }
            response_header {
              name  = "Access-Control-Allow-Origin"
              value = "*"
            }
            response_header {
              name  = "Access-Control-Expose-Headers"
              value = "Retry-After, X-RGS-Edge-Error"
            }
            response_header {
              name  = "X-RGS-Edge-Error"
              value = "RATE_LIMITED"
            }
          }
        }
      }
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 60
        limit                 = var.rate_limits.launch_requests_per_minute

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "/operator/v1/launches"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "POST"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_launch_rate"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "spin-rate-limit"
    priority = 110

    action {
      dynamic "count" {
        for_each = var.rate_rule_rollouts["spin-rate-limit"].action == "count" ? [1] : []
        content {}
      }
      dynamic "block" {
        for_each = var.rate_rule_rollouts["spin-rate-limit"].action == "block" ? [1] : []
        content {
          custom_response {
            response_code = 429
            response_header {
              name  = "Retry-After"
              value = "30"
            }
            response_header {
              name  = "Access-Control-Allow-Origin"
              value = "*"
            }
            response_header {
              name  = "Access-Control-Expose-Headers"
              value = "Retry-After, X-RGS-Edge-Error"
            }
            response_header {
              name  = "X-RGS-Edge-Error"
              value = "RATE_LIMITED"
            }
          }
        }
      }
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 60
        limit                 = var.rate_limits.spin_requests_per_minute

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "/client/v1/spins"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                positional_constraint = "EXACTLY"
                search_string         = "POST"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_spin_rate"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "public-api-rate-limit"
    priority = 120

    action {
      dynamic "count" {
        for_each = var.rate_rule_rollouts["public-api-rate-limit"].action == "count" ? [1] : []
        content {}
      }
      dynamic "block" {
        for_each = var.rate_rule_rollouts["public-api-rate-limit"].action == "block" ? [1] : []
        content {
          custom_response {
            response_code = 429
            response_header {
              name  = "Retry-After"
              value = "30"
            }
            response_header {
              name  = "Access-Control-Allow-Origin"
              value = "*"
            }
            response_header {
              name  = "Access-Control-Expose-Headers"
              value = "Retry-After, X-RGS-Edge-Error"
            }
            response_header {
              name  = "X-RGS-Edge-Error"
              value = "RATE_LIMITED"
            }
          }
        }
      }
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 60
        limit                 = var.rate_limits.public_requests_per_minute

        scope_down_statement {
          and_statement {
            statement {
              or_statement {
                statement {
                  byte_match_statement {
                    positional_constraint = "STARTS_WITH"
                    search_string         = "/client/"

                    field_to_match {
                      uri_path {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "STARTS_WITH"
                    search_string         = "/operator/"

                    field_to_match {
                      uri_path {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }

            statement {
              or_statement {
                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "GET"

                    field_to_match {
                      method {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "OPTIONS"

                    field_to_match {
                      method {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    positional_constraint = "EXACTLY"
                    search_string         = "POST"

                    field_to_match {
                      method {}
                    }

                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.web_acl_metric}_public_api_rate"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.web_acl_metric
    sampled_requests_enabled   = false
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${var.name_prefix}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "api" {
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.api.arn

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "x-rgs-signature"
    }
  }

  redacted_fields {
    single_header {
      name = "signature"
    }
  }

  redacted_fields {
    single_header {
      name = "signature-input"
    }
  }

  redacted_fields {
    single_header {
      name = "idempotency-key"
    }
  }

  redacted_fields {
    single_header {
      name = "x-nonce"
    }
  }

  # 正式 RGS 协议不使用 query；完整脱敏可防攻击者把 token/签名塞进 query 制造日志泄漏。
  # URI path 与 method 仍保留，供规则调优和事件响应使用。
  # English: The production RGS protocol does not use query strings. Full redaction prevents attackers from
  # placing tokens or signatures in a query to create log leaks; the URI path and method remain available for
  # rule tuning and incident response.
  redacted_fields {
    query_string {}
  }

  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"

      condition {
        action_condition {
          action = "BLOCK"
        }
      }

      condition {
        action_condition {
          action = "COUNT"
        }
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  alarm_name          = "${var.name_prefix}-waf-blocked-requests"
  alarm_description   = "区域 WAF 一分钟拒绝量超过经容量校准的阈值"
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  period              = 60
  threshold           = var.alarm_thresholds.blocked_requests_per_minute
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    Region = data.aws_region.current.region
    Rule   = "ALL"
    # AWS/WAFV2 使用 visibility_config.metric_name 发布 WebACL 维度，而不是资源名称。
    # 两者刻意保持不同，并由契约测试锁定。
    # AWS/WAFV2 publishes the WebACL dimension using visibility_config.metric_name,
    # not the resource name. Keeping these distinct is intentional and contract-tested.
    WebACL = local.web_acl_metric
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "waf_allowed_requests" {
  alarm_name          = "${var.name_prefix}-waf-allowed-request-cost"
  alarm_description   = "区域 WAF 一分钟放行量超过成本与源站容量预算"
  namespace           = "AWS/WAFV2"
  metric_name         = "AllowedRequests"
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  period              = 60
  threshold           = var.alarm_thresholds.allowed_requests_per_minute
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    Region = data.aws_region.current.region
    Rule   = "ALL"
    WebACL = local.web_acl_metric
  }

  tags = var.tags
}
