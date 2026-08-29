#!/bin/sh

# 该脚本在取得任何云凭据前校验发布输入；镜像只允许不可变 ECR SHA-256 摘要。
# English: This script validates publish input before obtaining any cloud credentials; the image only allows
# immutable ECR SHA-256 digests.
set -eu

fail() {
  printf '%s\n' "AWS 发布输入校验失败：$*" >&2
  exit 1
}

test "$#" -eq 6 || fail '必须传入环境、发布标签、三个镜像摘要和配置摘要'
target_environment=$1
release_tag=$2
rgs_digest=$3
migrator_digest=$4
web_digest=$5
configuration_sha256=$6

case "$target_environment" in
  dev|staging|prod-primary|prod-dr) ;;
  *) fail '目标环境不在允许列表中' ;;
esac

printf '%s\n' "$release_tag" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$' || \
  fail '发布标签格式错误'
test "$release_tag" != latest || fail '禁止使用 latest'

for digest in "$rgs_digest" "$migrator_digest" "$web_digest"; do
  printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || \
    fail '每个镜像都必须使用小写 sha256 摘要'
done

printf '%s\n' "$configuration_sha256" | grep -Eq '^[0-9a-f]{64}$' || \
  fail '配置摘要必须是小写 SHA-256'

printf '%s\n' 'AWS 发布输入校验通过。'
