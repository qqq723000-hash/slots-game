#!/bin/sh
# 使用只读 provider lock 对四个环境执行离线 backend 初始化和 schema 校验。
# English: Perform offline backend initialization and schema validation on four environments using read-only
# provider lock.
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
terraform_root=${1:-$(CDPATH='' cd -- "$script_directory/.." && pwd)}
terraform_binary=${TERRAFORM_BIN:-terraform}
plugin_cache=${TF_PLUGIN_CACHE_DIR:-${TMPDIR:-/tmp}/slots-terraform-plugin-cache}

command -v "$terraform_binary" >/dev/null 2>&1 || {
  printf '%s\n' "Terraform validate: 缺少命令 $terraform_binary" >&2
  exit 1
}

mkdir -p -- "$plugin_cache"
export TF_PLUGIN_CACHE_DIR="$plugin_cache"
export TF_IN_AUTOMATION=1

for environment in dev staging prod-primary prod-dr; do
  directory="$terraform_root/environments/$environment"
  test -f "$directory/.terraform.lock.hcl" || {
    printf '%s\n' "Terraform validate: 缺少 environments/$environment/.terraform.lock.hcl" >&2
    exit 1
  }

  "$terraform_binary" -chdir="$directory" init \
    -backend=false \
    -input=false \
    -lockfile=readonly \
    -no-color >/dev/null
  "$terraform_binary" -chdir="$directory" validate -no-color
done
