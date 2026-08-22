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
node_root="${HOME}/.local/opt/node-v22.22.0"

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
  test "$(stat -f '%Lp' "$state_root")" = 700 || { printf '%s\n' '状态目录权限必须是 0700。' >&2; exit 1; }
}

compose() {
  docker compose --env-file "$compose_environment" -f "$compose_file" "$@"
}
