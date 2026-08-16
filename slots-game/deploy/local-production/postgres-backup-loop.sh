#!/bin/sh
# 每六小时生成一份 custom-format 备份；失败后一分钟重试，不让容器退出重启
# 掩盖失败计数，也避免瞬时数据库波动造成六小时保护空窗。
set -u
umask 077

while :; do
  if /local/postgres-backup-once.sh; then
    sleep 21600
  else
    sleep 60
  fi
done
