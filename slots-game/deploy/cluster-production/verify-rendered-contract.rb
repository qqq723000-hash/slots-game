#!/usr/bin/env ruby

require "yaml"

root = ARGV.fetch(0)
expected_migrator_command = ARGV.fetch(1)
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
  target
end
abort "每个 Deployment 必须恰好由一个独立 HPA 管理" unless
  autoscaler_targets.sort == deployment_names.sort

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
  SlotsRGSHPAUnableToScale
  SlotsRGSSharedAdmissionErrors
  SlotsRGSAuthReplay
  SlotsRGSWalletUnknownOutcome
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
required_metrics = %w[
  rgs_ready
  rgs_http_server_failures_total
  rgs_http_requests_total
  rgs_capacity_rejected_total
  rgs_shared_admission_errors_total
  rgs_auth_replays_total
  rgs_wallet_unknown_outcomes_total
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
abort "RGS API 没有显式固定 api 角色" unless api_environment["RGS_RUNTIME_ROLE"] == "api"
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
]
abort "RGS API 缺少共享准入配置" unless
  (required_shared_environment - api_environment.keys).empty? &&
    api_environment["RGS_SHARED_ADMISSION_URL"].start_with?("rediss://")
shared_username = api_environment_items.fetch("RGS_SHARED_ADMISSION_USERNAME")
abort "RGS API 没有从独立共享准入 Secret 读取 ACL 用户名" unless
  shared_username["value"].nil? &&
    shared_username.dig("valueFrom", "secretKeyRef", "name") == "slots-rgs-shared-admission-v1" &&
    shared_username.dig("valueFrom", "secretKeyRef", "key") == "username"
abort "RGS Worker 没有显式固定 worker 角色" unless worker_environment["RGS_RUNTIME_ROLE"] == "worker"
abort "RGS Worker 缺少 outbox 所有者身份" unless worker_environment.key?("RGS_OUTBOX_OWNER")
abort "RGS Worker 被错误授予共享准入配置" if
  worker_environment.keys.any? { |name| name.start_with?("RGS_SHARED_ADMISSION_") }
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

deployments.each do |deployment|
  labels = deployment.dig("spec", "template", "metadata", "labels")
  abort "Pod 缺少公司日志管道审计标签" unless labels["slots-game.io/log-pipeline-provider"] == "company-node-log-pipeline"
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
