#!/bin/sh
# 在无网络、无宿主机端口的临时 PostgreSQL 中恢复最新备份集。
set -eu
# shellcheck source=deploy/local-production/common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"
require_docker
require_state

backup_directory="$state_root/backups"
test -d "$backup_directory"
manifest=''
attempt=0
while [ "$attempt" -lt 30 ]; do
  manifest="$(find "$backup_directory" -type f -name 'backup-set-*.sha256' -print | LC_ALL=C sort | tail -n 1)"
  test -n "$manifest" && break
  attempt=$((attempt + 1))
  sleep 2
done
test -n "$manifest" || { printf '%s\n' '未找到已完成的备份集。' >&2; exit 1; }

manifest_name="${manifest##*/}"
timestamp="${manifest_name#backup-set-}"
timestamp="${timestamp%.sha256}"
case "$timestamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) printf '%s\n' '备份时间标记不合法。' >&2; exit 1 ;;
esac

rgs_dump="$backup_directory/rgs-${timestamp}.dump"
operator_dump="$backup_directory/local_operator-${timestamp}.dump"
operator_archive="$backup_directory/operator-files-${timestamp}.tar.gz"
test -s "$rgs_dump" && test -s "$operator_dump" && test -s "$operator_archive"
(
  cd "$backup_directory"
  sha256sum -c "$manifest_name" >/dev/null
)

# 拒绝可越界解压的路径，并确认审计、日志和告警三个目录都在归档内。
archive_list="$(tar -tzf "$operator_archive")"
printf '%s\n' "$archive_list" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { exit 1 }
  END { if (NR == 0) exit 1 }
'
printf '%s\n' "$archive_list" | grep -Eq '^audit(/|$)'
printf '%s\n' "$archive_list" | grep -Eq '^logs(/|$)'
printf '%s\n' "$archive_list" | grep -Eq '^alerts(/|$)'

suffix="$(date -u +%s)-$$"
container_name="slots-backup-verify-$suffix"
case "$container_name" in
  slots-backup-verify-[0-9]*-[0-9]*) ;;
  *) printf '%s\n' '临时容器名不合法。' >&2; exit 1 ;;
esac

cleanup_restore_container() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup_restore_container EXIT HUP INT TERM

docker run -d --name "$container_name" \
  --label com.slots-game.purpose=backup-restore-verification \
  --network none --pull never \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$backup_directory:/backups:ro" \
  postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 \
  >/dev/null

attempt=0
until docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30 || { printf '%s\n' '备份恢复验证库未就绪。' >&2; exit 1; }
  sleep 1
done

docker exec "$container_name" createdb -U postgres restored_rgs
docker exec "$container_name" createdb -U postgres restored_local_operator
docker exec "$container_name" pg_restore -U postgres --exit-on-error --no-owner --no-privileges \
  --dbname restored_rgs "/backups/rgs-${timestamp}.dump"
docker exec "$container_name" pg_restore -U postgres --exit-on-error --no-owner --no-privileges \
  --dbname restored_local_operator "/backups/local_operator-${timestamp}.dump"
test "$(docker exec "$container_name" psql -U postgres -d restored_rgs -Atqc \
  "SELECT to_regclass('public.rgs_sessions') IS NOT NULL")" = t
test "$(docker exec "$container_name" psql -U postgres -d restored_local_operator -Atqc \
  "SELECT to_regclass('public.local_operator_accounts') IS NOT NULL")" = t

cleanup_restore_container
trap - EXIT HUP INT TERM
printf '%s\n' "备份集 $timestamp 已通过双库恢复与外部文件归档验证。"
