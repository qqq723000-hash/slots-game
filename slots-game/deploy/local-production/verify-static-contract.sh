#!/bin/sh
# 在启动容器前验证本机生产 Compose、镜像元数据、HSTS 与 Grafana 离线约束。
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
compose_file="$script_dir/compose.yml"
bootstrap_file="$script_dir/bootstrap.sh"
up_file="$script_dir/up.sh"

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
NODE

if grep -Eq '^[[:space:]]*provenance:' "$compose_file"; then
  printf '%s\n' 'Compose 配置不得声明不兼容的 build.provenance 字段。' >&2
  exit 1
fi
require_exact_line \
  'compose build --provenance=mode=max rgs-migrator rgs-server local-operator web' \
  "$bootstrap_file" \
  'bootstrap.sh 必须使用 BuildKit mode=max 来源证明构建全部自有镜像。'
require_exact_line \
  'compose build --provenance=mode=max rgs-migrator rgs-server local-operator web' \
  "$up_file" \
  'up.sh 必须使用 BuildKit mode=max 来源证明构建全部自有镜像。'
require_exact_line \
  'compose up -d --no-build --force-recreate' \
  "$up_file" \
  'up.sh 必须禁止启动阶段隐式重建镜像。'
if [ "$(grep -Ec '^[[:space:]]*compose build([[:space:]]|$)' "$bootstrap_file")" -ne 1 ]; then
  printf '%s\n' 'bootstrap.sh 只能执行一次受约束的镜像构建。' >&2
  exit 1
fi
if [ "$(grep -Ec '^[[:space:]]*compose build([[:space:]]|$)' "$up_file")" -ne 1 ]; then
  printf '%s\n' 'up.sh 只能执行一次受约束的镜像构建。' >&2
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

for dockerfile in "$script_dir/Dockerfile.services" "$script_dir/Dockerfile.web"; do
  for label in \
    org.opencontainers.image.created \
    org.opencontainers.image.revision \
    org.opencontainers.image.source \
    org.opencontainers.image.version \
    com.slots-game.deployment.profile; do
    grep -F "$label=" "$dockerfile" >/dev/null || {
      printf '%s\n' "$dockerfile 缺少 $label。" >&2
      exit 1
    }
  done
done

test "$(grep -Fc 'add_header Strict-Transport-Security "max-age=31536000" always;' "$script_dir/ingress-nginx.conf")" = 1 || {
  printf '%s\n' 'HTTPS 入口必须统一且仅声明一次 HSTS。' >&2
  exit 1
}

node "$script_dir/render-observability.mjs" "$temporary_root/rendered" >/dev/null
for directory in \
  "$temporary_root/rendered/grafana/provisioning/alerting" \
  "$temporary_root/rendered/grafana/provisioning/plugins"; do
  test -d "$directory" || { printf '%s\n' "$directory 未生成。" >&2; exit 1; }
done

"$script_dir/test-operations-contract.sh"

printf '%s\n' '本机生产静态契约验收通过。'
