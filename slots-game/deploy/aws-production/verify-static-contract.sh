#!/bin/sh
# AWS 正式交付契约对内置 Web、Pod TLS、非 ALB 入口和宽松网络失败闭合。
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
for override in \
  'web.enabled=true' \
  'ingress.className=nginx' \
  'ingress.tlsSecretEnabled=true' \
  'networkPolicy.ingressController.mode=selectors,networkPolicy.ingressController.cidrs={}'; do
  unsafe_render="$rendered_directory/unsafe.yaml"
  if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
    --kube-version 1.30.0 -f "$example_values" --set "$override" >"$unsafe_render" 2>/dev/null &&
    ruby "$rendered_contract" "$unsafe_render" up >/dev/null 2>&1; then
    fail "危险 AWS 覆盖被错误接受: $override"
  fi
done

printf '%s\n' 'AWS production contract: passed'
