#!/bin/sh
# shellcheck disable=SC2016

# 验证 Nginx 镜像只安装经审核、按架构固定摘要的 OpenSSL APK，并在每个可运行
# stage 结束时恢复 nginxinc 的非 root 用户。该脚本只解析 Dockerfile，不调用网络或 Docker。
# English: Verify that the Nginx image only installs audited, architecture-fixed digest OpenSSL APKs on every
# runnable Restore the non-root user of nginxinc at the end of the stage. This script only parses the Dockerfile
# and makes no calls to networking or Docker.
set -eu

fail() {
  printf '%s\n' "Nginx OpenSSL patch contract: $*" >&2
  exit 1
}

test "$#" -eq 2 || {
  printf '%s\n' 'usage: verify-nginx-openssl-patch.sh web|local DOCKERFILE' >&2
  exit 2
}

mode=$1
dockerfile=$2
case "$mode" in
  web|local) ;;
  *) fail "unsupported mode: $mode" ;;
esac
test -f "$dockerfile" && test ! -L "$dockerfile" || fail 'Dockerfile must be a regular non-symlink file'

require_line() {
  expected=$1
  grep -F -x -- "$expected" "$dockerfile" >/dev/null || fail "missing exact line: $expected"
}

require_line 'ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979'
require_line 'FROM scratch AS openssl-patches'
for package_line in \
  'ADD --checksum=sha256:161223a16f042b8e469e9441291e071464fd91d4f4bbe6f496ee8d0abd4e0701 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libcrypto3-3.5.8-r0.apk /x86_64/libcrypto3.apk' \
  'ADD --checksum=sha256:aca521e5ae4a321322a9d47ed64a1775f5ab1ffd215d1e9fc0433c58f7bfd037 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libssl3-3.5.8-r0.apk /x86_64/libssl3.apk' \
  'ADD --checksum=sha256:35b892813c23664a3592e4fc8c12a03538a22c579057655361c7043305272a9a https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libcrypto3-3.5.8-r0.apk /aarch64/libcrypto3.apk' \
  'ADD --checksum=sha256:d6ec970cc10e01539e41626f720c4e0ac69016eaa2079a10ef776ffd3243db5b https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libssl3-3.5.8-r0.apk /aarch64/libssl3.apk'
do
  require_line "$package_line"
done

# 忽略纯注释并连接 Dockerfile 续行，按实际 shell 指令统计 apk add；不能靠在审核命令
# 旁边另加一条联网安装，或在续行中插入签名/仓库绕过参数。
# English: Ignore pure comments and connect Dockerfile continuation lines to count apk add based on actual shell
# instructions; cannot rely on audit commands Add another line for network installation next to it, or insert
# signature/repository bypass parameters in the continuation line.
normalized=$(awk '
  /^[[:space:]]*#/ { next }
  {
    line = $0
    sub(/\r$/, "", line)
    if (pending == "") pending = line
    else pending = pending " " line
    if (pending ~ /\\[[:space:]]*$/) {
      sub(/\\[[:space:]]*$/, "", pending)
      next
    }
    gsub(/[[:space:]][[:space:]]*/, " ", pending)
    sub(/^ /, "", pending)
    sub(/ $/, "", pending)
    print pending
    pending = ""
  }
  END { if (pending != "") print pending }
' "$dockerfile")

if printf '%s\n' "$normalized" | grep -E -- \
  '--allow-untrusted|--force-[A-Za-z0-9_.-]+|--keys-dir([=[:space:]]|$)|APK_KEYS_DIR|/etc/apk/keys(/|[[:space:]]|$)|(^|[;&|[:space:]])apk[[:space:]]+keys([;&|[:space:]]|$)' \
  >/dev/null; then
  fail 'APK signature verification can be bypassed or supplied with custom keys'
fi
if printf '%s\n' "$normalized" | grep -E -- \
  '--repository([=[:space:]]|$)|(^|[;&|[:space:]])-X([=[:space:]]|$)|APK_REPOSITORY|/etc/apk/repositories([/[:space:]]|$)' \
  >/dev/null; then
  fail 'APK installation must not use a custom or network repository'
fi

approved_add='apk add --no-network --no-cache --repositories-file /dev/null "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk" &&'
count_occurrences() {
  needle=$1
  awk -v needle="$needle" '
    {
      source = $0
      while ((position = index(source, needle)) > 0) {
        count++
        source = substr(source, position + length(needle))
      }
    }
    END { print count + 0 }
  '
}

apk_add_count=$(printf '%s\n' "$normalized" | awk '
  {
    source = $0
    while (match(source, /(^|[;&|[:space:]])apk[[:space:]]+add([;&|[:space:]]|$)/)) {
      count++
      source = substr(source, RSTART + RLENGTH)
    }
  }
  END { print count + 0 }
')
apk_command_count=$(printf '%s\n' "$normalized" | awk '
  {
    source = $0
    while (match(source, /(^|[;&|($[:space:]])apk[[:space:]]+/)) {
      count++
      source = substr(source, RSTART + RLENGTH)
    }
  }
  END { print count + 0 }
')
approved_add_count=$(printf '%s\n' "$normalized" | count_occurrences "$approved_add")
repositories_file_count=$(printf '%s\n' "$normalized" | count_occurrences '--repositories-file')

case "$mode" in
  web) expected_add_count=3 ;;
  local) expected_add_count=1 ;;
esac
test "$apk_add_count" -eq "$expected_add_count" \
  && test "$approved_add_count" -eq "$expected_add_count" \
  && test "$repositories_file_count" -eq "$expected_add_count" \
  && test "$apk_command_count" -eq "$((expected_add_count * 4))" \
  || fail 'only the exact reviewed offline APK installation is allowed'

extract_stage() {
  stage_name=$1
  printf '%s\n' "$normalized" | awk -v wanted="$stage_name" '
    /^FROM[[:space:]]+/ {
      if (inside) exit
      inside = ($NF == wanted)
    }
    inside { print }
  '
}

verify_runtime_stage() {
  stage_label=$1
  stage_source=$2
  test -n "$stage_source" || fail "$stage_label stage is missing"
  stage_add_count=$(printf '%s\n' "$stage_source" | count_occurrences "$approved_add")
  test "$stage_add_count" -eq 1 || fail "$stage_label must install the reviewed APK pair exactly once"

  install_line=$(printf '%s\n' "$stage_source" | awk -v needle="$approved_add" '
    index($0, needle) { print; exit }
  ')
  printf '%s\n' "$install_line" | grep -F 'RUN --network=none ' >/dev/null \
    || fail "$stage_label reviewed APK installation must run without network access"
  printf '%s\n' "$install_line" | grep -F -- '--mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly' >/dev/null \
    || fail "$stage_label reviewed APK installation must use the read-only patch mount"
  printf '%s\n' "$install_line" | grep -F 'case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac' >/dev/null \
    || fail "$stage_label reviewed APK installation must reject unreviewed architectures"
  test "$(printf '%s\n' "$install_line" | count_occurrences 'apk --print-arch')" -eq 1 \
    || fail "$stage_label reviewed APK installation must derive one supported target architecture"
  if ! printf '%s\n' "$install_line" | grep -F "apk info -e 'libcrypto3=3.5.8-r0'" >/dev/null \
    || ! printf '%s\n' "$install_line" | grep -F "apk info -e 'libssl3=3.5.8-r0'" >/dev/null; then
    fail "$stage_label reviewed APK installation must prove both fixed OpenSSL package versions"
  fi

  install_user=$(printf '%s\n' "$stage_source" | awk -v needle="$approved_add" '
    /^USER[[:space:]]+/ { user = $2 }
    index($0, needle) { print user; exit }
  ')
  test "$install_user" = '0:0' || fail "$stage_label must install APKs as temporary root 0:0"
  effective_user=$(printf '%s\n' "$stage_source" | awk '
    /^USER[[:space:]]+/ { user = $2 }
    END { print user }
  ')
  test "$effective_user" = '101:101' || fail "$stage_label must leave effective USER 101:101"
}

if [ "$mode" = web ]; then
  for runtime_stage in config-conformance-nginx static-conformance runtime
  do
    verify_runtime_stage "$runtime_stage" "$(extract_stage "$runtime_stage")"
  done
  last_stage=$(printf '%s\n' "$normalized" | awk '/^FROM[[:space:]]+/ { stage = $NF } END { print stage }')
  test "$last_stage" = runtime || fail 'web runtime must remain the final Docker stage'
else
  from_count=$(printf '%s\n' "$normalized" | awk '/^FROM[[:space:]]+/ { count++ } END { print count + 0 }')
  test "$from_count" -eq 2 || fail 'local Nginx Dockerfile must contain only patch and final runtime stages'
  final_stage=$(printf '%s\n' "$normalized" | awk '
    /^FROM[[:space:]]+/ { block = $0 "\n"; seen = 1; next }
    seen { block = block $0 "\n" }
    END { printf "%s", block }
  ')
  printf '%s\n' "$final_stage" | grep -F -x 'FROM ${NGINX_IMAGE}' >/dev/null \
    || fail 'local final stage must inherit the reviewed NGINX_IMAGE'
  verify_runtime_stage 'local final runtime' "$final_stage"
fi

printf '%s\n' "Nginx OpenSSL patch contract passed: $mode"
