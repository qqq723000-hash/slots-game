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
  "alb.ingress.kubernetes.io/healthcheck-port" => "traffic-port",
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
%w[
  deletion_protection.enabled=true
  routing.http.drop_invalid_header_fields.enabled=true
  access_logs.s3.enabled=true
].each do |attribute|
  abort "ALB 安全或审计属性缺失: #{attribute}" unless load_balancer_attributes.include?(attribute)
end

service_names = resources.fetch("Service", []).map { |service| service.dig("metadata", "name") }
backend_name = ingress.dig("spec", "rules", 0, "http", "paths", 0, "backend", "service", "name")
abort "API Ingress 引用了不存在的 Service" unless service_names.include?(backend_name)
abort "operations Service 被错误暴露到公网" if backend_name.include?("operations")

network_policies = resources.fetch("NetworkPolicy", [])
rgs_ingress = network_policies.find do |policy|
  policy.dig("metadata", "name")&.end_with?("-rgs-ingress")
end
abort "AWS 渲染结果缺少 RGS 入口 NetworkPolicy" unless rgs_ingress
api_rule = rgs_ingress.dig("spec", "ingress").find do |rule|
  rule.fetch("ports", []).any? { |port| port["port"] == 8080 }
end
abort "RGS 公网端口缺少入口来源限制" unless api_rule
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
