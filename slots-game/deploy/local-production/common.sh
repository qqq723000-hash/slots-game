#!/bin/sh
# 本机集成验收脚本的共用路径、版本与 Compose 入口。
# shellcheck disable=SC2034
set -eu

local_production_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH='' cd -- "$local_production_directory/../.." && pwd)"
state_root="${LOCAL_PRODUCTION_STATE_ROOT:-${HOME}/.local/share/slots-game-production}"
secrets_root="$state_root/secrets"
compose_file="$local_production_directory/compose.yml"
compose_environment="$secrets_root/compose.env"
deployment_lock_file="$state_root/deployment.lock"
node_root="${HOME}/.local/opt/node-v22.22.0"

permission_mode() {
  if mode="$(stat -f '%Lp' "$1" 2>/dev/null)"; then
    :
  elif mode="$(stat -c '%a' -- "$1" 2>/dev/null)"; then
    :
  else
    printf '%s\n' '无法读取本机部署文件权限。' >&2
    exit 1
  fi
  case "$mode" in
    ''|*[!0-9]*)
      printf '%s\n' '本机部署文件权限格式无效。' >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$mode"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker CLI 不可用。' >&2; exit 1; }
  docker info >/dev/null 2>&1 || { printf '%s\n' '请先启动 Docker Desktop。' >&2; exit 1; }
}

require_node22() {
  test -x "$node_root/bin/node" || { printf '%s\n' '缺少已审核的 Node.js 22.22.0。' >&2; exit 1; }
  test "$("${node_root}/bin/node" --version)" = v22.22.0 || { printf '%s\n' 'Node.js 版本不符合 v22.22.0。' >&2; exit 1; }
  PATH="$node_root/bin:$PATH"
  export PATH
}

require_state() {
  test -s "$compose_environment" || { printf '%s\n' '请先执行 bootstrap.sh。' >&2; exit 1; }
  test "$(permission_mode "$state_root")" = 700 || { printf '%s\n' '状态目录权限必须是 0700。' >&2; exit 1; }
}

# 密钥创建成功不代表首次 bootstrap 已提交：npm/build/审批等后续阶段仍可能中断。
# 只有非空 compose.env 才是可启动镜像选择器；缺失或空文件都必须走首次选择器恢复路径。
needs_initial_compose_state() {
  test ! -s "$compose_environment"
}

# bootstrap/up/down/destroy 必须共用同一个内核级排他锁。锁文件本身会保留以保证
# macOS 使用 BSD lockf，Linux 合同环境使用 util-linux flock；进程退出或被终止时，
# 内核自动释放锁，不依赖清理一个可能已陈旧的 PID 文件。文件描述符由子脚本继承，
# 因此 bootstrap 的 drain 检查与定义提交始终处在同一个不可分割的部署窗口内。
acquire_deployment_lock() {
  test -d "$state_root" && test ! -L "$state_root" || {
    printf '%s\n' '状态目录必须是可验证的真实目录，无法建立部署锁。' >&2
    exit 1
  }
  test "$(permission_mode "$state_root")" = 700 || {
    printf '%s\n' '状态目录权限必须是 0700，无法建立部署锁。' >&2
    exit 1
  }
  umask 077
  : >>"$deployment_lock_file"
  test -f "$deployment_lock_file" && test ! -L "$deployment_lock_file" || {
    printf '%s\n' '部署锁必须是受限普通文件。' >&2
    exit 1
  }
  chmod 0600 "$deployment_lock_file"
  exec 9>>"$deployment_lock_file"
  lock_acquired=false
  if command -v /usr/bin/lockf >/dev/null 2>&1; then
    /usr/bin/lockf -s -t 0 9 && lock_acquired=true
  elif command -v /usr/bin/flock >/dev/null 2>&1; then
    /usr/bin/flock -n 9 && lock_acquired=true
  else
    exec 9>&-
    printf '%s\n' '系统缺少 /usr/bin/lockf 或 /usr/bin/flock，无法建立本机部署排他锁。' >&2
    exit 1
  fi
  if [ "$lock_acquired" != true ]; then
    exec 9>&-
    printf '%s\n' '另一个 bootstrap/up/down/destroy 正在操作本机部署，请等待其完成。' >&2
    exit 1
  fi
}

verify_state_definition_binding() {
  node - \
    "$secrets_root/definition-approval.json" \
    "$secrets_root/release-asset-approval.json" \
    "$compose_environment" <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");

function restricted(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
      || info.size <= 0 || info.size > 8 * 1024 * 1024) {
    throw new Error(`${label} must be a restricted regular file`);
  }
  return readFileSync(path, "utf8");
}

const approval = JSON.parse(restricted(process.argv[2], "definition approval"));
const identity = approval?.approval;
if (approval?.schema !== "rgs-definition-approval-v2"
    || typeof identity?.gameId !== "string"
    || typeof identity?.version !== "string"
    || !/^[a-f0-9]{64}$/u.test(identity?.sha256 ?? "")) {
  throw new Error("definition approval identity is invalid");
}
const entries = new Map();
for (const line of restricted(process.argv[4], "compose state").split("\n")) {
  if (line === "") continue;
  const separator = line.indexOf("=");
  if (separator <= 0) throw new Error("compose state contains an invalid line");
  const name = line.slice(0, separator);
  if (entries.has(name)) throw new Error("compose state contains a duplicate field");
  entries.set(name, line.slice(separator + 1));
}
for (const [name, expected] of [
  ["LOCAL_PRODUCTION_GAME_ID", identity.gameId],
  ["LOCAL_PRODUCTION_DEFINITION_VERSION", identity.version],
  ["LOCAL_PRODUCTION_DEFINITION_HASH", identity.sha256],
]) {
  if (entries.get(name) !== expected) {
    throw new Error("compose state does not match the committed definition; rerun bootstrap.sh");
  }
}
const assetApprovalHash = createHash("sha256")
  .update(restricted(process.argv[3], "release asset approval"), "utf8")
  .digest("hex");
if (entries.get("LOCAL_PRODUCTION_ASSET_APPROVAL_HASH") !== assetApprovalHash) {
  throw new Error("compose state does not match the committed release asset approval; rerun bootstrap.sh");
}
const imageTag = entries.get("LOCAL_PRODUCTION_IMAGE_TAG");
if (typeof imageTag !== "string"
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(imageTag)) {
  throw new Error("compose state image tag is invalid");
}
NODE
}

compose() {
  docker compose --env-file "$compose_environment" -f "$compose_file" "$@"
}
