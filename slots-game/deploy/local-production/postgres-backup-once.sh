#!/bin/sh
# 对两个业务库和外部审计/日志文件生成同一时间标记的原子归档。
set -eu
umask 077

# 同一时刻只允许一个周期任务或手工任务写入备份集。
exec 9>/backups/.backup.lock
flock -n 9 || {
  printf '%s\n' '另一个备份任务正在运行，本次不重叠执行。' >&2
  exit 75
}

backup_password="$(sed -n '1p' /run/backup-secrets/postgres-backup.password)"
test -n "$backup_password"
export PGPASSWORD="$backup_password"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
rgs_temporary="/backups/.rgs-${timestamp}.dump.partial"
operator_temporary="/backups/.local_operator-${timestamp}.dump.partial"
archive_temporary="/backups/.operator-files-${timestamp}.tar.gz.partial"
manifest_temporary="/backups/.backup-set-${timestamp}.sha256.partial"
status_file=/backups/backup-status.json
status_temporary=/backups/.backup-status.json.partial
backup_completed=0

status_number() {
  field=$1
  value=$(sed -n "s/.*\"${field}\":\([0-9][0-9]*\).*/\1/p" "$status_file")
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  test "${#value}" -le 18 || return 1
  printf '%s' "$value"
}

write_backup_status() {
  outcome=$1
  now=$(date -u +%s)
  last_success=0
  failures_total=0
  consecutive_failures=0
  if test -e "$status_file"; then
    test -f "$status_file" && test ! -L "$status_file"
    grep -E -x '\{"schema":"local-production-backup-status-v1","lastAttemptUnix":[0-9]+,"lastSuccessUnix":[0-9]+,"failuresTotal":[0-9]+,"consecutiveFailures":[0-9]+,"lastOutcome":"(success|failure)"\}' \
      "$status_file" >/dev/null
    last_success=$(status_number lastSuccessUnix)
    failures_total=$(status_number failuresTotal)
    consecutive_failures=$(status_number consecutiveFailures)
  fi
  case "$outcome" in
    success)
      last_success=$now
      consecutive_failures=0
      ;;
    failure)
      failures_total=$((failures_total + 1))
      consecutive_failures=$((consecutive_failures + 1))
      ;;
    *) return 2 ;;
  esac
  printf '%s\n' \
    "{\"schema\":\"local-production-backup-status-v1\",\"lastAttemptUnix\":${now},\"lastSuccessUnix\":${last_success},\"failuresTotal\":${failures_total},\"consecutiveFailures\":${consecutive_failures},\"lastOutcome\":\"${outcome}\"}" \
    >"$status_temporary"
  chmod 0600 "$status_temporary"
  mv "$status_temporary" "$status_file"
}

cleanup_partials() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  rm -f "$rgs_temporary" "$operator_temporary" "$archive_temporary" \
    "$manifest_temporary" "$status_temporary"
  if test "$backup_completed" -ne 1; then
    write_backup_status failure ||
      printf '%s\n' '备份失败且状态文件无法原子更新。' >&2
  fi
  exit "$exit_status"
}
trap cleanup_partials EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for database in rgs local_operator; do
  temporary="/backups/.${database}-${timestamp}.dump.partial"
  pg_dump "host=postgres port=5432 dbname=$database user=rgs_backup sslmode=verify-full sslrootcert=/run/backup-secrets/local-production-root-ca.pem" \
    --format=custom --compress=6 --no-owner --no-privileges --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
done

output_archive="/backups/operator-files-${timestamp}.tar.gz"
tar -C /operator-data -czf "$archive_temporary" audit logs alerts
tar -tzf "$archive_temporary" >/dev/null

# 只有三个临时成员都通过本地校验后才公开文件名。
mv "$rgs_temporary" "/backups/rgs-${timestamp}.dump"
mv "$operator_temporary" "/backups/local_operator-${timestamp}.dump"
mv "$archive_temporary" "$output_archive"

# 校验清单最后原子发布；它的存在表示三个成员均已写完。
(
  cd /backups
  sha256sum "rgs-${timestamp}.dump" "local_operator-${timestamp}.dump" \
    "operator-files-${timestamp}.tar.gz" >"$manifest_temporary"
)
mv "$manifest_temporary" "/backups/backup-set-${timestamp}.sha256"

find /backups -type f \( -name 'rgs-*.dump' -o -name 'local_operator-*.dump' \
  -o -name 'operator-files-*.tar.gz' -o -name 'backup-set-*.sha256' \) -mtime +14 -delete

# 成功状态只能在三个成员、校验清单和保留期维护全部完成之后发布。
write_backup_status success
backup_completed=1
unset PGPASSWORD backup_password
printf '%s\n' "backup set $timestamp complete"
