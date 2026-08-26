#!/bin/sh
# 删除本 Compose 的容器和卷；宿主机 state/备份/初始密钥始终保留。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_state
acquire_deployment_lock
test "${1:-}" = --confirm || { printf '%s\n' '用法: destroy.sh --confirm slots-game-production' >&2; exit 2; }
test "${2:-}" = slots-game-production || { printf '%s\n' '项目名不匹配，拒绝删除。' >&2; exit 2; }
project_name="$(compose config --format json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
test "$project_name" = slots-game-production || { printf '%s\n' 'Compose 项目身份校验失败。' >&2; exit 1; }
compose down --volumes --remove-orphans
printf '%s\n' '已删除 slots-game-production 容器和卷；宿主机 state 仍可恢复。'
