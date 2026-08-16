#!/bin/sh
# 立即生成一组完整备份，随后在隔离数据库中做真实恢复验证。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_state

backup_container="$(compose ps -q backup)"
test -n "$backup_container" || { printf '%s\n' '备份服务未运行。' >&2; exit 1; }
test "$(docker inspect -f '{{.State.Status}}' "$backup_container")" = running || {
  printf '%s\n' '备份服务未运行。' >&2
  exit 1
}
compose exec -T backup /local/postgres-backup-once.sh
"$local_production_directory/verify-backups.sh"
