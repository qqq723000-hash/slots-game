#!/bin/sh
# 在 VPC 内受保护执行器上验证集群 add-on；本脚本不会安装或修改任何资源。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
delivery_json=${1:-}
application_namespace=${2:-slots-production}
kubectl_binary=${KUBECTL_BIN:-kubectl}
aws_binary=${AWS_BIN:-aws}
rollout_timeout=${PLATFORM_ROLLOUT_TIMEOUT:-5m}

fail() {
  printf '%s\n' "AWS 平台前置门禁: $*" >&2
  exit 1
}

test -n "$delivery_json" || fail '用法: verify-live-platform-prerequisites.sh <terraform-output-delivery.json> [应用 namespace]'
test -f "$delivery_json" || fail "找不到 Terraform delivery JSON: $delivery_json"
case "$application_namespace" in
  ''|*[!a-z0-9-]*|-*|*-) fail '应用 namespace 不合法' ;;
esac
test "${#application_namespace}" -le 63 || fail '应用 namespace 超过 63 字符'
command -v ruby >/dev/null 2>&1 || fail '缺少 ruby'
command -v "$kubectl_binary" >/dev/null 2>&1 || fail "缺少命令 $kubectl_binary"
command -v "$aws_binary" >/dev/null 2>&1 || fail "缺少命令 $aws_binary"

ruby -rjson -ruri -e '
  value = JSON.parse(File.binread(ARGV.fetch(0)))
  expected_namespace = ARGV.fetch(1)
  handoff = value.fetch("application_handoff")
  abort "前置契约版本不受支持" unless handoff.fetch("contract_version") == "1.0.0"
  abort "基础设施输出错误宣称应用已就绪" unless handoff.fetch("foundation_apply_is_application_ready") == false
  abort "缺少私网执行器强制条件" unless handoff.fetch("private_vpc_runner_required") == true
  abort "应用发布状态在 delivery 与 handoff 之间不一致" unless
    handoff.fetch("application_release_allowed") == value.fetch("application_release_allowed") &&
    handoff.fetch("maintenance_in_progress") == value.fetch("maintenance_in_progress")
  abort "ALB SG target egress 端口合同不完整" unless
    value.fetch("alb_egress_target_ports") == [8080, 8081] &&
      handoff.fetch("alb_egress_target_ports") == [8080, 8081]
  abort "ALB SG 或公网子网 delivery 不合法" unless
    value.fetch("alb_security_group_id").match?(/\Asg-[0-9a-f]+\z/) &&
      value.fetch("public_subnet_ids").is_a?(Array) &&
      value.fetch("public_subnet_ids").length == 3 &&
      value.fetch("public_subnet_ids").uniq.length == 3 &&
      value.fetch("public_subnet_ids").all? { |subnet| subnet.match?(/\Asubnet-[0-9a-f]+\z/) } &&
      value.fetch("public_subnet_cidrs").is_a?(Array) &&
      value.fetch("public_subnet_cidrs").length == 3 &&
      value.fetch("public_subnet_cidrs").uniq.length == 3 &&
      value.fetch("public_subnet_cidrs").all? { |cidr| cidr.match?(/\A(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}\z/) }
  abort "ALB regional ACM 或 TLS policy delivery 不合法" unless
    value.fetch("regional_acm_certificate_arn").match?(%r{\Aarn:(aws|aws-us-gov):acm:#{Regexp.escape(value.fetch("aws_region"))}:#{value.fetch("aws_account_id")}:certificate/[0-9a-f-]{36}\z}) &&
      value.fetch("api_alb_tls_policy") == "ELBSecurityPolicy-TLS13-1-2-2021-06" &&
      handoff.fetch("api_alb_tls_policy") == value.fetch("api_alb_tls_policy")
  abort "ALB access log bucket/prefix delivery 未精确绑定 handoff" unless
    value.fetch("alb_access_log_bucket_name").match?(/\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\z/) &&
      value.fetch("alb_access_log_prefix").match?(%r{\A[a-z0-9][a-z0-9/_-]{1,127}\z}) &&
      handoff.fetch("alb_access_logs") == {
        "bucket" => value.fetch("alb_access_log_bucket_name"),
        "prefix" => value.fetch("alb_access_log_prefix"),
      }

  expected = %w[
    aws-load-balancer-controller
    cluster-autoscaler
    external-secrets
    kube-prometheus-stack
    prometheus-agent
  ].sort
  versions = handoff.fetch("addon_versions")
  abort "集群 add-on 集合不完整" unless versions.keys.sort == expected
  versions.each do |name, version|
    abort "#{name} 没有精确 SemVer" unless version.match?(/\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\z/)
  end

  autoscaler_tag = handoff.fetch("cluster_autoscaler_image_tag")
  abort "Cluster Autoscaler 镜像没有使用精确版本" unless autoscaler_tag.match?(/\Av1\.[0-9]{2}\.[0-9]+\z/)
  abort "Cluster Autoscaler 与 Kubernetes 主次版本不匹配" unless
    autoscaler_tag.start_with?("v#{handoff.fetch("kubernetes_version")}.")

  metrics_server_version = handoff.fetch("metrics_server_addon_version")
  abort "metrics-server 没有使用精确 EKS add-on 版本" unless
    metrics_server_version.match?(/\Av[0-9]+\.[0-9]+\.[0-9]+-eksbuild\.[0-9]+\z/)
  vpc_cni = handoff.fetch("vpc_cni_network_policy")
  abort "vpc-cni NetworkPolicy delivery 键集合不精确" unless
    vpc_cni.keys.sort == %w[addon_name addon_version configuration_values expected_status pod_identity]
  abort "vpc-cni NetworkPolicy add-on 版本、状态或配置合同不合法" unless
    vpc_cni.fetch("addon_name") == "vpc-cni" &&
      vpc_cni.fetch("addon_version").match?(/\Av[0-9]+\.[0-9]+\.[0-9]+-eksbuild\.[0-9]+\z/) &&
      vpc_cni.fetch("expected_status") == "ACTIVE" &&
      vpc_cni.fetch("configuration_values") == {"enableNetworkPolicy" => "true"}
  vpc_cni_identity = vpc_cni.fetch("pod_identity")
  abort "vpc-cni aws-node Pod Identity delivery 不合法" unless
    vpc_cni_identity.keys.sort == %w[namespace role_arn service_account] &&
      vpc_cni_identity.fetch("namespace") == "kube-system" &&
      vpc_cni_identity.fetch("service_account") == "aws-node" &&
      vpc_cni_identity.fetch("role_arn").match?(%r{\Aarn:(aws|aws-us-gov):iam::#{value.fetch("aws_account_id")}:role/.+\z})
  cloudwatch = handoff.fetch("cloudwatch_observability")
  abort "CloudWatch Observability delivery 键集合不精确" unless
    cloudwatch.keys.sort == %w[addon_name addon_version configuration_values expected_status pod_identity workloads]
  expected_cloudwatch_configuration = {
    "agent" => {"config" => {"logs" => {"metrics_collected" => {
      "kubernetes" => {"enhanced_container_insights" => true},
    }}}},
    "containerLogs" => {"enabled" => true},
  }
  abort "CloudWatch Observability add-on 版本、状态或配置合同不合法" unless
    cloudwatch.fetch("addon_name") == "amazon-cloudwatch-observability" &&
      cloudwatch.fetch("addon_version").match?(/\Av[0-9]+\.[0-9]+\.[0-9]+-eksbuild\.[0-9]+\z/) &&
      cloudwatch.fetch("expected_status") == "ACTIVE" &&
      cloudwatch.fetch("configuration_values") == expected_cloudwatch_configuration
  cloudwatch_identity = cloudwatch.fetch("pod_identity")
  abort "CloudWatch Agent Pod Identity delivery 不合法" unless
    cloudwatch_identity.keys.sort == %w[namespace role_arn service_account] &&
      cloudwatch_identity.fetch("namespace") == "amazon-cloudwatch" &&
      cloudwatch_identity.fetch("service_account") == "cloudwatch-agent" &&
      cloudwatch_identity.fetch("role_arn").match?(%r{\Aarn:(aws|aws-us-gov):iam::#{value.fetch("aws_account_id")}:role/.+\z})
  abort "CloudWatch Observability workload delivery 不合法" unless
    cloudwatch.fetch("workloads") == [
      {
        "namespace" => "amazon-cloudwatch", "kind" => "DaemonSet",
        "name" => "cloudwatch-agent", "minimum_pods" => 1,
        "service_account" => "cloudwatch-agent", "container_name" => "cloudwatch-agent",
      },
      {
        "namespace" => "amazon-cloudwatch", "kind" => "DaemonSet",
        "name" => "fluent-bit", "minimum_pods" => 1,
        "service_account" => "fluent-bit", "container_name" => "fluent-bit",
      },
    ]
  expected_deployments = {
    "aws_load_balancer_controller" => "kube-system/aws-load-balancer-controller",
    "cluster_autoscaler" => "kube-system/cluster-autoscaler",
    "external_secrets" => "external-secrets/external-secrets",
    "kube_state_metrics" => "monitoring/kube-prometheus-stack-kube-state-metrics",
    "metrics_server" => "kube-system/metrics-server",
    "prometheus_operator" => "monitoring/kube-prometheus-stack-operator",
  }
  abort "必需 Deployment 名称契约不完整" unless handoff.fetch("required_deployments") == expected_deployments
  abort "资源指标 APIService 名称契约不匹配" unless
    handoff.fetch("required_api_services") == { "resource_metrics" => "v1beta1.metrics.k8s.io" }
  abort "kube-state-metrics Helm release 名称契约不匹配" unless
    handoff.fetch("kube_state_metrics_release_name") == "kube-prometheus-stack"
  abort "应用 namespace 与受保护流水线输入不一致" unless
    value.fetch("application_namespace") == expected_namespace &&
    handoff.fetch("application_namespace") == expected_namespace
  abort "Helm release 名契约不合法" unless
    value.fetch("helm_release_name") == handoff.fetch("helm_release_name") &&
    value.fetch("helm_release_name").match?(/\A[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?\z/)

  edge = value.fetch("api_edge_security_contract")
  abort "API 边缘安全合同在 delivery 与 handoff 之间不一致" unless
    edge == handoff.fetch("api_edge_security")
  expected_waf_arn = value.fetch("api_waf_web_acl_arn")
  abort "API 区域 WAF ARN 不合法或与合同不一致" unless
    expected_waf_arn.match?(%r{\Aarn:(aws|aws-us-gov):wafv2:#{Regexp.escape(value.fetch("aws_region"))}:#{value.fetch("aws_account_id")}:regional/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+\z}) &&
    edge.fetch("web_acl_arn") == expected_waf_arn
  abort "API 公网入口权威模型错误" unless
    edge.fetch("contract_version") == "1.0.0" &&
      edge.fetch("authoritative_public_entry") == "internet-facing-alb" &&
      edge.fetch("web_acl_scope") == "REGIONAL" &&
      edge.fetch("default_action") == "ALLOW" &&
      edge.fetch("shield_standard_automatic") == true &&
      edge.fetch("cloudfront_is_api_proxy") == false &&
      edge.fetch("origin_bypass_model") == "not-applicable-alb-is-authoritative-origin"
  abort "API WAF 资源名与 CloudWatch metric dimension 合同未显式分离" unless
    edge.fetch("web_acl_name").is_a?(String) && !edge.fetch("web_acl_name").empty? &&
      edge.fetch("web_acl_metric_name").is_a?(String) && !edge.fetch("web_acl_metric_name").empty?
  valid_rollout = lambda do |rollout|
    (rollout == {"action" => "count", "evidence_reference" => "observation-pending"}) ||
      (rollout.fetch("action") == "block" &&
        rollout.fetch("evidence_reference").match?(%r{\As3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#]+\?versionId=[A-Za-z0-9._~+/=-]{1,1024}#[0-9a-f]{64}\z}))
  end
  abort "API body 边缘限制没有失败闭合" unless
    edge.fetch("body_inspection_limit_bytes") == 8192 &&
      edge.fetch("application_body_limit_bytes") == 8192 &&
      edge.fetch("oversized_body_action") == "BLOCK_AT_WAF_AND_APPLICATION" &&
      edge.fetch("required_size_rule_names").sort == %w[body-size-limit header-size-limit]
  abort "API 公网 health path 没有在 WAF 失败闭合或 ALB 探针端口错误" unless
    edge.fetch("public_health_path") == "/healthz" &&
      edge.fetch("public_health_path_action") == "BLOCK_AT_WAF" &&
      edge.fetch("alb_target_health_port") == 8081 &&
      edge.fetch("required_path_rule_names").sort == %w[
        public-healthz-block public-protocol-surface-block
      ] &&
      edge.fetch("allowed_public_path_prefixes") == ["/client/", "/operator/"] &&
      edge.fetch("allowed_public_methods") == %w[GET OPTIONS POST]
  abort "API aggregate header 规则阶段或最大合法请求头证据不合法" unless
    valid_rollout.call(edge.fetch("header_size_rule_rollout"))
  abort "API WAF 日志合同没有要求 query string 全量脱敏" unless
    edge.fetch("query_string_redacted") == true &&
      edge.fetch("sampled_requests_enabled") == false
  abort "API WAF managed/rate 规则合同不完整" unless
    edge.fetch("required_managed_rule_groups").sort == %w[
      AWSManagedRulesAmazonIpReputationList
      AWSManagedRulesCommonRuleSet
      AWSManagedRulesKnownBadInputsRuleSet
      AWSManagedRulesSQLiRuleSet
    ].sort &&
      edge.fetch("required_rate_rule_names").sort == %w[
        launch-rate-limit public-api-rate-limit spin-rate-limit
      ] &&
      edge.fetch("low_rate_rule_method") == "POST" &&
      edge.fetch("public_rate_rule_methods") == %w[GET OPTIONS POST] &&
      edge.fetch("rate_limit_response") == {
        "status_code" => 429,
        "retry_after_seconds" => 30,
        "access_control_allow_origin" => "*",
        "access_control_expose_header" => "Retry-After, X-RGS-Edge-Error",
        "edge_error_header" => "X-RGS-Edge-Error",
        "edge_error_value" => "RATE_LIMITED",
      }
  api_managed_versions = edge.fetch("managed_rule_versions")
  abort "API managed rule 精确版本或 evidence KMS key 合同不完整" unless
    api_managed_versions.keys.sort == %w[amazon-ip-reputation common known-bad-inputs sqli] &&
      api_managed_versions.values.all? { |version| version.match?(/\AVersion_[0-9]+\.[0-9]+\z/) } &&
      edge.fetch("evidence_kms_key_arn").match?(%r{\Aarn:(aws|aws-us-gov):kms:#{Regexp.escape(value.fetch("aws_region"))}:#{value.fetch("aws_account_id")}:key/[0-9a-f-]{36}\z})
  rate_rollouts = edge.fetch("rate_rule_rollouts")
  abort "API rate rules Count→Block 状态或校准证据不完整" unless
    rate_rollouts.keys.sort == edge.fetch("required_rate_rule_names").sort &&
      rate_rollouts.values.all? { |rollout| valid_rollout.call(rollout) }
  api_rollout = edge.fetch("managed_rule_rollout")
  abort "API managed rules Count→Block 状态或证据引用不合法" unless
    valid_rollout.call(api_rollout)

  web_edge = value.fetch("cloudfront_edge_security_contract")
  abort "CloudFront 边缘安全合同在 delivery 与 handoff 之间不一致" unless
    web_edge == handoff.fetch("cloudfront_edge_security")
  global_waf_arn = value.fetch("cloudfront_waf_web_acl_arn")
  abort "CloudFront global WAF ARN 不合法或与合同不一致" unless
    global_waf_arn.match?(%r{\Aarn:(aws|aws-us-gov):wafv2:us-east-1:#{value.fetch("aws_account_id")}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+\z}) &&
      web_edge.fetch("web_acl_arn") == global_waf_arn
  abort "CloudFront 静态 Web 权威入口或私有源站模型错误" unless
    web_edge.fetch("contract_version") == "1.0.0" &&
      web_edge.fetch("authoritative_public_entry") == "cloudfront" &&
      web_edge.fetch("origin_type") == "private-s3-oac" &&
      web_edge.fetch("origin_public_access_blocked") == true &&
      web_edge.fetch("api_proxy") == false &&
      web_edge.fetch("viewer_http_version") == "http2and3" &&
      web_edge.fetch("web_acl_scope") == "CLOUDFRONT" &&
      web_edge.fetch("waf_ownership") == "enterprise-platform" &&
      web_edge.fetch("waf_home_region") == "us-east-1" &&
      web_edge.fetch("shield_standard_automatic") == true &&
      web_edge.fetch("route53_alias_ownership") == "enterprise-platform"
  abort "CloudFront WAF managed/rate/logging 合同不完整" unless
    web_edge.fetch("required_managed_rule_groups").sort == %w[
      AWSManagedRulesAmazonIpReputationList
      AWSManagedRulesCommonRuleSet
      AWSManagedRulesKnownBadInputsRuleSet
    ].sort &&
      web_edge.fetch("required_rate_rule_names") == ["web-rate-limit"] &&
      web_edge.fetch("rate_limit_per_minute").is_a?(Integer) &&
      web_edge.fetch("rate_limit_per_minute") >= 100 &&
      web_edge.fetch("waf_log_filter") == "BLOCK_AND_COUNT_ONLY" &&
      web_edge.fetch("query_string_redacted") == true &&
      web_edge.fetch("sampled_requests_enabled") == false &&
      web_edge.fetch("web_acl_metric_name").match?(/\A[A-Za-z0-9_-]{1,128}\z/) &&
      web_edge.fetch("rule_metric_names").keys.sort == %w[
        amazon-ip-reputation common known-bad-inputs web-rate-limit
      ] && web_edge.fetch("rule_metric_names").values.uniq.length == 4 &&
      web_edge.fetch("rule_metric_names").values.all? { |name| name.match?(/\A[A-Za-z0-9_-]{1,128}\z/) }
  web_managed_versions = web_edge.fetch("managed_rule_versions")
  abort "CloudFront managed rule 精确版本或 evidence KMS key 合同不完整" unless
    web_managed_versions.keys.sort == %w[amazon-ip-reputation common known-bad-inputs] &&
      web_managed_versions.values.all? { |version| version.match?(/\AVersion_[0-9]+\.[0-9]+\z/) } &&
      web_edge.fetch("evidence_kms_key_arn") == edge.fetch("evidence_kms_key_arn")
  web_rollout = web_edge.fetch("managed_rule_rollout")
  abort "CloudFront managed rules Count→Block 状态或证据引用不合法" unless
    valid_rollout.call(web_rollout)
  abort "CloudFront rate rule Count→Block 状态或校准证据不合法" unless
    valid_rollout.call(web_edge.fetch("rate_rule_rollout"))

  rds = value.fetch("rds_alarm_contract")
  abort "RDS 告警合同键集合不精确" unless rds.keys.sort == %w[
    alarm_names alert_topic_arn contract_version database_topology db_instance_identifier
    deadlock_evidence deadlock_metric_filter metrics missing_data_policy multi_az namespace
  ]
  abort "RDS 告警合同身份或单实例拓扑不合法" unless
    rds.fetch("contract_version") == "2.0.0" &&
      rds.fetch("database_topology") == "single-db-instance" &&
      [true, false].include?(rds.fetch("multi_az")) &&
      rds.fetch("namespace") == "AWS/RDS" &&
      rds.fetch("db_instance_identifier") == "#{value.fetch("cluster_name")}-postgresql" &&
      rds.fetch("alert_topic_arn") == value.fetch("alert_topic_arn") &&
      rds.fetch("missing_data_policy") == "notBreaching"
  deadlock_filter = rds.fetch("deadlock_metric_filter")
  abort "PostgreSQL deadlock 日志 metric filter 合同不合法" unless
    deadlock_filter.keys.sort == %w[
      default_value filter_name filter_pattern log_group_name metric_name metric_namespace metric_value unit
    ] &&
      deadlock_filter.fetch("filter_name") == "#{rds.fetch("db_instance_identifier")}-deadlock-detected" &&
      deadlock_filter.fetch("log_group_name") ==
        "/aws/rds/instance/#{rds.fetch("db_instance_identifier")}/postgresql" &&
      deadlock_filter.fetch("filter_pattern") == %q{"deadlock detected"} &&
      deadlock_filter.fetch("metric_namespace") == "Slots/RDSLogEvents" &&
      deadlock_filter.fetch("metric_name") == "#{rds.fetch("db_instance_identifier")}-deadlock-detected" &&
      deadlock_filter.fetch("metric_value") == "1" && deadlock_filter.fetch("default_value") == 0 &&
      deadlock_filter.fetch("unit") == "Count"
  expected_single_rds_units = {
    "CPUUtilization" => "Percent", "DatabaseConnections" => "Count", "Deadlocks" => "Count",
    "DiskQueueDepth" => "Count", "FreeableMemory" => "Bytes", "FreeStorageSpace" => "Bytes",
    "ReadLatency" => "Seconds", "SwapUsage" => "Bytes", "WriteLatency" => "Seconds",
  }
  expected_single_rds_statistics = {
    "CPUUtilization" => "Average", "DatabaseConnections" => "Maximum", "Deadlocks" => "Sum",
    "DiskQueueDepth" => "Maximum", "FreeableMemory" => "Minimum", "FreeStorageSpace" => "Minimum",
    "ReadLatency" => "Average", "SwapUsage" => "Maximum", "WriteLatency" => "Average",
  }
  expected_math_rds = {
    "TotalIOPS" => {
      "unit" => "Count/Second", "label" => "Total RDS IOPS",
      "sources" => {"m1" => "ReadIOPS", "m2" => "WriteIOPS"},
    },
    "TotalThroughput" => {
      "unit" => "Bytes/Second", "label" => "Total RDS throughput",
      "sources" => {"m1" => "ReadThroughput", "m2" => "WriteThroughput"},
    },
  }
  rds_metrics = rds.fetch("metrics")
  expected_rds_metric_names = expected_single_rds_units.keys + expected_math_rds.keys
  abort "RDS 告警指标集合缺失、夹带 ReplicaLag/虚构原生 Total 指标或名称重复" unless
    rds_metrics.keys.sort == expected_rds_metric_names.sort &&
      rds.fetch("alarm_names").sort == rds_metrics.values.map { |metric| metric.fetch("alarm_name") }.sort &&
      rds.fetch("alarm_names").uniq.length == expected_rds_metric_names.length
  rds_metrics.each do |metric_name, metric|
    if expected_math_rds.key?(metric_name)
      expected_math = expected_math_rds.fetch(metric_name)
      abort "#{metric_name} metric-math 告警合同键集合不精确" unless metric.keys.sort == %w[
        alarm_name comparison_operator datapoints_to_alarm evaluation_periods metric_data_queries
        period_seconds threshold treat_missing_data unit
      ]
      abort "#{metric_name} metric-math 告警阈值、单位或窗口不合法" unless
        metric.fetch("alarm_name").start_with?("#{rds.fetch("db_instance_identifier")}-") &&
          metric.fetch("unit") == expected_math.fetch("unit") &&
          metric.fetch("threshold").is_a?(Numeric) && metric.fetch("threshold") > 0 &&
          metric.fetch("comparison_operator") == "GreaterThanOrEqualToThreshold" &&
          metric.fetch("period_seconds") == 60 && metric.fetch("evaluation_periods") == 3 &&
          metric.fetch("datapoints_to_alarm") == 2 && metric.fetch("treat_missing_data") == "notBreaching"
      queries = metric.fetch("metric_data_queries")
      abort "#{metric_name} metric-math query 数量或 ID 不精确" unless
        queries.is_a?(Array) && queries.length == 3 && queries.map { |query| query.fetch("id") }.sort == %w[e1 m1 m2]
      queries_by_id = queries.to_h { |query| [query.fetch("id"), query] }
      expression = queries_by_id.fetch("e1")
      abort "#{metric_name} metric-math expression 或 ReturnData 漂移" unless
        expression.keys.sort == %w[expression id label return_data] &&
          expression.fetch("expression") == "m1 + m2" && expression.fetch("label") == expected_math.fetch("label") &&
          expression.fetch("return_data") == true
      expected_math.fetch("sources").each do |id, source_metric_name|
        source = queries_by_id.fetch(id)
        abort "#{metric_name}/#{id} metric-math source 合同漂移" unless
          source.keys.sort == %w[
            dimension_name dimension_value id metric_name namespace period_seconds return_data statistic unit
          ] && source.fetch("metric_name") == source_metric_name && source.fetch("namespace") == "AWS/RDS" &&
            source.fetch("statistic") == "Average" && source.fetch("unit") == expected_math.fetch("unit") &&
            source.fetch("period_seconds") == 60 && source.fetch("dimension_name") == "DBInstanceIdentifier" &&
            source.fetch("dimension_value") == rds.fetch("db_instance_identifier") && source.fetch("return_data") == false
      end
      next
    end
    abort "#{metric_name} RDS 告警合同键集合不精确" unless metric.keys.sort == %w[
      alarm_name comparison_operator datapoints_to_alarm evaluation_periods period_seconds
      statistic threshold treat_missing_data unit
    ]
    low_capacity = %w[FreeableMemory FreeStorageSpace].include?(metric_name)
    abort "#{metric_name} RDS 告警单位、阈值或比较方向不合法" unless
      metric.fetch("alarm_name").start_with?("#{rds.fetch("db_instance_identifier")}-") &&
        metric.fetch("statistic") == expected_single_rds_statistics.fetch(metric_name) &&
        metric.fetch("unit") == expected_single_rds_units.fetch(metric_name) &&
        metric.fetch("threshold").is_a?(Numeric) && metric.fetch("threshold") > 0 &&
        metric.fetch("comparison_operator") ==
          (low_capacity ? "LessThanOrEqualToThreshold" : "GreaterThanOrEqualToThreshold") &&
        metric.fetch("period_seconds") == 60 && metric.fetch("treat_missing_data") == "notBreaching"
    if metric_name == "Deadlocks"
      abort "Deadlocks 必须单次 Sum 观测即告警" unless
        metric.fetch("threshold") == 1 && metric.fetch("evaluation_periods") == 1 &&
          metric.fetch("datapoints_to_alarm") == 1
    else
      abort "#{metric_name} 容量告警必须保持 2/3 debounce" unless
        metric.fetch("evaluation_periods") == 3 && metric.fetch("datapoints_to_alarm") == 2
    end
  end
  deadlock_evidence = rds.fetch("deadlock_evidence")
  abort "Deadlocks 日志证据外部门禁没有显式保留" unless
    deadlock_evidence.keys.sort == %w[
      alarm_name automatic_snapshot_implemented external_evidence_consumer_required postgresql_log_group_name
    ] && deadlock_evidence.fetch("alarm_name") == rds_metrics.fetch("Deadlocks").fetch("alarm_name") &&
      deadlock_evidence.fetch("postgresql_log_group_name") ==
        deadlock_filter.fetch("log_group_name") &&
      deadlock_evidence.fetch("automatic_snapshot_implemented") == false &&
      deadlock_evidence.fetch("external_evidence_consumer_required") == true

  read_scaling = value.fetch("rds_read_scaling_contract")
  abort "RDS 读扩展合同键集合不精确" unless read_scaling.keys.sort == %w[
    alarm_names alert_topic_arn application_routing_adopted backup_retention_days
    connection_pooler_implemented contract_version cross_region_dr_implemented
    db_subnet_group_name deletion_protection enabled engine_version expected_kms_key_arn
    expected_storage_encrypted instance_class live_inheritance_check_required log_group_names
    max_allocated_storage_gib metrics minimum_allocated_storage_gib parameter_group_name port
    rds_proxy_implemented read_replica_is_backup
    reader_db_instance_identifier reader_endpoint reader_multi_az same_region_kms_inheritance
    same_region_only source_db_instance_identifier source_multi_az storage_type topology vpc_security_group_ids
  ]
  abort "RDS 读扩展必须保持同区域、非 DR、非代理且应用未采用的边界" unless
    read_scaling.fetch("contract_version") == "1.0.0" &&
      [true, false].include?(read_scaling.fetch("enabled")) &&
      read_scaling.fetch("same_region_only") == true &&
      read_scaling.fetch("source_db_instance_identifier") == rds.fetch("db_instance_identifier") &&
      read_scaling.fetch("source_multi_az") == rds.fetch("multi_az") &&
      read_scaling.fetch("port") == 5432 &&
      read_scaling.fetch("application_routing_adopted") == false &&
      read_scaling.fetch("connection_pooler_implemented") == false &&
      read_scaling.fetch("rds_proxy_implemented") == false &&
      read_scaling.fetch("cross_region_dr_implemented") == false &&
      read_scaling.fetch("read_replica_is_backup") == false &&
      read_scaling.fetch("same_region_kms_inheritance") == true &&
      read_scaling.fetch("expected_storage_encrypted") == true &&
      read_scaling.fetch("alert_topic_arn") == value.fetch("alert_topic_arn") &&
      read_scaling.fetch("expected_kms_key_arn").match?(%r{\Aarn:(aws|aws-us-gov):kms:#{value.fetch("aws_region")}:#{value.fetch("aws_account_id")}:key/[0-9a-f-]{36}\z}) &&
      read_scaling.fetch("db_subnet_group_name") == rds.fetch("db_instance_identifier") &&
      read_scaling.fetch("parameter_group_name").start_with?("#{rds.fetch("db_instance_identifier")}-") &&
      read_scaling.fetch("vpc_security_group_ids").is_a?(Array) &&
      read_scaling.fetch("vpc_security_group_ids").length == 1 &&
      read_scaling.fetch("vpc_security_group_ids").fetch(0).match?(/\Asg-[0-9a-f]{17}\z/) &&
      value.key?("rds_reader_endpoint")
  if read_scaling.fetch("enabled")
    reader_identifier = "#{rds.fetch("db_instance_identifier")}-reader"
    abort "启用的 RDS 只读副本 identity、继承回读或 endpoint 合同不合法" unless
      read_scaling.fetch("topology") == "single-writer-one-same-region-read-replica" &&
        read_scaling.fetch("reader_db_instance_identifier") == reader_identifier &&
        read_scaling.fetch("reader_endpoint") == value.fetch("rds_reader_endpoint") &&
        read_scaling.fetch("reader_endpoint").match?(%r{\A[a-z0-9.-]+\.rds\.amazonaws\.com\z}) &&
        [true, false].include?(read_scaling.fetch("reader_multi_az")) &&
        (!value.fetch("environment").start_with?("prod-") || read_scaling.fetch("reader_multi_az") == true) &&
        read_scaling.fetch("engine_version").match?(/\A[0-9]+\.[0-9]+\z/) &&
        read_scaling.fetch("instance_class").match?(/\Adb\.[a-z0-9.-]+\z/) &&
        read_scaling.fetch("storage_type") == "gp3" &&
        read_scaling.fetch("minimum_allocated_storage_gib").is_a?(Integer) &&
        read_scaling.fetch("minimum_allocated_storage_gib") >= 20 &&
        read_scaling.fetch("max_allocated_storage_gib").is_a?(Integer) &&
        read_scaling.fetch("max_allocated_storage_gib") >=
          read_scaling.fetch("minimum_allocated_storage_gib") * 2 &&
        read_scaling.fetch("backup_retention_days").is_a?(Integer) &&
        read_scaling.fetch("backup_retention_days").between?(7, 35) &&
        read_scaling.fetch("deletion_protection") == true &&
        read_scaling.fetch("live_inheritance_check_required") == true &&
        read_scaling.fetch("log_group_names").sort == %W[
          /aws/rds/instance/#{reader_identifier}/postgresql
          /aws/rds/instance/#{reader_identifier}/upgrade
        ].sort
    expected_reader_units = {
      "CPUUtilization" => "Percent", "DatabaseConnections" => "Count", "DiskQueueDepth" => "Count",
      "FreeableMemory" => "Bytes", "FreeStorageSpace" => "Bytes", "ReadLatency" => "Seconds",
      "ReplicaLag" => "Seconds", "SwapUsage" => "Bytes",
    }
    expected_reader_statistics = {
      "CPUUtilization" => "Average", "DatabaseConnections" => "Maximum", "DiskQueueDepth" => "Maximum",
      "FreeableMemory" => "Minimum", "FreeStorageSpace" => "Minimum", "ReadLatency" => "Average",
      "ReplicaLag" => "Maximum", "SwapUsage" => "Maximum",
    }
    reader_metrics = read_scaling.fetch("metrics")
    abort "RDS 只读副本 ReplicaLag 或容量指标集合不精确" unless
      reader_metrics.keys.sort == expected_reader_units.keys.sort &&
        read_scaling.fetch("alarm_names").sort == reader_metrics.values.map { |metric| metric.fetch("alarm_name") }.sort &&
        read_scaling.fetch("alarm_names").uniq.length == expected_reader_units.length
    reader_metrics.each do |metric_name, metric|
      abort "#{metric_name} RDS 只读副本告警合同键集合不精确" unless metric.keys.sort == %w[
        alarm_name comparison_operator datapoints_to_alarm evaluation_periods period_seconds
        statistic threshold treat_missing_data unit
      ]
      low_capacity = %w[FreeableMemory FreeStorageSpace].include?(metric_name)
      abort "#{metric_name} RDS 只读副本告警阈值、窗口或语义不合法" unless
        metric.fetch("alarm_name").start_with?("#{reader_identifier}-") &&
          metric.fetch("statistic") == expected_reader_statistics.fetch(metric_name) &&
          metric.fetch("unit") == expected_reader_units.fetch(metric_name) &&
          metric.fetch("threshold").is_a?(Numeric) && metric.fetch("threshold") > 0 &&
          metric.fetch("comparison_operator") ==
            (low_capacity ? "LessThanOrEqualToThreshold" : "GreaterThanOrEqualToThreshold") &&
          metric.fetch("period_seconds") == 60 && metric.fetch("evaluation_periods") == 3 &&
          metric.fetch("datapoints_to_alarm") == 2 &&
          metric.fetch("treat_missing_data") == (metric_name == "ReplicaLag" ? "breaching" : "notBreaching")
    end
  else
    abort "关闭的 RDS 读扩展合同仍夹带 endpoint、资源或告警" unless
      read_scaling.fetch("topology") == "single-writer" &&
        read_scaling.fetch("reader_db_instance_identifier").nil? &&
        read_scaling.fetch("reader_endpoint").nil? && value.fetch("rds_reader_endpoint").nil? &&
        read_scaling.fetch("engine_version").nil? && read_scaling.fetch("instance_class").nil? &&
        read_scaling.fetch("storage_type").nil? && read_scaling.fetch("minimum_allocated_storage_gib").nil? &&
        read_scaling.fetch("max_allocated_storage_gib").nil? &&
        read_scaling.fetch("reader_multi_az").nil? && read_scaling.fetch("backup_retention_days").nil? &&
        read_scaling.fetch("deletion_protection").nil? &&
        read_scaling.fetch("live_inheritance_check_required") == false &&
        read_scaling.fetch("log_group_names") == [] && read_scaling.fetch("alarm_names") == [] &&
        read_scaling.fetch("metrics") == {}
  end

  %w[
    alb_egress_target_ports
    alb_security_group_id
    api_alb_tls_policy
    alert_topic_arn
    api_edge_security_contract
    api_waf_web_acl_arn
    amp_remote_write_endpoint
    amp_writer_role_arn
    application_release_allowed
    aws_account_id
    aws_region
    cluster_autoscaler_role_arn
    cluster_autoscaler_inline_policy_name
    cluster_name
    cloudfront_acm_certificate_arn
    cloudfront_alias_domain_name
    cloudfront_cache_policy_id
    cloudfront_distribution_domain_name
    cloudfront_distribution_id
    cloudfront_edge_security_contract
    cloudfront_log_bucket_domain_name
    cloudfront_log_prefix
    cloudfront_origin_access_control_id
    cloudfront_release_request_function_arn
    cloudfront_release_request_function_name
    cloudfront_release_response_function_arn
    cloudfront_release_response_function_name
    cloudfront_response_headers_policy_id
    cloudfront_waf_web_acl_arn
    environment
    maintenance_in_progress
    public_subnet_ids
    public_subnet_cidrs
    regional_acm_certificate_arn
    rds_alarm_contract
    rds_read_scaling_contract
    secret_sync_role_arn
    valkey_endpoint_url
    valkey_active_slot
    valkey_maxmemory_policy
    valkey_parameter_group_name
    valkey_password_versions
    valkey_primary_endpoint
    valkey_replication_group_id
    valkey_rotation_contract
    valkey_rotation_mode
    valkey_secret_arn
    valkey_secret_name
    valkey_user_name
    valkey_user_names
    vpc_cidr
    vpc_id
    web_bucket_name
    workload_client_security_group_id
  ].each do |key|
    abort "delivery 缺少 #{key}" if value.fetch(key).to_s.empty?
  end

  boundaries = value.fetch("application_secret_names")
  expected_boundaries = %w[
    api-runtime-assets
    migrator-database
    operations-bearer
    runtime-database
    worker-runtime-assets
  ]
  abort "应用 Secret 边界不完整" unless boundaries.keys.sort == expected_boundaries.sort
  expected_sync_names = boundaries.merge("shared-admission" => value.fetch("valkey_secret_name"))
  abort "ExternalSecret 资源名契约不一致" unless handoff.fetch("external_secret_resource_names") == expected_sync_names
  abort "Secret 名称没有使用不可变正整数版本后缀" unless expected_sync_names.values.all? { |name|
    name.match?(/-v[1-9][0-9]*\z/)
  }

  valkey_url = URI.parse(value.fetch("valkey_endpoint_url"))
  abort "Valkey URL 必须是无凭据 rediss origin" unless valkey_url.scheme == "rediss" && valkey_url.host &&
    valkey_url.userinfo.nil? && valkey_url.query.nil? && valkey_url.fragment.nil?
  abort "Valkey noeviction delivery 不合法" unless
    value.fetch("valkey_maxmemory_policy") == "noeviction" &&
      value.fetch("valkey_parameter_group_name").match?(/\A[a-z0-9][a-z0-9-]{0,254}\z/) &&
      value.fetch("valkey_replication_group_id").match?(/\A[a-z0-9][a-z0-9-]{0,39}\z/)

  active_slot = value.fetch("valkey_active_slot")
  user_names = value.fetch("valkey_user_names")
  password_versions = value.fetch("valkey_password_versions")
  rotation = value.fetch("valkey_rotation_contract")
  abort "Valkey A/B 用户集合不完整" unless user_names.keys.sort == %w[a b]
  abort "Valkey A/B 密码版本集合不完整" unless password_versions.keys.sort == %w[a b]
  abort "Valkey active slot 不合法" unless %w[a b].include?(active_slot)
  abort "Valkey 活动用户名与槽位不一致" unless value.fetch("valkey_user_name") == user_names.fetch(active_slot)
  abort "Valkey A/B 轮换契约版本不受支持" unless rotation.fetch("contract_version") == "1.0.0"
  abort "Valkey A/B 轮换契约与 delivery 不一致" unless
    rotation.fetch("active_slot") == active_slot &&
    rotation.fetch("active_user_name") == value.fetch("valkey_user_name") &&
    rotation.fetch("password_versions") == password_versions &&
    rotation.fetch("rotation_mode") == value.fetch("valkey_rotation_mode") &&
    rotation.fetch("application_release_allowed") == value.fetch("application_release_allowed") &&
    rotation.fetch("maintenance_in_progress") == value.fetch("maintenance_in_progress") &&
    rotation.fetch("application_release_allowed") == (rotation.fetch("rotation_mode") != "hmac-maintenance") &&
    rotation.fetch("maintenance_in_progress") == (rotation.fetch("rotation_mode") == "hmac-maintenance") &&
    rotation.fetch("both_users_remain_in_user_group") == true &&
    rotation.fetch("old_slot_reset_requires_live_evidence") == true &&
    rotation.fetch("hmac_bucket_reset_requires_separate_change") == true &&
    rotation.fetch("hmac_maintenance_requires_zero_replicas") == true &&
    rotation.fetch("hmac_maintenance_forbids_parallel_rollout") == true &&
    rotation.fetch("hmac_maintenance_single_attested_plan") == true &&
    rotation.fetch("hmac_maintenance_exit_requires_separate_plan") == true &&
    rotation.fetch("hmac_maintenance_attestation_schema") == "slots-game/hmac-quiesce-attestation/v1" &&
    rotation.fetch("hmac_maintenance_evidence_maximum_ttl_seconds") == 3600 &&
    rotation.fetch("hmac_maintenance_persistent_lock_name") == "slots-hmac-maintenance-lock" &&
    rotation.fetch("acl_command_profile") == "v2-economic" &&
    rotation.fetch("acl_schema_version") == "v2" &&
    rotation.fetch("acl_schema_transition") == "maintenance-quiesced" &&
    rotation.fetch("acl_schema_migration_requires_quiesced") == true &&
    rotation.fetch("acl_schema_rolling_compatible") == false &&
    rotation.fetch("acl_schema_dual_permissions_allowed") == false &&
    rotation.fetch("acl_schema_migration_order") == %w[
      stop-new-intents drain-old-api-pods apply-v2-acl start-v2-runtime
      verify-v2-shared-admission resume-new-intents
    ] &&
    rotation.fetch("hmac_maintenance_target_identity") == {
      "environment" => value.fetch("environment"),
      "aws_account_id" => value.fetch("aws_account_id"),
      "aws_region" => value.fetch("aws_region"),
      "eks_cluster_name" => value.fetch("cluster_name"),
      "kubernetes_namespace" => value.fetch("application_namespace"),
      "helm_release_name" => value.fetch("helm_release_name"),
    }
  abort "HMAC 停机维护尚未退出，禁止声明应用可发布" if rotation.fetch("rotation_mode") == "hmac-maintenance"
  abort "应用发布允许字段未通过" unless value.fetch("application_release_allowed") == true
  abort "HMAC 维护进行中字段未清除" unless value.fetch("maintenance_in_progress") == false
  abort "Valkey rotation mode 不合法" unless %w[steady password-rotation].include?(rotation.fetch("rotation_mode"))
  password_fingerprints = rotation.fetch("password_fingerprints")
  abort "Valkey A/B 密码 fingerprint 集合不完整" unless password_fingerprints.keys.sort == %w[a b]
  abort "Valkey 密码 fingerprint 不合法" unless password_fingerprints.values.all? { |fingerprint|
    fingerprint.match?(/\A[0-9a-f]{64}\z/)
  }
  abort "共享准入 HMAC fingerprint 不合法" unless
    rotation.fetch("hmac_key_fingerprint").match?(/\A[0-9a-f]{64}\z/)
  secret_version = value.fetch("valkey_secret_name").match(/-v([1-9][0-9]*)\z/)&.captures&.first&.to_i
  abort "Valkey Secret 名称无法提取版本" unless secret_version
  abort "Valkey Secret 名称版本与轮换契约不一致" unless rotation.fetch("published_secret_version") == secret_version
  abort "Valkey Secret 版本与活动槽奇偶契约不一致" unless
    (active_slot == "a" && secret_version.odd?) || (active_slot == "b" && secret_version.even?)
' "$delivery_json" "$application_namespace" || fail 'Terraform delivery 契约校验失败'

json_value() {
  ruby -rjson -e '
    value = JSON.parse(File.binread(ARGV.shift))
    ARGV.each { |key| value = value.fetch(key) }
    abort "JSON 值不是标量" if value.is_a?(Hash) || value.is_a?(Array)
    STDOUT.write(value.to_s)
  ' "$delivery_json" "$@"
}

cluster_name=$(json_value cluster_name)
current_cluster=$("$kubectl_binary" config view --minify -o jsonpath='{.clusters[0].name}' 2>/dev/null || true)
case "$current_cluster" in
  "$cluster_name"|*":cluster/$cluster_name") ;;
  *) fail "kubectl 当前集群与 delivery.cluster_name 不一致" ;;
esac

"$kubectl_binary" get --raw=/readyz >/dev/null || fail '当前执行器无法访问 EKS 私网 API 或集群未就绪'

check_deployment() {
  namespace=$1
  deployment=$2
  service_account=$3
  chart_version=$4

  "$kubectl_binary" -n "$namespace" get "serviceaccount/$service_account" >/dev/null || \
    fail "$namespace/$service_account ServiceAccount 缺失"
  "$kubectl_binary" -n "$namespace" rollout status "deployment/$deployment" \
    --timeout="$rollout_timeout" >/dev/null || fail "$namespace/$deployment 未就绪"
  "$kubectl_binary" -n "$namespace" get "deployment/$deployment" -o json | ruby -rjson -e '
    workload = JSON.parse(STDIN.read)
    expected = ARGV.fetch(0)
    chart_version = ARGV.fetch(1).tr("+", "_")
    integer = lambda do |name, value|
      abort "Deployment #{name} 不是整数" unless value.is_a?(Integer)
      value
    end
    desired = integer.call("spec.replicas", workload.dig("spec", "replicas"))
    generation = integer.call("metadata.generation", workload.dig("metadata", "generation"))
    abort "Deployment 正在删除" unless workload.dig("metadata", "deletionTimestamp").nil?
    status = workload.fetch("status")
    observed = integer.call("status.observedGeneration", status["observedGeneration"])
    replicas = integer.call("status.replicas", status["replicas"])
    updated = integer.call("status.updatedReplicas", status["updatedReplicas"])
    ready = integer.call("status.readyReplicas", status["readyReplicas"])
    available = integer.call("status.availableReplicas", status["availableReplicas"])
    unavailable = integer.call("status.unavailableReplicas", status.fetch("unavailableReplicas", 0))
    abort "Deployment 期望副本数必须至少为 1" unless desired >= 1
    abort "Deployment controller 尚未观测最新 generation" unless observed == generation
    abort "Deployment total/updated/ready/available 副本尚未全部收敛" unless
      replicas == desired && updated == desired && ready == desired && available == desired
    abort "Deployment 仍有不可用副本" unless unavailable == 0
    actual = workload.dig("spec", "template", "spec", "serviceAccountName")
    abort "Deployment 没有绑定约定 ServiceAccount" unless actual == expected
    chart = workload.dig("metadata", "labels", "helm.sh/chart").to_s
    abort "Deployment 的 Helm Chart 版本不匹配" unless chart.end_with?("-#{chart_version}")
  ' "$service_account" "$chart_version" || fail "$namespace/$deployment 身份或版本绑定不匹配"
}

check_deployment kube-system aws-load-balancer-controller aws-load-balancer-controller \
  "$(json_value application_handoff addon_versions aws-load-balancer-controller)"
check_deployment kube-system cluster-autoscaler cluster-autoscaler \
  "$(json_value application_handoff addon_versions cluster-autoscaler)"
check_deployment external-secrets external-secrets external-secrets \
  "$(json_value application_handoff addon_versions external-secrets)"
check_deployment monitoring kube-prometheus-stack-operator kube-prometheus-stack-operator \
  "$(json_value application_handoff addon_versions kube-prometheus-stack)"

aws_region=$(json_value aws_region)
valkey_replication_group_id=$(json_value valkey_replication_group_id)
valkey_parameter_group_name=$(json_value valkey_parameter_group_name)

"$aws_binary" elasticache describe-replication-groups \
  --replication-group-id "$valkey_replication_group_id" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("ReplicationGroups")
    expected = ARGV.fetch(0)
    abort "Valkey replication group 回读数量不唯一" unless value.length == 1
    group = value.fetch(0)
    abort "Valkey replication group 尚未稳定或存在 pending 变更" unless
      group.fetch("ReplicationGroupId") == expected &&
        group.fetch("Status") == "available" &&
        group.fetch("PendingModifiedValues") == {} &&
        group.fetch("MemberClusters").is_a?(Array) &&
        group.fetch("MemberClusters").length == 3 &&
        group.fetch("MemberClusters").uniq.length == 3
  ' "$valkey_replication_group_id" || fail 'Valkey replication group 尚未收敛，禁止应用发布'

"$aws_binary" elasticache describe-cache-clusters \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    clusters = JSON.parse(STDIN.read).fetch("CacheClusters").select { |cluster|
      cluster["ReplicationGroupId"] == ARGV.fetch(0)
    }
    expected_group = ARGV.fetch(1)
    abort "Valkey replication group 节点数量不完整" unless clusters.length == 3
    clusters.each do |cluster|
      parameter = cluster.fetch("CacheParameterGroup")
      abort "Valkey 节点 parameter group 尚未实际 in-sync" unless
        cluster.fetch("Engine") == "valkey" &&
          cluster.fetch("CacheClusterStatus") == "available" &&
          cluster.fetch("PendingModifiedValues") == {} &&
          parameter.fetch("CacheParameterGroupName") == expected_group &&
          parameter.fetch("ParameterApplyStatus") == "in-sync" &&
          parameter.fetch("CacheNodeIdsToReboot") == []
    end
  ' "$valkey_replication_group_id" "$valkey_parameter_group_name" || \
  fail 'Valkey noeviction parameter group 尚未在全部节点生效'

"$aws_binary" elasticache describe-cache-parameters \
  --cache-parameter-group-name "$valkey_parameter_group_name" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    parameters = JSON.parse(STDIN.read).fetch("Parameters").select { |parameter|
      parameter["ParameterName"] == "maxmemory-policy"
    }
    abort "Valkey maxmemory-policy 回读不唯一或不是 noeviction" unless
      parameters.length == 1 &&
        parameters.fetch(0).fetch("ParameterValue") == ARGV.fetch(0) &&
        parameters.fetch(0).fetch("Source") == "user"
  ' "$(json_value valkey_maxmemory_policy)" || fail 'Valkey maxmemory-policy 实际值未失败关闭'

ruby "$script_directory/verify-waf-rollout-evidence.rb" "$delivery_json" "$aws_binary" "$aws_region" ||
  fail 'WAF Count→Block 的 versioned S3 证据对象、SHA-256、规则绑定或审批 schema 不满足'
waf_arn=$(json_value api_waf_web_acl_arn)
waf_name=$(json_value api_edge_security_contract web_acl_name)
waf_id=${waf_arn##*/}

"$aws_binary" wafv2 get-web-acl \
  --name "$waf_name" \
  --scope REGIONAL \
  --id "$waf_id" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("WebACL")
    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    contract = delivery.fetch("api_edge_security_contract")
    abort "WAF 名称或 ARN 与 delivery 不一致" unless
      value.fetch("Name") == contract.fetch("web_acl_name") &&
        value.fetch("ARN") == contract.fetch("web_acl_arn")
    abort "WAF 默认动作不是显式 ALLOW" unless value.fetch("DefaultAction").keys == ["Allow"]

    rules = value.fetch("Rules").to_h { |rule| [rule.fetch("Name"), rule] }
    web_acl_visibility = value.fetch("VisibilityConfig")
    abort "区域 API WAF WebACL 或规则启用了可能泄漏请求内容的 sampled requests" unless
      web_acl_visibility.keys.sort == %w[CloudWatchMetricsEnabled MetricName SampledRequestsEnabled] &&
        web_acl_visibility.fetch("CloudWatchMetricsEnabled") == true &&
        web_acl_visibility.fetch("MetricName") == contract.fetch("web_acl_metric_name") &&
        web_acl_visibility.fetch("SampledRequestsEnabled") == false
    expected_managed = {
      "amazon-ip-reputation" => "AWSManagedRulesAmazonIpReputationList",
      "common" => "AWSManagedRulesCommonRuleSet",
      "known-bad-inputs" => "AWSManagedRulesKnownBadInputsRuleSet",
      "sqli" => "AWSManagedRulesSQLiRuleSet",
    }
    expected_managed.each do |rule_name, group_name|
      rule = rules.fetch(rule_name)
      managed = rule.dig("Statement", "ManagedRuleGroupStatement") || abort("#{rule_name} 不是 managed rule group")
      expected_override = contract.fetch("managed_rule_rollout").fetch("action") == "count" ? "Count" : "None"
      abort "#{rule_name} managed group 或 Count→Block 阶段漂移" unless
        rule.fetch("Statement").keys == ["ManagedRuleGroupStatement"] &&
          managed.keys.sort == %w[Name VendorName Version] &&
        managed.fetch("VendorName") == "AWS" && managed.fetch("Name") == group_name &&
          managed.fetch("Version") == contract.fetch("managed_rule_versions").fetch(rule_name) &&
          rule.fetch("OverrideAction").keys == [expected_override]
    end

    health_rule = rules.fetch("public-healthz-block")
    health_match = health_rule.dig("Statement", "ByteMatchStatement") ||
      abort("public-healthz-block 不是精确 URI path rule")
    search_matches = lambda do |actual, plain, encoded|
      actual == plain || actual == encoded
    end
    abort "public /healthz 未在 WAF 精确隐藏" unless
      health_rule.fetch("Action").keys == ["Block"] &&
        health_rule.dig("Action", "Block", "CustomResponse", "ResponseCode") == 404 &&
        health_match.fetch("PositionalConstraint") == "EXACTLY" &&
        health_match.dig("FieldToMatch", "UriPath") == {} &&
        search_matches.call(health_match.fetch("SearchString"), "/healthz", "L2hlYWx0aHo=")

    surface_rule = rules.fetch("public-protocol-surface-block")
    surface_statements = surface_rule.dig(
      "Statement", "NotStatement", "Statement", "AndStatement", "Statements"
    ) || abort("public-protocol-surface-block 不是 NOT(path-prefix AND method) rule")
    groups = surface_statements.map { |statement| statement.dig("OrStatement", "Statements") }
    abort "public protocol surface 必须恰好包含 path 与 method 两组" unless
      groups.length == 2 && groups.none?(&:nil?)
    path_group = groups.find do |group|
      group.all? { |statement| statement.dig("ByteMatchStatement", "FieldToMatch", "UriPath") == {} }
    end
    method_group = groups.find do |group|
      group.all? { |statement| statement.dig("ByteMatchStatement", "FieldToMatch", "Method") == {} }
    end
    abort "public protocol surface 缺少 URI 或 method 组" unless path_group && method_group
    paths = path_group.map do |statement|
      match = statement.fetch("ByteMatchStatement")
      abort "public protocol path allowlist 必须用原始 STARTS_WITH" unless
        match.fetch("PositionalConstraint") == "STARTS_WITH" &&
          match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]
      match.fetch("SearchString")
    end
    methods = method_group.map do |statement|
      match = statement.fetch("ByteMatchStatement")
      abort "public protocol method allowlist 必须用原始 EXACTLY" unless
        match.fetch("PositionalConstraint") == "EXACTLY" &&
          match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]
      match.fetch("SearchString")
    end
    expected_paths = contract.fetch("allowed_public_path_prefixes")
    expected_methods = contract.fetch("allowed_public_methods")
    abort "public protocol path/method allowlist 漂移" unless
      paths.length == expected_paths.length && expected_paths.all? { |plain|
        paths.include?(plain) || paths.include?([plain].pack("m0"))
      } && methods.length == expected_methods.length && expected_methods.all? { |plain|
        methods.include?(plain) || methods.include?([plain].pack("m0"))
      }
    abort "public protocol 非法面未固定 Block 404" unless
      surface_rule.fetch("Action").keys == ["Block"] &&
        surface_rule.dig("Action", "Block", "CustomResponse", "ResponseCode") == 404

    {"body-size-limit" => "Body", "header-size-limit" => "Headers"}.each do |rule_name, component|
      rule = rules.fetch(rule_name)
      size = rule.dig("Statement", "SizeConstraintStatement") || abort("#{rule_name} 不是 size rule")
      field = size.fetch("FieldToMatch").fetch(component)
      abort "#{rule_name} 没有固定 8 KiB 检查窗口与 oversize MATCH" unless
        size.fetch("ComparisonOperator") == "GT" && size.fetch("Size") == 8192 &&
          field.fetch("OversizeHandling") == "MATCH" &&
          size.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]
    end
    header_match = rules.fetch("header-size-limit").dig(
      "Statement", "SizeConstraintStatement", "FieldToMatch", "Headers"
    )
    abort "header-size-limit 未检查全部 aggregate headers" unless
      header_match.keys.sort == %w[MatchPattern MatchScope OversizeHandling] &&
        header_match.fetch("MatchScope") == "ALL" &&
        header_match.fetch("MatchPattern") == {"All" => {}} &&
        header_match.fetch("OversizeHandling") == "MATCH"
    abort "body-size-limit 必须直接 Block" unless
      rules.fetch("body-size-limit").fetch("Action").keys == ["Block"] &&
        rules.fetch("body-size-limit").dig("Action", "Block", "CustomResponse", "ResponseCode") == 413
    expected_header_action = contract.fetch("header_size_rule_rollout").fetch("action")
    abort "header-size-limit Count→Block 阶段漂移" unless
      rules.fetch("header-size-limit").fetch("Action").keys ==
        [expected_header_action == "count" ? "Count" : "Block"]
    if expected_header_action == "block"
      abort "header-size-limit Block 阶段没有固定 431" unless
        rules.fetch("header-size-limit").dig("Action", "Block", "CustomResponse", "ResponseCode") == 431
    end

    rate_contract = contract.fetch("rate_limits")
    {
      "public-api-rate-limit" => rate_contract.fetch("public_requests_per_minute"),
      "launch-rate-limit" => rate_contract.fetch("launch_requests_per_minute"),
      "spin-rate-limit" => rate_contract.fetch("spin_requests_per_minute"),
    }.each do |rule_name, limit|
      rule = rules.fetch(rule_name)
      rate = rule.dig("Statement", "RateBasedStatement") || abort("#{rule_name} 不是 rate rule")
      expected_action = contract.fetch("rate_rule_rollouts").fetch(rule_name).fetch("action")
      action = rule.fetch("Action")
      abort "#{rule_name} Count→Block 阶段漂移" unless
        action.keys == [expected_action == "count" ? "Count" : "Block"]
      if expected_action == "block"
        custom = action.dig("Block", "CustomResponse") || abort("#{rule_name} 没有自定义拒绝")
        response = contract.fetch("rate_limit_response")
        headers = custom.fetch("ResponseHeaders", []).to_h { |header| [header.fetch("Name"), header.fetch("Value")] }
        expected_headers = {
          "Retry-After" => response.fetch("retry_after_seconds").to_s,
          "Access-Control-Allow-Origin" => response.fetch("access_control_allow_origin"),
          "Access-Control-Expose-Headers" => response.fetch("access_control_expose_header"),
          response.fetch("edge_error_header") => response.fetch("edge_error_value"),
        }
        abort "#{rule_name} Block 阶段没有固定 429 或浏览器可读 Retry-After" unless
          custom.fetch("ResponseCode") == response.fetch("status_code") &&
            headers == expected_headers && custom.fetch("ResponseHeaders").length == expected_headers.length
      end
      abort "#{rule_name} 限额或聚合窗口漂移" unless
        rate.fetch("AggregateKeyType") == "IP" && rate.fetch("EvaluationWindowSec") == 60 &&
          rate.fetch("Limit") == limit && rate.key?("ScopeDownStatement")
    end

    {
      "launch-rate-limit" => ["/operator/v1/launches", "L29wZXJhdG9yL3YxL2xhdW5jaGVz"],
      "spin-rate-limit" => ["/client/v1/spins", "L2NsaWVudC92MS9zcGlucw=="],
    }.each do |rule_name, (path, encoded_path)|
      statements = rules.fetch(rule_name).dig(
        "Statement", "RateBasedStatement", "ScopeDownStatement", "AndStatement", "Statements"
      ) || abort("#{rule_name} 低阈值 scope 不是 path AND POST")
      abort "#{rule_name} 低阈值 scope 必须精确包含 path 与 method" unless statements.length == 2
      path_match = statements.map { |statement| statement.fetch("ByteMatchStatement") }.find { |match|
        match.dig("FieldToMatch", "UriPath") == {}
      }
      method_match = statements.map { |statement| statement.fetch("ByteMatchStatement") }.find { |match|
        match.dig("FieldToMatch", "Method") == {}
      }
      abort "#{rule_name} 低阈值规则错误覆盖状态、恢复或非 POST 请求" unless
        path_match && method_match &&
          path_match.fetch("PositionalConstraint") == "EXACTLY" &&
          path_match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}] &&
          search_matches.call(path_match.fetch("SearchString"), path, encoded_path) &&
          method_match.fetch("PositionalConstraint") == "EXACTLY" &&
          method_match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}] &&
          search_matches.call(method_match.fetch("SearchString"), contract.fetch("low_rate_rule_method"), "UE9TVA==")
    end
    public_scope = rules.fetch("public-api-rate-limit").dig(
      "Statement", "RateBasedStatement", "ScopeDownStatement", "AndStatement", "Statements"
    ) || abort("公网高阈值规则不是 path-prefix AND method allowlist")
    abort "公网高阈值规则必须恰好包含 path 与 method 两组" unless public_scope.length == 2
    public_path_group = public_scope.map { |statement| statement.dig("OrStatement", "Statements") }.find do |group|
      group&.all? { |statement| statement.dig("ByteMatchStatement", "FieldToMatch", "UriPath") == {} }
    end
    public_method_group = public_scope.map { |statement| statement.dig("OrStatement", "Statements") }.find do |group|
      group&.all? { |statement| statement.dig("ByteMatchStatement", "FieldToMatch", "Method") == {} }
    end
    abort "公网高阈值规则缺少 URI 或 GET/OPTIONS/POST method 组" unless public_path_group && public_method_group
    public_paths = public_path_group.map do |statement|
      match = statement.fetch("ByteMatchStatement")
      abort "公网高阈值规则必须使用 URI 前缀" unless
        match.fetch("PositionalConstraint") == "STARTS_WITH" && match.dig("FieldToMatch", "UriPath") == {} &&
          match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]
      match.fetch("SearchString")
    end
    allowed_public_paths = [["/client/", "L2NsaWVudC8="], ["/operator/", "L29wZXJhdG9yLw=="]]
    abort "公网高阈值规则没有同时覆盖 client/operator" unless
      allowed_public_paths.all? { |plain, encoded| public_paths.include?(plain) || public_paths.include?(encoded) } &&
        public_paths.length == 2
    public_methods = public_method_group.map do |statement|
      match = statement.fetch("ByteMatchStatement")
      abort "公网高阈值 method 必须原始 EXACTLY" unless
        match.fetch("PositionalConstraint") == "EXACTLY" && match.dig("FieldToMatch", "Method") == {} &&
          match.fetch("TextTransformations") == [{"Priority" => 0, "Type" => "NONE"}]
      match.fetch("SearchString")
    end
    allowed_public_methods = contract.fetch("public_rate_rule_methods")
    abort "公网高阈值规则必须精确覆盖 GET/OPTIONS/POST，避免预检洪泛旁路" unless
      allowed_public_methods.all? { |method|
        public_methods.include?(method) || public_methods.include?([method].pack("m0"))
      } && public_methods.length == allowed_public_methods.length

    expected_rules = expected_managed.keys + contract.fetch("required_path_rule_names") +
      contract.fetch("required_size_rule_names") +
      contract.fetch("required_rate_rule_names")
    expected_priorities = {
      "public-healthz-block" => 1,
      "public-protocol-surface-block" => 5,
      "amazon-ip-reputation" => 10,
      "common" => 20,
      "known-bad-inputs" => 30,
      "sqli" => 40,
      "body-size-limit" => 50,
      "header-size-limit" => 60,
      "launch-rate-limit" => 100,
      "spin-rate-limit" => 110,
      "public-api-rate-limit" => 120,
    }
    abort "WAF 规则集合缺失、重复或夹带未审批规则" unless
      rules.keys.sort == expected_rules.sort && rules.length == value.fetch("Rules").length
    abort "WAF 规则 priority 漂移或可能插入提前终止规则" unless
      expected_priorities == rules.transform_values { |rule| rule.fetch("Priority") }
    metric_suffixes = {
      "public-healthz-block" => "public_healthz_block",
      "public-protocol-surface-block" => "protocol_surface_block",
      "amazon-ip-reputation" => "amazon_ip_reputation",
      "common" => "common",
      "known-bad-inputs" => "known_bad_inputs",
      "sqli" => "sqli",
      "body-size-limit" => "body_size",
      "header-size-limit" => "header_size",
      "launch-rate-limit" => "launch_rate",
      "spin-rate-limit" => "spin_rate",
      "public-api-rate-limit" => "public_api_rate",
    }
    expected_metrics = metric_suffixes.transform_values { |suffix| "#{contract.fetch("web_acl_metric_name")}_#{suffix}" }
    abort "WAF 规则 visibility metric、采样或 CloudWatch 指标开关漂移" unless
      rules.all? { |name, rule|
        visibility = rule.fetch("VisibilityConfig")
        visibility.keys.sort == %w[CloudWatchMetricsEnabled MetricName SampledRequestsEnabled] &&
          visibility.fetch("CloudWatchMetricsEnabled") == true &&
          visibility.fetch("MetricName") == expected_metrics.fetch(name) &&
          visibility.fetch("SampledRequestsEnabled") == false
      }
  ' "$delivery_json" || fail '区域 API WAF 实际规则与 Terraform delivery 不一致'

"$aws_binary" wafv2 get-logging-configuration \
  --resource-arn "$waf_arn" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("LoggingConfiguration")
    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    contract = delivery.fetch("api_edge_security_contract")
    abort "WAF 日志没有绑定当前 Web ACL" unless value.fetch("ResourceArn") == contract.fetch("web_acl_arn")
    destinations = value.fetch("LogDestinationConfigs")
    abort "WAF 日志必须唯一写入合同 Log Group" unless
      destinations.length == 1 && destinations.fetch(0).end_with?(":log-group:#{contract.fetch("log_group_name")}")
    redacted_fields = value.fetch("RedactedFields")
    redacted = redacted_fields.map { |field| field.dig("SingleHeader", "Name") }.compact.sort
    expected = %w[authorization cookie idempotency-key signature signature-input x-nonce x-rgs-signature].sort
    query_redactions = redacted_fields.count { |field| field.key?("QueryString") }
    abort "WAF 日志敏感头/query 脱敏集合漂移" unless
      redacted == expected && query_redactions == 1 && redacted_fields.length == expected.length + 1
    logging_filter = value.fetch("LoggingFilter")
    filters = logging_filter.fetch("Filters")
    filter = filters.fetch(0) if filters.length == 1
    conditions = filter&.fetch("Conditions", []) || []
    actions = conditions.map { |condition| condition.dig("ActionCondition", "Action") }.compact.sort
    abort "WAF 日志成本过滤必须仅保留 BLOCK/COUNT" unless
      logging_filter.keys.sort == %w[DefaultBehavior Filters] &&
        logging_filter.fetch("DefaultBehavior") == "DROP" && filters.length == 1 &&
        filter.keys.sort == %w[Behavior Conditions Requirement] &&
        filter.fetch("Behavior") == "KEEP" && filter.fetch("Requirement") == "MEETS_ANY" &&
        conditions.length == 2 && conditions.all? { |condition|
          condition.keys == ["ActionCondition"] && condition.fetch("ActionCondition").keys == ["Action"]
        } && actions == %w[BLOCK COUNT]
  ' "$delivery_json" || fail '区域 API WAF 日志、脱敏或成本过滤不满足'

cloudfront_waf_arn=$(json_value cloudfront_waf_web_acl_arn)
cloudfront_waf_name=$(json_value cloudfront_edge_security_contract web_acl_arn)
cloudfront_waf_name=${cloudfront_waf_name%/*}
cloudfront_waf_name=${cloudfront_waf_name##*/}
cloudfront_waf_id=${cloudfront_waf_arn##*/}
"$aws_binary" wafv2 get-web-acl \
  --name "$cloudfront_waf_name" \
  --scope CLOUDFRONT \
  --id "$cloudfront_waf_id" \
  --region us-east-1 \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("WebACL")
    contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("cloudfront_edge_security_contract")
    abort "CloudFront WAF 名称或 ARN 与 delivery 不一致" unless
      value.fetch("Name") == contract.fetch("web_acl_arn").split("/")[-2] &&
        value.fetch("ARN") == contract.fetch("web_acl_arn")
    abort "CloudFront WAF 默认动作不是显式 ALLOW" unless value.fetch("DefaultAction").keys == ["Allow"]
    rules = value.fetch("Rules")
    web_acl_visibility = value.fetch("VisibilityConfig")
    abort "CloudFront WAF WebACL 或规则启用了可能泄漏请求内容的 sampled requests" unless
      web_acl_visibility.keys.sort == %w[CloudWatchMetricsEnabled MetricName SampledRequestsEnabled] &&
        web_acl_visibility.fetch("CloudWatchMetricsEnabled") == true &&
        web_acl_visibility.fetch("MetricName") == contract.fetch("web_acl_metric_name") &&
        web_acl_visibility.fetch("SampledRequestsEnabled") == false &&
        rules.all? { |rule|
          visibility = rule.fetch("VisibilityConfig")
          visibility.keys.sort == %w[CloudWatchMetricsEnabled MetricName SampledRequestsEnabled] &&
            visibility.fetch("CloudWatchMetricsEnabled") == true &&
            visibility.fetch("MetricName") == contract.fetch("rule_metric_names").fetch(rule.fetch("Name")) &&
            visibility.fetch("SampledRequestsEnabled") == false
        }
    managed_rules = rules.select { |rule| rule.dig("Statement", "ManagedRuleGroupStatement") }
    managed = managed_rules.map { |rule| rule.dig("Statement", "ManagedRuleGroupStatement", "Name") }.sort
    abort "CloudFront WAF managed rule groups 漂移" unless
      managed == contract.fetch("required_managed_rule_groups").sort
    expected_override = contract.fetch("managed_rule_rollout").fetch("action") == "count" ? "Count" : "None"
    abort "CloudFront managed rules Count→Block 阶段漂移" unless
      managed_rules.all? { |rule| rule.fetch("OverrideAction").keys == [expected_override] }
    expected_versions = contract.fetch("managed_rule_versions")
    abort "CloudFront managed rule group 版本未固定或漂移" unless
      managed_rules.all? { |rule|
        statement = rule.fetch("Statement")
        managed_statement = statement.fetch("ManagedRuleGroupStatement")
        statement.keys == ["ManagedRuleGroupStatement"] &&
          managed_statement.keys.sort == %w[Name VendorName Version] &&
          managed_statement.fetch("VendorName") == "AWS" &&
          expected_versions.fetch(rule.fetch("Name")) == managed_statement.fetch("Version")
      }
    rate_rule = rules.find { |rule| rule.fetch("Name") == "web-rate-limit" }
    rate = rate_rule&.dig("Statement", "RateBasedStatement")
    expected_rate_action = contract.fetch("rate_rule_rollout").fetch("action")
    abort "CloudFront WAF 静态请求限速缺失或漂移" unless
      rate && rate.fetch("AggregateKeyType") == "IP" && rate.fetch("EvaluationWindowSec") == 60 &&
        rate.fetch("Limit") == contract.fetch("rate_limit_per_minute") &&
        rate.keys.sort == %w[AggregateKeyType EvaluationWindowSec Limit] &&
        rate_rule.fetch("Action").keys == [expected_rate_action == "count" ? "Count" : "Block"]
    abort "CloudFront WAF 规则集合夹带未审批规则" unless rules.length == managed.length + 1
  ' "$delivery_json" || fail 'CloudFront global WAF 实际规则与采用方交接合同不一致'

"$aws_binary" wafv2 get-logging-configuration \
  --resource-arn "$cloudfront_waf_arn" \
  --region us-east-1 \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("LoggingConfiguration")
    contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("cloudfront_edge_security_contract")
    abort "CloudFront WAF 日志没有绑定当前 Web ACL" unless value.fetch("ResourceArn") == contract.fetch("web_acl_arn")
    destinations = value.fetch("LogDestinationConfigs")
    abort "CloudFront WAF 日志必须唯一写入合同 Log Group" unless
      destinations.length == 1 && destinations.fetch(0).end_with?(":log-group:#{contract.fetch("waf_log_group_name")}")
    redacted_fields = value.fetch("RedactedFields")
    redacted = redacted_fields.map { |field| field.dig("SingleHeader", "Name") }.compact.sort
    query_redactions = redacted_fields.count { |field| field.key?("QueryString") }
    abort "CloudFront WAF 日志必须脱敏 Authorization/Cookie/query" unless
      redacted == %w[authorization cookie] && query_redactions == 1 && redacted_fields.length == 3
    logging_filter = value.fetch("LoggingFilter")
    filters = logging_filter.fetch("Filters")
    filter = filters.fetch(0) if filters.length == 1
    conditions = filter&.fetch("Conditions", []) || []
    actions = conditions.map { |condition| condition.dig("ActionCondition", "Action") }.compact.sort
    abort "CloudFront WAF 日志成本过滤必须仅保留 BLOCK/COUNT" unless
      logging_filter.keys.sort == %w[DefaultBehavior Filters] &&
        logging_filter.fetch("DefaultBehavior") == "DROP" && filters.length == 1 &&
        filter.keys.sort == %w[Behavior Conditions Requirement] &&
        filter.fetch("Behavior") == "KEEP" && filter.fetch("Requirement") == "MEETS_ANY" &&
        conditions.length == 2 && conditions.all? { |condition|
          condition.keys == ["ActionCondition"] && condition.fetch("ActionCondition").keys == ["Action"]
        } && actions == %w[BLOCK COUNT]
  ' "$delivery_json" || fail 'CloudFront global WAF 日志、脱敏或成本过滤不满足'

cloudfront_distribution_id=$(json_value cloudfront_distribution_id)
"$aws_binary" cloudfront get-distribution \
  --id "$cloudfront_distribution_id" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read).fetch("Distribution")
    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    config = value.fetch("DistributionConfig")
    abort "CloudFront distribution 尚未完成部署" unless value.fetch("Status") == "Deployed"
    abort "CloudFront distribution 身份或 WAF 绑定漂移" unless
      value.fetch("Id") == delivery.fetch("cloudfront_distribution_id") &&
        value.fetch("DomainName") == delivery.fetch("cloudfront_distribution_domain_name") &&
        config.fetch("Enabled") == true &&
        config.fetch("HttpVersion") == delivery.fetch("cloudfront_edge_security_contract").fetch("viewer_http_version") &&
        config.fetch("WebACLId") == delivery.fetch("cloudfront_waf_web_acl_arn")
    aliases = config.fetch("Aliases")
    abort "CloudFront alias 或默认根漂移" unless
      aliases.fetch("Quantity") == 1 && aliases.fetch("Items") == [delivery.fetch("cloudfront_alias_domain_name")] &&
        config.fetch("DefaultRootObject") == "index.html"
    origins = config.fetch("Origins").fetch("Items")
    abort "CloudFront 必须只有私有 S3 OAC 源站" unless
      config.dig("Origins", "Quantity") == 1 && origins.length == 1 &&
        origins.fetch(0).fetch("Id") == "private-web-s3" &&
        origins.fetch(0).fetch("OriginPath", "") == "" &&
        origins.fetch(0).fetch("OriginAccessControlId") == delivery.fetch("cloudfront_origin_access_control_id") &&
        origins.fetch(0).fetch("DomainName") ==
          "#{delivery.fetch("web_bucket_name")}.s3.#{delivery.fetch("aws_region")}.amazonaws.com"
    empty_associations = lambda do |associations|
      associations.fetch("Quantity") == 0 && [nil, []].include?(associations["Items"])
    end
    exact_methods = lambda do |behavior|
      allowed = behavior.fetch("AllowedMethods")
      cached = allowed.fetch("CachedMethods")
      allowed.fetch("Quantity") == 3 && allowed.fetch("Items").sort == %w[GET HEAD OPTIONS] &&
        cached.fetch("Quantity") == 2 && cached.fetch("Items").sort == %w[GET HEAD]
    end
    default_behavior = config.fetch("DefaultCacheBehavior")
    expected_functions = {
      "viewer-request" => delivery.fetch("cloudfront_release_request_function_arn"),
      "viewer-response" => delivery.fetch("cloudfront_release_response_function_arn"),
    }
    default_functions = default_behavior.fetch("FunctionAssociations")
    function_items = default_functions.fetch("Items")
    function_map = function_items.to_h { |association| [association.fetch("EventType"), association.fetch("FunctionARN")] }
    abort "CloudFront default behavior 的方法、策略或函数关联漂移" unless
      default_behavior.fetch("TargetOriginId") == "private-web-s3" &&
        default_behavior.fetch("ViewerProtocolPolicy") == "redirect-to-https" &&
        exact_methods.call(default_behavior) && default_behavior.fetch("Compress") == true &&
        default_behavior.fetch("CachePolicyId") == delivery.fetch("cloudfront_cache_policy_id") &&
        default_behavior.fetch("ResponseHeadersPolicyId") == delivery.fetch("cloudfront_response_headers_policy_id") &&
        default_functions.fetch("Quantity") == 2 && function_items.length == 2 &&
        function_items.all? { |association| association.keys.sort == %w[EventType FunctionARN] } &&
        function_map == expected_functions &&
        empty_associations.call(default_behavior.fetch("LambdaFunctionAssociations"))
    cache_behaviors = config.fetch("CacheBehaviors")
    ordered_items = cache_behaviors.fetch("Items")
    ordered = ordered_items.fetch(0) if ordered_items.length == 1
    abort "CloudFront ordered behavior 必须精确只有 releases/* 且不得执行函数或 Lambda" unless
      cache_behaviors.fetch("Quantity") == 1 && ordered_items.length == 1 &&
        ordered.fetch("PathPattern") == "releases/*" && ordered.fetch("TargetOriginId") == "private-web-s3" &&
        ordered.fetch("ViewerProtocolPolicy") == "redirect-to-https" && exact_methods.call(ordered) &&
        ordered.fetch("Compress") == true &&
        ordered.fetch("CachePolicyId") == delivery.fetch("cloudfront_cache_policy_id") &&
        ordered.fetch("ResponseHeadersPolicyId") == delivery.fetch("cloudfront_response_headers_policy_id") &&
        empty_associations.call(ordered.fetch("FunctionAssociations")) &&
        empty_associations.call(ordered.fetch("LambdaFunctionAssociations"))
    logging = config.fetch("Logging")
    abort "CloudFront access logging 身份或 cookie 边界漂移" unless
      logging.fetch("Enabled") == true && logging.fetch("IncludeCookies") == false &&
        logging.fetch("Bucket") == delivery.fetch("cloudfront_log_bucket_domain_name") &&
        logging.fetch("Prefix") == delivery.fetch("cloudfront_log_prefix")
    certificate = config.fetch("ViewerCertificate")
    abort "CloudFront viewer certificate 或 TLS policy 漂移" unless
      certificate.fetch("ACMCertificateArn") == delivery.fetch("cloudfront_acm_certificate_arn") &&
        certificate.fetch("MinimumProtocolVersion") == "TLSv1.2_2021" &&
        certificate.fetch("SSLSupportMethod") == "sni-only"
  ' "$delivery_json" || fail 'CloudFront distribution、global WAF 或私有 S3 OAC 绑定不满足'

# X-Frame-Options 会先于精确 CSP frame-ancestors 阻断跨源运营商 iframe；
# 生产 Response Headers Policy 必须让制品提取出的单一 CSP 成为嵌入授权源。
cloudfront_response_headers_policy_id=$(json_value cloudfront_response_headers_policy_id)
"$aws_binary" cloudfront get-response-headers-policy-config \
  --id "$cloudfront_response_headers_policy_id" \
  --no-cli-pager \
  --output json | ruby -rjson -ruri -e '
    response = JSON.parse(STDIN.read)
    config = response.fetch("ResponseHeadersPolicyConfig")
    security = config.fetch("SecurityHeadersConfig")
    abort "CloudFront Response Headers Policy 仍注入 X-Frame-Options" if security.key?("FrameOptions")
    content_security_policy = security.fetch("ContentSecurityPolicy")
    policy = content_security_policy.fetch("ContentSecurityPolicy")
    abort "CloudFront CSP 未启用覆盖" unless content_security_policy.fetch("Override") == true
    frame_directives = policy.split(";").map(&:strip).reject(&:empty?).select { |item|
      item.split(/[[:space:]]+/, 2).fetch(0) == "frame-ancestors"
    }
    abort "CloudFront CSP 必须精确包含一个 frame-ancestors" unless frame_directives.length == 1
    sources = frame_directives.fetch(0).split(/[[:space:]]+/).drop(1)
    abort "CloudFront frame-ancestors 必须精确绑定一个 HTTPS 运营商 origin" unless sources.length == 1
    source = sources.fetch(0)
    origin = URI.parse(source)
    abort "CloudFront frame-ancestors 不是精确 HTTPS origin" unless
      origin.is_a?(URI::HTTPS) && !origin.host.to_s.empty? && origin.userinfo.nil? &&
        [nil, ""].include?(origin.path) && origin.query.nil? && origin.fragment.nil? && origin.to_s == source
  ' || fail 'CloudFront Response Headers Policy 的跨源 iframe 契约不满足'

# delivery 中的私有源站声明不能代替真实 S3 执行面。四项 Public Access
# Block 必须同时开启；否则攻击者可以绕过 CloudFront/WAF 直读源站并制造成本。
web_bucket_name=$(json_value web_bucket_name)
aws_account_id=$(json_value aws_account_id)
"$aws_binary" s3api get-public-access-block \
  --bucket "$web_bucket_name" \
  --expected-bucket-owner "$aws_account_id" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read)
    abort "S3 Public Access Block 回读结构不精确" unless
      value.keys == ["PublicAccessBlockConfiguration"]
    configuration = value.fetch("PublicAccessBlockConfiguration")
    expected = %w[BlockPublicAcls IgnorePublicAcls BlockPublicPolicy RestrictPublicBuckets]
    abort "CloudFront 私有 S3 源站没有完整开启 Public Access Block" unless
      configuration.keys.sort == expected.sort &&
        expected.all? { |key| configuration.fetch(key) == true }
  ' || fail 'CloudFront 私有 S3 源站 Public Access Block 未实际失败关闭'

# Public Access Block 不会阻止策略向某个具体外部 AWS principal 授权；继续
# 精确回读 bucket policy，确保唯一读取 Allow 仍绑定当前 CloudFront distribution。
"$aws_binary" s3api get-bucket-policy \
  --bucket "$web_bucket_name" \
  --expected-bucket-owner "$aws_account_id" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    response = JSON.parse(STDIN.read)
    abort "S3 bucket policy 回读结构不精确" unless
      response.keys == ["Policy"] && response.fetch("Policy").is_a?(String) &&
        response.fetch("Policy").bytesize.between?(1, 20_480)
    policy = JSON.parse(response.fetch("Policy"))
    abort "S3 bucket policy 顶层结构不精确" unless
      policy.keys.sort == %w[Statement Version] && policy.fetch("Version") == "2012-10-17"
    statements = policy.fetch("Statement")
    abort "S3 bucket policy 必须精确包含三条语句" unless
      statements.is_a?(Array) && statements.length == 3 &&
        statements.all? { |statement| statement.is_a?(Hash) }
    by_sid = statements.to_h { |statement| [statement.fetch("Sid", nil), statement] }
    abort "S3 bucket policy Sid 集合缺失或重复" unless
      by_sid.keys.sort == %w[AllowCloudFrontOacRead DenyInsecureTransport DenyUnconditionalReleaseWrites] &&
        by_sid.length == statements.length

    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    partition = delivery.fetch("cloudfront_waf_web_acl_arn").split(":").fetch(1)
    bucket_arn = "arn:#{partition}:s3:::#{delivery.fetch("web_bucket_name")}"
    distribution_arn = "arn:#{partition}:cloudfront::#{delivery.fetch("aws_account_id")}:distribution/#{delivery.fetch("cloudfront_distribution_id")}"
    one = lambda { |value| value.is_a?(Array) && value.length == 1 ? value.fetch(0) : value }

    allow = by_sid.fetch("AllowCloudFrontOacRead")
    abort "S3 OAC Allow 语句漂移" unless
      allow.keys.sort == %w[Action Condition Effect Principal Resource Sid] &&
        allow.fetch("Effect") == "Allow" && one.call(allow.fetch("Action")) == "s3:GetObject" &&
        one.call(allow.fetch("Resource")) == "#{bucket_arn}/*" &&
        allow.fetch("Principal") == {"Service" => "cloudfront.amazonaws.com"} &&
        allow.fetch("Condition") == {"StringEquals" => {"AWS:SourceArn" => distribution_arn}}

    immutable = by_sid.fetch("DenyUnconditionalReleaseWrites")
    immutable_principal = immutable.fetch("Principal")
    abort "S3 release 条件写 Deny 语句漂移" unless
      immutable.keys.sort == %w[Action Condition Effect Principal Resource Sid] &&
        immutable.fetch("Effect") == "Deny" && one.call(immutable.fetch("Action")) == "s3:PutObject" &&
        one.call(immutable.fetch("Resource")) == "#{bucket_arn}/releases/*" &&
        ["*", {"AWS" => "*"}].include?(immutable_principal) &&
        immutable.fetch("Condition") == {
          "Bool" => {"s3:ObjectCreationOperation" => "true"},
          "Null" => {"s3:if-none-match" => "true"},
        }

    deny = by_sid.fetch("DenyInsecureTransport")
    principal = deny.fetch("Principal")
    resources = deny.fetch("Resource")
    resources = [resources] unless resources.is_a?(Array)
    abort "S3 TLS Deny 语句漂移" unless
      deny.keys.sort == %w[Action Condition Effect Principal Resource Sid] &&
        deny.fetch("Effect") == "Deny" && one.call(deny.fetch("Action")) == "s3:*" &&
        resources.sort == [bucket_arn, "#{bucket_arn}/*"].sort &&
        ["*", {"AWS" => "*"}].include?(principal) &&
        deny.fetch("Condition") == {"Bool" => {"aws:SecureTransport" => "false"}}
  ' "$delivery_json" || fail 'CloudFront 私有 S3 源站 bucket policy 未精确绑定 OAC、release 条件写或 TLS 拒绝'

alarm_names=$(ruby -rjson -e '
  value = JSON.parse(File.binread(ARGV.fetch(0))).fetch("api_edge_security_contract").fetch("alarm_names")
  abort "WAF 告警名称数量不等于 2" unless value.length == 2
  STDOUT.write(value.join("\n"))
' "$delivery_json") || fail '无法读取 WAF 告警名称合同'
alarm_allowed=$(printf '%s\n' "$alarm_names" | sed -n '1p')
alarm_blocked=$(printf '%s\n' "$alarm_names" | sed -n '2p')
"$aws_binary" cloudwatch describe-alarms \
  --alarm-names "$alarm_allowed" "$alarm_blocked" \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read)
    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    contract = delivery.fetch("api_edge_security_contract")
    topic = delivery.fetch("alert_topic_arn")
    alarms = value.fetch("MetricAlarms").to_h { |alarm| [alarm.fetch("AlarmName"), alarm] }
    abort "WAF 告警集合缺失或重复" unless alarms.keys.sort == contract.fetch("alarm_names").sort
    thresholds = contract.fetch("alarm_thresholds")
    expected_thresholds = {
      contract.fetch("alarm_names").find { |name| name.end_with?("allowed-request-cost") } => thresholds.fetch("allowed_requests_per_minute"),
      contract.fetch("alarm_names").find { |name| name.end_with?("blocked-requests") } => thresholds.fetch("blocked_requests_per_minute"),
    }
    expected_metrics = {
      contract.fetch("alarm_names").find { |name| name.end_with?("allowed-request-cost") } => "AllowedRequests",
      contract.fetch("alarm_names").find { |name| name.end_with?("blocked-requests") } => "BlockedRequests",
    }
    alarms.each do |name, alarm|
      dimensions = alarm.fetch("Dimensions").to_h { |dimension| [dimension.fetch("Name"), dimension.fetch("Value")] }
      abort "#{name} WAF 告警动作、窗口或维度漂移" unless
        alarm.fetch("ActionsEnabled") == true && alarm.fetch("AlarmActions") == [topic] &&
          alarm.fetch("OKActions") == [topic] && alarm.fetch("Namespace") == "AWS/WAFV2" &&
          alarm.fetch("MetricName") == expected_metrics.fetch(name) && alarm.fetch("Statistic") == "Sum" &&
          alarm.fetch("ComparisonOperator") == "GreaterThanOrEqualToThreshold" &&
          alarm.fetch("Period") == 60 && alarm.fetch("EvaluationPeriods") == 1 &&
          alarm.fetch("DatapointsToAlarm") == 1 && alarm.fetch("TreatMissingData") == "notBreaching" &&
          alarm.fetch("Threshold") == expected_thresholds.fetch(name) &&
          dimensions == {"Region" => delivery.fetch("aws_region"), "Rule" => "ALL", "WebACL" => contract.fetch("web_acl_metric_name")}
    end
  ' "$delivery_json" || fail '区域 API WAF CloudWatch 告警不满足'

read -r deadlock_log_group deadlock_filter_prefix <<EOF
$(ruby -rjson -e '
  contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_alarm_contract")
  filter = contract.fetch("deadlock_metric_filter")
  puts [filter.fetch("log_group_name"), filter.fetch("filter_name")].join(" ")
' "$delivery_json")
EOF
"$aws_binary" logs describe-metric-filters \
  --log-group-name "$deadlock_log_group" \
  --filter-name-prefix "$deadlock_filter_prefix" \
  --region "$aws_region" \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read)
    contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_alarm_contract")
    expected = contract.fetch("deadlock_metric_filter")
    filters = value.fetch("metricFilters")
    abort "PostgreSQL deadlock metric filter 集合缺失、重复或夹带未批准过滤器" unless filters.length == 1
    filter = filters.fetch(0)
    transformations = filter.fetch("metricTransformations")
    abort "PostgreSQL deadlock metric filter 变换数量不精确" unless transformations.length == 1
    transformation = transformations.fetch(0)
    abort "PostgreSQL deadlock metric filter 日志组或 pattern 漂移" unless
      filter.fetch("filterName") == expected.fetch("filter_name") &&
        filter.fetch("logGroupName") == expected.fetch("log_group_name") &&
        filter.fetch("filterPattern") == expected.fetch("filter_pattern")
    abort "PostgreSQL deadlock metric filter namespace、指标、默认值或单位漂移" unless
      transformation.fetch("metricNamespace") == expected.fetch("metric_namespace") &&
        transformation.fetch("metricName") == expected.fetch("metric_name") &&
        transformation.fetch("metricValue") == expected.fetch("metric_value") &&
        transformation.fetch("defaultValue") == expected.fetch("default_value") &&
        transformation.fetch("unit") == expected.fetch("unit") &&
        transformation.fetch("dimensions", {}) == {}
  ' "$delivery_json" || fail 'PostgreSQL deadlock CloudWatch Logs metric filter 实际状态不满足'

rds_alarm_prefix=$(ruby -rjson -e '
  contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_alarm_contract")
  STDOUT.write("#{contract.fetch("db_instance_identifier")}-")
' "$delivery_json") || fail '无法读取 RDS 告警名称前缀'
"$aws_binary" cloudwatch describe-alarms \
  --alarm-name-prefix "$rds_alarm_prefix" \
  --region "$aws_region" \
  --output json | ruby -rjson -e '
    value = JSON.parse(STDIN.read)
    delivery = JSON.parse(File.binread(ARGV.fetch(0)))
    contract = delivery.fetch("rds_alarm_contract")
    expected_by_name = contract.fetch("metrics").to_h do |metric_name, metric|
      [metric.fetch("alarm_name"), metric.merge("metric_name" => metric_name)]
    end
    returned_alarm_items = value.fetch("MetricAlarms")
    returned_alarms = returned_alarm_items.to_h { |alarm| [alarm.fetch("AlarmName"), alarm] }
    read_scaling = delivery.fetch("rds_read_scaling_contract")
    allowed_names = contract.fetch("alarm_names") +
      (read_scaling.fetch("enabled") ? read_scaling.fetch("alarm_names") : [])
    alarms = returned_alarms.select { |name, _alarm| contract.fetch("alarm_names").include?(name) }
    abort "RDS writer 告警集合缺失、重复或前缀下夹带未批准告警" unless
      returned_alarm_items.length == returned_alarms.length &&
        (returned_alarms.keys - allowed_names).empty? &&
        alarms.keys.sort == contract.fetch("alarm_names").sort && alarms.length == expected_by_name.length
    alarms.each do |name, alarm|
      expected = expected_by_name.fetch(name)
      abort "#{name} RDS 告警动作、阈值或窗口漂移" unless
        alarm.fetch("ActionsEnabled") == true && alarm.fetch("AlarmActions") == [contract.fetch("alert_topic_arn")] &&
          alarm.fetch("OKActions") == [contract.fetch("alert_topic_arn")] &&
          alarm.fetch("InsufficientDataActions", []) == [] &&
          alarm.fetch("ComparisonOperator") == expected.fetch("comparison_operator") &&
          alarm.fetch("EvaluationPeriods") == expected.fetch("evaluation_periods") &&
          alarm.fetch("DatapointsToAlarm") == expected.fetch("datapoints_to_alarm") &&
          alarm.fetch("TreatMissingData") == expected.fetch("treat_missing_data") &&
          alarm.fetch("Threshold") == expected.fetch("threshold")
      if expected.key?("metric_data_queries")
        abort "#{name} 把虚拟 Total 指标错误声明为 AWS/RDS 原生指标" unless
          %w[Namespace MetricName Statistic Unit Dimensions Period].none? { |key| alarm.key?(key) }
        actual_queries = alarm.fetch("Metrics")
        expected_queries = expected.fetch("metric_data_queries")
        abort "#{name} MetricDataQueries 数量或 ID 漂移" unless
          actual_queries.length == expected_queries.length &&
            actual_queries.map { |query| query.fetch("Id") }.sort == expected_queries.map { |query| query.fetch("id") }.sort
        actual_by_id = actual_queries.to_h { |query| [query.fetch("Id"), query] }
        expected_queries.each do |query|
          actual = actual_by_id.fetch(query.fetch("id"))
          if query.key?("expression")
            abort "#{name}/#{query.fetch("id")} expression、label 或 ReturnData 漂移" unless
              actual.fetch("Expression") == query.fetch("expression") && actual.fetch("Label") == query.fetch("label") &&
                actual.fetch("ReturnData") == query.fetch("return_data") && !actual.key?("MetricStat")
            next
          end
          metric_stat = actual.fetch("MetricStat")
          source_metric = metric_stat.fetch("Metric")
          dimensions = source_metric.fetch("Dimensions").to_h do |dimension|
            [dimension.fetch("Name"), dimension.fetch("Value")]
          end
          abort "#{name}/#{query.fetch("id")} source metric、单位、窗口、维度或 ReturnData 漂移" unless
            !actual.key?("Expression") && actual.fetch("ReturnData") == query.fetch("return_data") &&
              source_metric.fetch("Namespace") == query.fetch("namespace") &&
              source_metric.fetch("MetricName") == query.fetch("metric_name") &&
              dimensions == {query.fetch("dimension_name") => query.fetch("dimension_value")} &&
              metric_stat.fetch("Period") == query.fetch("period_seconds") &&
              metric_stat.fetch("Stat") == query.fetch("statistic") && metric_stat.fetch("Unit") == query.fetch("unit")
        end
        next
      end
      deadlock = expected.fetch("metric_name") == "Deadlocks"
      deadlock_filter = contract.fetch("deadlock_metric_filter")
      expected_namespace = deadlock ? deadlock_filter.fetch("metric_namespace") : contract.fetch("namespace")
      expected_metric_name = deadlock ? deadlock_filter.fetch("metric_name") : expected.fetch("metric_name")
      expected_dimensions = deadlock ? {} : {"DBInstanceIdentifier" => contract.fetch("db_instance_identifier")}
      dimensions = alarm.fetch("Dimensions").to_h { |dimension| [dimension.fetch("Name"), dimension.fetch("Value")] }
      abort "#{name} RDS 单指标告警指标源、单位或维度漂移" unless
        alarm.fetch("Namespace") == expected_namespace &&
          alarm.fetch("MetricName") == expected_metric_name && alarm.fetch("Statistic") == expected.fetch("statistic") &&
          alarm.fetch("Unit") == expected.fetch("unit") &&
          alarm.fetch("Period") == expected.fetch("period_seconds") &&
          dimensions == expected_dimensions
    end
  ' "$delivery_json" || fail '单实例 RDS CloudWatch 告警实际状态不满足'

rds_reader_enabled=$(ruby -rjson -e '
  contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_read_scaling_contract")
  STDOUT.write(contract.fetch("enabled") ? "true" : "false")
' "$delivery_json") || fail '无法读取 RDS 读扩展开关'
if test "$rds_reader_enabled" = true; then
  rds_reader_identifier=$(ruby -rjson -e '
    contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_read_scaling_contract")
    STDOUT.write(contract.fetch("reader_db_instance_identifier"))
  ' "$delivery_json") || fail '无法读取 RDS 只读副本 identity'
  "$aws_binary" rds describe-db-instances \
    --db-instance-identifier "$rds_reader_identifier" \
    --region "$aws_region" \
    --output json | ruby -rjson -e '
      value = JSON.parse(STDIN.read)
      delivery = JSON.parse(File.binread(ARGV.fetch(0)))
      contract = delivery.fetch("rds_read_scaling_contract")
      instances = value.fetch("DBInstances")
      abort "RDS 只读副本缺失、重复或查询夹带其他实例" unless instances.length == 1
      instance = instances.fetch(0)
      endpoint = instance.fetch("Endpoint")
      parameter_groups = instance.fetch("DBParameterGroups")
      security_groups = instance.fetch("VpcSecurityGroups")
      abort "RDS 只读副本 identity、源实例、状态或 endpoint 漂移" unless
        instance.fetch("DBInstanceIdentifier") == contract.fetch("reader_db_instance_identifier") &&
          instance.fetch("DBInstanceStatus") == "available" &&
          instance.fetch("ReadReplicaSourceDBInstanceIdentifier") == contract.fetch("source_db_instance_identifier") &&
          endpoint.fetch("Address") == contract.fetch("reader_endpoint") &&
          endpoint.fetch("Port") == contract.fetch("port") &&
          instance.fetch("DBInstanceArn").match?(%r{\Aarn:(aws|aws-us-gov):rds:#{delivery.fetch("aws_region")}:#{delivery.fetch("aws_account_id")}:db:#{Regexp.escape(contract.fetch("reader_db_instance_identifier"))}\z})
      abort "RDS 只读副本网络、参数组或公开访问边界漂移" unless
        instance.fetch("PubliclyAccessible") == false &&
          instance.fetch("DBSubnetGroup").fetch("DBSubnetGroupName") == contract.fetch("db_subnet_group_name") &&
          parameter_groups.length == 1 &&
          parameter_groups.fetch(0) == {
            "DBParameterGroupName" => contract.fetch("parameter_group_name"),
            "ParameterApplyStatus" => "in-sync",
          } &&
          security_groups.map { |group| group.fetch("VpcSecurityGroupId") }.sort ==
            contract.fetch("vpc_security_group_ids").sort &&
          security_groups.all? { |group| group.fetch("Status") == "active" }
      abort "RDS 只读副本 KMS、备份、删除保护或运行参数漂移" unless
        instance.fetch("Engine") == "postgres" &&
          instance.fetch("EngineVersion") == contract.fetch("engine_version") &&
          instance.fetch("DBInstanceClass") == contract.fetch("instance_class") &&
          instance.fetch("StorageType") == contract.fetch("storage_type") &&
          instance.fetch("AllocatedStorage") >= contract.fetch("minimum_allocated_storage_gib") &&
          instance.fetch("MaxAllocatedStorage") == contract.fetch("max_allocated_storage_gib") &&
          instance.fetch("StorageEncrypted") == true &&
          instance.fetch("KmsKeyId") == contract.fetch("expected_kms_key_arn") &&
          instance.fetch("MultiAZ") == contract.fetch("reader_multi_az") &&
          instance.fetch("BackupRetentionPeriod") == contract.fetch("backup_retention_days") &&
          instance.fetch("DeletionProtection") == contract.fetch("deletion_protection") &&
          instance.fetch("IAMDatabaseAuthenticationEnabled") == true &&
          instance.fetch("AutoMinorVersionUpgrade") == false &&
          instance.fetch("MonitoringInterval") == 60 && instance.fetch("PerformanceInsightsEnabled") == true &&
          instance.fetch("EnabledCloudwatchLogsExports").sort == %w[postgresql upgrade] &&
          instance.fetch("PendingModifiedValues", {}) == {}
    ' "$delivery_json" || fail 'RDS 同区域只读副本实际继承与保护边界不满足'

  "$aws_binary" cloudwatch describe-alarms \
    --alarm-name-prefix "$rds_reader_identifier-" \
    --region "$aws_region" \
    --output json | ruby -rjson -e '
      value = JSON.parse(STDIN.read)
      contract = JSON.parse(File.binread(ARGV.fetch(0))).fetch("rds_read_scaling_contract")
      expected_by_name = contract.fetch("metrics").to_h do |metric_name, metric|
        [metric.fetch("alarm_name"), metric.merge("metric_name" => metric_name)]
      end
      alarm_items = value.fetch("MetricAlarms")
      alarms = alarm_items.to_h { |alarm| [alarm.fetch("AlarmName"), alarm] }
      abort "RDS 只读副本告警缺失、重复或夹带未批准告警" unless
        alarm_items.length == alarms.length &&
          alarms.keys.sort == contract.fetch("alarm_names").sort && alarms.length == expected_by_name.length
      alarms.each do |name, alarm|
        expected = expected_by_name.fetch(name)
        dimensions = alarm.fetch("Dimensions").to_h { |dimension| [dimension.fetch("Name"), dimension.fetch("Value")] }
        abort "#{name} RDS 只读副本告警动作、指标、阈值或窗口漂移" unless
          alarm.fetch("ActionsEnabled") == true && alarm.fetch("AlarmActions") == [contract.fetch("alert_topic_arn")] &&
            alarm.fetch("OKActions") == [contract.fetch("alert_topic_arn")] &&
            alarm.fetch("InsufficientDataActions", []) == [] && alarm.fetch("Namespace") == "AWS/RDS" &&
            alarm.fetch("MetricName") == expected.fetch("metric_name") &&
            alarm.fetch("Statistic") == expected.fetch("statistic") && alarm.fetch("Unit") == expected.fetch("unit") &&
            alarm.fetch("ComparisonOperator") == expected.fetch("comparison_operator") &&
            alarm.fetch("Period") == expected.fetch("period_seconds") &&
            alarm.fetch("EvaluationPeriods") == expected.fetch("evaluation_periods") &&
            alarm.fetch("DatapointsToAlarm") == expected.fetch("datapoints_to_alarm") &&
            alarm.fetch("Threshold") == expected.fetch("threshold") &&
            alarm.fetch("TreatMissingData") == expected.fetch("treat_missing_data") &&
            dimensions == {"DBInstanceIdentifier" => contract.fetch("reader_db_instance_identifier")}
      end
    ' "$delivery_json" || fail 'RDS 只读副本 ReplicaLag/容量告警实际状态不满足'
fi

autoscaler_image_tag=$(json_value application_handoff cluster_autoscaler_image_tag)
metrics_server_addon_version=$(json_value application_handoff metrics_server_addon_version)
vpc_cni_addon_version=$(json_value application_handoff vpc_cni_network_policy addon_version)
vpc_cni_role_arn=$(json_value application_handoff vpc_cni_network_policy pod_identity role_arn)
cloudwatch_addon_version=$(json_value application_handoff cloudwatch_observability addon_version)
cloudwatch_agent_role_arn=$(json_value application_handoff cloudwatch_observability pod_identity role_arn)

"$aws_binary" eks describe-addon \
  --cluster-name "$cluster_name" \
  --addon-name metrics-server \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    addon = JSON.parse(STDIN.read).fetch("addon")
    expected_version = ARGV.fetch(0)
    abort "metrics-server EKS add-on 名称不匹配" unless addon.fetch("addonName") == "metrics-server"
    abort "metrics-server EKS add-on 版本不匹配" unless addon.fetch("addonVersion") == expected_version
    abort "metrics-server EKS add-on 未达到 ACTIVE" unless addon.fetch("status") == "ACTIVE"
' "$metrics_server_addon_version" || fail 'metrics-server EKS add-on 版本或状态不满足'

"$aws_binary" eks describe-addon \
  --cluster-name "$cluster_name" \
  --addon-name vpc-cni \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    addon = JSON.parse(STDIN.read).fetch("addon")
    expected_version = ARGV.fetch(0)
    abort "vpc-cni EKS add-on 名称不匹配" unless addon.fetch("addonName") == "vpc-cni"
    abort "vpc-cni EKS add-on 版本不匹配" unless addon.fetch("addonVersion") == expected_version
    abort "vpc-cni EKS add-on 未达到 ACTIVE" unless addon.fetch("status") == "ACTIVE"
    configuration = addon.fetch("configurationValues")
    abort "vpc-cni configurationValues 不是 JSON 字符串" unless configuration.is_a?(String)
    abort "vpc-cni 未实际启用 NetworkPolicy" unless
      JSON.parse(configuration) == {"enableNetworkPolicy" => "true"}
  ' "$vpc_cni_addon_version" || fail 'vpc-cni NetworkPolicy add-on 版本、状态或配置不满足'

"$aws_binary" eks describe-addon \
  --cluster-name "$cluster_name" \
  --addon-name amazon-cloudwatch-observability \
  --region "$aws_region" \
  --no-cli-pager \
  --output json | ruby -rjson -e '
    addon = JSON.parse(STDIN.read).fetch("addon")
    expected_version = ARGV.fetch(0)
    expected_configuration = {
      "agent" => {"config" => {"logs" => {"metrics_collected" => {
        "kubernetes" => {"enhanced_container_insights" => true},
      }}}},
      "containerLogs" => {"enabled" => true},
    }
    abort "CloudWatch Observability EKS add-on 名称不匹配" unless
      addon.fetch("addonName") == "amazon-cloudwatch-observability"
    abort "CloudWatch Observability EKS add-on 版本不匹配" unless
      addon.fetch("addonVersion") == expected_version
    abort "CloudWatch Observability EKS add-on 未达到 ACTIVE" unless addon.fetch("status") == "ACTIVE"
    configuration = addon.fetch("configurationValues")
    abort "CloudWatch Observability configurationValues 不是 JSON 字符串" unless configuration.is_a?(String)
    abort "CloudWatch Observability 实际日志或增强指标配置漂移" unless
      JSON.parse(configuration) == expected_configuration
  ' "$cloudwatch_addon_version" || fail 'CloudWatch Observability add-on 版本、状态或配置不满足'

check_cloudwatch_daemonset() {
  daemonset_name=$1
  expected_service_account=$2
  expected_container=$3
  if test -n "$expected_service_account"; then
    "$kubectl_binary" -n amazon-cloudwatch get "serviceaccount/$expected_service_account" >/dev/null || \
      fail "amazon-cloudwatch/$expected_service_account ServiceAccount 缺失"
  fi
  "$kubectl_binary" -n amazon-cloudwatch rollout status "daemonset/$daemonset_name" \
    --timeout="$rollout_timeout" >/dev/null || fail "$daemonset_name DaemonSet 未就绪"
  "$kubectl_binary" -n amazon-cloudwatch get "daemonset/$daemonset_name" -o json | ruby -rjson -e '
    workload = JSON.parse(STDIN.read)
    name, expected_service_account, expected_container = ARGV
    if !expected_service_account.empty?
      abort "#{name} DaemonSet 未绑定专用 ServiceAccount" unless
        workload.dig("spec", "template", "spec", "serviceAccountName") == expected_service_account
    end
    if !expected_container.empty?
      containers = Array(workload.dig("spec", "template", "spec", "containers"))
      abort "#{name} 容器缺失" unless containers.any? { |container| container["name"] == expected_container }
    end
    desired = workload.dig("status", "desiredNumberScheduled").to_i
    abort "#{name} DaemonSet 没有可调度 Pod" unless desired >= 1
    abort "#{name} DaemonSet 未在全部节点完全就绪" unless
      workload.dig("status", "currentNumberScheduled").to_i == desired &&
        workload.dig("status", "updatedNumberScheduled").to_i == desired &&
        workload.dig("status", "numberReady").to_i == desired &&
        workload.dig("status", "numberAvailable").to_i == desired &&
        workload.dig("status", "numberUnavailable").to_i == 0
  ' "$daemonset_name" "$expected_service_account" "$expected_container" || \
    fail "$daemonset_name DaemonSet 运行身份或状态不满足"
}

check_cloudwatch_daemonset cloudwatch-agent cloudwatch-agent cloudwatch-agent
check_cloudwatch_daemonset fluent-bit fluent-bit fluent-bit

"$kubectl_binary" -n kube-system get serviceaccount/metrics-server >/dev/null || \
  fail 'kube-system/metrics-server ServiceAccount 缺失'
"$kubectl_binary" -n kube-system rollout status deployment/metrics-server \
  --timeout="$rollout_timeout" >/dev/null || fail 'kube-system/metrics-server Deployment 未就绪'
"$kubectl_binary" -n kube-system get deployment/metrics-server -o json | ruby -rjson -e '
  workload = JSON.parse(STDIN.read)
  service_account = workload.dig("spec", "template", "spec", "serviceAccountName")
  abort "metrics-server 没有绑定专用 ServiceAccount" unless service_account == "metrics-server"
  containers = Array(workload.dig("spec", "template", "spec", "containers"))
  abort "metrics-server 容器缺失" unless containers.any? { |container| container["name"] == "metrics-server" }
' || fail 'metrics-server Deployment 运行身份不满足'

"$kubectl_binary" get apiservice/v1beta1.metrics.k8s.io -o json | ruby -rjson -e '
  resource = JSON.parse(STDIN.read)
  conditions = Array(resource.dig("status", "conditions"))
  abort "资源指标 APIService 未达到 Available=True" unless conditions.any? { |condition|
    condition["type"] == "Available" && condition["status"] == "True"
  }
' || fail 'v1beta1.metrics.k8s.io APIService 不可用，HPA 不能安全扩缩容'

"$kubectl_binary" -n monitoring get serviceaccount/kube-prometheus-stack-kube-state-metrics >/dev/null || \
  fail 'monitoring/kube-prometheus-stack-kube-state-metrics ServiceAccount 缺失'
"$kubectl_binary" -n monitoring rollout status deployment/kube-prometheus-stack-kube-state-metrics \
  --timeout="$rollout_timeout" >/dev/null || fail 'kube-state-metrics Deployment 未就绪'
"$kubectl_binary" -n monitoring get deployment/kube-prometheus-stack-kube-state-metrics -o json | ruby -rjson -e '
  workload = JSON.parse(STDIN.read)
  service_account = workload.dig("spec", "template", "spec", "serviceAccountName")
  abort "kube-state-metrics 没有绑定固定 ServiceAccount" unless
    service_account == "kube-prometheus-stack-kube-state-metrics"
  containers = Array(workload.dig("spec", "template", "spec", "containers"))
  metrics_container = containers.find { |container| container["name"] == "kube-state-metrics" }
  abort "kube-state-metrics 容器缺失或镜像未固定" unless
    metrics_container && metrics_container["image"].is_a?(String) && !metrics_container["image"].empty?
  labels = workload.dig("metadata", "labels") || {}
  annotations = workload.dig("metadata", "annotations") || {}
  abort "kube-state-metrics 不属于固定 kube-prometheus-stack release" unless
    labels["app.kubernetes.io/instance"] == "kube-prometheus-stack" &&
    labels["app.kubernetes.io/name"] == "kube-state-metrics" &&
    annotations["meta.helm.sh/release-name"] == "kube-prometheus-stack" &&
    annotations["meta.helm.sh/release-namespace"] == "monitoring"
' || fail 'kube-state-metrics Helm release 所有权不满足'

"$kubectl_binary" -n kube-system get deployment/aws-load-balancer-controller -o json | ruby -rjson -e '
  workload = JSON.parse(STDIN.read)
  cluster_name = ARGV.fetch(0)
  containers = Array(workload.dig("spec", "template", "spec", "containers"))
  controller = containers.find { |container| container["name"] == "aws-load-balancer-controller" }
  abort "AWS Load Balancer Controller 容器缺失" unless controller
  args = Array(controller["args"])
  abort "AWS Load Balancer Controller 集群边界不匹配" unless args.include?("--cluster-name=#{cluster_name}")
  abort "AWS Load Balancer Controller 没有限定 alb IngressClass" unless args.include?("--ingress-class=alb")
' "$cluster_name" || fail 'AWS Load Balancer Controller 运行边界不满足'

"$kubectl_binary" -n kube-system get deployment/cluster-autoscaler -o json | ruby -rjson -e '
  workload = JSON.parse(STDIN.read)
  cluster_name = ARGV.fetch(0)
  region = ARGV.fetch(1)
  image_tag = ARGV.fetch(2)
  containers = Array(workload.dig("spec", "template", "spec", "containers"))
  autoscaler = containers.find { |container| container["name"] == "cluster-autoscaler" }
  abort "Cluster Autoscaler 容器缺失" unless autoscaler
  image = autoscaler.fetch("image")
  abort "Cluster Autoscaler 镜像版本不匹配" unless
    image.end_with?(":#{image_tag}") || image.match?(/:#{Regexp.escape(image_tag)}@sha256:[0-9a-f]{64}\z/)
  args = Array(autoscaler["args"])
  abort "Cluster Autoscaler cloud provider 不匹配" unless args.include?("--cloud-provider=aws")
  discovery = args.find { |argument| argument.start_with?("--node-group-auto-discovery=") }.to_s
  abort "Cluster Autoscaler 没有限定当前集群托管节点自动发现" unless
    discovery.include?("asg:tag=") &&
    discovery.include?("k8s.io/cluster-autoscaler/enabled") &&
    discovery.include?("k8s.io/cluster-autoscaler/#{cluster_name}")
  env = Array(autoscaler["env"])
  abort "Cluster Autoscaler AWS_REGION 不匹配" unless env.any? { |entry|
    entry["name"] == "AWS_REGION" && entry["value"] == region
  }
' "$cluster_name" "$aws_region" "$autoscaler_image_tag" || \
  fail 'Cluster Autoscaler 横向扩容契约不满足'

check_pod_identity() {
  namespace=$1
  service_account=$2
  expected_role_arn=$3

  association_id=$(
    "$aws_binary" eks list-pod-identity-associations \
      --cluster-name "$cluster_name" \
      --namespace "$namespace" \
      --service-account "$service_account" \
      --region "$aws_region" \
      --no-cli-pager \
      --output json | ruby -rjson -e '
        value = JSON.parse(STDIN.read)
        associations = Array(value["associations"])
        abort "Pod Identity association 数量不等于 1" unless associations.length == 1
        STDOUT.write(associations.fetch(0).fetch("associationId"))
      '
  ) || fail "$namespace/$service_account Pod Identity association 查询失败"

  "$aws_binary" eks describe-pod-identity-association \
    --cluster-name "$cluster_name" \
    --association-id "$association_id" \
    --region "$aws_region" \
    --no-cli-pager \
    --output json | ruby -rjson -e '
      value = JSON.parse(STDIN.read).fetch("association")
      expected_cluster, expected_namespace, expected_service_account, expected_role = ARGV
      abort "Pod Identity 集群不匹配" unless value.fetch("clusterName") == expected_cluster
      abort "Pod Identity namespace 不匹配" unless value.fetch("namespace") == expected_namespace
      abort "Pod Identity ServiceAccount 不匹配" unless value.fetch("serviceAccount") == expected_service_account
      role = value.fetch("roleArn")
      if expected_role.empty?
        abort "Pod Identity role ARN 不合法" unless role.match?(/\Aarn:(aws|aws-us-gov):iam::[0-9]{12}:role\/.+\z/)
      else
        abort "Pod Identity role 不匹配" unless role == expected_role
      end
    ' "$cluster_name" "$namespace" "$service_account" "$expected_role_arn" || \
    fail "$namespace/$service_account Pod Identity role 不匹配"
}

check_pod_identity kube-system cluster-autoscaler "$(json_value cluster_autoscaler_role_arn)"
check_pod_identity kube-system aws-load-balancer-controller ""
check_pod_identity kube-system aws-node "$vpc_cni_role_arn"
check_pod_identity amazon-cloudwatch cloudwatch-agent "$cloudwatch_agent_role_arn"
check_pod_identity external-secrets external-secrets "$(json_value secret_sync_role_arn)"
check_pod_identity monitoring prometheus-agent "$(json_value amp_writer_role_arn)"

autoscaler_role_arn=$(json_value cluster_autoscaler_role_arn)
autoscaler_role_name=${autoscaler_role_arn##*/}
autoscaler_policy_name=$(json_value cluster_autoscaler_inline_policy_name)
test -n "$autoscaler_role_name" || fail 'Cluster Autoscaler role 名为空'
test -n "$autoscaler_policy_name" || fail 'Cluster Autoscaler 内联策略名为空'
"$aws_binary" iam get-role-policy \
  --role-name "$autoscaler_role_name" \
  --policy-name "$autoscaler_policy_name" \
  --no-cli-pager \
  --output json | ruby -rjson -ruri -e '
    value = JSON.parse(STDIN.read)
    document = value.fetch("PolicyDocument")
    document = JSON.parse(URI.decode_www_form_component(document)) if document.is_a?(String)
    statements = Array(document.fetch("Statement"))
    read_statement = statements.find { |statement| statement.fetch("Sid", "") == "ReadCapacityMetadata" }
    abort "Cluster Autoscaler 缺少 ReadCapacityMetadata 语句" unless read_statement
    expected_actions = %w[
      autoscaling:DescribeAutoScalingGroups
      autoscaling:DescribeAutoScalingInstances
      autoscaling:DescribeLaunchConfigurations
      autoscaling:DescribeScalingActivities
      autoscaling:DescribeTags
      ec2:DescribeImages
      ec2:DescribeInstanceTypes
      ec2:DescribeLaunchTemplateVersions
      ec2:GetInstanceTypesFromInstanceRequirements
      eks:DescribeNodegroup
    ].sort
    actions = Array(read_statement.fetch("Action")).sort
    abort "Cluster Autoscaler 容量元数据只读权限集合漂移" unless
      read_statement.fetch("Effect") == "Allow" &&
      Array(read_statement.fetch("Resource")) == ["*"] &&
      actions == expected_actions
  ' || fail 'Cluster Autoscaler 实际 IAM 策略无法读取或缺少 autoscaling:DescribeTags'

for custom_resource_definition in \
  externalsecrets.external-secrets.io \
  ingressclassparams.elbv2.k8s.aws \
  prometheusagents.monitoring.coreos.com \
  prometheusrules.monitoring.coreos.com \
  servicemonitors.monitoring.coreos.com \
  targetgroupbindings.elbv2.k8s.aws; do
  "$kubectl_binary" get customresourcedefinition "$custom_resource_definition" >/dev/null || \
    fail "缺少 CRD $custom_resource_definition"
done

"$kubectl_binary" get ingressclass alb >/dev/null || fail '缺少 alb IngressClass'

"$kubectl_binary" -n "$application_namespace" wait --for=condition=Ready \
  secretstore/slots-aws-secrets-manager --timeout="$rollout_timeout" >/dev/null || \
  fail '应用 namespace 的 SecretStore 未就绪'

check_synced_secret() {
  boundary=$1
  secret_name=$2
  shift 2

  "$kubectl_binary" -n "$application_namespace" wait --for=condition=Ready \
    "externalsecret/$secret_name" --timeout="$rollout_timeout" >/dev/null || \
    fail "$boundary ExternalSecret 未就绪"

  "$kubectl_binary" -n "$application_namespace" get "externalsecret/$secret_name" -o json | \
    ruby -rjson -e '
      resource = JSON.parse(STDIN.read)
      expected_name = ARGV.fetch(0)
      synced_version = resource.dig("status", "syncedResourceVersion").to_s
      target_name = resource.dig("spec", "target", "name")
      abort "ExternalSecret 没有同步版本" if synced_version.empty?
      abort "ExternalSecret target 不匹配" unless target_name == expected_name
    ' "$secret_name" || fail "$boundary ExternalSecret 版本契约不满足"

  "$kubectl_binary" -n "$application_namespace" get "secret/$secret_name" -o json | \
    ruby -rjson -e '
      resource = JSON.parse(STDIN.read)
      expected_name = ARGV.shift
      boundary = ARGV.shift
      expected_keys = ARGV
      owners = resource.dig("metadata", "ownerReferences") || []
      abort "Secret 不由对应 ExternalSecret 管理" unless owners.any? { |owner|
        owner["kind"] == "ExternalSecret" && owner["name"] == expected_name
      }
      data = resource.fetch("data")
      abort "Secret 未设置 immutable=true" unless resource["immutable"] == true
      abort "Secret 缺少必需非空 key" unless expected_keys.all? { |key|
        data[key].is_a?(String) && !data[key].empty?
      }
    ' "$secret_name" "$boundary" "$@" || fail "$boundary Kubernetes Secret 内容契约不满足"
}

runtime_database_name=$(json_value application_secret_names runtime-database)
migrator_database_name=$(json_value application_secret_names migrator-database)
operations_bearer_name=$(json_value application_secret_names operations-bearer)
api_runtime_assets_name=$(json_value application_secret_names api-runtime-assets)
worker_runtime_assets_name=$(json_value application_secret_names worker-runtime-assets)
shared_admission_name=$(json_value valkey_secret_name)

check_synced_secret runtime-database "$runtime_database_name" database-url
check_synced_secret migrator-database "$migrator_database_name" database-url
check_synced_secret operations-bearer "$operations_bearer_name" operations.token
check_synced_secret api-runtime-assets "$api_runtime_assets_name" \
  operators.json definition.json definition-approval.json definition-approval-public.pem \
  launch-hmac.key trust-bundle.pem \
  operator-access-private.pem operator-access-public.pem operator-request-public.pem \
  operator-response-private.pem operator-response-public.pem wallet-request-private.pem \
  wallet-request-public.pem wallet-response-public.pem
check_synced_secret worker-runtime-assets "$worker_runtime_assets_name" \
  operators.json definition.json definition-approval.json definition-approval-public.pem \
  outbox-hmac.key outbox-bearer.token outbox-root-ca.pem trust-bundle.pem \
  wallet-request-private.pem wallet-request-public.pem wallet-response-public.pem
check_synced_secret shared-admission "$shared_admission_name" username password hmac.key root-ca.pem

"$kubectl_binary" -n monitoring get serviceaccount/prometheus-agent >/dev/null || \
  fail 'monitoring/prometheus-agent ServiceAccount 缺失'
"$kubectl_binary" -n monitoring wait --for=condition=Available \
  prometheusagent/prometheus-agent --timeout="$rollout_timeout" >/dev/null || \
  fail 'Prometheus Agent 未达到 Available'

amp_endpoint=$(json_value amp_remote_write_endpoint)
aws_region=$(json_value aws_region)
agent_version=$(json_value application_handoff addon_versions prometheus-agent)
amp_remote_write_url="${amp_endpoint%/}/api/v1/remote_write"

"$kubectl_binary" -n monitoring get prometheusagent/prometheus-agent -o json | ruby -rjson -e '
  resource = JSON.parse(STDIN.read)
  namespace = ARGV.fetch(0)
  expected_url = ARGV.fetch(1)
  expected_region = ARGV.fetch(2)
  expected_version = "v#{ARGV.fetch(3)}"
  spec = resource.fetch("spec")
  abort "Prometheus Agent ServiceAccount 不匹配" unless spec["serviceAccountName"] == "prometheus-agent"
  abort "Prometheus Agent 版本不匹配" unless spec["version"] == expected_version
  abort "Prometheus Agent 没有选择应用 ServiceMonitor" unless
    spec.dig("serviceMonitorSelector", "matchLabels", "app.kubernetes.io/part-of") == "slots-game"
  abort "Prometheus Agent namespace selector 不匹配" unless
    spec.dig("serviceMonitorNamespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == namespace
  remote_write = Array(spec["remoteWrite"])
  abort "Prometheus Agent 没有使用 SigV4 写入约定 AMP endpoint" unless remote_write.any? { |entry|
    entry["url"] == expected_url && entry.dig("sigv4", "region") == expected_region
  }
  desired = Integer(spec.fetch("replicas"))
  available = Integer(resource.dig("status", "availableReplicas") || 0)
  conditions = Array(resource.dig("status", "conditions"))
  abort "Prometheus Agent 副本未全部可用" unless desired >= 1 && available >= desired
  %w[Reconciled Available].each do |type|
    abort "Prometheus Agent #{type} 条件未满足" unless conditions.any? { |condition|
      condition["type"] == type && condition["status"] == "True"
    }
  end
' "$application_namespace" "$amp_remote_write_url" "$aws_region" "$agent_version" || \
  fail 'Prometheus Agent/AMP 目标契约不满足'

printf '%s\n' 'AWS 平台前置门禁: passed'
