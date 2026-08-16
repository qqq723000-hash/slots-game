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
resources.fetch("HorizontalPodAutoscaler", []).each do |autoscaler|
  target = autoscaler.dig("spec", "scaleTargetRef", "name")
  abort "HPA 引用了不存在的 Deployment: #{target}" unless deployment_names.include?(target)
end

resources.fetch("PodDisruptionBudget", []).each do |budget|
  selector = budget.dig("spec", "selector", "matchLabels")
  matched = pod_templates.any? { |labels| selector.all? { |key, value| labels[key] == value } }
  abort "PDB selector 没有匹配任何 Deployment" unless matched
end

service_names = services.map { |item| item.dig("metadata", "name") }
resources.fetch("Ingress", []).each do |ingress|
  ingress.fetch("spec").fetch("rules").each do |rule|
    rule.dig("http", "paths").each do |path|
      target = path.dig("backend", "service", "name")
      abort "Ingress 引用了不存在的 Service: #{target}" unless service_names.include?(target)
    end
  end
end

monitor = resources.fetch("ServiceMonitor", []).fetch(0)
monitor_selector = monitor.dig("spec", "selector", "matchLabels")
operations = services.find do |service|
  labels = service.dig("metadata", "labels")
  monitor_selector.all? { |key, value| labels[key] == value }
end
abort "ServiceMonitor selector 没有匹配 operations Service" unless operations
job_label = monitor.dig("spec", "jobLabel")
job_value = operations.dig("metadata", "labels", job_label)
abort "ServiceMonitor 没有把 operations Service 固定为 slots-rgs job" unless job_value == "slots-rgs"

prometheus_rule = resources.fetch("PrometheusRule", []).fetch(0)
abort "PrometheusRule 没有平台发现标签" unless
  prometheus_rule.dig("metadata", "labels", "prometheus") == "company-platform"
rules = prometheus_rule.dig("spec", "groups").flat_map { |group| group.fetch("rules") }
expected_alerts = %w[
  SlotsRGSTargetUnavailable
  SlotsRGSNotReady
  SlotsRGSServerErrorRateHigh
  SlotsRGSCapacityRejected
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
  abort "告警没有固定 slots-rgs job: #{rule.fetch("alert")}" unless expression.include?('job="slots-rgs"')
  abort "告警没有固定发布 namespace: #{rule.fetch("alert")}" unless
    expression.include?('namespace="slots-production"')
end
readiness_rule = rules.find { |rule| rule.fetch("alert") == "SlotsRGSNotReady" }
abort "RGS 就绪告警缺少指标消失分支" unless readiness_rule.fetch("expr").include?('absent(rgs_ready{')
required_metrics = %w[
  rgs_ready
  rgs_http_server_failures_total
  rgs_http_requests_total
  rgs_capacity_rejected_total
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
rgs_volumes = rgs.dig("spec", "template", "spec", "volumes")
operation_secret = rgs_volumes.find { |volume| volume["name"] == "operations-bearer" }.dig("secret", "secretName")
runtime_secret = rgs_volumes.find { |volume| volume["name"] == "runtime-assets" }.dig("secret", "secretName")
monitor_secret = monitor.dig("spec", "endpoints", 0, "authorization", "credentials", "name")
abort "ServiceMonitor 与 RGS 未引用同一个 operations Bearer Secret" unless monitor_secret == operation_secret
abort "operations Bearer 与运行签名材料错误共用 Secret" if operation_secret == runtime_secret

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
  pod.fetch("containers").each do |container|
    image = container.fetch("image")
    abort "工作负载镜像未绑定 sha256 摘要" unless image.match?(/@sha256:[a-f0-9]{64}\z/)
  end
end

migrator = resources.fetch("Job", []).fetch(0)
actual_command = migrator.dig("spec", "template", "spec", "containers", 0, "args", 0)
abort "迁移器命令不符合发布阶段: #{actual_command.inspect}" unless actual_command == expected_migrator_command

puts "cluster rendered contract: passed"
