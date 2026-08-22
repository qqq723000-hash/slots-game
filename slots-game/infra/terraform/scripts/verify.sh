#!/bin/sh
# 统一执行不访问 AWS API 的 Terraform 交付门禁。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
terraform_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
terraform_binary=${TERRAFORM_BIN:-terraform}

command -v "$terraform_binary" >/dev/null 2>&1 || {
  printf '%s\n' "Terraform verification: 缺少命令 $terraform_binary" >&2
  exit 1
}

"$terraform_binary" -chdir="$terraform_root" fmt -check -recursive
"$script_directory/verify-static-contract.sh" "$terraform_root"
"$script_directory/test-negative-contract.sh" "$terraform_root"
ruby "$script_directory/test-valkey-rotation-plan.rb"
TERRAFORM_BIN="$terraform_binary" "$script_directory/validate-environments.sh" "$terraform_root"

printf '%s\n' 'Terraform verification: passed'
