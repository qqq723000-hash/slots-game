#!/bin/sh
# 集群生产契约必须对缺失依赖、宽松网络和可变镜像失败闭合。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
workspace_root=$(CDPATH='' cd -- "$repository_root/.." && pwd)
chart_directory="$script_directory/chart"
example_values="$script_directory/values.example.yaml"
helm_binary=${HELM_BIN:-helm}
makefile="$repository_root/Makefile"
metrics_source="$repository_root/server/internal/platform/metrics.go"
backend_notice_generator="$repository_root/server/scripts/third-party-notices/main.go"
backend_notice_policy="$repository_root/server/third-party-licenses/policy.json"
backend_notice="$repository_root/server/THIRD_PARTY_NOTICES.txt"
if test -f "$repository_root/.github/workflows/supply-chain-release.yml"; then
  workflows_root="$repository_root/.github/workflows"
  release_workflow="$repository_root/.github/workflows/supply-chain-release.yml"
else
  workflows_root="$workspace_root/.github/workflows"
  release_workflow="$workspace_root/.github/workflows/supply-chain-release.yml"
fi
deployment_workflow="$workflows_root/deployment-conformance.yml"

fail() {
  printf '%s\n' "cluster production contract: $*" >&2
  exit 1
}

for command in "$helm_binary" cp grep mktemp ruby; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

for file in \
  "$script_directory/README.md" \
  "$script_directory/Dockerfile.services" \
  "$script_directory/Dockerfile.services.dockerignore" \
  "$script_directory/verify-image-runtime-contract.sh" \
  "$script_directory/verify-prometheus-rule-contract.sh" \
  "$script_directory/prometheus-rule-tests.yaml" \
  "$script_directory/verify-rendered-contract.rb" \
  "$script_directory/verify-kubeconform.sh" \
  "$makefile" \
  "$metrics_source" \
  "$backend_notice_generator" \
  "$backend_notice_policy" \
  "$backend_notice" \
  "$release_workflow" \
  "$deployment_workflow" \
  "$chart_directory/Chart.yaml" \
  "$chart_directory/values.yaml" \
  "$chart_directory/values.schema.json" \
  "$chart_directory/templates/rgs-deployment.yaml" \
  "$chart_directory/templates/worker-deployment.yaml" \
  "$chart_directory/templates/web-deployment.yaml" \
  "$chart_directory/templates/migrator-job.yaml" \
  "$chart_directory/templates/networkpolicies.yaml" \
  "$chart_directory/templates/autoscaling.yaml" \
  "$chart_directory/templates/poddisruptionbudgets.yaml" \
  "$chart_directory/templates/servicemonitor.yaml" \
  "$chart_directory/templates/prometheusrule.yaml" \
  "$repository_root/tools/container-helpers/secret-materializer/main.go" \
  "$example_values"; do
  test -f "$file" || fail "缺少 ${file#"$script_directory/"}"
done
test -x "$script_directory/verify-image-runtime-contract.sh" || fail '集群镜像动态契约不可执行'
test -x "$script_directory/verify-prometheus-rule-contract.sh" || fail '集群告警动态契约不可执行'
grep -F -x 'verify-cluster-image-contract:' "$makefile" >/dev/null ||
  fail 'Makefile 缺少集群镜像动态契约入口'
grep -F 'run: make verify-cluster-image-contract' "$release_workflow" >/dev/null ||
  fail '受保护发布没有动态执行集群镜像契约'
grep -F 'run: npm run build:determinism-check' "$release_workflow" >/dev/null ||
  fail '受保护发布没有独立执行前端确定性复建'
grep -F 'run: make verify-cluster-prometheus-rules' "$release_workflow" >/dev/null ||
  fail '受保护发布没有用 promtool 解析集群告警'
grep -F 'run: make verify-cluster-prometheus-rules' "$deployment_workflow" >/dev/null ||
  fail 'required 部署 CI 没有用 promtool 解析集群告警'
grep -F -- '--target rgs-runtime' "$script_directory/verify-image-runtime-contract.sh" >/dev/null ||
  fail '集群镜像动态契约没有构建 RGS 运行目标'
grep -F -- '--target rgs-migrator' "$script_directory/verify-image-runtime-contract.sh" >/dev/null ||
  fail '集群镜像动态契约没有构建迁移目标'
grep -F 'service-probe: unexpected HTTP status 503' "$script_directory/verify-image-runtime-contract.sh" >/dev/null ||
  fail '集群镜像动态契约没有验证探针失败行为'
grep -F 'RGS_DATABASE_URL_FILE=/run/cluster-contract/database-url' "$script_directory/verify-image-runtime-contract.sh" >/dev/null ||
  fail '集群镜像动态契约没有验证 Secret 文件正向加载'
grep -F -- '--entrypoint /secret-materializer' "$script_directory/verify-image-runtime-contract.sh" >/dev/null ||
  fail '集群镜像动态契约没有验证 0400 共享准入凭据物化'
test "$(grep -F -c ':/THIRD_PARTY_NOTICES.txt' "$script_directory/verify-image-runtime-contract.sh" || true)" -eq 2 ||
  fail '集群镜像动态契约没有分别提取两个 Go 第三方许可声明'
grep -F 'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893' "$script_directory/verify-prometheus-rule-contract.sh" >/dev/null ||
  fail '集群告警动态契约没有固定 promtool 镜像摘要'
grep -F 'promtool_image" test rules /tests.yaml' "$script_directory/verify-prometheus-rule-contract.sh" >/dev/null ||
  fail '集群告警动态契约没有执行 PromQL 行为测试'
grep -F 'HPA 指标目标完全消失时必须告警' "$script_directory/prometheus-rule-tests.yaml" >/dev/null ||
  fail 'HPA 告警没有覆盖指标完全消失行为'
grep -F 'API 与 Worker HPA 都 ScalingActive 时不得告警' "$script_directory/prometheus-rule-tests.yaml" >/dev/null ||
  fail 'HPA 告警没有覆盖双 HPA 正常行为'
grep -F '无关 release 的 HPA 不得填补 Worker 缺口' "$script_directory/prometheus-rule-tests.yaml" >/dev/null ||
  fail 'HPA 告警没有覆盖同 namespace 旁路 release 干扰'
grep -F 'API HPA 重复抓取不得填补 Worker 缺口' "$script_directory/prometheus-rule-tests.yaml" >/dev/null ||
  fail 'HPA 告警没有覆盖高可用 kube-state-metrics 重复抓取'
grep -F 'go run ./scripts/third-party-notices --check' "$script_directory/Dockerfile.services" >/dev/null ||
  fail '集群生产构建没有校验 Go 第三方许可声明'
backend_notice_copy='COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt'
test "$(grep -F -x -c "$backend_notice_copy" "$script_directory/Dockerfile.services" || true)" -eq 2 ||
  fail 'RGS 运行镜像与迁移镜像必须分别交付 Go 第三方许可声明'
grep -F 'var productionTargets = []string{"./cmd/rgs-server", "./cmd/rgs-migrator"}' "$backend_notice_generator" >/dev/null ||
  fail 'Go 第三方许可生成器没有固定两个生产二进制入口'
grep -F '"name": "NOTICE"' "$backend_notice_policy" >/dev/null ||
  fail 'Go 第三方许可审批清单没有保留上游 NOTICE'
grep -F '生产第三方模块数量：8' "$backend_notice" >/dev/null ||
  fail 'Go 第三方许可权威声明缺少完整生产依赖集合'
if grep -F 'github.com/DATA-DOG/go-sqlmock' "$backend_notice" >/dev/null; then
  fail '仅测试依赖被错误列入 Go 生产许可声明'
fi
grep -F 'lookup "apps/v1" "Deployment" .Release.Namespace ""' \
  "$chart_directory/templates/validate.yaml" >/dev/null ||
  fail '数学定义门禁没有按 namespace 枚举现网 Deployment'
grep -F 'app.kubernetes.io/instance' "$chart_directory/templates/validate.yaml" >/dev/null ||
  fail '数学定义门禁没有按 Helm release 标签筛选现网 Deployment'

temporary_root=${TMPDIR:-/tmp}
rendered_directory=$(mktemp -d "${temporary_root%/}/slots-cluster-production.XXXXXX")
cleanup() {
  case "$rendered_directory" in
    "${temporary_root%/}"/slots-cluster-production.*) rm -rf -- "$rendered_directory" ;;
    *) fail "拒绝清理异常路径 $rendered_directory" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

# 默认值不携带外部 Secret、域名、镜像摘要和出口网段，因此必须拒绝直接渲染。
if "$helm_binary" template slots "$chart_directory" --namespace slots-production >/dev/null 2>&1; then
  fail '未配置的默认 values 被错误接受'
fi

"$helm_binary" lint --strict "$chart_directory" -f "$example_values" >/dev/null
"$helm_binary" template slots "$chart_directory" \
  --namespace slots-production \
  -f "$example_values" \
  --output-dir "$rendered_directory" >/dev/null
"$helm_binary" template slots "$chart_directory" \
  --namespace slots-production \
  --is-upgrade \
  -f "$example_values" \
  --output-dir "$rendered_directory/upgrade" >/dev/null
"$helm_binary" template aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$chart_directory" --namespace slots-production -f "$example_values" \
  --output-dir "$rendered_directory/long-release" >/dev/null
"$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" \
  --set fullnameOverride=fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --output-dir "$rendered_directory/long-override" >/dev/null
"$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" \
  --set rgs.maintenanceQuiesced=true \
  --output-dir "$rendered_directory/maintenance-quiesced" >/dev/null
"$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" \
  --set-string externalSecrets.sharedAdmission.name=slots-rgs-shared-admission-v999 \
  --output-dir "$rendered_directory/shared-admission-rotated" >/dev/null
if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" --set-string rgs.maintenanceQuiesced=true >/dev/null 2>&1; then
  fail 'maintenanceQuiesced 的字符串类型被错误接受'
fi

rendered_root="$rendered_directory/slots-cluster-production/templates"
upgrade_rendered_root="$rendered_directory/upgrade/slots-cluster-production/templates"
long_release_root="$rendered_directory/long-release/slots-cluster-production/templates"
long_override_root="$rendered_directory/long-override/slots-cluster-production/templates"
maintenance_root="$rendered_directory/maintenance-quiesced/slots-cluster-production/templates"
shared_rotated_root="$rendered_directory/shared-admission-rotated/slots-cluster-production/templates"
test -d "$rendered_root" || fail 'Helm 未生成模板目录'
test -d "$upgrade_rendered_root" || fail 'Helm 未生成升级模板目录'
ruby "$script_directory/verify-rendered-contract.rb" "$rendered_root" up
ruby "$script_directory/verify-rendered-contract.rb" "$upgrade_rendered_root" verify
ruby "$script_directory/verify-rendered-contract.rb" "$long_release_root" up
ruby "$script_directory/verify-rendered-contract.rb" "$long_override_root" up
ruby -ryaml -e '
  root = ARGV.fetch(0)
  deployment = YAML.load(File.binread(File.join(root, "rgs-deployment.yaml")))
  abort "HMAC 维护态 API Deployment 未固定零副本" unless deployment.dig("spec", "replicas") == 0
  abort "HMAC 维护态 API 模板缺少失败闭合标记" unless
    deployment.dig("spec", "template", "metadata", "annotations", "slots-game.io/hmac-maintenance-quiesced") == "true"
  autoscalers = YAML.load_stream(File.binread(File.join(root, "autoscaling.yaml"))).compact
  components = autoscalers.map { |item| item.dig("metadata", "labels", "app.kubernetes.io/component") }.sort
  abort "HMAC 维护态错误渲染 API HPA 或删除其他 HPA" unless components == ["rgs-worker", "web"]
' "$maintenance_root"
ruby -ryaml -e '
  baseline = ARGV.fetch(0)
  rotated = ARGV.fetch(1)
  annotation = "slots-game.io/runtime-secret-references"
  load_hash = lambda do |root, file|
    document = YAML.load(File.binread(File.join(root, file)))
    document.dig("spec", "template", "metadata", "annotations", annotation)
  end
  abort "共享准入轮换没有改变 API Secret 摘要" if
    load_hash.call(baseline, "rgs-deployment.yaml") == load_hash.call(rotated, "rgs-deployment.yaml")
  abort "API 专属共享准入轮换错误改变 Worker Secret 摘要" unless
    load_hash.call(baseline, "worker-deployment.yaml") == load_hash.call(rotated, "worker-deployment.yaml")
' "$rendered_root" "$shared_rotated_root"

# 告警契约必须有明确的红灯变体：删除重放规则或弱化 increase 表达式都必须失败。
replay_alert_red_root="$rendered_directory/replay-alert-red"
cp -R "$rendered_root" "$replay_alert_red_root"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  document = YAML.load_file(path)
  document.fetch("spec").fetch("groups").each do |group|
    group.fetch("rules").reject! { |rule| rule["alert"] == "SlotsRGSAuthReplay" }
  end
  File.write(path, YAML.dump(document))
' "$replay_alert_red_root/prometheusrule.yaml"
if ruby "$script_directory/verify-rendered-contract.rb" "$replay_alert_red_root" up >/dev/null 2>&1; then
  fail '缺失认证重放告警的红灯变体被错误接受'
fi

replay_expression_red_root="$rendered_directory/replay-expression-red"
cp -R "$rendered_root" "$replay_expression_red_root"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  document = YAML.load_file(path)
  rules = document.fetch("spec").fetch("groups").flat_map { |group| group.fetch("rules") }
  replay = rules.find { |rule| rule["alert"] == "SlotsRGSAuthReplay" }
  replay["expr"] = %q{sum(rgs_auth_replays_total{job="slots-rgs",namespace="slots-production"}) > 0}
  File.write(path, YAML.dump(document))
' "$replay_expression_red_root/prometheusrule.yaml"
if ruby "$script_directory/verify-rendered-contract.rb" "$replay_expression_red_root" up >/dev/null 2>&1; then
  fail '未使用 increase 的认证重放告警红灯变体被错误接受'
fi

hpa_alert_red_root="$rendered_directory/hpa-alert-red"
cp -R "$rendered_root" "$hpa_alert_red_root"
ruby -ryaml -e '
  path = ARGV.fetch(0)
  document = YAML.load_file(path)
  document.fetch("spec").fetch("groups").each do |group|
    group.fetch("rules").reject! { |rule| rule["alert"] == "SlotsRGSHPAUnableToScale" }
  end
  File.write(path, YAML.dump(document))
' "$hpa_alert_red_root/prometheusrule.yaml"
if ruby "$script_directory/verify-rendered-contract.rb" "$hpa_alert_red_root" up >/dev/null 2>&1; then
  fail '缺失 HPA ScalingActive 告警的红灯变体被错误接受'
fi

require_rendered() {
  contract_expected=$1
  contract_target=$2
  grep -F -- "$contract_expected" "$contract_target" >/dev/null ||
    fail "渲染结果缺少 $contract_expected"
}

for file in rgs-deployment.yaml worker-deployment.yaml web-deployment.yaml; do
  require_rendered 'kind: Deployment' "$rendered_root/$file"
  require_rendered 'readOnlyRootFilesystem: true' "$rendered_root/$file"
  require_rendered 'runAsNonRoot: true' "$rendered_root/$file"
  require_rendered 'type: RuntimeDefault' "$rendered_root/$file"
  require_rendered 'drop:' "$rendered_root/$file"
  require_rendered 'topologySpreadConstraints:' "$rendered_root/$file"
done
require_rendered 'path: /readyz' "$rendered_root/web-deployment.yaml"
require_rendered 'path: /livez' "$rendered_root/web-deployment.yaml"
require_rendered 'maxUnavailable: 0' "$rendered_root/rgs-deployment.yaml"
require_rendered 'preStop:' "$rendered_root/rgs-deployment.yaml"
require_rendered 'value: api' "$rendered_root/rgs-deployment.yaml"
require_rendered 'slots-game.io/release-compatibility-class: "same-schema-and-definition"' "$rendered_root/rgs-deployment.yaml"
require_rendered 'slots-game.io/hmac-maintenance-quiesced: "false"' "$rendered_root/rgs-deployment.yaml"
if grep -E '^  replicas:' "$rendered_root/rgs-deployment.yaml" >/dev/null; then
  fail '普通发布的 API Deployment 不得抢占 HPA 的 replicas 所有权'
fi
require_rendered 'maxUnavailable: 0' "$rendered_root/worker-deployment.yaml"
require_rendered 'preStop:' "$rendered_root/worker-deployment.yaml"
require_rendered 'value: worker' "$rendered_root/worker-deployment.yaml"
require_rendered 'fieldPath: metadata.name' "$rendered_root/worker-deployment.yaml"
require_rendered 'helm.sh/hook: pre-install,pre-upgrade' "$rendered_root/migrator-job.yaml"
require_rendered '            - up' "$rendered_root/migrator-job.yaml"
require_rendered '            - verify' "$upgrade_rendered_root/migrator-job.yaml"
require_rendered 'kind: HorizontalPodAutoscaler' "$rendered_root/autoscaling.yaml"
require_rendered 'kind: PodDisruptionBudget' "$rendered_root/poddisruptionbudgets.yaml"
require_rendered 'kind: ServiceMonitor' "$rendered_root/servicemonitor.yaml"
require_rendered 'jobLabel: slots-game.io/metrics-job' "$rendered_root/servicemonitor.yaml"
require_rendered 'kind: PrometheusRule' "$rendered_root/prometheusrule.yaml"
require_rendered 'alert: SlotsRGSTargetUnavailable' "$rendered_root/prometheusrule.yaml"
require_rendered 'alert: SlotsRGSWorkerTargetUnavailable' "$rendered_root/prometheusrule.yaml"
require_rendered 'alert: SlotsRGSIntegrityQuarantine' "$rendered_root/prometheusrule.yaml"
require_rendered 'alert: SlotsRGSAuthReplay' "$rendered_root/prometheusrule.yaml"
require_rendered 'alert: SlotsRGSHPAUnableToScale' "$rendered_root/prometheusrule.yaml"
require_rendered 'sum(increase(rgs_auth_replays_total{job="slots-rgs",namespace="slots-production"}[5m])) > 0' "$rendered_root/prometheusrule.yaml"
require_rendered 'kube_horizontalpodautoscaler_status_condition{job="kube-state-metrics",namespace="slots-production",condition="ScalingActive",status="true"' "$rendered_root/prometheusrule.yaml"
require_rendered 'horizontalpodautoscaler=~"slots-slots-cluster-production-rgs|slots-slots-cluster-production-rgs-worker"' "$rendered_root/prometheusrule.yaml"
require_rendered 'count(max by (horizontalpodautoscaler) (kube_horizontalpodautoscaler_status_condition' "$rendered_root/prometheusrule.yaml"
test "$(grep -F -c '} == 1' "$rendered_root/prometheusrule.yaml" || true)" -eq 2 ||
  fail 'HPA 告警没有分别拒绝 ScalingActive true=0 和指标缺失'
require_rendered 'or absent(kube_horizontalpodautoscaler_status_condition{job="kube-state-metrics",namespace="slots-production",condition="ScalingActive",status="true"' "$rendered_root/prometheusrule.yaml"
require_rendered 'or absent(rgs_ready{job="slots-rgs",namespace="slots-production"})' "$rendered_root/prometheusrule.yaml"
require_rendered 'or absent(rgs_ready{job="slots-rgs-worker",namespace="slots-production"})' "$rendered_root/prometheusrule.yaml"
require_rendered 'kind: NetworkPolicy' "$rendered_root/networkpolicies.yaml"
require_rendered 'policyTypes:' "$rendered_root/networkpolicies.yaml"
require_rendered 'cidr: 10.20.0.0/24' "$rendered_root/networkpolicies.yaml"
require_rendered 'cidr: 10.30.0.0/24' "$rendered_root/networkpolicies.yaml"
require_rendered 'cidr: 10.40.0.0/24' "$rendered_root/networkpolicies.yaml"
require_rendered '@sha256:' "$rendered_root/rgs-deployment.yaml"
require_rendered '@sha256:' "$rendered_root/worker-deployment.yaml"
require_rendered '@sha256:' "$rendered_root/web-deployment.yaml"
require_rendered 'authorization:' "$rendered_root/servicemonitor.yaml"
require_rendered 'secretName: slots-rgs-runtime-database-v1' "$rendered_root/rgs-deployment.yaml"
require_rendered 'secretName: slots-rgs-runtime-database-v1' "$rendered_root/worker-deployment.yaml"
require_rendered 'name: slots-rgs-operations-bearer-v1' "$rendered_root/servicemonitor.yaml"
require_rendered 'key: username' "$rendered_root/rgs-deployment.yaml"
require_rendered 'helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded' "$rendered_root/migrator-job.yaml"
require_rendered 'slots-game.io/log-pipeline-provider: "company-node-log-pipeline"' "$rendered_root/rgs-deployment.yaml"
require_rendered 'slots-game.io/log-pipeline-provider: "company-node-log-pipeline"' "$rendered_root/worker-deployment.yaml"
require_rendered 'slots-game.io/web-version-isolation-provider: "company-web-blue-green"' "$rendered_root/web-deployment.yaml"

for metric in \
  rgs_http_server_failures_total \
  rgs_http_requests_total \
  rgs_capacity_rejected_total \
  rgs_auth_replays_total \
  rgs_wallet_unknown_outcomes_total \
  rgs_round_integrity_quarantines_total \
  rgs_session_integrity_quarantines_total \
  rgs_outbox_deferred_total \
  rgs_outbox_lease_lost_total \
  rgs_db_pool_in_use_connections \
  rgs_db_pool_max_open_connections \
  rgs_db_pool_wait_count_total; do
  grep -F "$metric" "$metrics_source" >/dev/null || fail "告警引用了后端未交付的指标: $metric"
done
grep -F 'rgs_ready' "$repository_root/server/internal/platform/metrics_http.go" >/dev/null ||
  fail '告警引用了后端未交付的 rgs_ready 指标'

if grep -R -E '^[[:space:]]*kind: (Secret|StatefulSet)$' "$rendered_root" >/dev/null; then
  fail 'Chart 不得创建 Secret 或内置有状态数据库'
fi
if grep -R -F 'local-operator' "$rendered_root" >/dev/null; then
  fail '集群生产 Chart 不得依赖本机 local-operator'
fi
if grep -F 'rgs-operations' "$rendered_root/ingresses.yaml" >/dev/null; then
  fail '运维 Service 被错误暴露到 Ingress'
fi
if grep -F 'RGS_OUTBOX_' "$rendered_root/rgs-deployment.yaml" >/dev/null; then
  fail 'API Deployment 被错误授予后台 outbox 能力'
fi
if grep -F 'name: http' "$rendered_root/worker-deployment.yaml" >/dev/null; then
  fail 'Worker Deployment 被错误授予公网 HTTP 端口'
fi
if ! grep -F 'AS rgs-runtime' "$script_directory/Dockerfile.services" >/dev/null ||
  ! grep -F 'AS rgs-migrator' "$script_directory/Dockerfile.services" >/dev/null; then
  fail '集群镜像文件缺少 RGS 或迁移器目标'
fi
if grep -F 'local-operator' "$script_directory/Dockerfile.services" >/dev/null; then
  fail '集群镜像不得打包本机 local-operator'
fi

# 关键安全边界的负向变体必须在 schema 或模板校验阶段被拒绝。
for override in \
  'unexpected=true' \
  'images.rgs.digest=' \
  'images.web.digest=latest' \
  'externalControls.globalRateLimitProvider=' \
  'externalControls.tlsEnforcementProvider=' \
  'externalControls.logPipelineProvider=' \
  'externalControls.webVersionIsolationProvider=' \
  'release.compatibilityClass=' \
  'release.compatibilityClass=database-schema-change' \
  'release.definitionIdentity.gameID=' \
  'release.definitionIdentity.sha256=ABCDEF' \
  'externalSecrets.operationsBearer.name=' \
  'externalSecrets.operationsBearer.name=slots-rgs-api-runtime-assets-v1' \
  'externalSecrets.sharedAdmission.name=slots-rgs-api-runtime-assets-v1' \
  'externalSecrets.workerRuntimeAssets.name=slots-rgs-api-runtime-assets-v1' \
  'externalSecrets.migratorDatabase.name=slots-rgs-runtime-database-v1' \
  'ingress.tlsRedirectAnnotationKey=' \
  'fullnameOverride=Bad_Name' \
  'rgs.replicaCount=2' \
  'rgs.pdb.minAvailable=3' \
  'worker.replicaCount=1' \
  'worker.autoscaling.maxReplicas=1' \
  'worker.pdb.minAvailable=2' \
  'web.pdb.minAvailable=3' \
  'rgs.publicBaseURL=https://wrong.example.com' \
  'ingress.webHost=rgs.example.com' \
  'rgs.runtime.databaseMaxOpenConnections=2,rgs.runtime.databaseMaxIdleConnections=3' \
  'rgs.runtime.databaseMaxOpenConnections=201' \
  'rgs.runtime.maxInFlightRequests=4097' \
  'rgs.runtime.maxConnectionsPerListener=16385' \
  'worker.runtime.databaseMaxOpenConnections=2,worker.runtime.databaseMaxIdleConnections=3' \
  'worker.runtime.maxConnectionsPerListener=16385' \
  'rgs.shutdownTimeoutSeconds=60,rgs.terminationGracePeriodSeconds=64' \
  'worker.shutdownTimeoutSeconds=60,worker.terminationGracePeriodSeconds=64' \
  'worker.runtime.outboxLeaseSeconds=130' \
  'migrator.migrationTimeoutSeconds=900,migrator.activeDeadlineSeconds=900' \
  'networkPolicy.egress.database.cidrs={}' \
  'networkPolicy.egress.database.cidrs={999.1.1.1/24}' \
  'networkPolicy.egress.audit.cidrs={0.0.0.0/0}' \
  'monitoring.enabled=false' \
  'monitoring.ruleLabels=' \
  'scheduling.nodeSelector.kubernetes\.io/arch=arm64' \
  'audit.endpointURL=https://user:password@audit.example.com/rgs/events' \
  'audit.mtls.enabled=true,audit.mtls.clientCertKey=,audit.mtls.clientKeyKey='; do
  if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
    -f "$example_values" --set "$override" >/dev/null 2>&1; then
    fail "危险覆盖被错误接受: $override"
  fi
done

if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" \
  --set-string 'externalSecrets.apiRuntimeAssets.additionalItems[0].path=../escape.pem' \
  >/dev/null 2>&1; then
  fail 'Secret 投影路径穿越被错误接受'
fi

if "$helm_binary" template slots "$chart_directory" --namespace slots-production \
  -f "$example_values" \
  --set-string 'externalSecrets.workerRuntimeAssets.additionalItems[0].path=keys/operator-access-private.pem' \
  >/dev/null 2>&1; then
  fail 'Worker API 私钥投影被错误接受'
fi

printf '%s\n' 'cluster production contract: passed'
