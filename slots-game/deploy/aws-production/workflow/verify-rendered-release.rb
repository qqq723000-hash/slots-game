#!/usr/bin/env ruby

# 该门禁校验正式 values 的实际 Helm 输出，不接受示例域名、宽松网络或未绑定摘要的镜像。
# English: This gate validates the actual Helm output from production values and rejects example domains,
# permissive networks, and images that are not digest-bound.
require "json"
require "yaml"

rendered_path, expected_rgs_image, expected_migrator_image, expected_namespace,
  expected_api_runtime_secret, expected_worker_runtime_secret, expected_shared_admission_secret = ARGV
abort "用法：verify-rendered-release.rb RENDERED RGS_IMAGE MIGRATOR_IMAGE NAMESPACE API_SECRET WORKER_SECRET SHARED_SECRET" unless
  expected_shared_admission_secret

secret_name_pattern = /\A[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-v[1-9][0-9]*\z/
abort "API 运行素材 Secret 名不合法" unless
  expected_api_runtime_secret.match?(secret_name_pattern) && expected_api_runtime_secret.length <= 253
abort "Worker 运行素材 Secret 名不合法" unless
  expected_worker_runtime_secret.match?(secret_name_pattern) && expected_worker_runtime_secret.length <= 253
abort "API 与 Worker 必须使用不同运行素材 Secret" if
  expected_api_runtime_secret == expected_worker_runtime_secret
abort "共享准入 Secret 名不合法" unless
  expected_shared_admission_secret.match?(secret_name_pattern) && expected_shared_admission_secret.length <= 253
abort "共享准入 Secret 必须与 API、Worker 运行素材 Secret 分离" if
  [expected_api_runtime_secret, expected_worker_runtime_secret].include?(expected_shared_admission_secret)

image_pattern = %r{\A([0-9]{12})\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-[0-9]+)\.amazonaws\.com/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}\z}
rgs_match = image_pattern.match(expected_rgs_image)
migrator_match = image_pattern.match(expected_migrator_image)
abort "RGS 镜像不是规范 ECR digest 引用" unless rgs_match
abort "Migrator 镜像不是规范 ECR digest 引用" unless migrator_match
abort "RGS 与 Migrator 必须属于同一账号和区域" unless rgs_match.captures == migrator_match.captures
expected_account_id, expected_region = rgs_match.captures

documents = YAML.load_stream(File.read(rendered_path)).compact
abort "Helm 没有渲染任何 Kubernetes 资源" if documents.empty?
documents.each do |document|
  abort "渲染结果包含非对象文档" unless document.is_a?(Hash)
  metadata = document.fetch("metadata")
  abort "资源缺少名称" if metadata.fetch("name", "").empty?
  abort "资源逃离正式 namespace" unless metadata.fetch("namespace", expected_namespace) == expected_namespace
end

resources = documents.group_by { |document| document.fetch("kind") }
forbidden_kinds = %w[Secret StatefulSet DaemonSet PersistentVolume PersistentVolumeClaim]
present_forbidden = resources.keys & forbidden_kinds
abort "渲染结果包含禁止资源：#{present_forbidden.join(',')}" unless present_forbidden.empty?

serialized = documents.map(&:to_yaml).join("\n")
abort "渲染结果仍包含占位值" if serialized.match?(/REPLACE_|\.example\.(?:com|internal)|localhost|123456789012/)
abort "渲染结果包含全网 NetworkPolicy" if serialized.include?("0.0.0.0/0")

components = documents.map { |document| document.dig("metadata", "labels", "app.kubernetes.io/component") }.compact
abort "AWS 正式环境错误渲染了 Web 组件" if components.include?("web")

deployments = resources.fetch("Deployment", [])
deployment_components = deployments.map { |deployment| deployment.dig("metadata", "labels", "app.kubernetes.io/component") }
abort "必须恰好渲染 RGS API 与独立 Worker" unless deployment_components.sort == %w[rgs rgs-worker]

expected_runtime_secrets = {
  "rgs" => expected_api_runtime_secret,
  "rgs-worker" => expected_worker_runtime_secret,
}
deployments.each do |deployment|
  component = deployment.dig("metadata", "labels", "app.kubernetes.io/component")
  expected_secret = expected_runtime_secrets.fetch(component)
  forbidden_secret = component == "rgs" ? expected_worker_runtime_secret : expected_api_runtime_secret
  pod_spec = deployment.dig("spec", "template", "spec") || abort("#{component} 缺少 Pod spec")
  secret_volumes = Array(pod_spec["volumes"]).select { |volume| volume.dig("secret", "secretName") }
  matching_volumes = secret_volumes.select { |volume| volume.dig("secret", "secretName") == expected_secret }
  abort "#{component} 没有唯一挂载自己的运行素材 Secret" unless matching_volumes.length == 1
  abort "#{component} 越权挂载另一职责的运行素材 Secret" if
    secret_volumes.any? { |volume| volume.dig("secret", "secretName") == forbidden_secret }
  runtime_volume = matching_volumes.first
  mount_names = Array(pod_spec["initContainers"]) + Array(pod_spec["containers"])
  runtime_mounts = mount_names.flat_map { |container| Array(container["volumeMounts"]) }.select do |mount|
    mount["name"] == runtime_volume.fetch("name")
  end
  abort "#{component} 运行素材 Secret volume 没有只读挂载" unless
    !runtime_mounts.empty? && runtime_mounts.all? { |mount| mount["readOnly"] == true }
  runtime_paths = Array(runtime_volume.dig("secret", "items")).map { |item| item.fetch("path") }
  if component == "rgs"
    abort "RGS API 缺少 launch HMAC" unless runtime_paths.include?("launch-hmac.key")
  else
    forbidden_worker_paths = runtime_paths.select do |path|
      normalized = path.downcase
      normalized.include?("launch") || normalized.include?("access") ||
        normalized.include?("operator-response")
    end
    abort "Worker 挂载了 API 专属签发材料：#{forbidden_worker_paths.join(',')}" unless
      forbidden_worker_paths.empty?
  end
end

rgs_deployment = deployments.find do |deployment|
  deployment.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs"
end
rgs_containers = Array(rgs_deployment.dig("spec", "template", "spec", "containers"))
username_env = rgs_containers.flat_map { |container| Array(container["env"]) }.select do |item|
  item["name"] == "RGS_SHARED_ADMISSION_USERNAME"
end
abort "RGS API 必须恰好从 Secret 引用一个共享准入用户名" unless username_env.length == 1
username_reference = username_env.first.fetch("valueFrom", {}).fetch("secretKeyRef", {})
abort "RGS API 共享准入用户名没有绑定 delivery 的版本化 Secret" unless
  username_reference["name"] == expected_shared_admission_secret &&
    username_reference["key"] == "username" && !username_env.first.key?("value")

hpas = resources.fetch("HorizontalPodAutoscaler", [])
hpa_components = hpas.map { |hpa| hpa.dig("metadata", "labels", "app.kubernetes.io/component") }
abort "必须恰好渲染 RGS API 与 Worker 两个 HPA" unless hpa_components.sort == %w[rgs rgs-worker]
hpas.each do |hpa|
  component = hpa.dig("metadata", "labels", "app.kubernetes.io/component")
  deployment = deployments.find do |item|
    item.dig("metadata", "labels", "app.kubernetes.io/component") == component
  end
  target = hpa.dig("spec", "scaleTargetRef") || {}
  abort "#{component} HPA 没有指向对应 Deployment" unless
    target["apiVersion"] == "apps/v1" && target["kind"] == "Deployment" &&
      target["name"] == deployment.dig("metadata", "name")
  abort "#{component} HPA 副本边界不安全" unless
    hpa.dig("spec", "minReplicas").to_i >= 2 &&
      hpa.dig("spec", "maxReplicas").to_i >= hpa.dig("spec", "minReplicas").to_i
  metric_names = Array(hpa.dig("spec", "metrics")).map { |metric| metric.dig("resource", "name") }
  abort "#{component} HPA 必须同时使用 CPU 与内存指标" unless metric_names.sort == %w[cpu memory]
end

pdb_components = resources.fetch("PodDisruptionBudget", []).map do |pdb|
  pdb.dig("metadata", "labels", "app.kubernetes.io/component")
end
abort "RGS API 与 Worker 都必须有 PDB" unless pdb_components.sort == %w[rgs rgs-worker]

jobs = resources.fetch("Job", [])
abort "必须恰好渲染一个 Migrator hook Job" unless jobs.length == 1
migrator_annotations = jobs.first.dig("metadata", "annotations") || {}
abort "Migrator 必须在 install/upgrade 前运行" unless
  migrator_annotations.fetch("helm.sh/hook", "").split(",").sort == %w[pre-install pre-upgrade]

workloads = deployments + jobs
workloads.each do |workload|
  component = workload.dig("metadata", "labels", "app.kubernetes.io/component")
  pod_spec = workload.dig("spec", "template", "spec") || abort("工作负载缺少 Pod spec")
  expected_image = component == "migrator" ? expected_migrator_image : expected_rgs_image
  containers = Array(pod_spec["initContainers"]) + Array(pod_spec["containers"])
  abort "工作负载没有容器" if containers.empty?
  containers.each do |container|
    abort "#{component} 使用了未审批镜像" unless container.fetch("image") == expected_image
    security = container.fetch("securityContext", {})
    abort "#{component} 容器允许提权" unless security["allowPrivilegeEscalation"] == false
    abort "#{component} 容器根文件系统可写" unless security["readOnlyRootFilesystem"] == true
    abort "#{component} 容器可能以 root 运行" unless security["runAsNonRoot"] == true
    abort "#{component} 容器未丢弃全部 Linux capabilities" unless
      security.dig("capabilities", "drop") == ["ALL"]
    resources_config = container.fetch("resources", {})
    abort "#{component} 容器缺少 requests/limits" unless
      resources_config["requests"].is_a?(Hash) && resources_config["limits"].is_a?(Hash)
    Array(container["env"]).each do |entry|
      name = entry.fetch("name", "")
      next unless name.match?(/PASSWORD|TOKEN|SECRET|DATABASE_URL|PRIVATE|HMAC/i) && entry.key?("value")
      value = entry.fetch("value").to_s
      safe_reference = (name.end_with?("_FILE") || name.end_with?("_PATH")) && value.match?(%r{\A/[A-Za-z0-9._/-]+\z})
      safe_identifier = name.end_with?("_ID") && value.match?(/\A[A-Za-z0-9._:-]+\z/)
      abort "敏感环境变量被以内联明文渲染：#{name}" unless safe_reference || safe_identifier
    end
  end
  if pod_spec.fetch("serviceAccountName", "default") == "default"
    abort "使用 default ServiceAccount 的工作负载必须关闭 token 自动挂载" unless
      pod_spec["automountServiceAccountToken"] == false
  end
  abort "工作负载没有 RuntimeDefault seccomp" unless
    pod_spec.dig("securityContext", "seccompProfile", "type") == "RuntimeDefault"
end

deployments.each do |deployment|
  deployment.dig("spec", "template", "spec", "containers").each do |container|
    abort "在线工作负载缺少 readinessProbe" unless container["readinessProbe"]
    abort "在线工作负载缺少 livenessProbe" unless container["livenessProbe"]
  end
end

service_accounts = resources.fetch("ServiceAccount", [])
abort "RGS API 与 Worker 必须使用独立 ServiceAccount" unless service_accounts.length == 2
service_accounts.each do |service_account|
  annotations = service_account.dig("metadata", "annotations") || {}
  abort "业务 Pod 不得取得 AWS IAM role" if annotations.key?("eks.amazonaws.com/role-arn")
end

ingresses = resources.fetch("Ingress", [])
abort "AWS 正式环境必须恰好渲染一个 API Ingress" unless ingresses.length == 1
ingress = ingresses.first
abort "API Ingress 必须使用 ALB class" unless ingress.dig("spec", "ingressClassName") == "alb"
abort "ALB 终止 TLS 时不得引用 Kubernetes TLS Secret" if ingress.fetch("spec").key?("tls")
host = ingress.dig("spec", "rules", 0, "host").to_s
abort "API Ingress 主机名不是正式域名" unless host.match?(/\A[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\z/) && !host.end_with?(".example.com")
annotations = ingress.dig("metadata", "annotations") || {}
abort "ALB 必须是公网权威入口" unless annotations["alb.ingress.kubernetes.io/scheme"] == "internet-facing"
abort "ALB target 必须使用 IP 模式" unless annotations["alb.ingress.kubernetes.io/target-type"] == "ip"
abort "ALB 必须固定 IPv4 地址类型" unless annotations["alb.ingress.kubernetes.io/ip-address-type"] == "ipv4"
abort "ALB 到 target 的业务协议必须固定 HTTP" unless
  annotations["alb.ingress.kubernetes.io/backend-protocol"] == "HTTP"
begin
  listen_ports = JSON.parse(annotations.fetch("alb.ingress.kubernetes.io/listen-ports", ""))
rescue JSON::ParserError
  abort "ALB listen-ports 不是合法 JSON"
end
abort "ALB 监听器必须精确为 HTTP 80 与 HTTPS 443" unless
  listen_ports == [{"HTTP" => 80}, {"HTTPS" => 443}]
abort "ALB TLS policy 必须固定 TLS 1.2/1.3 基线" unless
  annotations["alb.ingress.kubernetes.io/ssl-policy"] == "ELBSecurityPolicy-TLS13-1-2-2021-06"
abort "自管 ALB SG 必须允许 controller 维护 backend SG rules" unless
  annotations["alb.ingress.kubernetes.io/manage-backend-security-group-rules"] == "true"
abort "ALB 必须把 HTTP 重定向到 HTTPS" unless annotations["alb.ingress.kubernetes.io/ssl-redirect"] == "443"
abort "ALB 不得把私有 /readyz 暴露为公网探针" unless annotations["alb.ingress.kubernetes.io/healthcheck-path"] == "/healthz"
abort "ALB 必须在 IP target 的私有 operations 8081 执行健康检查" unless
  annotations["alb.ingress.kubernetes.io/healthcheck-port"] == "8081"
abort "ALB health success code 必须精确为 200" unless
  annotations["alb.ingress.kubernetes.io/success-codes"] == "200"
certificate = annotations.fetch("alb.ingress.kubernetes.io/certificate-arn", "")
waf = annotations.fetch("alb.ingress.kubernetes.io/wafv2-acl-arn", "")
abort "ALB ACM 证书账号或区域错误" unless
  certificate.match?(%r{\Aarn:aws:acm:#{Regexp.escape(expected_region)}:#{expected_account_id}:certificate/[0-9a-f-]+\z})
abort "ALB WAF 账号或区域错误" unless
  waf.match?(%r{\Aarn:aws:wafv2:#{Regexp.escape(expected_region)}:#{expected_account_id}:regional/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+\z})
subnets = annotations.fetch("alb.ingress.kubernetes.io/subnets", "").split(",")
abort "ALB 必须显式绑定三个不同子网" unless
  subnets.length == 3 && subnets.uniq.length == 3 && subnets.all? { |item| item.match?(/\Asubnet-[0-9a-f]+\z/) }
abort "ALB 必须显式绑定安全组" unless
  annotations.fetch("alb.ingress.kubernetes.io/security-groups", "").match?(/\Asg-[0-9a-f]+\z/)
attributes = annotations.fetch("alb.ingress.kubernetes.io/load-balancer-attributes", "").split(",")
attribute_pairs = attributes.map do |attribute|
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

delivery_path = ENV["TERRAFORM_DELIVERY_FILE"]
if delivery_path && !delivery_path.empty?
  delivery = JSON.parse(File.binread(delivery_path))
  expected_subnets = delivery.fetch("public_subnet_ids")
  expected_security_group = delivery.fetch("alb_security_group_id")
  abort "ALB 子网没有精确绑定当前 Terraform delivery" unless
    expected_subnets.is_a?(Array) && expected_subnets.length == 3 &&
      subnets.sort == expected_subnets.sort
  abort "ALB 安全组没有精确绑定当前 Terraform delivery" unless
    annotations.fetch("alb.ingress.kubernetes.io/security-groups", "") == expected_security_group
  abort "ALB certificate 或 TLS policy 没有精确绑定当前 Terraform delivery" unless
    certificate == delivery.fetch("regional_acm_certificate_arn") &&
      delivery.fetch("api_alb_tls_policy") == "ELBSecurityPolicy-TLS13-1-2-2021-06" &&
      delivery.dig("application_handoff", "api_alb_tls_policy") == delivery.fetch("api_alb_tls_policy")
  abort "ALB access log bucket/prefix 没有精确绑定当前 Terraform delivery" unless
    attribute_map.fetch("access_logs.s3.bucket") == delivery.fetch("alb_access_log_bucket_name") &&
      attribute_map.fetch("access_logs.s3.prefix") == delivery.fetch("alb_access_log_prefix") &&
      delivery.dig("application_handoff", "alb_access_logs") == {
        "bucket" => delivery.fetch("alb_access_log_bucket_name"),
        "prefix" => delivery.fetch("alb_access_log_prefix"),
      }
  abort "Terraform delivery 未证明 ALB SG 同时允许业务与 operations health target" unless
    delivery.fetch("alb_egress_target_ports") == [8080, 8081] &&
      delivery.dig("application_handoff", "alb_egress_target_ports") == [8080, 8081]
  expected_waf = delivery.fetch("api_waf_web_acl_arn")
  contract = delivery.fetch("api_edge_security_contract")
  abort "ALB 没有绑定当前 Terraform delivery 的区域 WAF" unless waf == expected_waf
  abort "API 边缘安全合同与 WAF ARN 不一致" unless contract.fetch("web_acl_arn") == expected_waf
  abort "API 边缘安全合同版本或入口权威模型错误" unless
    contract.fetch("contract_version") == "1.0.0" &&
      contract.fetch("authoritative_public_entry") == "internet-facing-alb" &&
      contract.fetch("web_acl_scope") == "REGIONAL" &&
      contract.fetch("cloudfront_is_api_proxy") == false &&
      contract.fetch("origin_bypass_model") == "not-applicable-alb-is-authoritative-origin"
  abort "API 请求体限制没有在 WAF 与应用之间失败闭合" unless
    contract.fetch("body_inspection_limit_bytes") == 8192 &&
      contract.fetch("application_body_limit_bytes") == 8192 &&
      contract.fetch("oversized_body_action") == "BLOCK_AT_WAF_AND_APPLICATION"
  abort "公网 health path 未在 WAF 失败闭合或未与 ALB 私有探针端口对齐" unless
    contract.fetch("public_health_path") == "/healthz" &&
      contract.fetch("public_health_path_action") == "BLOCK_AT_WAF" &&
      contract.fetch("alb_target_health_port") == 8081 &&
      contract.fetch("required_path_rule_names").sort == %w[
        public-healthz-block public-protocol-surface-block
      ] &&
      contract.fetch("allowed_public_path_prefixes") == ["/client/", "/operator/"] &&
      contract.fetch("allowed_public_methods") == %w[GET OPTIONS POST]
end

services = resources.fetch("Service", [])
public_service = ingress.dig("spec", "rules", 0, "http", "paths", 0, "backend", "service", "name")
abort "Ingress 引用了不存在的 Service" unless services.any? { |service| service.dig("metadata", "name") == public_service }
abort "operations Service 被暴露到公网" if public_service.to_s.include?("operations")

network_policies = resources.fetch("NetworkPolicy", [])
abort "AWS 正式环境缺少 NetworkPolicy" if network_policies.length < 4
network_policies.each do |policy|
  Array(policy.dig("spec", "ingress")).each do |rule|
    Array(rule["from"]).each do |source|
      cidr = source.dig("ipBlock", "cidr")
      abort "NetworkPolicy 接受全网入口" if cidr == "0.0.0.0/0"
    end
  end
  Array(policy.dig("spec", "egress")).each do |rule|
    Array(rule["to"]).each do |target|
      cidr = target.dig("ipBlock", "cidr")
      abort "NetworkPolicy 允许全网出口" if cidr == "0.0.0.0/0"
    end
  end
end

if delivery_path && !delivery_path.empty?
  expected_alb_source_cidrs = delivery.fetch("public_subnet_cidrs")
  abort "Terraform delivery 公网子网 CIDR 集合不合法" unless
    expected_alb_source_cidrs.is_a?(Array) && expected_alb_source_cidrs.length == 3 &&
      expected_alb_source_cidrs.uniq.length == 3
  rgs_policies = network_policies.select do |policy|
    policy.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" &&
      Array(policy.dig("spec", "policyTypes")).include?("Ingress")
  end
  abort "RGS ingress NetworkPolicy 集合不精确" unless rgs_policies.length == 1
  controller_rules = Array(rgs_policies.fetch(0).dig("spec", "ingress")).select do |rule|
    Array(rule["ports"]).map { |port| port.fetch("port") }.sort == [8080, 8081]
  end
  abort "RGS NetworkPolicy 缺少 ALB 业务/health 精确端口规则" unless controller_rules.length == 1
  controller_sources = Array(controller_rules.fetch(0)["from"])
  actual_alb_source_cidrs = controller_sources.map { |source| source.dig("ipBlock", "cidr") }
  abort "RGS NetworkPolicy 的 ALB 来源必须全部是 Terraform 公网子网 CIDR" unless
    actual_alb_source_cidrs.none?(&:nil?) &&
      actual_alb_source_cidrs.sort == expected_alb_source_cidrs.sort
  monitoring_rules = Array(rgs_policies.fetch(0).dig("spec", "ingress")).select do |rule|
    Array(rule["ports"]) == [{"port" => 8081, "protocol" => "TCP"}]
  end
  abort "RGS NetworkPolicy monitoring 8081 规则集合不精确" unless monitoring_rules.length == 1
  abort "RGS NetworkPolicy monitoring 来源未绑定批准的 Prometheus agent" unless
    Array(monitoring_rules.fetch(0)["from"]) == [{
      "namespaceSelector" => {
        "matchLabels" => {"kubernetes.io/metadata.name" => "monitoring"},
      },
      "podSelector" => {
        "matchLabels" => {"app.kubernetes.io/name" => "prometheus-agent"},
      },
    }]
end

puts "AWS 正式 Helm 渲染发布契约通过。"
