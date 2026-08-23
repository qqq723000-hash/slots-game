#!/bin/sh
# 使用固定 Kubernetes 版本校验全部原生资源；监控 CRD 由目标集群服务端复核。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
chart_directory="$script_directory/chart"
example_values="$script_directory/values.example.yaml"
helm_binary=${HELM_BIN:-helm}
kubeconform_binary=${KUBECONFORM_BIN:-kubeconform}
schema_location='https://raw.githubusercontent.com/yannh/kubernetes-json-schema/c8f4e61c63bc529749125ac566bccc6986e08d45/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}.json'

for command in "$helm_binary" "$kubeconform_binary" mktemp; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s\n' "cluster kubeconform: 缺少命令 $command" >&2
    exit 1
  }
done

temporary_root=${TMPDIR:-/tmp}
rendered_directory=$(mktemp -d "${temporary_root%/}/slots-cluster-kubeconform.XXXXXX")
cleanup() {
  case "$rendered_directory" in
    "${temporary_root%/}"/slots-cluster-kubeconform.*) rm -rf -- "$rendered_directory" ;;
    *) printf '%s\n' "cluster kubeconform: 拒绝清理异常路径 $rendered_directory" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

for phase in install upgrade hmac-maintenance database-maintenance maintenance-restored; do
  case "$phase" in
  upgrade)
    "$helm_binary" template slots "$chart_directory" \
      --namespace slots-production --is-upgrade \
      --kube-version 1.30.0 -f "$example_values" \
      >"$rendered_directory/$phase.yaml"
    ;;
  hmac-maintenance)
    "$helm_binary" template slots "$chart_directory" \
      --namespace slots-production \
      --kube-version 1.30.0 -f "$example_values" \
      --set rgs.maintenanceQuiesced=true \
      >"$rendered_directory/$phase.yaml"
    ;;
  database-maintenance)
    "$helm_binary" template slots "$chart_directory" \
      --namespace slots-production \
      --kube-version 1.30.0 -f "$example_values" \
      --set rgs.maintenanceQuiesced=true \
      --set worker.maintenanceQuiesced=true \
      >"$rendered_directory/$phase.yaml"
    ;;
  maintenance-restored)
    "$helm_binary" template slots "$chart_directory" \
      --namespace slots-production \
      --kube-version 1.30.0 -f "$example_values" \
      --set rgs.maintenanceQuiesced=false \
      --set worker.maintenanceQuiesced=false \
      >"$rendered_directory/$phase.yaml"
    ;;
  install)
    "$helm_binary" template slots "$chart_directory" \
      --namespace slots-production \
      --kube-version 1.30.0 -f "$example_values" \
      >"$rendered_directory/$phase.yaml"
    ;;
  esac
  "$kubeconform_binary" \
    -strict \
    -summary \
    -exit-on-error \
    -kubernetes-version 1.30.0 \
    -schema-location "$schema_location" \
    -skip ServiceMonitor,PrometheusRule \
    "$rendered_directory/$phase.yaml"
done

printf '%s\n' 'cluster kubeconform: passed'
