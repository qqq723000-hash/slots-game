#!/usr/bin/env ruby

# 该门禁校验正式 values 的实际 Helm 输出，不接受示例域名、宽松网络或未绑定摘要的镜像。
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
abort "ALB target 必须使用 IP 模式" unless annotations["alb.ingress.kubernetes.io/target-type"] == "ip"
abort "ALB 必须把 HTTP 重定向到 HTTPS" unless annotations["alb.ingress.kubernetes.io/ssl-redirect"] == "443"
abort "ALB 不得把私有 /readyz 暴露为公网探针" unless annotations["alb.ingress.kubernetes.io/healthcheck-path"] == "/healthz"
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
%w[deletion_protection.enabled=true routing.http.drop_invalid_header_fields.enabled=true access_logs.s3.enabled=true].each do |required|
  abort "ALB 缺少安全或审计属性：#{required}" unless attributes.include?(required)
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

puts "AWS 正式 Helm 渲染发布契约通过。"
