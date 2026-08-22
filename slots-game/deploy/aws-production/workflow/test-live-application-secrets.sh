#!/bin/sh

# 使用纯本地 fixture 证明缺 key、可变 Secret 和 delivery 漂移都会在 Helm 前被拒绝。
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../../.." && pwd)
verifier="$script_directory/verify-live-application-secrets.sh"
renderer="$repository_root/slots-game/deploy/aws-production/render-external-secrets.rb"
platform_verifier="$repository_root/slots-game/deploy/aws-production/verify-live-platform-prerequisites.sh"
mock_kubectl="$script_directory/fixtures/mock-kubectl.sh"
mock_live_kubectl="$script_directory/fixtures/mock-live-kubectl.sh"
mock_live_aws="$script_directory/fixtures/mock-live-aws.sh"
values_file="$script_directory/fixtures/live-values.yaml"
chart_defaults="$repository_root/slots-game/deploy/cluster-production/chart/values.yaml"
delivery_file="$script_directory/fixtures/live-delivery.json"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-live-secret-test.XXXXXX")

cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "AWS 平台与应用 Secret 负向 fixture 失败：$*" >&2
  exit 1
}

KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null || \
  fail '完整平台实时门禁 fixture 未通过'

if MOCK_PLATFORM_MODE=pod-identity-drift KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail 'External Secrets Pod Identity role 漂移未被拒绝'
fi

if MOCK_PLATFORM_MODE=missing-api-key KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 API 必需 key 的不可变 Secret'
fi

if MOCK_PLATFORM_MODE=missing-shared-username KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 Valkey ACL username 的共享准入 Secret'
fi

if MOCK_PLATFORM_MODE=metrics-server-degraded KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝非 ACTIVE 的 metrics-server EKS add-on'
fi

if MOCK_PLATFORM_MODE=autoscaler-policy-missing-describe-tags \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝缺少 autoscaling:DescribeTags 的实际 IAM 策略'
fi

if MOCK_PLATFORM_MODE=autoscaler-policy-wildcard \
  KUBECTL_BIN=$mock_live_kubectl AWS_BIN=$mock_live_aws \
  "$platform_verifier" "$delivery_file" slots-production >/dev/null 2>&1; then
  fail '平台门禁未拒绝 Cluster Autoscaler 通配 IAM 权限'
fi

KUBECTL_BIN=$mock_kubectl "$verifier" "$values_file" "$chart_defaults" \
  slots-production "$delivery_file" >/dev/null || \
  fail '完整不可变 Secret fixture 未通过'

rendered_file="$fixture_root/external-secrets.yaml"
ruby "$renderer" "$delivery_file" slots-production > "$rendered_file" || \
  fail 'ExternalSecret renderer 正样例未通过'
ruby -ryaml -e '
  documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
  abort unless documents.count { |item| item["kind"] == "SecretStore" } == 1
  external = documents.select { |item| item["kind"] == "ExternalSecret" }
  abort unless external.length == 6
  abort unless external.all? { |item|
    item.dig("spec", "refreshPolicy") == "CreatedOnce" &&
      item.dig("spec", "target", "immutable") == true &&
      item.dig("spec", "secretStoreRef", "kind") == "SecretStore"
  }
' "$rendered_file" || fail 'ExternalSecret renderer 没有生成六个不可变 CreatedOnce 目标'

unversioned_delivery="$fixture_root/unversioned-delivery.json"
jq '.valkey_secret_name = "slots-rgs-shared-admission"' "$delivery_file" > "$unversioned_delivery"
if ruby "$renderer" "$unversioned_delivery" slots-production >/dev/null 2>&1; then
  fail 'ExternalSecret renderer 未拒绝无版本 Secret 名'
fi

if MOCK_SECRET_MODE=missing-key KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail 'API 运行素材 Secret 缺少必需 key 未被拒绝'
fi

if MOCK_SECRET_MODE=missing-worker-key KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail 'Worker 运行素材 Secret 缺少必需 key 未被拒绝'
fi

if MOCK_SECRET_MODE=missing-username KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail '共享准入 Secret 缺少 Valkey ACL username 未被拒绝'
fi

if MOCK_SECRET_MODE=mutable KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$delivery_file" >/dev/null 2>&1; then
  fail '可变 Secret 未被拒绝'
fi

mismatched_delivery="$fixture_root/mismatched-delivery.json"
jq '.application_secret_names["runtime-database"] = "slots-wrong-runtime-database-v9"' \
  "$delivery_file" > "$mismatched_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$mismatched_delivery" >/dev/null 2>&1; then
  fail 'Helm values 与 Terraform delivery 的 Secret 名漂移未被拒绝'
fi

wrong_endpoint_values="$fixture_root/wrong-endpoint-values.yaml"
ruby -ryaml -e '
  value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: false)
  value.fetch("rgs").fetch("sharedAdmission")["endpointURL"] =
    "rediss://wrong-valkey.example.cache.amazonaws.com:6379"
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$values_file" "$wrong_endpoint_values"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$wrong_endpoint_values" "$chart_defaults" slots-production "$delivery_file" \
  >/dev/null 2>&1; then
  fail 'Helm values 的 Valkey endpoint 与 Terraform delivery 漂移未被拒绝'
fi

drifted_valkey_delivery="$fixture_root/drifted-valkey-delivery.json"
jq '.valkey_active_slot = "b"' "$delivery_file" > "$drifted_valkey_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$drifted_valkey_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey A/B active slot 与用户名、轮换契约漂移未被拒绝'
fi

missing_fingerprint_delivery="$fixture_root/missing-fingerprint-delivery.json"
jq 'del(.valkey_rotation_contract.password_fingerprints.b)' \
  "$delivery_file" > "$missing_fingerprint_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$missing_fingerprint_delivery" \
  >/dev/null 2>&1; then
  fail 'Valkey B 槽 password fingerprint 缺失未被拒绝'
fi

hmac_maintenance_delivery="$fixture_root/hmac-maintenance-delivery.json"
jq '.valkey_rotation_mode = "hmac-maintenance" |
  .valkey_rotation_contract.rotation_mode = "hmac-maintenance"' \
  "$delivery_file" > "$hmac_maintenance_delivery"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$values_file" "$chart_defaults" slots-production "$hmac_maintenance_delivery" \
  >/dev/null 2>&1; then
  fail 'HMAC 停机维护期间仍允许应用发布'
fi

collapsed_delivery="$fixture_root/collapsed-delivery.json"
collapsed_values="$fixture_root/collapsed-values.yaml"
jq '.application_secret_names["worker-runtime-assets"] = .application_secret_names["api-runtime-assets"]' \
  "$delivery_file" > "$collapsed_delivery"
ruby -ryaml -e '
  value = YAML.safe_load(File.binread(ARGV.fetch(0)), aliases: false)
  value.fetch("externalSecrets").fetch("workerRuntimeAssets")["name"] =
    value.fetch("externalSecrets").fetch("apiRuntimeAssets").fetch("name")
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$values_file" "$collapsed_values"
if KUBECTL_BIN=$mock_kubectl \
  "$verifier" "$collapsed_values" "$chart_defaults" slots-production "$collapsed_delivery" \
  >/dev/null 2>&1; then
  fail 'API 与 Worker 运行素材复用同一 Secret 未被拒绝'
fi

printf '%s\n' 'AWS 平台与应用 Secret 实时门禁负向 fixture 通过。'
