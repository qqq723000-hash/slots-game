#!/bin/sh
# 依次导出两个业务库和外部审计/日志文件，并以同一时间标记原子发布完整备份集。
# 发布原子性不表示三个来源具有同一时点快照；需要跨存储一致性时必须先静默写入或使用平台快照。
# English: Export the two business libraries and external audit/log files in sequence, and atomically publish
# the full backup set with the same time stamp. Release atomicity does not mean that the three sources have the
# same point-in-time snapshot; when cross-storage consistency is required, you must first write silently or use
# a platform snapshot.
set -eu
umask 077
LC_ALL=C
export LC_ALL

# 备份完整性库开始
# English: Backup Integrity Repository Begins
fail() {
  printf '%s\n' "backup integrity: $*" >&2
  exit 1
}

require_plain_nonempty_file() {
  path=$1
  test -f "$path" && test ! -L "$path" && test -s "$path" ||
    fail "expected a non-empty regular file: $path"
  hardlinked_path=$(find "$path" -type f ! -links 1 -print -quit)
  test -z "$hardlinked_path" || fail "regular file must have exactly one link: $path"
}

verify_source_tree() {
  source_root=$1
  test -d "$source_root" && test ! -L "$source_root" ||
    fail "source root must be a real directory"

  for source_name in audit logs alerts; do
    source_path="$source_root/$source_name"
    test -d "$source_path" && test ! -L "$source_path" ||
      fail "$source_name must be a real directory"
    unexpected_entry=$(find "$source_path" ! -type f ! -type d -print -quit)
    test -z "$unexpected_entry" ||
      fail "$source_name contains a link or special file"
    hardlinked_entry=$(find "$source_path" -type f ! -links 1 -print -quit)
    test -z "$hardlinked_entry" ||
      fail "$source_name contains a multiply linked file"
    if ! find "$source_path" -exec sh -c '
      for entry do
        entry_name=${entry##*/}
        case "$entry_name" in
          ""|.|..|*[!A-Za-z0-9._-]*) exit 1 ;;
        esac
      done
    ' sh {} +; then
      fail "$source_name contains a non-canonical or control-character name"
    fi
  done
}

assert_set_absent() {
  backup_directory=$1
  timestamp=$2
  test -d "$backup_directory" && test ! -L "$backup_directory" ||
    fail 'backup directory must be a real directory'
  case "$timestamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) fail 'backup timestamp is invalid' ;;
  esac
  for candidate in \
    ".rgs-${timestamp}.dump.partial" \
    ".local_operator-${timestamp}.dump.partial" \
    ".operator-files-${timestamp}.tar.gz.partial" \
    ".backup-set-${timestamp}.sha256.partial" \
    ".backup-status.json.partial" \
    "rgs-${timestamp}.dump" \
    "local_operator-${timestamp}.dump" \
    "operator-files-${timestamp}.tar.gz" \
    "backup-set-${timestamp}.sha256"
  do
    test ! -e "$backup_directory/$candidate" && test ! -L "$backup_directory/$candidate" ||
      fail "backup timestamp collision: $candidate"
  done
}

publish_no_clobber() {
  temporary=$1
  destination=$2
  require_plain_nonempty_file "$temporary"
  test ! -e "$destination" && test ! -L "$destination" ||
    fail "refusing to replace published backup member: $destination"
  destination_directory=$(dirname "$destination")
  test -d "$destination_directory" && test ! -L "$destination_directory" ||
    fail 'published backup directory must be a real directory'
  sync -f "$temporary" || fail "could not flush backup member data: $temporary"
  # 同一 /backups 文件系统内的 link(2) 是原子的，目标已存在时必定失败；随后删除临时名。
  # English: link(2) within the same /backups filesystem is atomic and must fail if the target already exists;
  # the temporary name is subsequently deleted.
  ln "$temporary" "$destination" || fail "could not atomically publish: $destination"
  unlink "$temporary" || fail "published member retained its temporary link: $temporary"
  sync -f "$destination_directory" || fail "could not flush backup directory: $destination_directory"
  require_plain_nonempty_file "$destination"
}

replace_durable() {
  temporary=$1
  destination=$2
  require_plain_nonempty_file "$temporary"
  if test -e "$destination" || test -L "$destination"; then
    require_plain_nonempty_file "$destination"
  fi
  destination_directory=$(dirname "$destination")
  test -d "$destination_directory" && test ! -L "$destination_directory" ||
    fail 'replacement directory must be a real directory'
  sync -f "$temporary" || fail "could not flush replacement data: $temporary"
  mv "$temporary" "$destination" || fail "could not atomically replace: $destination"
  sync -f "$destination_directory" || fail "could not flush replacement directory: $destination_directory"
  require_plain_nonempty_file "$destination"
}

verify_backup_set() {
  backup_directory=$1
  timestamp=$2

  test -d "$backup_directory" && test ! -L "$backup_directory" ||
    fail 'backup directory must be a real directory'
  case "$timestamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) fail 'backup timestamp is invalid' ;;
  esac

  manifest_name="backup-set-${timestamp}.sha256"
  rgs_name="rgs-${timestamp}.dump"
  operator_name="local_operator-${timestamp}.dump"
  archive_name="operator-files-${timestamp}.tar.gz"
  manifest="$backup_directory/$manifest_name"
  operator_archive="$backup_directory/$archive_name"

  require_plain_nonempty_file "$manifest"
  require_plain_nonempty_file "$backup_directory/$rgs_name"
  require_plain_nonempty_file "$backup_directory/$operator_name"
  require_plain_nonempty_file "$operator_archive"

  # 清单必须精确列出三个公开成员，固定顺序与文件名；禁止漏验真实 dump、追加路径或
  # 通过符号链接把校验引向备份目录之外。
  # English: The list must accurately list the three public members in a fixed order and file name; it is
  # forbidden to omit the real dump, append the path or Direct verification outside the backup directory via a
  # symbolic link.
  awk 'END { exit(NR == 3 ? 0 : 1) }' "$manifest" ||
    fail 'manifest must contain exactly three entries'
  sed -n '1p' "$manifest" |
    grep -E "^[0-9a-f]{64}  rgs-${timestamp}\.dump$" >/dev/null ||
    fail 'manifest RGS entry is missing or malformed'
  sed -n '2p' "$manifest" |
    grep -E "^[0-9a-f]{64}  local_operator-${timestamp}\.dump$" >/dev/null ||
    fail 'manifest local operator entry is missing or malformed'
  sed -n '3p' "$manifest" |
    grep -E "^[0-9a-f]{64}  operator-files-${timestamp}\.tar\.gz$" >/dev/null ||
    fail 'manifest operator archive entry is missing or malformed'
  (
    cd "$backup_directory"
    sha256sum -c "$manifest_name" >/dev/null
  ) || fail 'backup member checksum verification failed'

  verify_operator_archive "$operator_archive"
}

verify_operator_archive() {
  operator_archive=$1
  require_plain_nonempty_file "$operator_archive"
  # 哨兵必须位于命令替换末尾，避免 shell 吞掉最后一个成员名中的 LF 并把控制字符档案
  # 错认成规范路径；移除哨兵后，保留下来的空行会由下方安全字符规则拒绝。
  # English: The sentinel must be placed at the end of the command substitution to prevent the shell from
  # swallowing the LF in the last member name and replacing the control characters in the file Mistaken as a
  # canonical path; after removing the sentry, the remaining empty lines will be rejected by the safe character
  # rules below.
  archive_list=$(
    tar -tzf "$operator_archive" || exit 1
    printf '\001'
  ) || fail 'operator archive cannot be listed'
  archive_list=${archive_list%?}
  listing_newline='
'
  case "$archive_list" in
    *"$listing_newline") archive_list=${archive_list%?} ;;
    *) fail 'operator archive listing is not record terminated' ;;
  esac
  printf '%s\n' "$archive_list" | awk '
    !/^[A-Za-z0-9._\/-]+$/ { exit 1 }
    /^\// || /\/\// || /(^|\/)\.($|\/)/ || /(^|\/)\.\.($|\/)/ { exit 1 }
    !/^(audit|logs|alerts)(\/|$)/ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' || fail 'operator archive contains a non-canonical, control-character or unexpected path'
  archive_details=$(
    tar -tvzf "$operator_archive" || exit 1
    printf '\001'
  ) || fail 'operator archive metadata cannot be listed'
  archive_details=${archive_details%?}
  case "$archive_details" in
    *"$listing_newline") archive_details=${archive_details%?} ;;
    *) fail 'operator archive metadata is not record terminated' ;;
  esac
  printf '%s\n' "$archive_details" | awk '
    substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }
    END { if (NR == 0) exit 1 }
  ' || fail 'operator archive contains a link or special member'
  archive_count=$(printf '%s\n' "$archive_list" | awk 'END { print NR + 0 }')
  detail_count=$(printf '%s\n' "$archive_details" | awk 'END { print NR + 0 }')
  test "$archive_count" -eq "$detail_count" || fail 'operator archive listings disagree'

  # 去掉目录尾斜杠后每个路径必须唯一，既拒绝重复成员，也拒绝同名文件/目录碰撞。
  # English: Each path must be unique after removing the trailing slash in the directory. Duplicate members and
  # file/directory collisions with the same name are rejected.
  duplicate_path=$(printf '%s\n' "$archive_list" | sed 's:/*$::' | LC_ALL=C sort | uniq -d | sed -n '1p')
  test -z "$duplicate_path" || fail "operator archive repeats a path: $duplicate_path"

  # tar -t 与 tar -tv 的顺序一致；逐项绑定类型后，目录必须带尾斜杠、普通文件不得带，
  # 且任何普通文件都不能同时充当另一成员的祖先路径。
  # English: The order of tar -t and tar -tv is the same; after binding types one by one, the directory must
  # have a trailing slash, and ordinary files must not. And no ordinary file can simultaneously serve as the
  # ancestor path of another member.
  archive_types=$(printf '%s\n' "$archive_details" | cut -c1)
  {
    printf '%s\n' "$archive_types"
    printf '\001\n'
    printf '%s\n' "$archive_list"
  } | awk '
    $0 == sprintf("%c", 1) { names_phase = 1; next }
    !names_phase { types[++type_count] = $0; next }
    { names[++name_count] = $0 }
    END {
      if (type_count != name_count || name_count == 0) exit 1
      for (i = 1; i <= name_count; i += 1) {
        paths[i] = names[i]
        if (types[i] == "d") {
          if (paths[i] !~ /\/$/) exit 1
          sub(/\/$/, "", paths[i])
        } else if (types[i] == "-") {
          if (paths[i] ~ /\/$/) exit 1
        } else {
          exit 1
        }
      }
      for (i = 1; i <= name_count; i += 1) {
        if (types[i] != "-") continue
        prefix = paths[i] "/"
        for (j = 1; j <= name_count; j += 1) {
          if (i != j && index(paths[j], prefix) == 1) exit 1
        }
      }
    }
  ' || fail 'operator archive contains a type/path ancestor conflict'
  for required_root in audit logs alerts; do
    root_line=$(printf '%s\n' "$archive_list" | awk -v root="${required_root}/" '
      $0 == root { count += 1; line = NR }
      END { if (count == 1) print line }
    ')
    test -n "$root_line" || fail "operator archive must contain one ${required_root}/ root directory"
    root_type=$(printf '%s\n' "$archive_details" | sed -n "${root_line}p" | cut -c1)
    test "$root_type" = d || fail "operator archive root is not a directory: $required_root"
  done
}
# 备份完整性库结束
# English: End of backup integrity library

run_backup_integrity_command() {
  test "$#" -ge 1 || fail 'backup integrity command is required'
  command=$1
  shift
  case "$command" in
    verify-source)
      test "$#" -eq 1 || fail 'usage: postgres-backup-once.sh integrity verify-source SOURCE_ROOT'
      verify_source_tree "$1"
      ;;
    verify-set)
      test "$#" -eq 2 || fail 'usage: postgres-backup-once.sh integrity verify-set BACKUP_DIRECTORY TIMESTAMP'
      verify_backup_set "$1" "$2"
      ;;
    verify-archive)
      test "$#" -eq 1 || fail 'usage: postgres-backup-once.sh integrity verify-archive ARCHIVE'
      verify_operator_archive "$1"
      ;;
    assert-set-absent)
      test "$#" -eq 2 || fail 'usage: postgres-backup-once.sh integrity assert-set-absent BACKUP_DIRECTORY TIMESTAMP'
      assert_set_absent "$1" "$2"
      ;;
    publish-file)
      test "$#" -eq 2 || fail 'usage: postgres-backup-once.sh integrity publish-file TEMPORARY DESTINATION'
      publish_no_clobber "$1" "$2"
      ;;
    replace-file)
      test "$#" -eq 2 || fail 'usage: postgres-backup-once.sh integrity replace-file TEMPORARY DESTINATION'
      replace_durable "$1" "$2"
      ;;
    *)
      fail 'unsupported backup integrity command'
      ;;
  esac
}

if [ "$#" -gt 0 ] && [ "$1" = integrity ]; then
  shift
  run_backup_integrity_command "$@"
  exit 0
fi
test "$#" -eq 0 || fail 'usage: postgres-backup-once.sh [integrity COMMAND ARGUMENTS]'

# 同一时刻只允许一个周期任务或手工任务写入备份集。
# English: Only one periodic task or manual task is allowed to write to the backup set at the same time.
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
  replace_durable "$status_temporary" "$status_file"
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

# 秒级时间戳的顺序任务也不得覆盖先前备份；发布阶段还会用原子 no-clobber link 再防竞态。
# English: Sequential tasks with second-level timestamps must not overwrite previous backups; atomic no-clobber
# links are also used during the release phase to prevent race conditions.
assert_set_absent /backups "$timestamp"

for database in rgs local_operator; do
  temporary="/backups/.${database}-${timestamp}.dump.partial"
  pg_dump "host=postgres port=5432 dbname=$database user=rgs_backup sslmode=verify-full sslrootcert=/run/backup-secrets/local-production-root-ca.pem" \
    --format=custom --compress=6 --no-owner --no-privileges --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
done

output_archive="/backups/operator-files-${timestamp}.tar.gz"
# 归档前拒绝符号链接、FIFO、socket 和设备节点；恢复验证也会再次检查归档成员类型。
# English: Symbolic links, FIFOs, sockets, and device nodes are rejected before archiving; restore validation
# also checks archive member types again.
verify_source_tree /operator-data
tar -C /operator-data -czf "$archive_temporary" audit logs alerts
verify_operator_archive "$archive_temporary"

# 只有三个临时成员都通过本地校验后才用原子 no-clobber link 公开文件名。
# English: Only use the atomic no-clobber link to expose the file name after all three temporary members pass
# local verification.
publish_no_clobber "$rgs_temporary" "/backups/rgs-${timestamp}.dump"
publish_no_clobber "$operator_temporary" "/backups/local_operator-${timestamp}.dump"
publish_no_clobber "$archive_temporary" "$output_archive"

# 校验清单最后原子发布；它的存在表示三个成员均已写完。
# English: The check list is finally published atomically; its presence indicates that all three members have
# been written.
(
  cd /backups
  sha256sum "rgs-${timestamp}.dump" "local_operator-${timestamp}.dump" \
    "operator-files-${timestamp}.tar.gz" >"$manifest_temporary"
)
publish_no_clobber "$manifest_temporary" "/backups/backup-set-${timestamp}.sha256"

find /backups -type f \( -name 'rgs-*.dump' -o -name 'local_operator-*.dump' \
  -o -name 'operator-files-*.tar.gz' -o -name 'backup-set-*.sha256' \) -mtime +14 -delete

# 成功状态只能在三个成员、校验清单和保留期维护全部完成之后发布。
# English: Success status can only be released after all three members, check list, and retention period
# maintenance have been completed.
write_backup_status success
backup_completed=1
unset PGPASSWORD backup_password
printf '%s\n' "backup set $timestamp complete"
