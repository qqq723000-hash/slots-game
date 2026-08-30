#!/bin/sh
# 每六小时生成一份 custom-format 备份；失败后一分钟重试，不让容器退出重启
# 掩盖失败计数，也避免瞬时数据库波动造成六小时保护空窗。
# English: Generate a custom-format backup every six hours; retry one minute after failure without allowing the
# container to egress and restart. Cover up the failure count and avoid the six-hour protection window caused by
# instantaneous database fluctuations.
set -u
umask 077

while :; do
  if /local/postgres-backup-once.sh; then
    sleep 21600
  else
    sleep 60
  fi
done
