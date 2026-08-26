#!/bin/sh
# 本契约先于实现落地：缺少通知落盘、备份状态或容量保护时必须失败闭合。
# shellcheck disable=SC2016
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
backup_integrity_file="$script_dir/backup-integrity.sh"
backup_verify_file="$script_dir/verify-backups.sh"
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
  "$backup_once_file" "$backup_health_file" "$backup_integrity_file" \
  "$backup_verify_file" "$render_file"; do
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
if grep -F '/local/backup-integrity.sh' "$compose_file" "$backup_once_file" >/dev/null; then
  fail 'backup runtime must remain self-contained for the established read-only mount topology'
fi
require_fixed 'verify_source_tree /operator-data' "$backup_once_file"
# 这里核对被测脚本中的字面量变量引用。
# shellcheck disable=SC2016
require_fixed 'verify_operator_archive "$archive_temporary"' "$backup_once_file"
# shellcheck disable=SC2016
require_fixed 'assert_set_absent /backups "$timestamp"' "$backup_once_file"
require_fixed 'publish_no_clobber' "$backup_once_file"
test "$(grep -E -c '^publish_no_clobber ' "$backup_once_file")" -eq 4 ||
  fail 'backup publisher must durably publish exactly three members and one manifest'
require_fixed 'replace_durable "$status_temporary" "$status_file"' "$backup_once_file"
for integrity_source in "$backup_integrity_file" "$backup_once_file"; do
  require_fixed '# 备份完整性库开始' "$integrity_source"
  require_fixed '# 备份完整性库结束' "$integrity_source"
done
sed -n '/^# 备份完整性库开始$/,/^# 备份完整性库结束$/p' \
  "$backup_integrity_file" >"$rendered_dir/standalone-backup-integrity-library.sh"
sed -n '/^# 备份完整性库开始$/,/^# 备份完整性库结束$/p' \
  "$backup_once_file" >"$rendered_dir/runtime-backup-integrity-library.sh"
cmp -s "$rendered_dir/standalone-backup-integrity-library.sh" \
  "$rendered_dir/runtime-backup-integrity-library.sh" ||
  fail 'self-contained runtime and standalone backup integrity libraries drifted'
test "$(grep -F -c 'sync -f "$temporary"' "$backup_integrity_file")" -eq 2 ||
  fail 'both immutable and mutable backup publishers must flush file data'
test "$(grep -F -c 'sync -f "$destination_directory"' "$backup_integrity_file")" -eq 2 ||
  fail 'both immutable and mutable backup publishers must flush directory entries'
# shellcheck disable=SC2016
require_fixed 'backup-integrity.sh" verify-set "$backup_directory" "$timestamp"' "$backup_verify_file"
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
future=$((now + 600))
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

# 备份完整性验证先在纯文件夹具中证明：精确三成员清单可通过，漏验成员、链接输入和
# 含链接归档必须在启动恢复数据库前被拒绝。
backup_fixture="$rendered_dir/backup-fixture"
backup_timestamp=20260824T000000Z
mkdir -p "$backup_fixture/archive/audit" "$backup_fixture/archive/logs" \
  "$backup_fixture/archive/alerts"
printf '%s\n' 'synthetic rgs dump' >"$backup_fixture/rgs-${backup_timestamp}.dump"
printf '%s\n' 'synthetic operator dump' >"$backup_fixture/local_operator-${backup_timestamp}.dump"
printf '%s\n' 'synthetic audit record' >"$backup_fixture/archive/audit/events.jsonl"
printf '%s\n' 'synthetic log record' >"$backup_fixture/archive/logs/rgs.jsonl"
printf '%s\n' 'synthetic alert record' >"$backup_fixture/archive/alerts/events.jsonl"
tar -C "$backup_fixture/archive" -czf \
  "$backup_fixture/operator-files-${backup_timestamp}.tar.gz" audit logs alerts
(
  cd "$backup_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
"$backup_integrity_file" verify-source "$backup_fixture/archive"
"$backup_integrity_file" verify-set "$backup_fixture" "$backup_timestamp"

# 已有生产容器只挂载 once/loop/health 三个脚本。once 必须在没有新兄弟文件的旧挂载
# 拓扑中保留同等完整性能力，避免仓库热更新后等待容器重建期间停止备份。
established_mount_fixture="$rendered_dir/established-backup-mount"
mkdir -p "$established_mount_fixture"
cp "$backup_once_file" "$established_mount_fixture/postgres-backup-once.sh"
chmod 0555 "$established_mount_fixture/postgres-backup-once.sh"
test ! -e "$established_mount_fixture/backup-integrity.sh"
"$established_mount_fixture/postgres-backup-once.sh" integrity verify-source \
  "$backup_fixture/archive"
"$established_mount_fixture/postgres-backup-once.sh" integrity verify-set \
  "$backup_fixture" "$backup_timestamp"

empty_backup_fixture="$rendered_dir/backup-empty"
mkdir -p "$empty_backup_fixture"
"$backup_integrity_file" assert-set-absent "$empty_backup_fixture" "$backup_timestamp"
printf '%s\n' 'publish probe' >"$empty_backup_fixture/.publish-probe.partial"
"$backup_integrity_file" publish-file "$empty_backup_fixture/.publish-probe.partial" \
  "$empty_backup_fixture/publish-probe.out"
test ! -e "$empty_backup_fixture/.publish-probe.partial"
require_fixed 'publish probe' "$empty_backup_fixture/publish-probe.out"
printf '%s\n' 'old status' >"$empty_backup_fixture/replace-probe.out"
printf '%s\n' 'new status' >"$empty_backup_fixture/.replace-probe.partial"
"$backup_integrity_file" replace-file "$empty_backup_fixture/.replace-probe.partial" \
  "$empty_backup_fixture/replace-probe.out"
test ! -e "$empty_backup_fixture/.replace-probe.partial"
require_fixed 'new status' "$empty_backup_fixture/replace-probe.out"
printf '%s\n' 'established mount publish probe' \
  >"$empty_backup_fixture/.established-mount.partial"
"$established_mount_fixture/postgres-backup-once.sh" integrity publish-file \
  "$empty_backup_fixture/.established-mount.partial" \
  "$empty_backup_fixture/established-mount.out"
test ! -e "$empty_backup_fixture/.established-mount.partial"
require_fixed 'established mount publish probe' "$empty_backup_fixture/established-mount.out"

failing_sync_bin="$rendered_dir/failing-sync-bin"
mkdir -p "$failing_sync_bin"
printf '%s\n' '#!/bin/sh' 'exit 1' >"$failing_sync_bin/sync"
chmod 0700 "$failing_sync_bin/sync"
printf '%s\n' 'must remain temporary' >"$empty_backup_fixture/.sync-failure.partial"
if PATH="$failing_sync_bin:$PATH" "$backup_integrity_file" publish-file \
  "$empty_backup_fixture/.sync-failure.partial" \
  "$empty_backup_fixture/sync-failure.out" >/dev/null 2>&1; then
  fail 'backup integrity published a member after its durability flush failed'
fi
test ! -e "$empty_backup_fixture/sync-failure.out"
require_fixed 'must remain temporary' "$empty_backup_fixture/.sync-failure.partial"
printf '%s\n' 'immutable original member' >"$empty_backup_fixture/rgs-${backup_timestamp}.dump"
collision_hash_before=$(sha256sum "$empty_backup_fixture/rgs-${backup_timestamp}.dump")
if "$backup_integrity_file" assert-set-absent "$empty_backup_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a reused backup timestamp'
fi
printf '%s\n' 'replacement attempt' >"$empty_backup_fixture/.replacement.partial"
if "$backup_integrity_file" publish-file "$empty_backup_fixture/.replacement.partial" \
  "$empty_backup_fixture/rgs-${backup_timestamp}.dump" >/dev/null 2>&1; then
  fail 'backup integrity replaced an existing published member'
fi
collision_hash_after=$(sha256sum "$empty_backup_fixture/rgs-${backup_timestamp}.dump")
test "$collision_hash_after" = "$collision_hash_before" ||
  fail 'backup collision changed the existing member hash'
require_fixed 'replacement attempt' "$empty_backup_fixture/.replacement.partial"

omitted_fixture="$rendered_dir/backup-omitted-member"
cp -R "$backup_fixture" "$omitted_fixture"
printf '%s\n' 'unrelated file' >"$omitted_fixture/unrelated.txt"
(
  cd "$omitted_fixture"
  sha256sum unrelated.txt >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$omitted_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a manifest that omitted the real backup members'
fi

extra_manifest_fixture="$rendered_dir/backup-extra-manifest-member"
cp -R "$backup_fixture" "$extra_manifest_fixture"
printf '%s\n' 'unrelated file' >"$extra_manifest_fixture/unrelated.txt"
(
  cd "$extra_manifest_fixture"
  sha256sum unrelated.txt >>"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$extra_manifest_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted an extra manifest member'
fi

duplicate_manifest_fixture="$rendered_dir/backup-duplicate-manifest-member"
cp -R "$backup_fixture" "$duplicate_manifest_fixture"
duplicate_manifest_line=$(sed -n '1p' \
  "$duplicate_manifest_fixture/backup-set-${backup_timestamp}.sha256")
printf '%s\n' "$duplicate_manifest_line" \
  >>"$duplicate_manifest_fixture/backup-set-${backup_timestamp}.sha256"
if "$backup_integrity_file" verify-set "$duplicate_manifest_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a duplicate manifest member'
fi

linked_dump_fixture="$rendered_dir/backup-linked-dump"
cp -R "$backup_fixture" "$linked_dump_fixture"
mv "$linked_dump_fixture/rgs-${backup_timestamp}.dump" \
  "$linked_dump_fixture/rgs-${backup_timestamp}.dump.target"
ln -s "rgs-${backup_timestamp}.dump.target" \
  "$linked_dump_fixture/rgs-${backup_timestamp}.dump"
if "$backup_integrity_file" verify-set "$linked_dump_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a symlinked database dump'
fi

hardlinked_dump_fixture="$rendered_dir/backup-hardlinked-dump"
cp -R "$backup_fixture" "$hardlinked_dump_fixture"
mv "$hardlinked_dump_fixture/rgs-${backup_timestamp}.dump" \
  "$hardlinked_dump_fixture/rgs-${backup_timestamp}.dump.private"
ln "$hardlinked_dump_fixture/rgs-${backup_timestamp}.dump.private" \
  "$hardlinked_dump_fixture/rgs-${backup_timestamp}.dump"
if "$backup_integrity_file" verify-set "$hardlinked_dump_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a multiply linked database dump'
fi

linked_source_fixture="$rendered_dir/backup-linked-source"
cp -R "$backup_fixture/archive" "$linked_source_fixture"
ln -s events.jsonl "$linked_source_fixture/audit/events-link.jsonl"
if "$backup_integrity_file" verify-source "$linked_source_fixture" >/dev/null 2>&1; then
  fail 'backup integrity accepted a symlink in the source tree'
fi

external_hardlink_source_fixture="$rendered_dir/backup-external-hardlink-source"
cp -R "$backup_fixture/archive" "$external_hardlink_source_fixture"
printf '%s\n' 'same-volume private record' >"$external_hardlink_source_fixture/private-record"
ln "$external_hardlink_source_fixture/private-record" \
  "$external_hardlink_source_fixture/audit/smuggled-record"
if "$backup_integrity_file" verify-source "$external_hardlink_source_fixture" >/dev/null 2>&1; then
  fail 'backup integrity accepted a source file hardlinked outside the selected trees'
fi

fifo_source_fixture="$rendered_dir/backup-fifo-source"
cp -R "$backup_fixture/archive" "$fifo_source_fixture"
mkfifo "$fifo_source_fixture/logs/unexpected.pipe"
if "$backup_integrity_file" verify-source "$fifo_source_fixture" >/dev/null 2>&1; then
  fail 'backup integrity accepted a FIFO in the source tree'
fi

linked_archive_fixture="$rendered_dir/backup-linked-archive"
cp -R "$backup_fixture" "$linked_archive_fixture"
ln -s events.jsonl "$linked_archive_fixture/archive/audit/events-link.jsonl"
tar -C "$linked_archive_fixture/archive" -czf \
  "$linked_archive_fixture/operator-files-${backup_timestamp}.tar.gz" audit logs alerts
(
  cd "$linked_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$linked_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a symlink member in the operator archive'
fi

hardlink_archive_fixture="$rendered_dir/backup-hardlink-archive"
cp -R "$backup_fixture" "$hardlink_archive_fixture"
ln "$hardlink_archive_fixture/archive/audit/events.jsonl" \
  "$hardlink_archive_fixture/archive/audit/events-hardlink.jsonl"
tar -C "$hardlink_archive_fixture/archive" -czf \
  "$hardlink_archive_fixture/operator-files-${backup_timestamp}.tar.gz" audit logs alerts
(
  cd "$hardlink_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$hardlink_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a hardlink member in the operator archive'
fi

traversal_archive_fixture="$rendered_dir/backup-traversal-archive"
cp -R "$backup_fixture" "$traversal_archive_fixture"
(
  cd "$traversal_archive_fixture/archive/audit"
  tar -P -czf "$traversal_archive_fixture/operator-files-${backup_timestamp}.tar.gz" \
    ../audit ../logs ../alerts
)
(
  cd "$traversal_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$traversal_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted parent traversal paths in the operator archive'
fi

file_root_archive_fixture="$rendered_dir/backup-file-root-archive"
cp -R "$backup_fixture" "$file_root_archive_fixture"
mkdir -p "$file_root_archive_fixture/flat-roots"
printf '%s\n' audit >"$file_root_archive_fixture/flat-roots/audit"
printf '%s\n' logs >"$file_root_archive_fixture/flat-roots/logs"
printf '%s\n' alerts >"$file_root_archive_fixture/flat-roots/alerts"
tar -C "$file_root_archive_fixture/flat-roots" -czf \
  "$file_root_archive_fixture/operator-files-${backup_timestamp}.tar.gz" audit logs alerts
(
  cd "$file_root_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$file_root_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted ordinary files as required archive roots'
fi

duplicate_path_archive_fixture="$rendered_dir/backup-duplicate-path-archive"
cp -R "$backup_fixture" "$duplicate_path_archive_fixture"
tar -C "$duplicate_path_archive_fixture/archive" -czf \
  "$duplicate_path_archive_fixture/operator-files-${backup_timestamp}.tar.gz" \
  audit audit logs alerts
(
  cd "$duplicate_path_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$duplicate_path_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted duplicate archive paths'
fi

path_collision_archive_fixture="$rendered_dir/backup-path-collision-archive"
cp -R "$backup_fixture" "$path_collision_archive_fixture"
mkdir -p "$path_collision_archive_fixture/file-stage"
printf '%s\n' audit >"$path_collision_archive_fixture/file-stage/audit"
tar -C "$path_collision_archive_fixture/file-stage" -cf \
  "$path_collision_archive_fixture/operator-files-${backup_timestamp}.tar" audit
tar -C "$path_collision_archive_fixture/archive" -rf \
  "$path_collision_archive_fixture/operator-files-${backup_timestamp}.tar" audit logs alerts
gzip -c "$path_collision_archive_fixture/operator-files-${backup_timestamp}.tar" \
  >"$path_collision_archive_fixture/operator-files-${backup_timestamp}.tar.gz"
(
  cd "$path_collision_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$path_collision_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a file-directory archive path collision'
fi

prefix_conflict_archive_fixture="$rendered_dir/backup-prefix-conflict-archive"
cp -R "$backup_fixture" "$prefix_conflict_archive_fixture"
mkdir -p "$prefix_conflict_archive_fixture/prefix-root/audit" \
  "$prefix_conflict_archive_fixture/prefix-root/logs" \
  "$prefix_conflict_archive_fixture/prefix-root/alerts" \
  "$prefix_conflict_archive_fixture/prefix-child/audit/branch"
printf '%s\n' 'regular ancestor' >"$prefix_conflict_archive_fixture/prefix-root/audit/branch"
printf '%s\n' 'descendant payload' \
  >"$prefix_conflict_archive_fixture/prefix-child/audit/branch/item"
tar -C "$prefix_conflict_archive_fixture/prefix-root" -cf \
  "$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar" audit logs alerts
tar -C "$prefix_conflict_archive_fixture/prefix-child" -rf \
  "$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar" audit/branch/item
gzip -c "$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar" \
  >"$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar.gz"
tar -tzf "$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar.gz" |
  grep -F -x 'audit/branch' >/dev/null || fail 'prefix-conflict fixture omitted its regular ancestor'
tar -tzf "$prefix_conflict_archive_fixture/operator-files-${backup_timestamp}.tar.gz" |
  grep -F -x 'audit/branch/item' >/dev/null || fail 'prefix-conflict fixture omitted its descendant'
(
  cd "$prefix_conflict_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$prefix_conflict_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted a regular-file ancestor conflict'
fi

control_name_archive_fixture="$rendered_dir/backup-control-name-archive"
cp -R "$backup_fixture" "$control_name_archive_fixture"
lf_name=$(printf 'lf\nname')
cr_name=$(printf 'cr\rname')
tab_name=$(printf 'tab\tname')
printf '%s\n' lf >"$control_name_archive_fixture/archive/audit/$lf_name"
printf '%s\n' cr >"$control_name_archive_fixture/archive/logs/$cr_name"
printf '%s\n' tab >"$control_name_archive_fixture/archive/alerts/$tab_name"
if "$backup_integrity_file" verify-source "$control_name_archive_fixture/archive" >/dev/null 2>&1; then
  fail 'backup integrity accepted source names containing LF, CR or TAB'
fi
tar -C "$control_name_archive_fixture/archive" -czf \
  "$control_name_archive_fixture/operator-files-${backup_timestamp}.tar.gz" audit logs alerts
(
  cd "$control_name_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$control_name_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted archive names containing LF, CR or TAB escapes'
fi

trailing_lf_archive_fixture="$rendered_dir/backup-trailing-lf-archive"
cp -R "$backup_fixture" "$trailing_lf_archive_fixture"
rm -f "$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar.gz"
tar -C "$trailing_lf_archive_fixture/archive" -cf \
  "$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar" audit logs alerts
trailing_lf_name='final-line-feed
'
printf '%s\n' trailing-control \
  >"$trailing_lf_archive_fixture/archive/audit/$trailing_lf_name"
tar -C "$trailing_lf_archive_fixture/archive" -rf \
  "$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar" \
  "audit/$trailing_lf_name"
gzip -c "$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar" \
  >"$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar.gz"
if "$backup_integrity_file" verify-archive \
  "$trailing_lf_archive_fixture/operator-files-${backup_timestamp}.tar.gz" >/dev/null 2>&1; then
  fail 'backup integrity accepted a final archive member ending in LF'
fi

alias_archive_fixture="$rendered_dir/backup-alias-archive"
cp -R "$backup_fixture" "$alias_archive_fixture"
tar -C "$alias_archive_fixture/archive" -cf \
  "$alias_archive_fixture/operator-files-${backup_timestamp}.tar" audit logs alerts
tar -C "$alias_archive_fixture/archive" -rf \
  "$alias_archive_fixture/operator-files-${backup_timestamp}.tar" \
  audit/./events.jsonl audit//events.jsonl
tar -tf "$alias_archive_fixture/operator-files-${backup_timestamp}.tar" |
  grep -F -x 'audit/./events.jsonl' >/dev/null || fail 'alias fixture omitted its dot component'
tar -tf "$alias_archive_fixture/operator-files-${backup_timestamp}.tar" |
  grep -F -x 'audit//events.jsonl' >/dev/null || fail 'alias fixture omitted its empty component'
gzip -c "$alias_archive_fixture/operator-files-${backup_timestamp}.tar" \
  >"$alias_archive_fixture/operator-files-${backup_timestamp}.tar.gz"
(
  cd "$alias_archive_fixture"
  sha256sum "rgs-${backup_timestamp}.dump" "local_operator-${backup_timestamp}.dump" \
    "operator-files-${backup_timestamp}.tar.gz" >"backup-set-${backup_timestamp}.sha256"
)
if "$backup_integrity_file" verify-set "$alias_archive_fixture" "$backup_timestamp" >/dev/null 2>&1; then
  fail 'backup integrity accepted dot or empty archive path components'
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

sh -n "$backup_loop_file" "$backup_once_file" "$backup_health_file" \
  "$backup_integrity_file" "$backup_verify_file"
printf '%s\n' 'local production operations contract: passed'
