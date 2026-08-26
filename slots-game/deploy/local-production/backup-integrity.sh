#!/bin/sh
# 验证备份输入树与已发布备份集；不启动数据库或接触线上容器。
set -eu
LC_ALL=C
export LC_ALL

# 备份完整性库开始
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
  duplicate_path=$(printf '%s\n' "$archive_list" | sed 's:/*$::' | LC_ALL=C sort | uniq -d | sed -n '1p')
  test -z "$duplicate_path" || fail "operator archive repeats a path: $duplicate_path"

  # tar -t 与 tar -tv 的顺序一致；逐项绑定类型后，目录必须带尾斜杠、普通文件不得带，
  # 且任何普通文件都不能同时充当另一成员的祖先路径。
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

case "${1:-}" in
  verify-source)
    test "$#" -eq 2 || fail 'usage: backup-integrity.sh verify-source SOURCE_ROOT'
    verify_source_tree "$2"
    ;;
  verify-set)
    test "$#" -eq 3 || fail 'usage: backup-integrity.sh verify-set BACKUP_DIRECTORY TIMESTAMP'
    verify_backup_set "$2" "$3"
    ;;
  verify-archive)
    test "$#" -eq 2 || fail 'usage: backup-integrity.sh verify-archive ARCHIVE'
    verify_operator_archive "$2"
    ;;
  assert-set-absent)
    test "$#" -eq 3 || fail 'usage: backup-integrity.sh assert-set-absent BACKUP_DIRECTORY TIMESTAMP'
    assert_set_absent "$2" "$3"
    ;;
  publish-file)
    test "$#" -eq 3 || fail 'usage: backup-integrity.sh publish-file TEMPORARY DESTINATION'
    publish_no_clobber "$2" "$3"
    ;;
  replace-file)
    test "$#" -eq 3 || fail 'usage: backup-integrity.sh replace-file TEMPORARY DESTINATION'
    replace_durable "$2" "$3"
    ;;
  *)
    fail 'usage: backup-integrity.sh assert-set-absent BACKUP_DIRECTORY TIMESTAMP | publish-file TEMPORARY DESTINATION | replace-file TEMPORARY DESTINATION | verify-source SOURCE_ROOT | verify-archive ARCHIVE | verify-set BACKUP_DIRECTORY TIMESTAMP'
    ;;
esac
