#!/bin/sh
# 备份容器健康仅接受最近一次成功且在七小时窗口内的原子状态。
# English: Backup container health only accepts the most recent successful atomic state within a seven-hour
# window.
set -eu

status_file=${BACKUP_STATUS_FILE:-/backups/backup-status.json}
maximum_age=${BACKUP_MAX_SUCCESS_AGE_SECONDS:-25200}

test -f "$status_file" && test ! -L "$status_file"
case "$maximum_age" in
  ''|*[!0-9]*) exit 1 ;;
esac
test "$maximum_age" -ge 3600 && test "$maximum_age" -le 86400
grep -E -x '\{"schema":"local-production-backup-status-v1","lastAttemptUnix":[0-9]+,"lastSuccessUnix":[0-9]+,"failuresTotal":[0-9]+,"consecutiveFailures":0,"lastOutcome":"success"\}' \
  "$status_file" >/dev/null

last_success=$(sed -n 's/.*"lastSuccessUnix":\([0-9][0-9]*\).*/\1/p' "$status_file")
case "$last_success" in
  ''|*[!0-9]*) exit 1 ;;
esac
test "${#last_success}" -le 18
now=$(date -u +%s)
age=$((now - last_success))
# 最多容忍五分钟向前时钟偏差；更大偏差会让“新鲜度”失真，必须失败闭合。
# English: A maximum of five minutes of forward clock deviation is tolerated; greater deviations distort
# "freshness" and must fail to close.
test "$age" -ge -300
test "$age" -le "$maximum_age"
