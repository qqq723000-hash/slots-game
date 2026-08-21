#!/bin/sh
# 在 VPC 内受保护执行器上验证集群 add-on；本脚本不会安装或修改任何资源。
set -eu

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

  %w[
    amp_remote_write_endpoint
    amp_writer_role_arn
    application_release_allowed
    aws_account_id
    aws_region
    cluster_autoscaler_role_arn
    cluster_autoscaler_inline_policy_name
    cluster_name
    environment
    maintenance_in_progress
    secret_sync_role_arn
    valkey_endpoint_url
    valkey_active_slot
    valkey_password_versions
    valkey_primary_endpoint
    valkey_rotation_contract
    valkey_rotation_mode
    valkey_secret_arn
    valkey_secret_name
    valkey_user_name
    valkey_user_names
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
autoscaler_image_tag=$(json_value application_handoff cluster_autoscaler_image_tag)
metrics_server_addon_version=$(json_value application_handoff metrics_server_addon_version)

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
      --no-paginate \
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
