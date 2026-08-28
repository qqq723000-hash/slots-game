#!/usr/bin/env ruby

require "yaml"

root = ARGV.fetch(0)
expected_migrator_command = ARGV.fetch(1)
expected_tracing = ARGV.fetch(2, "enabled")
documents = Dir.glob(File.join(root, "**", "*.yaml")).sort.flat_map do |path|
  YAML.load_stream(File.read(path)).compact
end
abort "渲染目录没有 Kubernetes 资源" if documents.empty?

resources = documents.group_by { |document| document.fetch("kind") }
deployments = resources.fetch("Deployment", [])
services = resources.fetch("Service", [])
service_accounts = resources.fetch("ServiceAccount", [])

documents.each do |document|
  name = document.dig("metadata", "name")
  valid = name.is_a?(String) && name.length <= 63 &&
    name.match?(/\A[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\z/)
  abort "资源名称不是 63 字符以内的 DNS label: #{name.inspect}" unless valid
end

service_account_names = service_accounts.map { |item| item.dig("metadata", "name") }
deployments.each do |deployment|
  abort "启用 HPA 的 Deployment 不得固定 spec.replicas，避免 Helm 发布覆盖实时扩容结果" if
    deployment.fetch("spec").key?("replicas")
  pod = deployment.dig("spec", "template", "spec")
  account = pod.fetch("serviceAccountName")
  abort "Deployment 引用了不存在的 ServiceAccount: #{account}" unless service_account_names.include?(account)
  selector = pod.fetch("nodeSelector")
  abort "Deployment 未固定 linux/amd64" unless selector["kubernetes.io/os"] == "linux" &&
    selector["kubernetes.io/arch"] == "amd64"
end

tracing_environment = {
  "RGS_OTEL_TRACES_ENDPOINT" => "https://otel-collector.example.internal:4318/v1/traces",
  "RGS_OTEL_TRACE_SAMPLE_RATIO" => "0.01",
  "RGS_OTEL_BATCH_TIMEOUT" => "1000ms",
  "RGS_OTEL_EXPORT_TIMEOUT" => "3000ms",
  "RGS_OTEL_SHUTDOWN_TIMEOUT" => "5000ms",
  "RGS_OTEL_MAX_QUEUE_SIZE" => "1024",
  "RGS_OTEL_MAX_EXPORT_BATCH_SIZE" => "256"
}
runtime_deployments = deployments.select do |deployment|
  %w[rgs rgs-worker].include?(deployment.dig("metadata", "labels", "app.kubernetes.io/component"))
end
runtime_deployments.each do |deployment|
  environment = deployment.dig("spec", "template", "spec", "containers", 0, "env").to_h do |item|
    [item.fetch("name"), item["value"]]
  end
  if expected_tracing == "enabled"
    actual = environment.slice(*tracing_environment.keys).transform_values(&:to_s)
    abort "API/Worker tracing 环境变量不完整或不一致" unless actual == tracing_environment
  else
    abort "关闭 tracing 后仍向 API/Worker 注入 RGS_OTEL_*" if
      environment.keys.any? { |name| name.start_with?("RGS_OTEL_") }
  end
end

tracing_rules = resources.fetch("NetworkPolicy", []).flat_map do |policy|
  policy.dig("spec", "egress") || []
end.select do |rule|
  cidrs = (rule["to"] || []).map { |peer| peer.dig("ipBlock", "cidr") }.compact
  ports = (rule["ports"] || []).map { |port| port["port"] }
  cidrs.include?("10.60.0.0/24") || ports.include?(4318)
end
if expected_tracing == "enabled"
  abort "启用 tracing 后缺少唯一 collector CIDR/端口出口" unless
    tracing_rules.length == 1 &&
      tracing_rules[0].fetch("to").map { |peer| peer.dig("ipBlock", "cidr") } == ["10.60.0.0/24"] &&
      tracing_rules[0].fetch("ports") == [{"port" => 4318, "protocol" => "TCP"}]
else
  abort "关闭 tracing 后仍渲染 collector 出口" unless tracing_rules.empty?
end

pod_templates = deployments.map { |item| item.dig("spec", "template", "metadata", "labels") }
services.each do |service|
  selector = service.dig("spec", "selector")
  matched = pod_templates.any? do |labels|
    selector.all? { |key, value| labels[key] == value }
  end
  abort "Service selector 没有匹配任何 Deployment: #{service.dig("metadata", "name")}" unless matched
end

deployment_names = deployments.map { |item| item.dig("metadata", "name") }
autoscalers = resources.fetch("HorizontalPodAutoscaler", [])
autoscaler_targets = autoscalers.map do |autoscaler|
  target = autoscaler.dig("spec", "scaleTargetRef", "name")
  abort "HPA 引用了不存在的 Deployment: #{target}" unless deployment_names.include?(target)
  metric_contract = autoscaler.dig("spec", "metrics").map do |metric|
    [metric.fetch("type"), metric.dig("resource", "name")]
  end
  abort "HPA 在未交付指标 adapter 时不得伪装 I/O 自定义指标" unless
    metric_contract.sort_by { |type, name| "#{type}:#{name}" } ==
      [["Resource", "cpu"], ["Resource", "memory"]]
  target
end
abort "每个 Deployment 必须恰好由一个独立 HPA 管理" unless
  autoscaler_targets.sort == deployment_names.sort
rgs_autoscaler = autoscalers.find do |autoscaler|
  autoscaler.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs"
end
worker_autoscaler = autoscalers.find do |autoscaler|
  autoscaler.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs-worker"
end
abort "API/Worker HPA 缺少静态预热副本" unless
  rgs_autoscaler&.dig("spec", "minReplicas").to_i >= 3 &&
    worker_autoscaler&.dig("spec", "minReplicas").to_i >= 2

pdbs = resources.fetch("PodDisruptionBudget", [])
pdbs.each do |budget|
  selector = budget.dig("spec", "selector", "matchLabels")
  matched = pod_templates.any? { |labels| selector.all? { |key, value| labels[key] == value } }
  abort "PDB selector 没有匹配任何 Deployment" unless matched
end
abort "每个 Deployment 必须恰好配置一个独立 PDB" unless pdbs.length == deployments.length

service_names = services.map { |item| item.dig("metadata", "name") }
resources.fetch("Ingress", []).each do |ingress|
  ingress.fetch("spec").fetch("rules").each do |rule|
    rule.dig("http", "paths").each do |path|
      target = path.dig("backend", "service", "name")
      abort "Ingress 引用了不存在的 Service: #{target}" unless service_names.include?(target)
    end
  end
end

monitors = resources.fetch("ServiceMonitor", [])
monitor_jobs = monitors.to_h do |monitor|
  monitor_selector = monitor.dig("spec", "selector", "matchLabels")
  operations = services.find do |service|
    labels = service.dig("metadata", "labels")
    monitor_selector.all? { |key, value| labels[key] == value }
  end
  abort "ServiceMonitor selector 没有匹配 operations Service" unless operations
  job_label = monitor.dig("spec", "jobLabel")
  job_value = operations.dig("metadata", "labels", job_label)
  [job_value, [monitor, operations]]
end
abort "ServiceMonitor 没有分别固定 API 与 Worker job" unless
  monitor_jobs.keys.sort == %w[slots-rgs slots-rgs-worker]

prometheus_rule = resources.fetch("PrometheusRule", []).fetch(0)
abort "PrometheusRule 没有平台发现标签" unless
  prometheus_rule.dig("metadata", "labels", "prometheus") == "company-platform"
rules = prometheus_rule.dig("spec", "groups").flat_map { |group| group.fetch("rules") }
expected_alerts = %w[
  SlotsRGSTargetUnavailable
  SlotsRGSNotReady
  SlotsRGSWorkerTargetUnavailable
  SlotsRGSWorkerNotReady
  SlotsRGSServerErrorRateHigh
  SlotsRGSCapacityRejected
  SlotsRGSNewIntentCapacityRejected
  SlotsRGSCryptographicCapacityRejected
  SlotsRGSHPAUnableToScale
  SlotsRGSSharedAdmissionErrors
  SlotsRGSEconomicAdmissionLimitedSustained
  SlotsRGSEconomicAdmissionErrors
  SlotsRGSEconomicAdmissionUnavailable
  SlotsRGSEconomicAdmissionObservationStale
  SlotsRGSAuthReplay
  SlotsRGSSecurityLogDropsSustained
  SlotsRGSTraceExportFailures
  SlotsRGSWalletUnknownOutcome
  SlotsRGSWalletIsolationRejected
  SlotsRGSWalletCircuitOpen
  SlotsRGSWalletPendingSustained
  SlotsRGSWalletResponseAuthenticationInvalid
  SlotsRGSWalletLatencyHigh
  SlotsRGSWalletRequestsStalled
  SlotsRGSRecoveryBacklogHigh
  SlotsRGSRecoveryOldestDue
  SlotsRGSRecoveryLoopStale
  SlotsRGSRecoverySnapshotStale
  SlotsRGSRoundManualReview
  SlotsRGSIntegrityQuarantine
  SlotsRGSOutboxDeferred
  SlotsRGSOutboxLeaseLost
  SlotsRGSDatabasePoolSaturated
  SlotsRGSDatabasePoolWaits
]
actual_alerts = rules.map { |rule| rule.fetch("alert") }
abort "PrometheusRule 告警集合不完整或重复" unless actual_alerts.sort == expected_alerts.sort
rules.each do |rule|
  expression = rule.fetch("expr")
  expected_job = rule.fetch("alert") == "SlotsRGSHPAUnableToScale" ?
    'job="kube-state-metrics"' : nil
  abort "告警没有固定受控指标 job: #{rule.fetch("alert")}" unless
    (expected_job && expression.include?(expected_job)) ||
      expression.include?('job="slots-rgs"') ||
      expression.include?('job="slots-rgs-worker"') ||
      expression.include?('job=~"slots-rgs|slots-rgs-worker"')
  abort "告警没有固定发布 namespace: #{rule.fetch("alert")}" unless
    expression.include?('namespace="slots-production"')
end
hpa_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSHPAUnableToScale" }
hpa_names = autoscalers.to_h do |autoscaler|
  [autoscaler.dig("metadata", "labels", "app.kubernetes.io/component"), autoscaler.dig("metadata", "name")]
end
expected_hpa_matcher = "horizontalpodautoscaler=~\"#{hpa_names.fetch("rgs")}|#{hpa_names.fetch("rgs-worker")}\""
abort "HPA 告警没有同时要求 API 与 Worker ScalingActive" unless
  hpa_rule.fetch("expr").include?('condition="ScalingActive",status="true"') &&
    hpa_rule.fetch("expr").include?('count(max by (horizontalpodautoscaler) (kube_horizontalpodautoscaler_status_condition') &&
    hpa_rule.fetch("expr").scan('} == 1').length == 2 &&
    hpa_rule.fetch("expr").include?("< 2") &&
    hpa_rule.fetch("expr").include?('absent(kube_horizontalpodautoscaler_status_condition{job="kube-state-metrics",namespace="slots-production",condition="ScalingActive",status="true"') &&
    hpa_rule.fetch("expr").scan(expected_hpa_matcher).length == 2 &&
    !hpa_rule.fetch("expr").include?('horizontalpodautoscaler=~".*-')
readiness_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSNotReady" }
abort "RGS 就绪告警缺少指标消失分支" unless readiness_rule.fetch("expr").include?('absent(rgs_ready{')
worker_readiness_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSWorkerNotReady" }
abort "Worker 就绪告警缺少指标消失分支" unless
  worker_readiness_rule.fetch("expr").include?('absent(rgs_ready{job="slots-rgs-worker"')
auth_replay_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSAuthReplay" }
abort "认证重放告警必须使用五分钟 increase 并在首次事件时触发" unless
  auth_replay_rule.fetch("expr").strip ==
    'sum(increase(rgs_auth_replays_total{job="slots-rgs",namespace="slots-production"}[5m])) > 0'
abort "认证重放告警必须保持 warning 级别" unless
  auth_replay_rule.dig("labels", "severity") == "warning"
security_log_drop_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSSecurityLogDropsSustained" }
abort "安全日志丢弃告警必须使用五分钟 increase 且持续五分钟" unless
  security_log_drop_rule.fetch("expr").strip ==
    'sum(increase(rgs_security_logs_dropped_total{job=~"slots-rgs|slots-rgs-worker",namespace="slots-production"}[5m])) > 0' &&
    security_log_drop_rule.fetch("for") == "5m"
abort "安全日志丢弃告警必须保持 warning 级别" unless
  security_log_drop_rule.dig("labels", "severity") == "warning"
trace_export_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSTraceExportFailures" }
abort "追踪导出失败告警必须覆盖 API/Worker、使用五分钟 increase 且保持 warning" unless
  trace_export_rule.fetch("expr").strip ==
    'sum(increase(rgs_trace_export_failures_total{job=~"slots-rgs|slots-rgs-worker",namespace="slots-production"}[5m])) > 0' &&
    trace_export_rule.dig("labels", "severity") == "warning"
economic_unavailable_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSEconomicAdmissionUnavailable" }
abort "经济准入不可用告警必须只在基础 API 仍就绪时触发并覆盖指标缺失" unless
  economic_unavailable_rule.fetch("expr").include?('rgs_economic_admission_ready{job="slots-rgs",namespace="slots-production"} == 0') &&
    economic_unavailable_rule.fetch("expr").scan('rgs_ready{job="slots-rgs",namespace="slots-production"} == 1').length == 2 &&
    economic_unavailable_rule.fetch("expr").include?('unless on (job, namespace, instance)') &&
    economic_unavailable_rule.fetch("for") == "2m"
economic_stale_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSEconomicAdmissionObservationStale" }
abort "经济准入新鲜度告警必须使用保守 age 并覆盖从未验证或指标缺失" unless
  economic_stale_rule.fetch("expr").include?('rgs_economic_admission_last_success_age_seconds{job="slots-rgs",namespace="slots-production"} < 0') &&
    economic_stale_rule.fetch("expr").include?('rgs_economic_admission_last_success_age_seconds{job="slots-rgs",namespace="slots-production"} > 900') &&
    economic_stale_rule.fetch("expr").include?('unless on (job, namespace, instance)') &&
    economic_stale_rule.fetch("for") == "5m"
{
  "SlotsRGSRecoveryBacklogHigh" => ["rgs_recovery_backlog", ">= 501"],
  "SlotsRGSRecoveryOldestDue" => ["rgs_recovery_oldest_due_age_seconds", "> 120"],
}.each do |alert, (metric, threshold)|
  expression = rules.find { |rule| rule.fetch("alert") == alert }.fetch("expr")
  abort "#{alert} 没有只聚合同实例的新鲜恢复快照" unless
    expression.include?(metric) &&
      expression.include?("and on (instance)") &&
      expression.scan("rgs_recovery_snapshot_last_success_timestamp_seconds").length == 2 &&
      expression.include?("< 60") && expression.include?(threshold)
end
required_metrics = %w[
  rgs_ready
  rgs_http_server_failures_total
  rgs_http_requests_total
  rgs_capacity_rejected_total
  rgs_new_intent_capacity_rejected_total
  rgs_cryptographic_capacity_rejected_total
  rgs_shared_admission_errors_total
  rgs_economic_admission_ready
  rgs_economic_admission_last_success_age_seconds
  rgs_auth_replays_total
  rgs_security_logs_dropped_total
  rgs_wallet_unknown_outcomes_total
  rgs_wallet_isolation_rejected_total
  rgs_wallet_breakers
  rgs_wallet_request_duration_seconds_count
  rgs_wallet_request_duration_seconds_bucket
  rgs_wallet_inflight
  rgs_recovery_backlog
  rgs_recovery_oldest_due_age_seconds
  rgs_recovery_loop_last_success_timestamp_seconds
  rgs_recovery_snapshot_last_success_timestamp_seconds
  rgs_rounds_manual_review_total
  rgs_round_integrity_quarantines_total
  rgs_session_integrity_quarantines_total
  rgs_outbox_deferred_total
  rgs_outbox_lease_lost_total
  rgs_db_pool_in_use_connections
  rgs_db_pool_max_open_connections
  rgs_db_pool_wait_count_total
]
all_expressions = rules.map { |rule| rule.fetch("expr") }.join("\n")
required_metrics.each do |metric|
  abort "PrometheusRule 缺少现有 RGS 指标: #{metric}" unless all_expressions.match?(/\b#{Regexp.escape(metric)}\b/)
end

rgs = deployments.find do |deployment|
  deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs"
end
abort "缺少 RGS Deployment" unless rgs
worker = deployments.find do |deployment|
  deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs-worker"
end
abort "缺少 RGS Worker Deployment" unless worker
api_container = rgs.dig("spec", "template", "spec", "containers").fetch(0)
worker_container = worker.dig("spec", "template", "spec", "containers").fetch(0)
abort "RGS liveness 必须使用私有 operations 8081 /healthz" unless
  api_container.dig("livenessProbe", "httpGet", "path") == "/healthz" &&
    api_container.dig("livenessProbe", "httpGet", "port") == "operations"
abort "RGS readiness 必须通过携带 operations Bearer 的私有 /service-probe" unless
  api_container.dig("readinessProbe", "exec", "command") == ["/service-probe"] &&
    api_container.dig("startupProbe", "exec", "command") == ["/service-probe"]
abort "Worker rollout 必须由携带 operations Bearer 的恢复首轮 readyz 门禁驱动" unless
  worker_container.dig("readinessProbe", "exec", "command") == ["/service-probe"] &&
    worker_container.dig("startupProbe", "exec", "command") == ["/service-probe"] &&
    worker_container.dig("startupProbe", "successThreshold") == 1 &&
    worker.dig("spec", "strategy", "rollingUpdate", "maxUnavailable") == 0
worker_startup_budget = worker_container.dig("startupProbe", "periodSeconds") *
  worker_container.dig("startupProbe", "failureThreshold")
abort "Worker startup probe 预算必须小于 rollout progress deadline" unless
  worker_startup_budget < worker.dig("spec", "progressDeadlineSeconds")
api_environment = api_container.fetch("env").to_h { |item| [item.fetch("name"), item["value"]] }
worker_environment = worker_container.fetch("env").to_h { |item| [item.fetch("name"), item["value"]] }
api_environment_items = api_container.fetch("env").to_h { |item| [item.fetch("name"), item] }
expected_definition_identity = {
  "RGS_EXPECTED_DEFINITION_GAME_ID" => "iron-colossus",
  "RGS_EXPECTED_DEFINITION_VERSION" => "definition-v1",
  "RGS_EXPECTED_DEFINITION_SHA256" => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
}
abort "API 没有绑定候选数学定义身份" unless api_environment.slice(*expected_definition_identity.keys) ==
  expected_definition_identity
abort "Worker 没有绑定候选数学定义身份" unless worker_environment.slice(*expected_definition_identity.keys) ==
  expected_definition_identity
{"API" => rgs, "Worker" => worker}.each do |name, deployment|
  annotations = deployment.dig("spec", "template", "metadata", "annotations")
  abort "#{name} Pod 模板没有固化数学定义身份" unless
    annotations["slots-game.io/definition-game-id"] == expected_definition_identity["RGS_EXPECTED_DEFINITION_GAME_ID"] &&
      annotations["slots-game.io/definition-version"] == expected_definition_identity["RGS_EXPECTED_DEFINITION_VERSION"] &&
      annotations["slots-game.io/definition-sha256"] == expected_definition_identity["RGS_EXPECTED_DEFINITION_SHA256"]
end
abort "RGS API 访问令牌协议未固定为 v3" unless
  rgs.dig("spec", "template", "metadata", "annotations", "slots-game.io/access-token-protocol") == "RGS-ACCESS-v3"
abort "RGS API 没有显式固定 api 角色" unless api_environment["RGS_RUNTIME_ROLE"] == "api"
abort "RGS API 请求体硬上限没有与 ALB WAF 8 KiB 检查窗口对齐" unless
  api_environment["RGS_MAX_REQUEST_BYTES"] == "8192"
abort "RGS API 没有固定匿名并发/加密容量或预认证高水位" unless
  api_environment["RGS_MAX_IN_FLIGHT_REQUESTS"] == "128" &&
    api_environment["RGS_MAX_CRYPTO_IN_FLIGHT"] == "64" &&
    api_environment["RGS_PREAUTH_RATE_PER_SECOND"] == "5000" &&
    api_environment["RGS_PREAUTH_RATE_BURST"] == "10000"
abort "RGS API 不得按未认证 method/path 授予恢复预留" if
  api_environment.key?("RGS_RECOVERY_IN_FLIGHT_RESERVE") ||
    api_environment.key?("RGS_CRYPTO_RECOVERY_RESERVE")
abort "RGS API 没有固定独立的一秒钱包快速路径预算" unless
  api_environment["RGS_WALLET_FAST_PATH_TIMEOUT"] == "1s" &&
    api_environment["RGS_WALLET_TIMEOUT"] == "4s"
abort "RGS API 没有为结果闭环固定数据库保留连接" unless
  api_environment["RGS_DB_MAX_OPEN_CONNS"] == "20" &&
    api_environment["RGS_DB_CRITICAL_RESERVE_CONNS"] == "5"
abort "RGS API 被错误授予 outbox 配置" if api_environment.keys.any? { |name| name.start_with?("RGS_OUTBOX_") }
required_shared_environment = %w[
  RGS_SHARED_ADMISSION_URL
  RGS_SHARED_ADMISSION_USERNAME
  RGS_SHARED_ADMISSION_PASSWORD_FILE
  RGS_SHARED_ADMISSION_HMAC_KEY_FILE
  RGS_SHARED_ADMISSION_ROOT_CA_FILE
  RGS_SHARED_ADMISSION_TIMEOUT
  RGS_SHARED_ADMISSION_RATE_PER_SECOND
  RGS_SHARED_ADMISSION_RATE_BURST
  RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND
  RGS_ECONOMIC_OPERATOR_RATE_BURST
  RGS_ECONOMIC_BACKEND_RATE_PER_SECOND
  RGS_ECONOMIC_BACKEND_RATE_BURST
]
abort "RGS API 缺少共享准入配置" unless
  (required_shared_environment - api_environment.keys).empty? &&
    api_environment["RGS_SHARED_ADMISSION_URL"].start_with?("rediss://")
abort "RGS API EDoS 双成本桶未固定经审计基线" unless
  api_environment["RGS_ECONOMIC_OPERATOR_RATE_PER_SECOND"] == "20" &&
    api_environment["RGS_ECONOMIC_OPERATOR_RATE_BURST"] == "40" &&
    api_environment["RGS_ECONOMIC_BACKEND_RATE_PER_SECOND"] == "100" &&
    api_environment["RGS_ECONOMIC_BACKEND_RATE_BURST"] == "200"
shared_username = api_environment_items.fetch("RGS_SHARED_ADMISSION_USERNAME")
abort "RGS API 没有从独立共享准入 Secret 读取 ACL 用户名" unless
  shared_username["value"].nil? &&
    shared_username.dig("valueFrom", "secretKeyRef", "name") == "slots-rgs-shared-admission-v1" &&
    shared_username.dig("valueFrom", "secretKeyRef", "key") == "username"
abort "RGS Worker 没有显式固定 worker 角色" unless worker_environment["RGS_RUNTIME_ROLE"] == "worker"
abort "RGS Worker 被错误授予 API 新意图数据库保留配置" if
  worker_environment.key?("RGS_DB_CRITICAL_RESERVE_CONNS")
abort "RGS Worker 被错误授予 API 快速路径预算" if worker_environment.key?("RGS_WALLET_FAST_PATH_TIMEOUT")
abort "RGS Worker 缺少 outbox 所有者身份" unless worker_environment.key?("RGS_OUTBOX_OWNER")
abort "RGS Worker 没有固定加密并发上限" unless
  worker_environment["RGS_MAX_CRYPTO_IN_FLIGHT"] == "64"
abort "RGS Worker 不得按未认证任务类型授予恢复加密预留" if
  worker_environment.key?("RGS_CRYPTO_RECOVERY_RESERVE")
abort "RGS Worker 被错误授予共享准入配置" if
  worker_environment.keys.any? do |name|
    name.start_with?("RGS_SHARED_ADMISSION_") || name.start_with?("RGS_ECONOMIC_")
  end
worker_ports = worker_container.fetch("ports").map { |port| port.fetch("name") }
abort "RGS Worker 暴露了运维端口以外的监听端口" unless worker_ports == ["operations"]

api_pod = rgs.dig("spec", "template", "spec")
worker_pod = worker.dig("spec", "template", "spec")
materializer = api_pod.fetch("initContainers").find do |container|
  container["name"] == "shared-admission-secret-materializer"
end
abort "RGS API 缺少 0400 共享准入凭据物化器" unless materializer &&
  materializer.fetch("command") == ["/secret-materializer"] &&
  materializer.dig("securityContext", "runAsUser") == 65_532 &&
  materializer.dig("securityContext", "allowPrivilegeEscalation") == false
api_volume_names = api_pod.fetch("volumes").map { |volume| volume.fetch("name") }
worker_volume_names = worker_pod.fetch("volumes").map { |volume| volume.fetch("name") }
abort "RGS API 缺少共享准入源 Secret 或内存凭据卷" unless
  api_volume_names.include?("shared-admission-source") && api_volume_names.include?("shared-admission")
abort "RGS Worker 被错误挂载共享准入凭据" if
  worker_volume_names.any? { |name| name.start_with?("shared-admission") }
shared_source = api_pod.fetch("volumes").find { |volume| volume["name"] == "shared-admission-source" }
shared_target = api_pod.fetch("volumes").find { |volume| volume["name"] == "shared-admission" }
abort "共享准入源必须来自独立 Kubernetes Secret" unless shared_source.dig("secret", "secretName") ==
  "slots-rgs-shared-admission-v1"
abort "共享准入最终凭据必须位于 Memory emptyDir" unless
  shared_target.dig("emptyDir", "medium") == "Memory"
expected_runtime_secrets = {
  "slots-rgs" => "slots-rgs-api-runtime-assets-v1",
  "slots-rgs-worker" => "slots-rgs-worker-runtime-assets-v1",
}
{"slots-rgs" => rgs, "slots-rgs-worker" => worker}.each do |job, deployment|
  volumes = deployment.dig("spec", "template", "spec", "volumes")
  operation_secret = volumes.find { |volume| volume["name"] == "operations-bearer" }.dig("secret", "secretName")
  runtime_secret = volumes.find { |volume| volume["name"] == "runtime-assets" }.dig("secret", "secretName")
  monitor = monitor_jobs.fetch(job).fetch(0)
  monitor_secret = monitor.dig("spec", "endpoints", 0, "authorization", "credentials", "name")
  abort "ServiceMonitor 与 #{job} 未引用同一个 operations Bearer Secret" unless monitor_secret == operation_secret
  abort "operations Bearer 与运行签名材料错误共用 Secret" if operation_secret == runtime_secret
  abort "#{job} 没有引用角色隔离的运行 Secret" unless runtime_secret == expected_runtime_secrets.fetch(job)
end
worker_runtime_volume = worker_pod.fetch("volumes").find { |volume| volume["name"] == "runtime-assets" }
worker_runtime_paths = worker_runtime_volume.dig("secret", "items").map { |item| item.fetch("path") }
abort "Worker 被错误挂载 API 专属签发材料" if worker_runtime_paths.any? do |path|
  path.match?(/access|operator-response|launch/i)
end

audit_policies = resources.fetch("NetworkPolicy", []).select do |policy|
  policy.dig("spec", "egress")&.any? do |egress|
    egress.fetch("to", []).any? { |target| target.dig("ipBlock", "cidr") == "10.40.0.0/24" }
  end
end
abort "审计出口必须只由一个 NetworkPolicy 授权" unless audit_policies.length == 1
audit_selector = audit_policies.fetch(0).dig("spec", "podSelector", "matchLabels")
abort "审计出口没有严格选择 RGS Worker" unless
  audit_selector["app.kubernetes.io/component"] == "rgs-worker"

shared_policies = resources.fetch("NetworkPolicy", []).select do |policy|
  policy.dig("spec", "egress")&.any? do |egress|
    egress.fetch("to", []).any? { |target| target.dig("ipBlock", "cidr") == "10.50.0.0/24" }
  end
end
abort "共享准入出口必须只由一个 NetworkPolicy 授权" unless shared_policies.length == 1
shared_selector = shared_policies.fetch(0).dig("spec", "podSelector", "matchLabels")
abort "共享准入出口没有严格选择 RGS API" unless
  shared_selector["app.kubernetes.io/component"] == "rgs"

rgs_ingress_policy = resources.fetch("NetworkPolicy", []).find do |policy|
  policy.dig("metadata", "name")&.end_with?("-rgs-ingress")
end
abort "缺少 RGS 入口 NetworkPolicy" unless rgs_ingress_policy
entry_rule = rgs_ingress_policy.dig("spec", "ingress").find do |rule|
  rule.fetch("ports", []).any? { |port| port["port"] == 8080 }
end
abort "RGS 入口 NetworkPolicy 缺少业务端口" unless entry_rule
abort "入口来源必须只访问业务 8080 与私有健康检查 8081" unless
  entry_rule.fetch("ports").map { |port| [port["port"], port["protocol"]] }.sort ==
    [[8080, "TCP"], [8081, "TCP"]]

deployments.each do |deployment|
  labels = deployment.dig("spec", "template", "metadata", "labels")
  abort "Pod 缺少外部日志管道审计标签" unless labels["slots-game.io/log-pipeline-provider"] == "company-node-log-pipeline"
end
web = deployments.find do |deployment|
  deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "web"
end
abort "缺少 Web Deployment" unless web
abort "Web Pod 缺少版本隔离审计标签" unless
  web.dig("spec", "template", "metadata", "labels", "slots-game.io/web-version-isolation-provider") ==
    "company-web-blue-green"
web_ingress = resources.fetch("Ingress", []).find do |ingress|
  ingress.dig("metadata", "labels", "app.kubernetes.io/component") == "web"
end
abort "Web Ingress 缺少版本隔离审计标签" unless
  web_ingress&.dig("metadata", "labels", "slots-game.io/web-version-isolation-provider") ==
    "company-web-blue-green"

(deployments + resources.fetch("Job", [])).each do |workload|
  pod = workload.dig("spec", "template", "spec")
  selector = pod.fetch("nodeSelector")
  abort "工作负载未固定 linux/amd64" unless selector["kubernetes.io/os"] == "linux" &&
    selector["kubernetes.io/arch"] == "amd64"
  (pod.fetch("containers") + pod.fetch("initContainers", [])).each do |container|
    image = container.fetch("image")
    abort "工作负载镜像未绑定 sha256 摘要" unless image.match?(/@sha256:[a-f0-9]{64}\z/)
  end
end

migrator = resources.fetch("Job", []).fetch(0)
actual_command = migrator.dig("spec", "template", "spec", "containers", 0, "args", 0)
abort "迁移器命令不符合发布阶段: #{actual_command.inspect}" unless actual_command == expected_migrator_command

puts "cluster rendered contract: passed"
