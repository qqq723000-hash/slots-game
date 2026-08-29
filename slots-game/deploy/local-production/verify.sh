#!/bin/sh
# 动态验收 TLS、认证、数据库、可观测、日志 sink 和真实一次性启动会话。
# English: Dynamic acceptance of TLS, authentication, databases, observables, log sinks and true one-time boot
# sessions.
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_node22
require_state

ca_file="$secrets_root/local-production-root-ca.pem"
csp_verifier="$repository_root/deploy/web/content-security-policy.mjs"
release_manifest_verifier="$repository_root/web/scripts/release-manifest.mjs"
test -s "$ca_file"
test -s "$csp_verifier"
test -s "$release_manifest_verifier"

metadata_value() {
  value="$(sed -n "s/^$1=//p" "$compose_environment")"
  test -n "$value" || { printf '%s\n' "$1 镜像元数据缺失。" >&2; exit 1; }
  printf '%s' "$value"
}

image_created="$(metadata_value LOCAL_PRODUCTION_IMAGE_CREATED)"
image_revision="$(metadata_value LOCAL_PRODUCTION_IMAGE_REVISION)"
image_source="$(metadata_value LOCAL_PRODUCTION_IMAGE_SOURCE)"
image_version="$(metadata_value LOCAL_PRODUCTION_IMAGE_VERSION)"
image_tag="$(metadata_value LOCAL_PRODUCTION_IMAGE_TAG)"
operator_id="$(metadata_value LOCAL_PRODUCTION_OPERATOR_ID)"

printf '%s\n' '验收阶段：镜像来源元数据。'

verify_image_metadata() {
  image_name="$1"
  expected_title="$2"
  # shellcheck disable=SC2016
  docker image inspect "$image_name" | node -e '
let source="";
process.stdin.on("data", chunk => { source += chunk; }).on("end", () => {
  const image = JSON.parse(source)[0];
  const labels = image?.Config?.Labels ?? {};
  const expected = {
    "org.opencontainers.image.title": process.argv[1],
    "org.opencontainers.image.created": process.argv[2],
    "org.opencontainers.image.revision": process.argv[3],
    "org.opencontainers.image.source": process.argv[4],
    "org.opencontainers.image.version": process.argv[5],
    "com.slots-game.deployment.profile": "local-production",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (labels[name] !== value) throw new Error(`${name} mismatch for ${process.argv[6]}`);
  }
});
' "$expected_title" "$image_created" "$image_revision" "$image_source" "$image_version" "$image_name"
}

verify_image_metadata "slots-rgs-runtime:$image_tag" slots-rgs-runtime
verify_image_metadata "slots-rgs-migrator:$image_tag" slots-rgs-migrator
verify_image_metadata "slots-local-operator:$image_tag" slots-local-operator
verify_image_metadata "slots-web:$image_tag" slots-web
verify_image_metadata "slots-nginx-proxy:$image_tag" slots-nginx-proxy

printf '%s\n' '验收阶段：容器健康与最小权限。'
for service in postgres valkey local-operator rgs-server web ingress vector alertmanager alert-proxy prometheus grafana backup; do
  container_id="$(compose ps -q "$service")"
  test -n "$container_id" || { printf '%s\n' "$service 容器不存在。" >&2; exit 1; }
  test "$(docker inspect -f '{{.State.Status}}' "$container_id")" = running || {
    printf '%s\n' "$service 未运行。" >&2; exit 1;
  }
  health_status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
  attempt=0
  while test -n "$health_status" && test "$health_status" != healthy && test "$attempt" -lt 72; do
    attempt=$((attempt + 1))
    sleep 5
    health_status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
  done
  test -z "$health_status" || test "$health_status" = healthy || {
    printf '%s\n' "$service 健康检查在六分钟内未通过。" >&2; exit 1;
  }
  test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container_id")" = true || {
    printf '%s\n' "$service 根文件系统不是只读。" >&2; exit 1;
  }
  docker inspect -f '{{json .HostConfig.CapDrop}}' "$container_id" | grep -q '"ALL"' || {
    printf '%s\n' "$service 未丢弃默认 capabilities。" >&2; exit 1;
  }
  docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$container_id" | grep -q 'no-new-privileges' || {
    printf '%s\n' "$service 未启用 no-new-privileges。" >&2; exit 1;
  }
done
for service in service-volume-init rgs-migrator local-operator-bootstrap local-operator-migrate backup-policy; do
  container_id="$(compose ps -aq "$service")"
  test -n "$container_id"
  test "$(docker inspect -f '{{.State.ExitCode}}' "$container_id")" = 0 || {
    printf '%s\n' "$service 一次性任务失败。" >&2; exit 1;
  }
done

printf '%s\n' '验收阶段：HTTPS 入口与服务探针。'
curl --fail --silent --show-error --cacert "$ca_file" \
  --resolve slots.localhost:8443:127.0.0.1 https://slots.localhost:8443/healthz >/dev/null
public_rgs_health_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --cacert "$ca_file" --resolve rgs.localhost:8443:127.0.0.1 \
  https://rgs.localhost:8443/healthz)"
test "$public_rgs_health_status" = 404
for ingress_host in slots.localhost rgs.localhost; do
  curl --silent --show-error --dump-header - --output /dev/null --cacert "$ca_file" \
    --resolve "$ingress_host:8443:127.0.0.1" "https://$ingress_host:8443/healthz" \
    | tr -d '\r' | grep -Eiq '^strict-transport-security: max-age=31536000$' || {
      printf '%s\n' "$ingress_host 未返回统一 HSTS。" >&2
      exit 1
    }
done
verify_web_content_security_policy() {
  web_path="$1"
  web_label="$2"
  web_headers_file="$(mktemp -t slots-web-csp.XXXXXX)"
  if ! curl --fail --silent --show-error --dump-header "$web_headers_file" --output /dev/null \
    --cacert "$ca_file" --resolve slots.localhost:8443:127.0.0.1 \
    "https://slots.localhost:8443$web_path"; then
    rm -f "$web_headers_file"
    printf '%s\n' "$web_label 无法完整读取。" >&2
    exit 1
  fi
  if ! tr -d '\r' < "$web_headers_file" \
    | node "$csp_verifier" \
      --rgs-base-url https://rgs.localhost:8443 \
      --host-origin https://slots.localhost:8443; then
    rm -f "$web_headers_file"
    printf '%s\n' "$web_label 未返回唯一且完整的严格 CSP。" >&2
    exit 1
  fi
  rm -f "$web_headers_file"
}

verify_web_content_security_policy / 'Web 首页'
verify_web_content_security_policy /release-manifest.json 'Web 发布清单'
release_manifest_json="$(curl --fail --silent --show-error --cacert "$ca_file" \
  --resolve slots.localhost:8443:127.0.0.1 \
  https://slots.localhost:8443/release-manifest.json)"
representative_script_path="$(printf '%s' "$release_manifest_json" | node --input-type=module -e '
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const {verifyReleaseManifest}=await import(pathToFileURL(process.argv[1]).href);
const manifest=verifyReleaseManifest(JSON.parse(readFileSync(0, "utf8")), { requireRevision: true });
if (manifest.version !== process.argv[2] || manifest.revision !== process.argv[3]) {
  throw new Error("Web 发布清单身份与已提交镜像版本或 revision 不一致");
}
const script=(manifest.files ?? []).find((file) =>
  typeof file?.path === "string" && /^assets\/[A-Za-z0-9_-]+\.js$/u.test(file.path));
if (!script) process.exit(1);
process.stdout.write(script.path);
' "$release_manifest_verifier" "$image_version" "$image_revision")"
test -n "$representative_script_path" || {
  printf '%s\n' '发布清单中没有可用于响应头验收的代表性脚本。' >&2
  exit 1
}
verify_web_content_security_policy "/$representative_script_path" 'Web 代表性脚本'
unset release_manifest_json representative_script_path
launcher_page="$(curl --fail --silent --show-error --cacert "$ca_file" \
  --resolve slots.localhost:8443:127.0.0.1 https://slots.localhost:8443/operator/)"
printf '%s' "$launcher_page" | grep -Eq '<form[^>]+action="/launch"'
invalid_form_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --cacert "$ca_file" --resolve slots.localhost:8443:127.0.0.1 \
  -H 'Content-Type: application/x-www-form-urlencoded' --data 'accessToken=invalid' \
  https://slots.localhost:8443/launch)"
test "$invalid_form_status" = 401

compose exec -T \
  -e PROBE_URL=http://127.0.0.1:8081/healthz \
  -e PROBE_BEARER_FILE= \
  rgs-server /service-probe
compose exec -T rgs-server /service-probe
compose exec -T \
  -e PROBE_URL=http://127.0.0.1:8081/metrics \
  -e PROBE_BEARER_FILE=/run/local-production/operations.token \
  rgs-server /service-probe
compose exec -T \
  -e PROBE_URL=https://127.0.0.1:8443/healthz \
  -e PROBE_ROOT_CA_FILE=/run/operator-secrets/local-production-root-ca.pem \
  -e PROBE_SERVER_NAME=local-operator \
  local-operator /service-probe
compose exec -T \
  -e PROBE_URL=https://127.0.0.1:8443/metrics \
  -e PROBE_ROOT_CA_FILE=/run/operator-secrets/local-production-root-ca.pem \
  -e PROBE_SERVER_NAME=local-operator \
  -e PROBE_BEARER_FILE=/run/operator-secrets/local-operator-metrics.token \
  local-operator /service-probe
# 密码只经容器环境传给 valkey-cli，不进入命令行、宿主输出或 Compose 环境。
# English: The password is only passed to valkey-cli through the container environment and does not enter the
# command line, host output or Compose environment.
# shellcheck disable=SC2016
compose exec -T valkey sh -ceu '
  REDISCLI_AUTH="$(sed -n "1p" /run/valkey-secrets/valkey-password)"
  export REDISCLI_AUTH
  valkey-cli --tls --cacert /run/valkey-secrets/local-production-root-ca.pem \
    --user rgs-api -h valkey -p 6379 ping | grep -qx PONG
'

printf '%s\n' '验收阶段：数据库 TLS 与观测面。'
# shellcheck disable=SC2016
compose exec -T postgres sh -ceu '
  PGPASSWORD="$(sed -n "1p" /run/postgres-input/postgres-admin.password)"
  export PGPASSWORD
  psql "host=postgres port=5432 dbname=rgs user=postgres sslmode=verify-full sslrootcert=/run/postgres-input/local-production-root-ca.pem" -Atqc "SELECT current_setting('\''ssl'\''), current_database()" | grep -qx "on|rgs"
'

curl --fail --silent --show-error http://127.0.0.1:9090/-/ready >/dev/null
targets_ready=0
attempt=0
while [ "$attempt" -lt 12 ]; do
  targets_json="$(curl --fail --silent --show-error http://127.0.0.1:9090/api/v1/targets?state=active)"
  if printf '%s' "$targets_json" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
 const p=JSON.parse(s); if(p.status!=="success") process.exit(1);
 const required=new Set(["rgs","vector","local-operator"]);
 for(const target of p.data.activeTargets||[]) if(target.health==="up") required.delete(target.labels?.job);
 process.exit(required.size?1:0);
});'; then
    targets_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done
test "$targets_ready" = 1 || { printf '%s\n' 'Prometheus 必需 targets 未全部 up。' >&2; exit 1; }
# Prometheus 就绪早于首次规则求值；等待规则全部加载并完成一次健康求值，避免冷启动误报。
# English: Prometheus is ready earlier than the first rule evaluation; wait for all rules to be loaded and
# complete a health evaluation to avoid cold start false positives.
rules_ready=0
attempt=0
while [ "$attempt" -lt 12 ]; do
  rules_json="$(curl --fail --silent --show-error http://127.0.0.1:9090/api/v1/rules)"
  if printf '%s' "$rules_json" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
 const p=JSON.parse(s); const rules=(p.data?.groups||[]).flatMap(g=>g.rules||[]);
 const required=[
   "LocalOperatorUnavailable", "LocalProductionBackupStatusUnreadable",
   "LocalProductionBackupFailed", "LocalProductionBackupStale",
   "LocalOperatorAuditStoreNearCapacity", "LocalOperatorLogStoreNearCapacity",
   "LocalOperatorAlertStoreNearCapacity"
 ];
 if(required.some(name=>!rules.some(rule=>rule.name===name)) ||
    rules.some(r=>r.health!=="ok")) process.exit(1);
});'; then
    rules_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done
test "$rules_ready" = 1 || { printf '%s\n' 'Prometheus 告警规则未完成健康求值。' >&2; exit 1; }
node -e '
const fs=require("fs"); const dashboard=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const expressions=(dashboard.panels||[]).flatMap(panel=>(panel.targets||[]).map(target=>target.expr));
if(!expressions.some(expr=>expr?.includes("local_operator_ready")) ||
   !expressions.some(expr=>expr?.includes("local_operator_failures_total"))) process.exit(1);
' "$state_root/rendered/grafana/dashboards/rgs-overview.json"

require_prometheus_vector() {
  query=$1
  query_attempt=0
  while test "$query_attempt" -lt 12; do
    result=$(curl --fail --silent --show-error --get --data-urlencode "query=$query" \
      http://127.0.0.1:9090/api/v1/query)
    if printf '%s' "$result" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
 const p=JSON.parse(s); process.exit(p.status==="success" && (p.data?.result||[]).length>0 ? 0 : 1);
});'; then
      return 0
    fi
    query_attempt=$((query_attempt + 1))
    sleep 5
  done
  printf '%s\n' "Prometheus 查询未满足: $query" >&2
  return 1
}

# 备份状态与三个有界持久化存储必须由已认证的 local-operator scrape 暴露。
# English: Backup state and three bounded persistence stores must be exposed by an authenticated local-operator
# scrape.
require_prometheus_vector 'local_production_backup_status_file_readable{job="local-operator"} == 1'
require_prometheus_vector 'local_production_backup_last_success_timestamp_seconds{job="local-operator"} > 0'
require_prometheus_vector 'local_production_backup_consecutive_failures{job="local-operator"} == 0'
require_prometheus_vector 'local_operator_audit_store_capacity_bytes{job="local-operator"} == 536870912'
require_prometheus_vector 'local_operator_log_store_capacity_bytes{job="local-operator"} == 268435456'
require_prometheus_vector 'local_operator_alert_store_capacity_bytes{job="local-operator"} == 67108864'
require_prometheus_vector 'local_operator_audit_store_writable{job="local-operator"} == 1'
require_prometheus_vector 'local_operator_log_store_writable{job="local-operator"} == 1'
require_prometheus_vector 'local_operator_alert_store_writable{job="local-operator"} == 1'

printf '%s\n' '验收阶段：脱敏日志持久化。'
read_vector_sink_counter() {
  curl --fail --silent --show-error --get \
    --data-urlencode 'query=sum(vector_component_sent_events_total{component_id="local_https_archive"})' \
    http://127.0.0.1:9090/api/v1/query | node -e '
let source="";
process.stdin.on("data", chunk => { source += chunk; }).on("end", () => {
  const payload=JSON.parse(source);
  if (payload.status !== "success") process.exit(1);
  const results=payload.data?.result ?? [];
  if (results.length === 0) return process.stdout.write("0");
  const value=Number(results[0]?.value?.[1]);
  if (!Number.isFinite(value) || value < 0) process.exit(1);
  process.stdout.write(String(value));
});'
}

read_operator_log_bytes() {
  # 容器内 shell 应展开文件/计数变量，宿主不得提前展开。
  # English: The in-container shell should expand file/count variables, the host must not expand them
  # beforehand.
  # shellcheck disable=SC2016
  compose exec -T backup sh -ceu '
    total=0
    found=0
    for file in /operator-data/logs/rgs*.jsonl; do
      test -f "$file" || continue
      set -- $(wc -c < "$file")
      test "$#" -eq 1
      bytes=$1
      case "$bytes" in *[!0-9]*) exit 1 ;; esac
      total=$((total + bytes))
      found=1
    done
    test "$found" -eq 1
    printf "%s" "$total"
  '
}

verify_operator_log_probe() {
  expected_digest=$1
  # 容器内 shell 按受控摘要搜索脱敏 JSONL，宿主不得提前展开。
  # English: The in-container shell searches for desensitized JSONL by controlled digest, and the host must not
  # expand it in advance.
  # shellcheck disable=SC2016
  compose exec -T backup sh -ceu '
    needle=$1
    found=0
    for file in /operator-data/logs/rgs*.jsonl; do
      test -f "$file" || continue
      found=1
      grep -F "$needle" "$file" || :
    done
    test "$found" -eq 1
  ' sh "$expected_digest" |
    node "$local_production_directory/verify-operator-log-probe.mjs" "$expected_digest"
}

# 在触发之前同时记录 sink 累计值和持久文件总字节。只发送一个业务探针；后续推进
# 只能来自 Vector 的固定四字段 10 秒心跳，不能再发业务事件掩盖低流量磁盘唤醒问题。
# 唯一安全 request id 仅用于计算日志中的 SHA-256 摘要，不作为业务/租户标识。
# English: Both sink cumulative value and persistent file total bytes are recorded before triggering. Only send
# one business probe; follow up It can only come from Vector's fixed four-field 10-second heartbeat, and no
# business events can be sent to cover up low-traffic disk wake-up issues. The unique secure request id is only
# used to calculate the SHA-256 digest in the logs and is not used as a business/tenant identifier.
vector_sink_baseline=$(read_vector_sink_counter)
operator_log_bytes_baseline=$(read_operator_log_bytes)
# 模板字符串插值必须由 Node 求值，不能由当前 shell 提前展开。
# English: Template string interpolation must be evaluated by Node and cannot be prematurely expanded by the
# current shell.
# shellcheck disable=SC2016
log_probe_request_id=$(node -e '
const {randomBytes}=require("node:crypto");
process.stdout.write(`vectorverify${randomBytes(18).toString("hex")}`);
')
log_probe_digest="sha256:$(node -e '
const {createHash}=require("node:crypto");
process.stdout.write(createHash("sha256").update(process.argv[1], "utf8").digest("hex"));
' "$log_probe_request_id")"
log_probe_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --cacert "$ca_file" --resolve rgs.localhost:8443:127.0.0.1 \
  --header 'Content-Type: application/json' --header "X-Request-Id: $log_probe_request_id" \
  --header "X-Operator-Id: $operator_id" \
  --data '{}' https://rgs.localhost:8443/operator/v1/launches)
test "$log_probe_status" = 401 || {
  printf '%s\n' "RGS 日志探针返回非预期状态 ${log_probe_status}。" >&2
  exit 1
}
unset log_probe_request_id
delivery_ready=0
delivery_attempt=0
while [ "$delivery_attempt" -le 5 ]; do
  operator_log_bytes_current=$(read_operator_log_bytes)
  if test "$operator_log_bytes_current" -gt "$operator_log_bytes_baseline" \
      && verify_operator_log_probe "$log_probe_digest"; then
    delivery_ready=1
    break
  fi
  delivery_attempt=$((delivery_attempt + 1))
  if [ "$delivery_attempt" -le 5 ]; then
    sleep 5
  fi
done
test "$delivery_ready" = 1 || {
  printf '%s\n' 'Vector HTTPS sink 未在 25 秒内证明单业务探针的文件增长与精确脱敏落盘语义。' >&2
  exit 1
}
printf '%s\n' 'Vector 单业务探针已在 25 秒内完成文件增长与精确脱敏落盘。'

# sent counter 经 Vector internal_metrics 和 Prometheus 两个 15 秒周期传播；它只验证
# 可观测链路新鲜度，不参与也不推翻上面已经完成的 25 秒业务交付判定。
# English: sent counter is propagated via Vector internal_metrics and Prometheus in two 15-second periods; it
# only verifies The link freshness can be observed without participating in or overturning the 25-second service
# delivery judgment completed above.
counter_ready=0
counter_attempt=0
while [ "$counter_attempt" -le 7 ]; do
  vector_sink_current=$(read_vector_sink_counter)
  if node -e '
const current=Number(process.argv[1]); const baseline=Number(process.argv[2]);
process.exit(Number.isFinite(current) && Number.isFinite(baseline) && current > baseline ? 0 : 1);
' "$vector_sink_current" "$vector_sink_baseline"; then
    counter_ready=1
    break
  fi
  counter_attempt=$((counter_attempt + 1))
  if [ "$counter_attempt" -le 7 ]; then
    sleep 5
  fi
done
test "$counter_ready" = 1 || {
  printf '%s\n' '单业务探针已在 25 秒内精确落盘，但 Vector sent counter 未在独立 35 秒观测窗口内刷新。' >&2
  exit 1
}
unset log_probe_digest vector_sink_baseline vector_sink_current \
  operator_log_bytes_baseline operator_log_bytes_current delivery_ready delivery_attempt \
  counter_ready counter_attempt

printf '%s\n' '验收阶段：一次性游戏启动会话。'
admin_token="$(sed -n '1p' "$secrets_root/local-operator-admin.token")"
launch_response="$(mktemp -t slots-launch.XXXXXX)"
trap 'rm -f "$launch_response"' EXIT HUP INT TERM
launch_status="$(printf 'Authorization: Bearer %s\n' "$admin_token" \
  | curl --silent --show-error --output "$launch_response" --write-out '%{http_code}' \
  --cacert "$ca_file" --resolve slots.localhost:8443:127.0.0.1 \
  --header @- -H 'Content-Type: application/json' \
  --data '{}' https://slots.localhost:8443/api/v1/launches)"
unset admin_token
test "$launch_status" = 201
node -e '
const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const target=new URL(p.url||"https://invalid.local");
if(!/^lc_[A-Za-z0-9_-]{43}$/.test(p.launchCode||"") || target.origin!=="https://slots.localhost:8443" || !p.sessionId) process.exit(1);
' "$launch_response"
LOCAL_BROWSER_CERT_FILE="$secrets_root/ingress-server.pem" \
  node "$local_production_directory/verify-browser-session.mjs" "$launch_response"
rm -f "$launch_response"
trap - EXIT HUP INT TERM

unauthorized_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$ca_file" \
  --resolve alertmanager:9093:127.0.0.1 https://alertmanager:9093/-/ready)"
test "$unauthorized_status" = 401
printf '%s\n' '验收阶段：Alertmanager 认证与 receiver 持久化。'
alert_token="$(sed -n '1p' "$secrets_root/alertmanager.token")"
printf 'Authorization: Bearer %s\n' "$alert_token" \
  | curl --fail --silent --show-error --cacert "$ca_file" \
    --resolve alertmanager:9093:127.0.0.1 --header @- \
    https://alertmanager:9093/-/ready >/dev/null

# 向真实 Alertmanager API 注入一个两分钟自愈的技术探针，确认非空 receiver 经过
# TLS/Bearer 到达 local-operator，并由 Prometheus 观察到持久化成功计数增长。
# English: Inject a two-minute self-healing technical probe into the real Alertmanager API to confirm that the
# non-null receiver passes TLS/Bearer reaches the local-operator and the persistence success count is observed
# by Prometheus to increase.
alert_baseline_json="$(curl --fail --silent --show-error --get \
  --data-urlencode 'query=local_operator_alert_accepted_total{job="local-operator"}' \
  http://127.0.0.1:9090/api/v1/query)"
alert_baseline="$(printf '%s' "$alert_baseline_json" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
 const p=JSON.parse(s); const v=Number(p.data?.result?.[0]?.value?.[1]);
 if(!Number.isFinite(v)) process.exit(1); process.stdout.write(String(v));
});')"
# shellcheck disable=SC2016
probe_payload="$(node -e '
const now=new Date(); const end=new Date(now.getTime()+120000);
const probe=`verify-${Math.floor(now.getTime()/1000)}-${process.argv[1]}`;
process.stdout.write(JSON.stringify([{
 labels:{alertname:"LocalProductionDeliveryProbe",severity:"none",service:"observability",probe_id:probe},
 annotations:{summary:"本机 Alertmanager receiver 交付探针"},
 startsAt:now.toISOString(),endsAt:end.toISOString(),generatorURL:"https://slots.localhost:8443/operator/runbooks/alert-delivery-probe"
}]));
' "$$")"
printf 'Authorization: Bearer %s\n' "$alert_token" \
  | curl --fail --silent --show-error --cacert "$ca_file" \
  --resolve alertmanager:9093:127.0.0.1 --header @- -H 'Content-Type: application/json' \
  --data "$probe_payload" https://alertmanager:9093/api/v2/alerts >/dev/null
unset probe_payload
alert_delivered=0
attempt=0
while [ "$attempt" -lt 18 ]; do
  current_json="$(curl --fail --silent --show-error --get \
    --data-urlencode 'query=local_operator_alert_accepted_total{job="local-operator"}' \
    http://127.0.0.1:9090/api/v1/query)"
  if printf '%s' "$current_json" | node -e '
let s=""; const baseline=Number(process.argv[1]);
process.stdin.on("data",d=>s+=d).on("end",()=>{
 const p=JSON.parse(s); const current=Number(p.data?.result?.[0]?.value?.[1]);
 process.exit(Number.isFinite(current) && current>baseline ? 0 : 1);
});' "$alert_baseline"; then
    alert_delivered=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done
test "$alert_delivered" = 1 || { printf '%s\n' 'Alertmanager receiver 未确认持久化投递。' >&2; exit 1; }
unset alert_token
printf '%s\n' '验收阶段：Grafana 与备份恢复。'
curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null
grafana_logs="$(compose logs --no-color --since=15m grafana 2>&1)"
for forbidden_log in \
  'Failed to read plugin provisioning files from directory' \
  "can't read alerting provisioning files from directory" \
  'Update check failed' \
  'read-only file system'; do
  if printf '%s\n' "$grafana_logs" | grep -F "$forbidden_log" >/dev/null; then
    printf '%s\n' "Grafana 仍有可消除的启动噪声：$forbidden_log" >&2
    exit 1
  fi
done

# 未知 SNI/Host 必须在 TLS 握手层被拒绝，不得默认落到 Web。
# English: Unknown SNI/Host must be rejected at the TLS handshake layer and must not fall to the web by default.
if curl --insecure --silent --show-error --connect-timeout 3 --output /dev/null \
  --resolve unknown.localhost:8443:127.0.0.1 https://unknown.localhost:8443/ 2>/dev/null; then
  printf '%s\n' '未知入口主机名未被拒绝。' >&2
  exit 1
fi

"$local_production_directory/verify-backups.sh"

printf '%s\n' '本机集成验收端到端门禁通过。'
