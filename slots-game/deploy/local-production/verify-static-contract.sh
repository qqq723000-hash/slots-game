#!/bin/sh
# 在启动容器前验证本机集成验收 Compose、镜像元数据、HSTS 与 Grafana 离线约束。
# 本文件需精确检索被验收脚本中的字面量 `$...`，且 Node 负向变异不应由 shell 展开。
# shellcheck disable=SC2016
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
compose_file="$script_dir/compose.yml"
bootstrap_file="$script_dir/bootstrap.sh"
up_file="$script_dir/up.sh"
verify_file="$script_dir/verify.sh"
operator_log_probe_verifier_file="$script_dir/verify-operator-log-probe.mjs"
volume_initializer_file="$script_dir/initialize-volumes.sh"
asset_approval_generator_file="$script_dir/create-asset-approval.mjs"
browser_verifier_file="$script_dir/verify-browser-session.mjs"
browser_probe_file="$script_dir/browser-session-probe.mjs"
browser_probe_test="$script_dir/browser-session-probe.test.mjs"
csp_verifier_file="$script_dir/../web/content-security-policy.mjs"

require_exact_line() {
  expected_line="$1"
  target_file="$2"
  failure_message="$3"
  if [ "$(grep -Fxc "$expected_line" "$target_file")" -ne 1 ]; then
    printf '%s\n' "$failure_message" >&2
    exit 1
  fi
}

command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker CLI 不可用。' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 不可用。' >&2; exit 1; }
require_exact_line '      LOCAL_OPERATOR_IDLE_DISCONNECT: 20m' "$compose_file" '本地 operator 缺少 20 分钟空闲断开策略。'
require_exact_line '      RGS_SESSION_IDLE_DISCONNECT_MIN: 1m' "$compose_file" '本地 RGS 缺少空闲断开下限。'
require_exact_line '      RGS_SESSION_IDLE_DISCONNECT_MAX: 24h' "$compose_file" '本地 RGS 缺少空闲断开上限。'
require_exact_line '    VITE_OPERATOR_RETURN_URL: /operator/' "$compose_file" '本地 Web Compose 缺少同源 operator 返回地址。'
require_exact_line '  VITE_OPERATOR_RETURN_URL=/operator/ \' "$bootstrap_file" '本地 Web 构建未注入 operator 返回地址。'
require_exact_line 'ARG VITE_OPERATOR_RETURN_URL' "$script_dir/Dockerfile.web" '本地 Web 镜像未锁定 operator 返回地址构建参数。'
require_exact_line 'RUN --network=none test "${VITE_OPERATOR_RETURN_URL}" = /operator/ && \' "$script_dir/Dockerfile.web" '本地 Web 镜像未验证 operator 返回地址。'
test -f "$browser_probe_file"
test -f "$browser_probe_test"
test -f "$csp_verifier_file"
test -f "$operator_log_probe_verifier_file"
test -f "$volume_initializer_file"
test -f "$asset_approval_generator_file"
node --check "$browser_probe_file"
node --check "$browser_verifier_file"
node --check "$operator_log_probe_verifier_file"
node --check "$asset_approval_generator_file"
node --test "$browser_probe_test"

temporary_root="$(mktemp -d -t slots-local-contract.XXXXXX)"
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

export LOCAL_PRODUCTION_STATE_ROOT="$temporary_root/state"
export LOCAL_PRODUCTION_GAME_ID="contract-game"
export LOCAL_PRODUCTION_DEFINITION_VERSION="contract-version"
export LOCAL_PRODUCTION_DEFINITION_HASH="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export LOCAL_PRODUCTION_OPERATOR_ID="contract-operator"
export LOCAL_PRODUCTION_IMAGE_CREATED="2026-01-01T00:00:00Z"
export LOCAL_PRODUCTION_IMAGE_REVISION="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export LOCAL_PRODUCTION_IMAGE_SOURCE="https://github.com/qqq723000-hash/slots-game"
export LOCAL_PRODUCTION_IMAGE_VERSION="contract-version"

cat >"$temporary_root/release-manifest.json" <<'JSON'
{
  "schemaVersion": 1,
  "files": [
    {
      "path": "favicon.ico",
      "bytes": 370070,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "path": "assets/primal-runtime/feature.bin",
      "bytes": 42,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    {
      "path": "nested/favicon.ico",
      "bytes": 1,
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      "path": "assets/unprotected.txt",
      "bytes": 2,
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  ]
}
JSON
node "$asset_approval_generator_file" \
  "$temporary_root/release-manifest.json" \
  "$temporary_root/release-asset-approval.json"
node - "$temporary_root/release-asset-approval.json" <<'NODE'
const { readFileSync } = require("node:fs");
const approval = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expectedPaths = ["assets/primal-runtime/feature.bin", "favicon.ico"];
const actualPaths = (approval.assets ?? []).map((entry) => entry.path).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error("本地资源审批必须精确覆盖根 favicon.ico 与受保护前缀，且不得接受同名嵌套路径");
}
const favicon = approval.assets.find((entry) => entry.path === "favicon.ico");
if (favicon?.bytes !== 370070
    || favicon?.sha256 !== "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
  throw new Error("本地资源审批没有绑定 favicon.ico 的精确字节数与 SHA-256");
}
NODE

docker compose -f "$compose_file" config --format json >"$temporary_root/compose.json"
node - "$temporary_root/compose.json" <<'NODE'
const { readFileSync } = require("node:fs");
const document = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expectedArgs = {
  OCI_IMAGE_CREATED: process.env.LOCAL_PRODUCTION_IMAGE_CREATED,
  OCI_IMAGE_REVISION: process.env.LOCAL_PRODUCTION_IMAGE_REVISION,
  OCI_IMAGE_SOURCE: process.env.LOCAL_PRODUCTION_IMAGE_SOURCE,
  OCI_IMAGE_VERSION: process.env.LOCAL_PRODUCTION_IMAGE_VERSION,
};
const volumeInitializer = document.services?.["service-volume-init"];
if (volumeInitializer?.network_mode !== "none") {
  throw new Error("读取全部源秘密的初始化容器必须完全禁用网络");
}
if (Object.keys(volumeInitializer?.networks ?? {}).length !== 0) {
  throw new Error("读取全部源秘密的初始化容器不得加入任何 Compose 网络");
}
for (const serviceName of ["rgs-migrator", "rgs-server", "local-operator", "web"]) {
  const build = document.services?.[serviceName]?.build;
  if (!build) throw new Error(`${serviceName} 缺少构建配置`);
  for (const [name, value] of Object.entries(expectedArgs)) {
    if (build.args?.[name] !== value) throw new Error(`${serviceName} is missing ${name}`);
  }
}
const grafana = document.services?.grafana?.environment ?? {};
for (const [name, value] of Object.entries({
  GF_ANALYTICS_REPORTING_ENABLED: "false",
  GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
  GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
  GF_PLUGINS_PLUGIN_ADMIN_ENABLED: "false",
  GF_PLUGINS_PREINSTALL_DISABLED: "true",
  GF_PLUGINS_PREINSTALL_AUTO_UPDATE: "false",
})) {
  if (grafana[name] !== value) throw new Error(`Grafana must set ${name}=${value}`);
}
const rgsEnvironment = document.services?.["rgs-server"]?.environment ?? {};
if (rgsEnvironment.RGS_WALLET_ROOT_CA_FILE !== "/run/local-production/local-production-root-ca.pem") {
  throw new Error("RGS 钱包客户端必须显式加载本机生产根 CA");
}
if (rgsEnvironment.PROBE_URL !== "http://127.0.0.1:8081/readyz"
    || rgsEnvironment.PROBE_BEARER_FILE !== "/run/local-production/operations.token") {
  throw new Error("RGS Compose 健康门必须使用带 Bearer 的私有 operations readiness");
}
const rgsService = document.services?.["rgs-server"] ?? {};
const valkeyService = document.services?.valkey ?? {};
const ingressNetworks = new Set(Object.keys(document.services?.ingress?.networks ?? {}));
const rgsNetworks = new Set(Object.keys(rgsService.networks ?? {}));
const valkeyNetworks = new Set(Object.keys(valkeyService.networks ?? {}));
const prometheusNetworks = new Set(Object.keys(document.services?.prometheus?.networks ?? {}));
if (document.networks?.operations?.internal !== true || !rgsNetworks.has("operations")
    || !prometheusNetworks.has("operations") || ingressNetworks.has("operations")) {
  throw new Error("私有 operations 网络只能连接 RGS 与明确的运维消费者，入口不得加入");
}
if ((rgsService.ports ?? []).length !== 0) {
  throw new Error("RGS 公共或 operations 监听器不得直接发布到宿主机");
}
if (valkeyService.image !== "valkey/valkey:8.1-alpine@sha256:e0eb7c480958d32bdc4357a74bdd70653ae15f2f9b4c93c4a5a9fad1dc471c84"
    || valkeyService.user !== "999:1000" || valkeyService.read_only !== true
    || !(valkeyService.cap_drop ?? []).includes("ALL")
    || !(valkeyService.security_opt ?? []).includes("no-new-privileges:true")) {
  throw new Error("本地 Valkey 必须固定镜像摘要并以最小权限、只读根文件系统运行");
}
if (document.networks?.admission?.internal !== true || !rgsNetworks.has("admission")
    || valkeyNetworks.size !== 1 || !valkeyNetworks.has("admission")
    || ingressNetworks.has("admission") || (valkeyService.ports ?? []).length !== 0) {
  throw new Error("Valkey 只能通过未发布的内部 admission 网络连接 RGS");
}
for (const [name, expected] of Object.entries({
  RGS_SHARED_ADMISSION_URL: "rediss://valkey:6379",
  RGS_SHARED_ADMISSION_USERNAME: "rgs-api",
  RGS_SHARED_ADMISSION_PASSWORD_FILE: "/run/local-production/valkey-password",
  RGS_SHARED_ADMISSION_HMAC_KEY_FILE: "/run/local-production/shared-admission-hmac.key",
  RGS_SHARED_ADMISSION_ROOT_CA_FILE: "/run/local-production/local-production-root-ca.pem",
})) {
  if (rgsEnvironment[name] !== expected) throw new Error(`RGS 缺少本地共享准入配置 ${name}`);
}
NODE

if grep -Eq '^[[:space:]]*provenance:' "$compose_file"; then
  printf '%s\n' 'Compose 配置不得声明不兼容的 build.provenance 字段。' >&2
  exit 1
fi
require_exact_line \
  'compose build --provenance=mode=max rgs-migrator rgs-server local-operator web' \
  "$bootstrap_file" \
  'bootstrap.sh 必须使用 BuildKit mode=max 来源证明构建全部自有镜像。'
grep -F 'go run ./cmd/local-production-bootstrap add-shared-admission "$secrets_root"' "$bootstrap_file" >/dev/null || {
  printf '%s\n' 'bootstrap.sh 必须幂等补齐旧本地状态的 Valkey 专用材料。' >&2
  exit 1
}
require_exact_line \
  'compose up -d --no-build --force-recreate' \
  "$up_file" \
  'up.sh 必须禁止启动阶段隐式重建镜像。'
if [ "$(grep -Ec '^[[:space:]]*compose build([[:space:]]|$)' "$bootstrap_file")" -ne 1 ]; then
  printf '%s\n' 'bootstrap.sh 只能执行一次受约束的镜像构建。' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*compose build([[:space:]]|$)' "$up_file"; then
  printf '%s\n' 'up.sh 不得用旧 revision 元数据重建当前工作区。' >&2
  exit 1
fi
if [ "$(grep -Ec '^[[:space:]]*compose up([[:space:]]|$)' "$up_file")" -ne 1 ]; then
  printf '%s\n' 'up.sh 只能执行一次受约束的服务启动。' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*compose up .*--build([[:space:]]|$)' "$up_file"; then
  printf '%s\n' 'up.sh 不得通过 compose up --build 绕过来源证明构建。' >&2
  exit 1
fi

grep -F "csp_verifier=\"\$repository_root/deploy/web/content-security-policy.mjs\"" "$verify_file" >/dev/null || {
  printf '%s\n' '本机动态验收必须复用 Web 精确 CSP 语义校验器。' >&2
  exit 1
}
test "$(grep -Fxc 'verify_web_content_security_policy() {' "$verify_file")" -eq 1 || {
  printf '%s\n' '本机动态验收必须只定义一次 CSP 响应检查。' >&2
  exit 1
}
test "$(grep -Ec '^verify_web_content_security_policy[[:space:]]+' "$verify_file")" -eq 3 || {
  printf '%s\n' '本机动态验收必须覆盖三类真实 CSP 响应。' >&2
  exit 1
}
for required_csp_response in \
  "verify_web_content_security_policy / 'Web 首页'" \
  "verify_web_content_security_policy /release-manifest.json 'Web 发布清单'" \
  "verify_web_content_security_policy \"/\$representative_script_path\" 'Web 代表性脚本'"
do
  grep -F "$required_csp_response" "$verify_file" >/dev/null || {
    printf '%s\n' "本机 CSP 动态验收缺少：$required_csp_response" >&2
    exit 1
  }
done

verify_log_delivery_contract() {
  candidate=$1
  test "$(grep -Fxc 'vector_sink_baseline=$(read_vector_sink_counter)' "$candidate")" -eq 1 &&
    test "$(grep -Fxc 'operator_log_bytes_baseline=$(read_operator_log_bytes)' "$candidate")" -eq 1 &&
    test "$(grep -Fxc 'process.exit(Number.isFinite(current) && Number.isFinite(baseline) && current > baseline ? 0 : 1);' "$candidate")" -eq 1 &&
    test "$(grep -Fxc "      && test \"\$operator_log_bytes_current\" -gt \"\$operator_log_bytes_baseline\" \\" "$candidate")" -eq 1 &&
    test "$(grep -Fxc '      && verify_operator_log_probe "$log_probe_digest"; then' "$candidate")" -eq 1 &&
    test "$(grep -Fxc '    node "$local_production_directory/verify-operator-log-probe.mjs" "$expected_digest"' "$candidate")" -eq 1 &&
    test "$(grep -Fxc 'const {randomBytes}=require("node:crypto");' "$candidate")" -eq 1 &&
    test "$(grep -Fxc 'process.stdout.write(`vectorverify${randomBytes(18).toString("hex")}`);' "$candidate")" -eq 1 &&
    test "$(grep -Fxc '  --header "X-Operator-Id: $operator_id" \' "$candidate")" -eq 1 &&
    test "$(grep -Fxc 'process.stdout.write(createHash("sha256").update(process.argv[1], "utf8").digest("hex"));' "$candidate")" -eq 1
}

if ! verify_log_delivery_contract "$verify_file"; then
  printf '%s\n' '本机动态验收必须证明当次 Vector sink 计数增量、文件增长与精确脱敏语义。' >&2
  exit 1
fi

log_probe_fixture_digest='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
log_probe_fixture_valid='{"service":"rgs-server","level":"WARN","msg":"http request","route":"operator.launch","request_id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":401,"status_class":"4xx","duration_ms":12}'
printf '%s\n%s\n' "$log_probe_fixture_valid" "$log_probe_fixture_valid" |
  node "$operator_log_probe_verifier_file" "$log_probe_fixture_digest" || {
    printf '%s\n' '本机日志语义门禁误拒 Vector at-least-once 合法重复。' >&2
    exit 1
  }
log_probe_fixture_sensitive='{"service":"rgs-server","level":"WARN","msg":"http request","route":"operator.launch","request_id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":401,"status_class":"4xx","duration_ms":12,"container_id":"must-not-escape"}'
if printf '%s\n%s\n' "$log_probe_fixture_valid" "$log_probe_fixture_sensitive" |
    node "$operator_log_probe_verifier_file" "$log_probe_fixture_digest"; then
  printf '%s\n' '本机日志语义门禁接受了含敏感元数据的重复记录。' >&2
  exit 1
fi
log_probe_fixture_missing_status='{"service":"rgs-server","level":"WARN","msg":"http request","route":"operator.launch","request_id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status_class":"4xx","duration_ms":12}'
if printf '%s\n' "$log_probe_fixture_missing_status" |
    node "$operator_log_probe_verifier_file" "$log_probe_fixture_digest"; then
  printf '%s\n' '本机日志语义门禁接受了缺少 401 状态的记录。' >&2
  exit 1
fi
log_probe_fixture_wrong_level='{"service":"rgs-server","level":"INFO","msg":"http request","route":"operator.launch","request_id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":401,"status_class":"4xx","duration_ms":12}'
if printf '%s\n' "$log_probe_fixture_wrong_level" |
    node "$operator_log_probe_verifier_file" "$log_probe_fixture_digest"; then
  printf '%s\n' '本机日志语义门禁接受了错误的 401 日志级别。' >&2
  exit 1
fi

counter_mutation="$temporary_root/verify-log-counter-mutation.sh"
cp "$verify_file" "$counter_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const changed=source.replace("current > baseline", "current > 0");
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$counter_mutation"
if verify_log_delivery_contract "$counter_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了仅检查历史 sink 累计值的假绿回归。' >&2
  exit 1
fi

semantic_mutation="$temporary_root/verify-log-semantic-mutation.sh"
cp "$verify_file" "$semantic_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const marker="&& verify_operator_log_probe \"$log_probe_digest\"; then";
const changed=source.replace(marker, "&& true; then");
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$semantic_mutation"
if verify_log_delivery_contract "$semantic_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了移除精确日志语义核对的回归。' >&2
  exit 1
fi

comment_mutation="$temporary_root/verify-log-comment-mutation.sh"
cp "$verify_file" "$comment_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const marker="      && verify_operator_log_probe \"$log_probe_digest\"; then";
const changed=source.replace(marker, `      # ${marker.trim()}\n      && true; then`);
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$comment_mutation"
if verify_log_delivery_contract "$comment_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了仅在注释中保留语义探针的回归。' >&2
  exit 1
fi

require_exact_line \
  "  node \"\$local_production_directory/verify-browser-session.mjs\" \"\$launch_response\"" \
  "$verify_file" \
  '完整验收必须消费一次性启动响应并执行真实浏览器会话门禁。'
grep -F "LOCAL_BROWSER_CERT_FILE=\"\$secrets_root/ingress-server.pem\"" "$verify_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须只信任本部署的入口证书公钥。' >&2
  exit 1
}
for forbidden_browser_flag in '--disable-gpu' '--no-sandbox' '--ignore-certificate-errors"'; do
  if grep -F -- "$forbidden_browser_flag" "$browser_verifier_file" >/dev/null; then
    printf '%s\n' "真实浏览器门禁包含禁用安全或渲染能力的参数：$forbidden_browser_flag" >&2
    exit 1
  fi
done
grep -F -- "--ignore-certificate-errors-spki-list=\${certificateKey}" "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须按入口证书 SPKI 精确授权。' >&2
  exit 1
}
grep -F 'exchangeStatus === 200' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须证明 RGS 会话交换成功。' >&2
  exit 1
}
grep -F 'exchangeMethod === "POST"' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须证明会话交换使用精确 POST。' >&2
  exit 1
}
grep -F 'latestState.rgsSession === "online"' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须证明权威会话已应用到玩家界面。' >&2
  exit 1
}
grep -F 'responseURL.origin === expectedRgsOrigin' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须绑定精确 RGS HTTPS origin。' >&2
  exit 1
}
grep -F 'assemblyStage === "readiness-complete-painted"' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须证明游戏画布完成就绪。' >&2
  exit 1
}
grep -F "addEventListener('securitypolicyviolation'" "$browser_probe_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须在文档创建前监听 CSP 违规事件。' >&2
  exit 1
}
grep -F 'latestState.cspViolations.length > 0' "$browser_verifier_file" >/dev/null || {
  printf '%s\n' '真实浏览器门禁必须把任一 CSP 违规作为验收失败。' >&2
  exit 1
}

for dockerfile in "$script_dir/Dockerfile.services" "$script_dir/Dockerfile.web"; do
  for label in \
    org.opencontainers.image.created \
    org.opencontainers.image.revision \
    org.opencontainers.image.source \
    org.opencontainers.image.version \
    com.slots-game.deployment.profile; do
    grep -F "$label=" "$dockerfile" >/dev/null || {
      printf '%s\n' "${dockerfile} 缺少 ${label}。" >&2
      exit 1
    }
  done
done

test "$(grep -Fc 'add_header Strict-Transport-Security "max-age=31536000" always;' "$script_dir/ingress-nginx.conf")" = 1 || {
  printf '%s\n' 'HTTPS 入口必须统一且仅声明一次 HSTS。' >&2
  exit 1
}
test "$(grep -Fc '    location = /healthz {' "$script_dir/ingress-nginx.conf")" = 1 \
  && test "$(grep -Fc '      return 404;' "$script_dir/ingress-nginx.conf")" = 1 || {
  printf '%s\n' 'RGS 公网入口必须精确拦截 /healthz。' >&2
  exit 1
}
grep -F 'PROBE_URL=http://127.0.0.1:8081/healthz' "$verify_file" >/dev/null || {
  printf '%s\n' '本机动态验收必须探测私有 operations liveness。' >&2
  exit 1
}
grep -F 'test "$public_rgs_health_status" = 404' "$verify_file" >/dev/null || {
  printf '%s\n' '本机动态验收必须拒绝公网 RGS /healthz。' >&2
  exit 1
}

node "$script_dir/render-observability.mjs" "$temporary_root/rendered" >/dev/null
require_exact_line \
  'copy_secret local-production-root-ca.pem /target/prometheus alertmanager_root_ca.pem 65534 65534' \
  "$volume_initializer_file" \
  'Prometheus 必须取得固定文件名的 Alertmanager 私有根 CA。'
grep -F 'ca_file: /run/secrets/alertmanager_root_ca.pem' \
  "$temporary_root/rendered/prometheus.yml" >/dev/null || {
  printf '%s\n' '本机 Prometheus 渲染产物未绑定固定 Alertmanager CA 路径。' >&2
  exit 1
}
node - "$temporary_root/rendered/grafana/dashboards/rgs-overview.json" <<'NODE'
const {readFileSync}=require("node:fs");
const dashboard=JSON.parse(readFileSync(process.argv[2], "utf8"));
const ids=dashboard.panels.map((panel) => panel.id);
if (ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) process.exit(1);
NODE
for directory in \
  "$temporary_root/rendered/grafana/provisioning/alerting" \
  "$temporary_root/rendered/grafana/provisioning/plugins"; do
  test -d "$directory" || { printf '%s\n' "$directory 未生成。" >&2; exit 1; }
done

"$script_dir/test-operations-contract.sh"

printf '%s\n' '本机集成验收静态契约通过。'
