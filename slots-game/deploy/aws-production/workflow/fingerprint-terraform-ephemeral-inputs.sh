#!/bin/sh
# shellcheck disable=SC2016

# 只输出与本次运行绑定的 HMAC 指纹，不输出任何 Terraform ephemeral 变量值。
# English: Only the HMAC fingerprint bound to this run is output, and no Terraform ephemeral variable values are
# output.
set -eu

fail() {
  printf '%s\n' "Terraform ephemeral 输入指纹失败：$*" >&2
  exit 1
}

test "$#" -eq 1 || fail '必须传入目标环境'
target_environment=$1

for variable_name in TF_VAR_valkey_password_a TF_VAR_valkey_password_b \
  TF_VAR_shared_admission_hmac_key TF_VAR_valkey_root_ca_pem \
  GITHUB_REPOSITORY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT; do
  variable_value=$(printenv "$variable_name" 2>/dev/null || true)
  test -n "$variable_value" || fail "$variable_name 未配置"
done

case "$target_environment" in
  dev|staging|prod-primary|prod-dr) ;;
  *) fail '目标环境不在允许列表中' ;;
esac

command -v node >/dev/null 2>&1 || fail '缺少 node'
TARGET_ENVIRONMENT=$target_environment node -e '
  const { createHmac } = require("node:crypto");
  const names = [
    "TF_VAR_valkey_password_a",
    "TF_VAR_valkey_password_b",
    "TF_VAR_shared_admission_hmac_key",
    "TF_VAR_valkey_root_ca_pem",
  ];
  const values = names.map((name) => process.env[name]);
  const keyParts = values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`);
  const key = Buffer.from(keyParts.join("\u0000"), "utf8");
  const context = [
    "slots-terraform-ephemeral-v2",
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    process.env.TARGET_ENVIRONMENT,
  ].join("\u0000");
  process.stdout.write(`${createHmac("sha256", key).update(context).digest("hex")}\n`);
'
