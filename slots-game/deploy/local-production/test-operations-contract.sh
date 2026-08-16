#!/bin/sh
# 本契约先于实现落地：缺少通知落盘、备份状态或容量保护时必须失败闭合。
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)

fail() {
  printf '%s\n' "local production operations contract: $*" >&2
  exit 1
}

require_fixed() {
  expected=$1
  file=$2
  grep -F -- "$expected" "$file" >/dev/null ||
    fail "missing '$expected' in ${file#"$repository_root/"}"
}

alertmanager_file="$script_dir/alertmanager.yml"
compose_file="$script_dir/compose.yml"
backup_loop_file="$script_dir/postgres-backup-loop.sh"
backup_once_file="$script_dir/postgres-backup-once.sh"
backup_health_file="$script_dir/postgres-backup-healthcheck.sh"
render_file="$script_dir/render-observability.mjs"
temporary_root=${TMPDIR:-/tmp}
rendered_dir=$(mktemp -d "${temporary_root%/}/slots-operations-contract.XXXXXX")
cleanup() {
  case "$rendered_dir" in
    "${temporary_root%/}"/slots-operations-contract.*) rm -rf -- "$rendered_dir" ;;
    *) fail "refusing to remove unexpected path $rendered_dir" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

for file in "$alertmanager_file" "$compose_file" "$backup_loop_file" \
  "$backup_once_file" "$backup_health_file" "$render_file"; do
  test -f "$file" || fail "missing ${file#"$repository_root/"}"
done
node "$render_file" "$rendered_dir" >/dev/null
rendered_rules="$rendered_dir/rules/rgs-alerts.yml"
rendered_dashboard="$rendered_dir/grafana/dashboards/rgs-overview.json"

# Alertmanager 的默认 receiver 必须通过双向受限网络、TLS 主机名校验和文件 Bearer
# 写入本机运营服务，禁止空 receiver 静默吞掉告警。
require_fixed 'url: https://wallet:8443/alerts' "$alertmanager_file"
require_fixed 'credentials_file: /run/alertmanager-webhook-secrets/alertmanager.token' "$alertmanager_file"
require_fixed 'ca_file: /run/alertmanager-webhook-secrets/local-production-root-ca.pem' "$alertmanager_file"
require_fixed 'server_name: wallet' "$alertmanager_file"
require_fixed 'send_resolved: true' "$alertmanager_file"
require_fixed 'LOCAL_OPERATOR_ALERT_FILE: /var/lib/local-operator/alerts/events.jsonl' "$compose_file"

# 每次备份必须原子发布机器可读状态；周期容器同时提供新鲜度健康检查。
require_fixed 'write_backup_status failure' "$backup_once_file"
require_fixed 'write_backup_status success' "$backup_once_file"
require_fixed '/local/postgres-backup-healthcheck.sh' "$compose_file"
require_fixed 'local_production_backup_last_success_timestamp_seconds' "$rendered_rules"
require_fixed 'LocalProductionBackupStale' "$rendered_rules"
require_fixed 'LocalProductionBackupFailed' "$rendered_rules"

# 健康检查必须动态接受新鲜成功状态，并拒绝失败、过期和超前时钟状态。
status_file="$rendered_dir/backup-status.json"
now=$(date -u +%s)
printf '%s\n' \
  "{\"schema\":\"local-production-backup-status-v1\",\"lastAttemptUnix\":${now},\"lastSuccessUnix\":${now},\"failuresTotal\":0,\"consecutiveFailures\":0,\"lastOutcome\":\"success\"}" \
  >"$status_file"
BACKUP_STATUS_FILE="$status_file" BACKUP_MAX_SUCCESS_AGE_SECONDS=25200 sh "$backup_health_file"
stale=$((now - 25201))
printf '%s\n' \
  "{\"schema\":\"local-production-backup-status-v1\",\"lastAttemptUnix\":${stale},\"lastSuccessUnix\":${stale},\"failuresTotal\":0,\"consecutiveFailures\":0,\"lastOutcome\":\"success\"}" \
  >"$status_file"
if BACKUP_STATUS_FILE="$status_file" BACKUP_MAX_SUCCESS_AGE_SECONDS=25200 sh "$backup_health_file"; then
  fail 'backup health accepted stale status'
fi
future=$((now + 301))
printf '%s\n' \
  "{\"schema\":\"local-production-backup-status-v1\",\"lastAttemptUnix\":${future},\"lastSuccessUnix\":${future},\"failuresTotal\":0,\"consecutiveFailures\":0,\"lastOutcome\":\"success\"}" \
  >"$status_file"
if BACKUP_STATUS_FILE="$status_file" BACKUP_MAX_SUCCESS_AGE_SECONDS=25200 sh "$backup_health_file"; then
  fail 'backup health accepted future status'
fi
printf '%s\n' \
  "{\"schema\":\"local-production-backup-status-v1\",\"lastAttemptUnix\":${now},\"lastSuccessUnix\":${now},\"failuresTotal\":1,\"consecutiveFailures\":1,\"lastOutcome\":\"failure\"}" \
  >"$status_file"
if BACKUP_STATUS_FILE="$status_file" BACKUP_MAX_SUCCESS_AGE_SECONDS=25200 sh "$backup_health_file"; then
  fail 'backup health accepted failed status'
fi

# 审计、日志与告警文件必须在达到容量前可观测，并且容量耗尽不得把基础
# readiness 永久拖入重启循环。
for metric in \
  local_operator_audit_store_bytes \
  local_operator_audit_store_capacity_bytes \
  local_operator_audit_store_writable \
  local_operator_log_store_bytes \
  local_operator_log_store_capacity_bytes \
  local_operator_alert_store_bytes \
  local_operator_alert_store_capacity_bytes; do
  require_fixed "$metric" "$rendered_rules"
  require_fixed "$metric" "$rendered_dashboard"
done
require_fixed 'LocalOperatorAuditStoreNearCapacity' "$rendered_rules"
require_fixed 'LocalOperatorLogStoreNearCapacity' "$rendered_rules"
require_fixed 'LocalOperatorAlertStoreNearCapacity' "$rendered_rules"

sh -n "$backup_loop_file" "$backup_once_file" "$backup_health_file"
printf '%s\n' 'local production operations contract: passed'
