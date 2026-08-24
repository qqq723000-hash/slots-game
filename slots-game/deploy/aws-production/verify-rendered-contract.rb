#!/usr/bin/env ruby

require "json"
require "yaml"

rendered_path = ARGV.fetch(0)
expected_migrator_command = ARGV.fetch(1)
documents = YAML.load_stream(File.read(rendered_path)).compact
abort "AWS 渲染结果没有 Kubernetes 资源" if documents.empty?

resources = documents.group_by { |document| document.fetch("kind") }
components = documents.map do |document|
  document.dig("metadata", "labels", "app.kubernetes.io/component")
end.compact

abort "AWS 正式环境错误渲染了 Web 组件" if components.include?("web")
expected_runtime_components = %w[rgs rgs-worker].sort
deployments = resources.fetch("Deployment", [])
hpas = resources.fetch("HorizontalPodAutoscaler", [])
pdbs = resources.fetch("PodDisruptionBudget", [])
{
  "Deployment" => deployments,
  "HorizontalPodAutoscaler" => hpas,
  "PodDisruptionBudget" => pdbs
}.each do |kind, items|
  actual_components = items.map do |item|
    item.dig("metadata", "labels", "app.kubernetes.io/component")
  end.sort
  abort "AWS 正式环境必须恰好渲染 RGS API 与 Worker 的 #{kind}" unless
    actual_components == expected_runtime_components
end
abort "AWS 正式环境必须恰好渲染一个 API Ingress" unless resources.fetch("Ingress", []).length == 1
abort "AWS 正式环境不得创建 Secret 或内置数据库" unless (resources.keys & %w[Secret StatefulSet]).empty?

ingress = resources.fetch("Ingress").fetch(0)
abort "API Ingress 未使用 AWS ALB class" unless ingress.dig("spec", "ingressClassName") == "alb"
abort "ALB 终止 TLS 时不得引用 Kubernetes TLS Secret" if ingress.dig("spec").key?("tls")
abort "API Ingress 主机名不符合 AWS 示例契约" unless
  ingress.dig("spec", "rules", 0, "host") == "rgs.production.example.com"

annotations = ingress.dig("metadata", "annotations") || {}
expected_annotations = {
  "alb.ingress.kubernetes.io/scheme" => "internet-facing",
  "alb.ingress.kubernetes.io/target-type" => "ip",
  "alb.ingress.kubernetes.io/ip-address-type" => "ipv4",
  "alb.ingress.kubernetes.io/backend-protocol" => "HTTP",
  "alb.ingress.kubernetes.io/ssl-redirect" => "443",
  "alb.ingress.kubernetes.io/healthcheck-path" => "/healthz",
  "alb.ingress.kubernetes.io/healthcheck-port" => "8081",
  "alb.ingress.kubernetes.io/success-codes" => "200",
  "alb.ingress.kubernetes.io/manage-backend-security-group-rules" => "true"
}
expected_annotations.each do |key, value|
  abort "ALB 注解缺失或错误: #{key}" unless annotations[key] == value
end
abort "ALB 不得探测仅存在于私有运维监听器的 /readyz" if
  annotations["alb.ingress.kubernetes.io/healthcheck-path"] == "/readyz"

listen_ports = JSON.parse(annotations.fetch("alb.ingress.kubernetes.io/listen-ports"))
abort "ALB 必须只提供 HTTP 重定向入口与 HTTPS 业务入口" unless
  listen_ports == [{ "HTTP" => 80 }, { "HTTPS" => 443 }]

certificate_arn = annotations.fetch("alb.ingress.kubernetes.io/certificate-arn", "")
waf_arn = annotations.fetch("alb.ingress.kubernetes.io/wafv2-acl-arn", "")
abort "ALB 未绑定区域 ACM 证书" unless certificate_arn.match?(%r{\Aarn:aws:acm:[a-z0-9-]+:\d{12}:certificate/[0-9a-f-]+\z})
abort "ALB 未绑定区域 WAFv2 Web ACL" unless waf_arn.match?(%r{\Aarn:aws:wafv2:[a-z0-9-]+:\d{12}:regional/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+\z})

subnets = annotations.fetch("alb.ingress.kubernetes.io/subnets", "").split(",")
abort "ALB 必须显式分布到三个不同子网" unless subnets.length == 3 && subnets.uniq.length == 3 &&
  subnets.all? { |subnet| subnet.match?(/\Asubnet-[0-9a-f]+\z/) }
abort "ALB 必须显式绑定安全组" unless
  annotations.fetch("alb.ingress.kubernetes.io/security-groups", "").match?(/\Asg-[0-9a-f]+\z/)

load_balancer_attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes", "").split(",")
attribute_pairs = load_balancer_attributes.map do |attribute|
  key, value = attribute.split("=", 2)
  abort "ALB 属性格式不合法" if key.nil? || key.empty? || value.nil? || value.empty?
  [key, value]
end
attribute_keys = attribute_pairs.map(&:first)
abort "ALB 属性键不得重复" unless attribute_keys.uniq.length == attribute_keys.length
expected_attribute_values = {
  "deletion_protection.enabled" => "true",
  "waf.fail_open.enabled" => "false",
  "routing.http.drop_invalid_header_fields.enabled" => "true",
  "routing.http.desync_mitigation_mode" => "strictest",
  "routing.http2.enabled" => "true",
  "idle_timeout.timeout_seconds" => "30",
  "client_keep_alive.seconds" => "300",
  "access_logs.s3.enabled" => "true",
}
allowed_attribute_keys = expected_attribute_values.keys + %w[access_logs.s3.bucket access_logs.s3.prefix]
abort "ALB 属性键集合不精确" unless attribute_keys.sort == allowed_attribute_keys.sort
attribute_map = attribute_pairs.to_h
abort "ALB 安全、容量或审计属性漂移" unless
  expected_attribute_values.all? { |key, value| attribute_map[key] == value }
abort "ALB 访问日志 bucket 不合法" unless
  attribute_map.fetch("access_logs.s3.bucket", "").match?(/\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\z/)
abort "ALB 访问日志 prefix 不合法" unless
  attribute_map.fetch("access_logs.s3.prefix", "").match?(%r{\A[a-z0-9][a-z0-9/_-]{1,127}\z})

service_names = resources.fetch("Service", []).map { |service| service.dig("metadata", "name") }
backend_name = ingress.dig("spec", "rules", 0, "http", "paths", 0, "backend", "service", "name")
abort "API Ingress 引用了不存在的 Service" unless service_names.include?(backend_name)
abort "operations Service 被错误暴露到公网" if backend_name.include?("operations")

rgs = deployments.find do |deployment|
  deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs"
end
rgs_environment = rgs.dig("spec", "template", "spec", "containers", 0, "env").to_h do |item|
  [item.fetch("name"), item["value"]]
end
abort "RGS 请求体上限没有与 ALB WAF 8 KiB 检查窗口对齐" unless
  rgs_environment["RGS_MAX_REQUEST_BYTES"] == "8192"
abort "RGS 没有固定匿名加密容量与预认证高水位" unless
  rgs_environment["RGS_MAX_CRYPTO_IN_FLIGHT"] == "64" &&
    rgs_environment["RGS_PREAUTH_RATE_PER_SECOND"] == "5000" &&
    rgs_environment["RGS_PREAUTH_RATE_BURST"] == "10000"
abort "RGS 不得按未认证 method/path 授予恢复预留" if
  rgs_environment.key?("RGS_RECOVERY_IN_FLIGHT_RESERVE") ||
    rgs_environment.key?("RGS_CRYPTO_RECOVERY_RESERVE")

network_policies = resources.fetch("NetworkPolicy", [])
rgs_ingress = network_policies.find do |policy|
  policy.dig("metadata", "name")&.end_with?("-rgs-ingress")
end
abort "AWS 渲染结果缺少 RGS 入口 NetworkPolicy" unless rgs_ingress
api_rule = rgs_ingress.dig("spec", "ingress").find do |rule|
  rule.fetch("ports", []).any? { |port| port["port"] == 8080 }
end
abort "RGS 公网端口缺少入口来源限制" unless api_rule
abort "受控 ALB 来源必须只访问业务 8080 与私有健康检查 8081" unless
  api_rule.fetch("ports").map { |port| [port["port"], port["protocol"]] }.sort ==
    [[8080, "TCP"], [8081, "TCP"]]
api_sources = api_rule.fetch("from")
expected_ingress_cidrs = %w[10.0.10.0/24 10.0.11.0/24 10.0.12.0/24]
actual_ingress_cidrs = api_sources.map { |source| source.dig("ipBlock", "cidr") }
abort "RGS 公网端口必须只接受三个受控入口子网 CIDR" unless
  actual_ingress_cidrs == expected_ingress_cidrs

documents.each do |document|
  serialized = document.to_yaml
  abort "AWS 渲染结果包含全网 NetworkPolicy" if serialized.include?("0.0.0.0/0")
  abort "AWS 渲染结果泄漏了未使用的 Web 镜像" if serialized.include?("slots/web-unused")
  abort "AWS 渲染结果引用了未使用的 TLS Secret" if serialized.include?("unused-by-")
end

workloads = resources.fetch("Deployment", []) + resources.fetch("Job", [])
workloads.each do |workload|
  workload.dig("spec", "template", "spec", "containers").each do |container|
    abort "AWS 工作负载镜像未绑定 sha256 摘要" unless
      container.fetch("image").match?(/@sha256:[a-f0-9]{64}\z/)
  end
end

migrator = resources.fetch("Job", []).fetch(0)
actual_command = migrator.dig("spec", "template", "spec", "containers", 0, "args", 0)
abort "AWS 迁移器命令不符合发布阶段: #{actual_command.inspect}" unless
  actual_command == expected_migrator_command

puts "AWS rendered contract: passed"
