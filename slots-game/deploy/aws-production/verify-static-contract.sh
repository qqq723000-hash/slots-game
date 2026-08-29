#!/bin/sh
# AWS 正式交付契约对内置 Web、Pod TLS、非 ALB 入口和宽松网络失败闭合。
# English: AWS artifactsion delivery contracts are closed to built-in web, Pod TLS, non-ALB ingress, and
# permissive network failures.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)
chart_directory="$repository_root/deploy/cluster-production/chart"
example_values="$script_directory/values.example.yaml"
rendered_contract="$script_directory/verify-rendered-contract.rb"
live_platform_gate="$script_directory/verify-live-platform-prerequisites.sh"
external_secrets_renderer="$script_directory/render-external-secrets.rb"
cluster_addons_contract="$repository_root/infra/terraform/contracts/cluster-addons-interface.v1.yaml"
helm_binary=${HELM_BIN:-helm}
kubeconform_binary=${KUBECONFORM_BIN:-kubeconform}
schema_location='https://raw.githubusercontent.com/yannh/kubernetes-json-schema/c8f4e61c63bc529749125ac566bccc6986e08d45/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}.json'
makefile="$repository_root/Makefile"
workflow="$workspace_root/.github/workflows/deployment-conformance.yml"

fail() {
  printf '%s\n' "AWS production contract: $*" >&2
  exit 1
}

for command in "$helm_binary" "$kubeconform_binary" grep mktemp ruby; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

for file in "$script_directory/README.md" "$example_values" "$rendered_contract" \
  "$live_platform_gate" "$external_secrets_renderer" "$cluster_addons_contract" "$makefile" "$workflow"; do
  test -f "$file" || fail "缺少 ${file#"$repository_root/"}"
done
test -x "$rendered_contract" || fail 'AWS 渲染契约不可执行'
test -x "$live_platform_gate" || fail 'AWS 平台实时门禁不可执行'
test -x "$external_secrets_renderer" || fail 'External Secrets renderer 不可执行'
sh -n "$live_platform_gate" || fail 'AWS 平台实时门禁 shell 语法错误'
ruby -c "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer Ruby 语法错误'
grep -F 'applyMeansApplicationReady: false' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约错误宣称基础设施 apply 后应用就绪'
grep -F 'requiresPrivateVpcRunner: true' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约没有强制私网执行器'
grep -F 'prometheusagents.monitoring.coreos.com' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约缺少 Prometheus Agent CRD'
grep -F 'id: cluster-autoscaler' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约缺少 Cluster Autoscaler'
grep -F 'id: vpc-cni-network-policy' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约缺少 vpc-cni NetworkPolicy 执行面'
grep -F 'enableNetworkPolicy: "true"' "$cluster_addons_contract" >/dev/null || fail 'vpc-cni add-on 契约未失败关闭启用 NetworkPolicy'
grep -F 'id: amazon-cloudwatch-observability' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约缺少 CloudWatch Observability 日志执行面'
grep -F '        - fluent-bit' "$cluster_addons_contract" >/dev/null || fail 'CloudWatch Observability add-on 契约缺少 Fluent Bit 日志投递工作负载'
grep -F 'cluster_autoscaler_role_arn' "$cluster_addons_contract" >/dev/null || fail '集群 add-on 契约缺少节点扩容专用身份'
grep -F 'syncedResourceVersion' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 ExternalSecret 同步版本'
grep -F 'sigv4' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 AMP SigV4'
grep -F 'helm.sh/chart' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证固定 Helm Chart 版本'
grep -F 'Cluster Autoscaler 横向扩容契约不满足' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证节点横向扩容'
grep -F 'list-pod-identity-associations' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取实际 Pod Identity association'
grep -F 'describe-pod-identity-association' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有核对实际 Pod Identity role'
grep -F 'iam get-role-policy' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取 Cluster Autoscaler 实际 IAM 策略'
grep -F 'autoscaling:DescribeTags' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 Cluster Autoscaler DescribeTags 权限'
grep -F 'cluster_autoscaler_inline_policy_name' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有绑定 Cluster Autoscaler 策略名'
grep -F 'application_release_allowed' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有拒绝 HMAC 维护期应用发布'
grep -F 'maintenance_in_progress' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有校验 HMAC 维护状态'
grep -F 'eks describe-addon' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取 metrics-server EKS add-on 状态'
grep -F 'addon.fetch("status") == "ACTIVE"' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有要求 metrics-server add-on ACTIVE'
grep -F 'elasticache describe-replication-groups' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取 Valkey replication group 当前状态'
grep -F 'elasticache describe-cache-clusters' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取 Valkey 节点 parameter group 生效状态'
grep -F 'elasticache describe-cache-parameters' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取 Valkey maxmemory-policy 实际值'
grep -F 'ParameterApplyStatus' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有拒绝 Valkey parameter group pending apply'
grep -F 'ParameterValue") == ARGV.fetch(0)' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有固定 Valkey noeviction 实际值'
grep -F 'wafv2 get-web-acl' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读实际 WAF Web ACL'
grep -F 'wafv2 get-logging-configuration' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读 WAF 日志配置'
grep -F 'cloudwatch describe-alarms' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读 WAF CloudWatch 告警'
grep -F 'cloudfront get-distribution' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读 CloudFront/WAF/OAC 绑定'
grep -F 's3api get-public-access-block' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读 CloudFront S3 源站 Public Access Block'
grep -F 'BlockPublicAcls IgnorePublicAcls BlockPublicPolicy RestrictPublicBuckets' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有精确要求 S3 四项 Public Access Block'
grep -F 's3api get-bucket-policy' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有回读 CloudFront S3 源站 bucket policy'
grep -F 'AllowCloudFrontOacRead DenyInsecureTransport DenyUnconditionalReleaseWrites' \
  "$live_platform_gate" >/dev/null || \
  fail 'AWS 平台实时门禁没有精确限制 OAC Allow、release 条件写与 TLS Deny 语句'
grep -F '/operator/v1/launches' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有固定 launch 低阈值 scope'
grep -F '/client/v1/spins' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有固定 spin 低阈值 scope'
grep -F 'header_size_rule_rollout' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 aggregate header Count→Block 阶段'
grep -F 'rate_rule_rollouts' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 rate Count→Block 阶段'
grep -F 'managed_rule_rollout' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 managed Count→Block 阶段'
grep -F 'SampledRequestsEnabled' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有关闭 WAF sampled requests 数据面'
grep -F 'apiservice/v1beta1.metrics.k8s.io' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有读取资源指标 APIService'
grep -F 'condition["type"] == "Available" && condition["status"] == "True"' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有要求资源指标 APIService Available=True'
grep -F 'deployment/kube-prometheus-stack-kube-state-metrics' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 kube-state-metrics Deployment'
grep -F 'container["name"] == "kube-state-metrics"' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有验证 kube-state-metrics 容器'
grep -F 'annotations["meta.helm.sh/release-name"] == "kube-prometheus-stack"' "$live_platform_gate" >/dev/null || fail 'AWS 平台实时门禁没有固定 kube-state-metrics Helm release'
grep -F 'api-runtime-assets' "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer 缺少 API 运行秘密边界'
grep -F 'worker-runtime-assets' "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer 缺少 Worker 运行秘密边界'
grep -F 'secretKey: username' "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer 缺少 Valkey A/B ACL 用户名'
if grep -F ' runtime-assets' "$external_secrets_renderer" >/dev/null; then
  fail 'External Secrets renderer 禁止合并 API 与 Worker 运行秘密'
fi
grep -F 'immutable: true' "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer 没有生成 immutable Secret'
grep -F 'refreshPolicy: CreatedOnce' "$external_secrets_renderer" >/dev/null || fail 'External Secrets renderer 没有固定一次性同步策略'
if grep -F 'Base64.strict_decode64' "$live_platform_gate" >/dev/null; then
  fail 'AWS 平台实时门禁禁止解码 native Secret 值'
fi
if grep -F 'kind: ClusterSecretStore' "$external_secrets_renderer" >/dev/null; then
  fail 'External Secrets renderer 禁止扩大为集群级 SecretStore'
fi
grep -F -x 'verify-aws-production:' "$makefile" >/dev/null || fail 'Makefile 缺少 AWS 正式交付入口'
grep -F './deploy/aws-production/verify-static-contract.sh' "$makefile" >/dev/null || fail 'Makefile 没有执行 AWS 正式交付契约'
grep -F 'run: make verify-deployment-contracts' "$workflow" >/dev/null || fail 'required 部署 CI 没有执行完整部署契约'
grep -F 'AWS' "$workflow" >/dev/null || fail 'required 部署 CI 没有明确声明 AWS 契约'

temporary_root=${TMPDIR:-/tmp}
rendered_directory=$(mktemp -d "${temporary_root%/}/slots-aws-production.XXXXXX")
cleanup() {
  case "$rendered_directory" in
    "${temporary_root%/}"/slots-aws-production.*) rm -rf -- "$rendered_directory" ;;
    *) fail "拒绝清理异常路径 $rendered_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

"$helm_binary" lint --strict "$chart_directory" -f "$example_values" >/dev/null

render_phase() {
  phase=$1
  output=$2
  if test "$phase" = upgrade; then
    "$helm_binary" template slots "$chart_directory" --namespace slots-production \
      --is-upgrade --kube-version 1.30.0 -f "$example_values" >"$output"
  else
    "$helm_binary" template slots "$chart_directory" --namespace slots-production \
      --kube-version 1.30.0 -f "$example_values" >"$output"
  fi
}

render_phase install "$rendered_directory/install.yaml"
render_phase upgrade "$rendered_directory/upgrade.yaml"
ruby "$rendered_contract" "$rendered_directory/install.yaml" up
ruby "$rendered_contract" "$rendered_directory/upgrade.yaml" verify
HELM_BIN="$helm_binary" "$script_directory/workflow/test-rendered-release-network.sh" >/dev/null

unsafe_attributes="$rendered_directory/unsafe-alb-attributes.yaml"
cp -- "$rendered_directory/install.yaml" "$unsafe_attributes"
ruby -e '
  path = ARGV.fetch(0)
  content = File.binread(path)
  required = "routing.http.desync_mitigation_mode=strictest"
  abort "负测缺少 strictest ALB 属性" unless content.include?(required)
  File.binwrite(path, content.sub(required, "routing.http.desync_mitigation_mode=defensive"))
' "$unsafe_attributes"
if ruby "$rendered_contract" "$unsafe_attributes" up >/dev/null 2>&1; then
  fail 'ALB desync mitigation 降级被错误接受'
fi

for mutation in waf-fail-open duplicate-waf-fail-open; do
  unsafe_waf_attributes="$rendered_directory/$mutation.yaml"
  cp -- "$rendered_directory/install.yaml" "$unsafe_waf_attributes"
  MUTATION=$mutation ruby -e '
    path = ARGV.fetch(0)
    content = File.binread(path)
    required = "waf.fail_open.enabled=false"
    abort "负测缺少 WAF fail-open ALB 属性" unless content.include?(required)
    replacement = if ENV.fetch("MUTATION") == "waf-fail-open"
      "waf.fail_open.enabled=true"
    else
      "#{required},waf.fail_open.enabled=true"
    end
    File.binwrite(path, content.sub(required, replacement))
  ' "$unsafe_waf_attributes"
  if ruby "$rendered_contract" "$unsafe_waf_attributes" up >/dev/null 2>&1; then
    fail "ALB WAF fail-open 危险属性被错误接受：$mutation"
  fi
done

for phase in install upgrade; do
  "$kubeconform_binary" \
    -strict \
    -summary \
    -exit-on-error \
    -kubernetes-version 1.30.0 \
    -schema-location "$schema_location" \
    -skip ServiceMonitor,PrometheusRule \
    "$rendered_directory/$phase.yaml"
done

# 关键 AWS 边界的危险覆盖必须被渲染语义契约拒绝。
# English: Dangerous overrides of critical AWS boundaries must be denied by the rendering semantics contract.
for override in \
  'web.enabled=true' \
  'ingress.className=nginx' \
  'ingress.tlsSecretEnabled=true' \
  'ingress.apiHealthCheckPath=/readyz' \
  'ingress.apiHealthCheckPort=8080' \
  'rgs.runtime.maxRequestBytes=8193' \
  'networkPolicy.ingressController.mode=selectors,networkPolicy.ingressController.cidrs={}'; do
  unsafe_render="$rendered_directory/unsafe.yaml"
  if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
    --kube-version 1.30.0 -f "$example_values" --set "$override" >"$unsafe_render" 2>/dev/null &&
    ruby "$rendered_contract" "$unsafe_render" up >/dev/null 2>&1; then
    fail "危险 AWS 覆盖被错误接受: $override"
  fi
done

printf '%s\n' 'AWS production contract: passed'
