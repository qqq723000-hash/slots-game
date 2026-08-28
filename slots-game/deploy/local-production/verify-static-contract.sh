#!/bin/sh
# 在启动容器前验证本机集成验收 Compose、镜像元数据、HSTS 与 Grafana 离线约束。
# 本文件需精确检索被验收脚本中的字面量 `$...`，且 Node 负向变异不应由 shell 展开。
# shellcheck disable=SC2016,SC1003
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
compose_file="$script_dir/compose.yml"
bootstrap_file="$script_dir/bootstrap.sh"
common_file="$script_dir/common.sh"
up_file="$script_dir/up.sh"
down_file="$script_dir/down.sh"
destroy_file="$script_dir/destroy.sh"
prepare_state_file="$script_dir/prepare-state.mjs"
prepare_state_test="$script_dir/prepare-state.test.mjs"
image_version_resolver_file="$script_dir/resolve-image-version.mjs"
image_version_resolver_test="$script_dir/resolve-image-version.test.mjs"
source_identity_resolver_file="$script_dir/resolve-source-identity.mjs"
source_identity_resolver_test="$script_dir/resolve-source-identity.test.mjs"
web_build_runner_file="$script_dir/run-web-build.mjs"
web_build_runner_test="$script_dir/run-web-build.test.mjs"
release_identity_verifier_file="$script_dir/verify-release-identity.mjs"
release_identity_verifier_test="$script_dir/verify-release-identity.test.mjs"
web_candidate_payload_test="$script_dir/test-web-candidate-payload.sh"
deployment_transaction_test="$script_dir/deployment-transaction.test.sh"
verify_file="$script_dir/verify.sh"
operator_log_probe_verifier_file="$script_dir/verify-operator-log-probe.mjs"
volume_initializer_file="$script_dir/initialize-volumes.sh"
asset_approval_generator_file="$script_dir/create-asset-approval.mjs"
asset_approval_rotator_file="$script_dir/rotate-asset-approval.mjs"
asset_approval_rotator_test="$script_dir/rotate-asset-approval.test.mjs"
nginx_proxy_dockerfile="$script_dir/Dockerfile.nginx-proxy"
nginx_openssl_patch_verifier="$repository_root/deploy/supply-chain/verify-nginx-openssl-patch.sh"
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

verify_nginx_openssl_patch_contract() {
  dockerfile="$1"
  require_exact_line \
    'ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979' \
    "$dockerfile" \
    "$(basename "$dockerfile") 必须固定已审核的多架构 nginxinc 基础镜像索引摘要。"
  for required_line in \
    'FROM scratch AS openssl-patches' \
    'ADD --checksum=sha256:161223a16f042b8e469e9441291e071464fd91d4f4bbe6f496ee8d0abd4e0701 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libcrypto3-3.5.8-r0.apk /x86_64/libcrypto3.apk' \
    'ADD --checksum=sha256:aca521e5ae4a321322a9d47ed64a1775f5ab1ffd215d1e9fc0433c58f7bfd037 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libssl3-3.5.8-r0.apk /x86_64/libssl3.apk' \
    'ADD --checksum=sha256:35b892813c23664a3592e4fc8c12a03538a22c579057655361c7043305272a9a https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libcrypto3-3.5.8-r0.apk /aarch64/libcrypto3.apk' \
    'ADD --checksum=sha256:d6ec970cc10e01539e41626f720c4e0ac69016eaa2079a10ef776ffd3243db5b https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libssl3-3.5.8-r0.apk /aarch64/libssl3.apk' \
    '    --mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly \' \
    '    openssl_patch_arch="$(apk --print-arch)" && \' \
    '    case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac && \' \
    '    apk add --no-network --no-cache --repositories-file /dev/null \' \
    '      "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk" && \' \
    "    apk info -e 'libcrypto3=3.5.8-r0' >/dev/null && \\" \
    "    apk info -e 'libssl3=3.5.8-r0' >/dev/null"
  do
    require_exact_line "$required_line" "$dockerfile" \
      "$(basename "$dockerfile") 缺少固定摘要、离线安装或版本证明：$required_line"
  done
  if grep -E '^[^#]*apk[[:space:]]+upgrade([[:space:]]|$)' "$dockerfile" >/dev/null; then
    printf '%s\n' "$(basename "$dockerfile") 不得执行可变 apk upgrade。" >&2
    exit 1
  fi
  test "$(grep -Fxc 'USER 0:0' "$dockerfile")" -eq 1 \
    && test "$(grep -Fxc 'USER 101:101' "$dockerfile")" -ge 1 || {
      printf '%s\n' "$(basename "$dockerfile") 必须只在离线补丁阶段临时提权并恢复 nginxinc UID 101。" >&2
      exit 1
    }
}

command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker CLI 不可用。' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 不可用。' >&2; exit 1; }
test -x "$nginx_openssl_patch_verifier" || { printf '%s\n' 'Nginx OpenSSL 补丁机器门禁缺失。' >&2; exit 1; }
test -f "$nginx_proxy_dockerfile"
"$nginx_openssl_patch_verifier" local "$script_dir/Dockerfile.web" >/dev/null
"$nginx_openssl_patch_verifier" local "$nginx_proxy_dockerfile" >/dev/null
verify_nginx_openssl_patch_contract "$script_dir/Dockerfile.web"
verify_nginx_openssl_patch_contract "$nginx_proxy_dockerfile"
require_exact_line '      LOCAL_OPERATOR_IDLE_DISCONNECT: 20m' "$compose_file" '本地 operator 缺少 20 分钟空闲断开策略。'
require_exact_line '      RGS_SESSION_IDLE_DISCONNECT_MIN: 1m' "$compose_file" '本地 RGS 缺少空闲断开下限。'
require_exact_line '      RGS_SESSION_IDLE_DISCONNECT_MAX: 24h' "$compose_file" '本地 RGS 缺少空闲断开上限。'
require_exact_line '    VITE_OPERATOR_RETURN_URL: /operator/' "$compose_file" '本地 Web Compose 缺少同源 operator 返回地址。'
require_exact_line '    VITE_OPERATOR_RETURN_URL: "/operator/",' "$web_build_runner_file" '本地 Web 构建未注入 operator 返回地址。'
require_exact_line 'if [ "${NODE_OPTIONS+x}" = x ]; then' "$bootstrap_file" \
  'bootstrap.sh 必须在任何 Docker/Node 调用前拒绝 NODE_OPTIONS。'
node_options_guard_line="$(grep -nF 'if [ "${NODE_OPTIONS+x}" = x ]; then' "$bootstrap_file" | cut -d: -f1)"
docker_requirement_line="$(grep -nF 'require_docker' "$bootstrap_file" | head -n 1 | cut -d: -f1)"
test -n "$node_options_guard_line" && test -n "$docker_requirement_line" \
  && test "$node_options_guard_line" -lt "$docker_requirement_line" || {
  printf '%s\n' 'NODE_OPTIONS 门禁必须早于 bootstrap 的第一个外部运行时调用。' >&2
  exit 1
}
if NODE_OPTIONS='' "$bootstrap_file" >/dev/null 2>&1; then
  printf '%s\n' 'bootstrap.sh 接受了显式 NODE_OPTIONS。' >&2
  exit 1
fi
for web_release_identity in \
  '    WEB_RELEASE_REQUIRE_IDENTITY: "1",' \
  '    WEB_RELEASE_REVISION: identity.revision,' \
  '    WEB_RELEASE_VERSION: identity.version,'
do
  require_exact_line "$web_release_identity" "$web_build_runner_file" \
    '隔离 Web 构建必须注入与 OCI 相同的完整发布身份。'
done
require_exact_line 'ARG VITE_OPERATOR_RETURN_URL' "$script_dir/Dockerfile.web" '本地 Web 镜像未锁定 operator 返回地址构建参数。'
require_exact_line 'RUN --network=none test "${VITE_OPERATOR_RETURN_URL}" = /operator/ && \' "$script_dir/Dockerfile.web" '本地 Web 镜像未验证 operator 返回地址。'
require_exact_line 'RUN --network=none rm -rf /usr/share/nginx/html && \' "$script_dir/Dockerfile.web" \
  '本地 Web 镜像必须整体清空上游静态根，不能遗留默认或隐藏文件。'
require_exact_line '    install -d -o 0 -g 0 -m 0755 /usr/share/nginx/html' "$script_dir/Dockerfile.web" \
  '本地 Web 镜像必须以固定属主和权限重建真实静态根。'
web_root_reset_line="$(grep -nF -x 'RUN --network=none rm -rf /usr/share/nginx/html && \' "$script_dir/Dockerfile.web" | cut -d: -f1)"
web_dist_copy_line="$(grep -nF -x 'COPY --chown=101:101 web/dist/ /usr/share/nginx/html/' "$script_dir/Dockerfile.web" | cut -d: -f1)"
test -n "$web_root_reset_line" && test -n "$web_dist_copy_line" \
  && test "$web_root_reset_line" -lt "$web_dist_copy_line" || {
    printf '%s\n' '本地 Web 镜像必须先重建空静态根，再复制发布清单约束的 dist。' >&2
    exit 1
  }
test -f "$browser_probe_file"
test -f "$browser_probe_test"
test -f "$csp_verifier_file"
test -f "$operator_log_probe_verifier_file"
test -f "$volume_initializer_file"
test -f "$asset_approval_generator_file"
test -f "$asset_approval_rotator_file"
test -f "$asset_approval_rotator_test"
test -f "$deployment_transaction_test"
test -f "$prepare_state_test"
test -f "$image_version_resolver_file"
test -f "$image_version_resolver_test"
test -f "$source_identity_resolver_file"
test -f "$source_identity_resolver_test"
test -f "$web_build_runner_file"
test -f "$web_build_runner_test"
test -f "$release_identity_verifier_file"
test -f "$release_identity_verifier_test"
test -x "$web_candidate_payload_test"
sh -n "$web_candidate_payload_test"
require_exact_line 'test-local-web-candidate-payload:' "$repository_root/Makefile" \
  'Makefile 缺少真实本机 Web 候选 payload 回归目标。'
web_candidate_payload_make_command=$(printf '\t%s' '@./deploy/local-production/test-web-candidate-payload.sh')
require_exact_line "$web_candidate_payload_make_command" "$repository_root/Makefile" \
  'Makefile 的真实本机 Web 候选 payload 回归命令发生漂移。'
for web_payload_contract_line in \
  "base_image='nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979'" \
  '  if [ "$candidate_image_tag_owned" = true ]; then' \
  '    if [ "$current_tag_id" = "$candidate_image_id" ]; then' \
  '      docker image rm "$candidate_image" >/dev/null 2>&1 || true' \
  'node "$static_verifier" "$context_root/web/dist" >/dev/null' \
  'docker cp "$base_container_id:/usr/share/nginx/html/50x.html" "$test_root/base-50x.html" >/dev/null' \
  'DOCKER_BUILDKIT=1 docker build --pull=false \' \
  '  --iidfile "$candidate_image_iidfile" \' \
  '  --tag "$candidate_image" \' \
  'tag_image_id=$(docker image inspect --format '\''{{.Id}}'\'' "$candidate_image")' \
  'candidate_image_tag_owned=true' \
  'candidate_container_id=$(docker create "$candidate_image_id")' \
  'docker cp "$candidate_container_id:/usr/share/nginx/html/." "$candidate_static_root" >/dev/null' \
  'test ! -e "$candidate_static_root/50x.html" || {' \
  'node "$static_verifier" "$candidate_static_root" >/dev/null'
do
  require_exact_line "$web_payload_contract_line" "$web_candidate_payload_test" \
    "真实本机 Web 候选 payload 回归缺少闭环步骤：$web_payload_contract_line"
done
if grep -F 'docker create "$candidate_image")' "$web_candidate_payload_test" >/dev/null \
  || grep -F 'docker image rm "$candidate_image_id"' "$web_candidate_payload_test" >/dev/null \
  || grep -E '^[[:space:]]*exit[[:space:]]+0([[:space:]]|$)' "$web_candidate_payload_test" >/dev/null; then
  printf '%s\n' '真实本机 Web 候选 payload 回归绕过不可变 ID、清理所有权或提前成功退出。' >&2
  exit 1
fi
node --check "$browser_probe_file"
node --check "$browser_verifier_file"
node --check "$operator_log_probe_verifier_file"
node --check "$asset_approval_generator_file"
node --check "$asset_approval_rotator_file"
node --check "$prepare_state_file"
node --check "$image_version_resolver_file"
node --check "$source_identity_resolver_file"
node --check "$web_build_runner_file"
node --check "$release_identity_verifier_file"
node --test "$browser_probe_test"
node --test "$asset_approval_rotator_test"
node --test "$source_identity_resolver_test"
node --test "$web_build_runner_test"
node --test "$release_identity_verifier_test"
node --test "$prepare_state_test"
node --test "$image_version_resolver_test"
sh "$deployment_transaction_test"

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
export LOCAL_PRODUCTION_IMAGE_TAG="contract-candidate"
export LOCAL_PRODUCTION_ASSET_APPROVAL_HASH="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

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
for (const serviceName of ["rgs-migrator", "rgs-server", "local-operator", "web", "ingress", "alert-proxy"]) {
  const build = document.services?.[serviceName]?.build;
  if (!build) throw new Error(`${serviceName} 缺少构建配置`);
  for (const [name, value] of Object.entries(expectedArgs)) {
    if (build.args?.[name] !== value) throw new Error(`${serviceName} is missing ${name}`);
  }
  if (document.services?.[serviceName]?.pull_policy !== "never") {
    throw new Error(`${serviceName} must never pull a candidate image from a registry`);
  }
}
for (const [serviceName, image] of Object.entries({
  "rgs-migrator": "slots-rgs-migrator:contract-candidate",
  "rgs-server": "slots-rgs-runtime:contract-candidate",
  "local-operator": "slots-local-operator:contract-candidate",
  "web": "slots-web:contract-candidate",
  "ingress": "slots-nginx-proxy:contract-candidate",
  "alert-proxy": "slots-nginx-proxy:contract-candidate",
})) {
  if (document.services?.[serviceName]?.image !== image) {
    throw new Error(`${serviceName} does not use the immutable candidate image tag`);
  }
}
if (document.services?.ingress?.build?.dockerfile !== "deploy/local-production/Dockerfile.nginx-proxy"
    || document.services?.["alert-proxy"]?.build?.dockerfile !== "deploy/local-production/Dockerfile.nginx-proxy") {
  throw new Error("入口与告警代理必须共用固定的 Nginx 候选镜像 Dockerfile");
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
  '  compose build --provenance=mode=max rgs-migrator rgs-server local-operator web ingress' \
  "$bootstrap_file" \
  'bootstrap.sh 必须使用 BuildKit mode=max 来源证明构建全部自有镜像。'
require_exact_line \
  '    /usr/bin/lockf -s -t 0 9 && lock_acquired=true' \
  "$common_file" \
  'macOS 本机部署必须使用进程退出后自动恢复的 BSD 排他锁。'
require_exact_line \
  '    /usr/bin/flock -n 9 && lock_acquired=true' \
  "$common_file" \
  'Linux 合同环境必须使用同样绑定文件描述符的排他锁。'
require_exact_line \
  'needs_initial_compose_state() {' \
  "$common_file" \
  '本地部署必须能识别首次 bootstrap 在选择器提交前中断的恢复状态。'
require_exact_line \
  'if needs_initial_compose_state; then' \
  "$bootstrap_file" \
  'bootstrap.sh 必须按非空 compose.env 而不是密钥目录存在性恢复首次提交。'
for locked_entrypoint in "$bootstrap_file" "$up_file" "$down_file" "$destroy_file"; do
  require_exact_line \
    'acquire_deployment_lock' \
    "$locked_entrypoint" \
    "$(basename "$locked_entrypoint") 必须取得共享部署锁。"
done
require_exact_line \
  'verify_state_definition_binding' \
  "$up_file" \
  'up.sh 必须在启动前核对签名定义与原子 Compose 状态。'
grep -F 'LOCAL_PRODUCTION_ASSET_APPROVAL_HASH' "$common_file" >/dev/null || {
  printf '%s\n' 'up.sh 的代际绑定必须覆盖已提交资源审批摘要。' >&2
  exit 1
}
test "$(grep -Fxc '    image: slots-local-operator:${LOCAL_PRODUCTION_IMAGE_TAG:-local-production}' "$compose_file")" -eq 3 || {
  printf '%s\n' '全部本机 operator 服务必须选择同一不可变候选镜像 tag。' >&2
  exit 1
}
for image_line in \
  '    image: slots-rgs-migrator:${LOCAL_PRODUCTION_IMAGE_TAG:-local-production}' \
  '    image: slots-rgs-runtime:${LOCAL_PRODUCTION_IMAGE_TAG:-local-production}' \
  '    image: slots-web:${LOCAL_PRODUCTION_IMAGE_TAG:-local-production}'
do
  require_exact_line "$image_line" "$compose_file" '自有镜像必须通过已提交的候选 tag 选择。'
done
test "$(grep -Fxc '    image: slots-nginx-proxy:${LOCAL_PRODUCTION_IMAGE_TAG:-local-production}' "$compose_file")" -eq 2 || {
  printf '%s\n' '入口与告警代理必须绑定同一不可变 Nginx 候选镜像 tag。' >&2
  exit 1
}
require_exact_line \
  '      test: [CMD, env, SSL_CERT_FILE=/run/ingress-secrets/local-production-root-ca.pem, wget, -q, -T, "3", -O, /dev/null, https://slots.localhost:8443/healthz]' \
  "$compose_file" \
  'HTTPS 入口必须保留使用固定 CA 与主机名校验的 wget TLS 健康探针。'
require_exact_line \
  '      test: [CMD, env, SSL_CERT_FILE=/run/alert-secrets/local-production-root-ca.pem, wget, -q, -T, "3", -O, /dev/null, https://127.0.0.1:8443/healthz]' \
  "$compose_file" \
  '告警代理必须保留使用固定 CA 的 wget TLS 健康探针。'
test "$(grep -Fxc '    pull_policy: never' "$compose_file")" -eq 8 || {
  printf '%s\n' '全部自有镜像必须禁用候选 tag 的远端拉取。' >&2
  exit 1
}
require_exact_line \
  '  "slots-nginx-proxy:$candidate_image_tag"' \
  "$bootstrap_file" \
  'bootstrap.sh 必须在提交前检查共用 Nginx 候选镜像确实存在。'
for metadata_verification in \
  'verify_image_metadata "slots-rgs-runtime:$image_tag" slots-rgs-runtime' \
  'verify_image_metadata "slots-rgs-migrator:$image_tag" slots-rgs-migrator' \
  'verify_image_metadata "slots-local-operator:$image_tag" slots-local-operator' \
  'verify_image_metadata "slots-web:$image_tag" slots-web' \
  'verify_image_metadata "slots-nginx-proxy:$image_tag" slots-nginx-proxy'
do
  require_exact_line "$metadata_verification" "$verify_file" \
    '动态验收必须按 compose.env 的同一候选 tag 核对全部自有镜像来源元数据。'
done
if grep -E '^verify_image_metadata slots-[^:]+:local-production' "$verify_file" >/dev/null; then
  printf '%s\n' '动态验收不得退回与已提交候选选择器无关的固定镜像 tag。' >&2
  exit 1
fi
for repository_version_control in \
  'import { verifyReleaseVersion } from "../supply-chain/verify-release-version.mjs";' \
  '  const repositoryVersion = verifyReleaseVersion(projectRoot);'
do
  require_exact_line "$repository_version_control" "$image_version_resolver_file" \
    '本机镜像版本解析器必须复用仓库 canonical 版本合同。'
done
if grep -F 'LOCAL_PRODUCTION_IMAGE_VERSION:-local-production' "$bootstrap_file" >/dev/null; then
  printf '%s\n' 'bootstrap.sh 不得把部署 profile 误用作 OCI 发布版本。' >&2
  exit 1
fi
require_exact_line \
  'image_version="$(node "$local_production_directory/resolve-image-version.mjs" "$repository_root")"' \
  "$bootstrap_file" \
  'bootstrap.sh 必须通过已测试解析器取得唯一 canonical OCI version。'
test "$(grep -Ec '(^|[[:space:]])image_version=' "$bootstrap_file")" -eq 1 || {
  printf '%s\n' 'bootstrap.sh 必须且只能赋值一次 canonical image_version。' >&2
  exit 1
}
version_contract_line="$(grep -nF 'image_version="$(node "$local_production_directory/resolve-image-version.mjs" "$repository_root")"' "$bootstrap_file" | cut -d: -f1)"
revision_contract_line="$(grep -nF 'image_revision="$(node "$local_production_directory/resolve-source-identity.mjs" "$repository_root")"' "$bootstrap_file" | cut -d: -f1)"
state_creation_line="$(grep -nF 'mkdir -p "$state_root" "$state_root/backups" "$state_root/artifacts" "$state_root/rendered"' "$bootstrap_file" | cut -d: -f1)"
web_build_line="$(grep -nF 'node "$local_production_directory/run-web-build.mjs" \' "$bootstrap_file" | cut -d: -f1)"
test -n "$version_contract_line" && test -n "$revision_contract_line" \
  && test -n "$state_creation_line" && test -n "$web_build_line" \
  && test "$version_contract_line" -lt "$state_creation_line" \
  && test "$revision_contract_line" -lt "$state_creation_line" \
  && test "$revision_contract_line" -lt "$web_build_line" || {
  printf '%s\n' 'bootstrap.sh 必须在修改状态或构建 Web 前固定 canonical 版本与 revision。' >&2
  exit 1
}
require_exact_line \
  'image_revision="$(node "$local_production_directory/resolve-source-identity.mjs" "$repository_root")"' \
  "$bootstrap_file" \
  'bootstrap.sh 必须通过已测试解析器取得唯一 canonical revision。'
test "$(grep -Fxc 'verify_source_identity' "$bootstrap_file")" -eq 5 || {
  printf '%s\n' 'bootstrap.sh 必须在 Web、Compose、不可逆提交和最终选择器边界复核源码身份。' >&2
  exit 1
}
for source_identity_contract in \
  '    ["rev-parse", "--verify", "HEAD^{commit}"],' \
  '    ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."],' \
  '      ":(exclude)web/release-nginx.conf",' \
  '      && environment[REVISION_OVERRIDE] !== firstHead.revision) {' \
  '  if (status !== "") fail("project worktree must be clean");' \
  '    name.slice(0, 4).toLowerCase() === ".env"'
do
  require_exact_line "$source_identity_contract" "$source_identity_resolver_file" \
    '源码身份解析器缺少 HEAD、clean、override 或 .env* 失败关闭合同。'
done
require_exact_line \
  '  if (entries.some((entry) => entry.name.toLowerCase() === ".npmrc")) {' \
  "$source_identity_resolver_file" \
  '本机 Web 构建必须拒绝隐式 npm project 配置。'
require_exact_line \
  '  assertNoIgnoredBuildInputs(resolvedProjectRoot, runner);' \
  "$source_identity_resolver_file" \
  '每个源码身份 checkpoint 都必须拒绝 ignored Docker/Vite 构建输入。'
test "$(grep -Fc 'assertNoIgnoredBuildInputs(resolvedProjectRoot, gitRunner);' \
    "$web_build_runner_file")" -eq 3 || {
  printf '%s\n' '隔离 Web 构建必须在安装前、安装后和构建后复核 ignored 构建输入。' >&2
  exit 1
}
if grep -F '|| true' "$source_identity_resolver_file" >/dev/null \
  || grep -F 'process.env,' "$web_build_runner_file" >/dev/null \
  || grep -F '...process.env' "$web_build_runner_file" >/dev/null; then
  printf '%s\n' '源码身份和 Web 构建不得吞掉 Git 失败或继承未审核环境。' >&2
  exit 1
fi
for isolated_npm_configuration_contract in \
  '  const directory = mkdtempSync(resolve(tmpdir(), "slots-local-production-npm-"));' \
  '      writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });' \
  '      `--userconfig=${configuration.userConfig}`,' \
  '      `--globalconfig=${configuration.globalConfig}`,' \
  '    if (!removeTemporaryNpmConfigurations(configuration, true)) {'
do
  require_exact_line "$isolated_npm_configuration_contract" "$web_build_runner_file" \
    '隔离 Web 构建必须使用两个进程内创建的空 0600 npm 配置并在 finally 清理。'
done
if grep -F -- '--userconfig=/dev/null' "$web_build_runner_file" >/dev/null \
  || grep -F -- '--globalconfig=/dev/null' "$web_build_runner_file" >/dev/null \
  || grep -F 'nodeRoot, "etc", "npmrc"' "$web_build_runner_file" >/dev/null; then
  printf '%s\n' '隔离 Web 构建不得读取可变的用户或 Node 安装目录 npm 配置。' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*(NODE_OPTIONS|VITE_UNREVIEWED|npm_config_registry):' \
    "$web_build_runner_file"; then
  printf '%s\n' '隔离 Web 构建源码不得加入未批准的构建环境。' >&2
  exit 1
fi
require_exact_line \
      '      { requireRevision: true },' \
  "$asset_approval_rotator_file" \
  '本机资源审批必须拒绝缺少完整 revision 的发布清单。'
if ! grep -F 'const expected=`slots-nginx-proxy:${process.argv[1]}`;' "$bootstrap_file" >/dev/null \
  || ! grep -F 'for (const serviceName of ["ingress", "alert-proxy"]) {' "$bootstrap_file" >/dev/null; then
  printf '%s\n' 'bootstrap.sh 必须在构建前证明入口与告警代理绑定同一候选 tag。' >&2
  exit 1
fi
test "$(tr -d '\r\n' <"$script_dir/Dockerfile.nginx-proxy.dockerignore")" = '*' || {
  printf '%s\n' '共用 Nginx 代理构建不得发送仓库内容作为上下文。' >&2
  exit 1
}
grep -F 'go run ./cmd/local-production-bootstrap add-shared-admission "$secrets_root"' "$bootstrap_file" >/dev/null || {
  printf '%s\n' 'bootstrap.sh 必须幂等补齐旧本地状态的 Valkey 专用材料。' >&2
  exit 1
}
grep -F 'go run ./cmd/local-production-bootstrap definition-rotation-status "$secrets_root"' "$bootstrap_file" >/dev/null || {
	printf '%s\n' 'bootstrap.sh 必须先验证当前与目标定义身份。' >&2
	exit 1
}
grep -F '"$local_production_directory/verify-definition-drain.sh" \' "$bootstrap_file" >/dev/null || {
		printf '%s\n' 'bootstrap.sh 必须在定义轮换前执行数据库排空门禁。' >&2
		exit 1
}
grep -F 'go run ./cmd/local-production-bootstrap rotate-definition "$secrets_root" "$state_root/backups"' "$bootstrap_file" >/dev/null || {
	printf '%s\n' 'bootstrap.sh 必须安全轮换已变更的本机签名游戏定义。' >&2
	exit 1
}
test -x "$script_dir/verify-definition-drain.sh" || {
	printf '%s\n' '本机定义排空门禁必须可执行。' >&2
	exit 1
}
require_exact_line \
  'node "$local_production_directory/rotate-asset-approval.mjs" \' \
  "$bootstrap_file" \
  'bootstrap.sh 必须显式提交先前验证的本机资源审批候选。'
require_exact_line \
  'asset_prepare_status="$(node "$local_production_directory/rotate-asset-approval.mjs" \' \
  "$bootstrap_file" \
  'bootstrap.sh 必须在定义提交前准备隔离的资源审批候选。'
require_exact_line \
  'release_static_root="$repository_root/web/dist"' \
  "$bootstrap_file" \
  'bootstrap.sh 必须只固定一次宿主静态根路径。'
require_exact_line \
  'release_manifest_path="$release_static_root/release-manifest.json"' \
  "$bootstrap_file" \
  'bootstrap.sh 必须从已验证静态根取得审批清单。'
test "$(grep -Fxc '  "$release_manifest_path" \' "$bootstrap_file")" -eq 2 || {
  printf '%s\n' '资源审批准备与提交必须绑定同一当前发布清单。' >&2
  exit 1
}
test "$(grep -Fxc '  "$secrets_root/release-asset-approval.json" \' "$bootstrap_file")" -eq 2 || {
  printf '%s\n' '资源审批准备与提交必须绑定同一已提交审批。' >&2
  exit 1
}
require_exact_line \
  '  "$state_root/backups" \' \
  "$bootstrap_file" \
  '本机资源审批轮换必须保留可恢复备份。'
for release_identity_binding in \
  'test "$#" -eq 6 && test "$1" = prepared || {' \
  'prepared_asset_release_id="$6"' \
  'test "$prepared_asset_release_id" = "$asset_release_id" || {' \
  '  "$prepared_asset_release_id"'
do
  require_exact_line "$release_identity_binding" "$bootstrap_file" \
    'bootstrap.sh 必须严格解析、核对并传递 prepare 的 canonical releaseId。'
done
require_exact_line 'verify_host_release_payload() {' "$bootstrap_file" \
  'bootstrap.sh 必须复用宿主静态 payload 逐文件校验。'
test "$(grep -Fxc 'verify_host_release_payload' "$bootstrap_file")" -eq 4 || {
  printf '%s\n' 'bootstrap.sh 必须在 prepare、Compose、不可逆提交和最终选择器前复核完整 Web payload。' >&2
  exit 1
}
for rotation_identity_contract in \
  '      { requireRevision: true },' \
  '    releaseId: manifest.releaseId,' \
  '  if (releaseId !== expectedReleaseId) {' \
  '    fail("release manifest identity changed after candidate validation");'
do
  require_exact_line "$rotation_identity_contract" "$asset_approval_rotator_file" \
    '资源审批 prepare/commit 缺少完整 revision 或 canonical releaseId 事务绑定。'
done
require_exact_line \
  '  const verified = verifyReleaseManifest(manifest, { requireRevision: true });' \
  "$release_identity_verifier_file" \
  '发布身份校验器必须拒绝匿名 revision。'
require_exact_line \
  '  if (verified.version !== expectedVersion || verified.revision !== expectedRevision) {' \
  "$release_identity_verifier_file" \
  '发布身份校验器必须精确比较 version 与 revision。'
require_exact_line \
  '  const manifest = await verifyWebStaticRoot(staticRoot);' \
  "$release_identity_verifier_file" \
  '发布身份校验器必须逐文件验证静态 payload。'
grep -F 'candidate_web_image_id="$(docker image inspect --format '\''{{.Id}}'\'' "slots-web:$candidate_image_tag")"' \
    "$bootstrap_file" >/dev/null \
  && grep -F 'docker cp "$candidate_web_container_id:/usr/share/nginx/html/." "$candidate_web_static_root"' \
    "$bootstrap_file" >/dev/null \
  && grep -F '  "$candidate_web_static_root" \' "$bootstrap_file" >/dev/null \
  && grep -F 'docker cp "$candidate_web_container_id:/etc/nginx/conf.d/default.conf" \' \
    "$bootstrap_file" >/dev/null \
  && grep -F 'cmp "$candidate_web_extract_root/expected-release-nginx.conf" \' \
    "$bootstrap_file" >/dev/null || {
  printf '%s\n' 'bootstrap.sh 必须按不可变 image ID 提取并逐文件验证候选 Web payload。' >&2
  exit 1
}
for candidate_web_signal_trap in \
  "trap 'handle_candidate_web_signal 129' HUP" \
  "trap 'handle_candidate_web_signal 130' INT" \
  "trap 'handle_candidate_web_signal 143' TERM"
do
  require_exact_line "$candidate_web_signal_trap" "$bootstrap_file" \
    '候选 Web 提取收到终止信号后必须清理并以对应状态退出。'
done
require_exact_line '  trap - EXIT HUP INT TERM' "$bootstrap_file" \
  '候选 Web 信号处理必须在退出前解除重复清理 trap。'
asset_prepare_line="$(grep -nF 'asset_prepare_status="$(node "$local_production_directory/rotate-asset-approval.mjs" \' "$bootstrap_file" | cut -d: -f1)"
build_line="$(grep -nF 'compose build --provenance=mode=max rgs-migrator rgs-server local-operator web ingress' "$bootstrap_file" | cut -d: -f1)"
status_line="$(grep -nF 'go run ./cmd/local-production-bootstrap definition-rotation-status "$secrets_root"' "$bootstrap_file" | cut -d: -f1)"
asset_commit_line="$(grep -nF '  commit \' "$bootstrap_file" | cut -d: -f1)"
definition_commit_line="$(grep -nF 'go run ./cmd/local-production-bootstrap rotate-definition "$secrets_root" "$state_root/backups"' "$bootstrap_file" | cut -d: -f1)"
final_state_line="$(grep -nF 'node "$local_production_directory/prepare-state.mjs" "$state_root"' "$bootstrap_file" | tail -n 1 | cut -d: -f1)"
if [ -z "$asset_prepare_line" ] || [ -z "$build_line" ] || [ -z "$status_line" ] || \
   [ -z "$asset_commit_line" ] || \
   [ -z "$definition_commit_line" ] || [ -z "$final_state_line" ] || \
   [ "$asset_prepare_line" -ge "$build_line" ] || [ "$build_line" -ge "$status_line" ] || \
   [ "$status_line" -ge "$definition_commit_line" ] || \
   [ "$definition_commit_line" -ge "$asset_commit_line" ] || \
   [ "$asset_commit_line" -ge "$final_state_line" ]; then
  printf '%s\n' 'bootstrap.sh 必须按审批候选、镜像构建、排空、定义、审批、原子状态顺序提交。' >&2
  exit 1
fi
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
require_exact_line \
  'release_manifest_verifier="$repository_root/web/scripts/release-manifest.mjs"' \
  "$verify_file" \
  '本机动态验收必须复用发布清单语义校验器。'
require_exact_line \
  'const manifest=verifyReleaseManifest(JSON.parse(readFileSync(0, "utf8")), { requireRevision: true });' \
  "$verify_file" \
  '本机动态验收必须拒绝缺少完整 revision 的线上发布清单。'
require_exact_line \
  'if (manifest.version !== process.argv[2] || manifest.revision !== process.argv[3]) {' \
  "$verify_file" \
  '本机动态验收必须精确比较清单与 OCI/Compose 的版本和 revision。'
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
  delivery_section=$(sed -n '/^delivery_ready=0$/,/^test "$delivery_ready" = 1 || {$/p' "$candidate")
  counter_section=$(sed -n '/^counter_ready=0$/,/^test "$counter_ready" = 1 || {$/p' "$candidate")
  test "$(grep -Fxc 'vector_sink_baseline=$(read_vector_sink_counter)' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'operator_log_bytes_baseline=$(read_operator_log_bytes)' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '  operator_log_bytes_current=$(read_operator_log_bytes)' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'process.exit(Number.isFinite(current) && Number.isFinite(baseline) && current > baseline ? 0 : 1);' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '  if test "$operator_log_bytes_current" -gt "$operator_log_bytes_baseline" \' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '      && verify_operator_log_probe "$log_probe_digest"; then' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '    node "$local_production_directory/verify-operator-log-probe.mjs" "$expected_digest"' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'const {randomBytes}=require("node:crypto");' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'process.stdout.write(`vectorverify${randomBytes(18).toString("hex")}`);' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '  --header "X-Operator-Id: $operator_id" \' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'process.stdout.write(createHash("sha256").update(process.argv[1], "utf8").digest("hex"));' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'while [ "$delivery_attempt" -le 5 ]; do' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '  if [ "$delivery_attempt" -le 5 ]; then' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'while [ "$counter_attempt" -le 7 ]; do' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc '  if [ "$counter_attempt" -le 7 ]; then' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'test "$delivery_ready" = 1 || {' "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc "printf '%s\\n' 'Vector 单业务探针已在 25 秒内完成文件增长与精确脱敏落盘。'" "$candidate")" -eq 1 || return 1
  test "$(grep -Fxc 'test "$counter_ready" = 1 || {' "$candidate")" -eq 1 || return 1
  test "$(grep -Fc 'https://rgs.localhost:8443/operator/v1/launches' "$candidate")" -eq 1 || return 1
  case "$delivery_section" in
    *vector_sink*) return 1 ;;
  esac
  case "$counter_section" in
    *operator_log*|*log_probe_digest*) return 1 ;;
  esac
}

if ! verify_log_delivery_contract "$verify_file"; then
  printf '%s\n' '本机动态验收必须把 25 秒精确落盘与独立 sent counter 新鲜度观测解耦。' >&2
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

timeout_mutation="$temporary_root/verify-log-timeout-mutation.sh"
cp "$verify_file" "$timeout_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const changed=source.replaceAll(`"$delivery_attempt" -le 5`, `"$delivery_attempt" -le 18`);
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$timeout_mutation"
if verify_log_delivery_contract "$timeout_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了把单业务日志交付上限从 25 秒放宽回 90 秒的回归。' >&2
  exit 1
fi

coupled_counter_mutation="$temporary_root/verify-log-coupled-counter-mutation.sh"
cp "$verify_file" "$coupled_counter_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const marker="  operator_log_bytes_current=$(read_operator_log_bytes)";
const changed=source.replace(marker, "  read_vector_sink_counter >/dev/null\n" + marker);
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$coupled_counter_mutation"
if verify_log_delivery_contract "$coupled_counter_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了把 Prometheus counter 重新耦合到 25 秒交付判定的回归。' >&2
  exit 1
fi

short_counter_window_mutation="$temporary_root/verify-log-short-counter-window-mutation.sh"
cp "$verify_file" "$short_counter_window_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const changed=source.replace(`while [ "$counter_attempt" -le 7 ]; do`, `while [ "$counter_attempt" -le 2 ]; do`);
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$short_counter_window_mutation"
if verify_log_delivery_contract "$short_counter_window_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了不足一个完整 scrape 余量的 counter 观测窗口。' >&2
  exit 1
fi

second_business_probe_mutation="$temporary_root/verify-second-business-log-probe-mutation.sh"
cp "$verify_file" "$second_business_probe_mutation"
node -e '
const fs=require("node:fs"); const path=process.argv[1]; const source=fs.readFileSync(path,"utf8");
const marker="test \"$log_probe_status\" = 401 || {";
const duplicate=`curl --silent --show-error --output /dev/null --cacert "$ca_file" \\\n+  --resolve rgs.localhost:8443:127.0.0.1 --data '{}' \\\n+  https://rgs.localhost:8443/operator/v1/launches\n`;
const changed=source.replace(marker, duplicate + marker);
if(changed===source) process.exit(1); fs.writeFileSync(path,changed);
' "$second_business_probe_mutation"
if verify_log_delivery_contract "$second_business_probe_mutation"; then
  printf '%s\n' '本机动态验收负向门禁接受了用第二个业务请求唤醒 Vector 磁盘缓冲的假绿回归。' >&2
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

for dockerfile in "$script_dir/Dockerfile.services" "$script_dir/Dockerfile.web" "$nginx_proxy_dockerfile"; do
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
