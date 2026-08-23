#!/bin/sh

# 只校验 Kubernetes Secret 的名称、不可变标志和 key 集合，不输出或解码任何值。
set -eu

fail() {
  printf '%s\n' "AWS 应用 Secret 实时门禁失败：$*" >&2
  exit 1
}

test "$#" -eq 4 || fail '必须传入 Helm values、Chart 默认 values、namespace 和 Terraform delivery JSON'
values_file=$1
chart_defaults_file=$2
namespace=$3
delivery_file=$4
kubectl_binary=${KUBECTL_BIN:-kubectl}

test -f "$values_file" || fail 'Helm values 不存在'
test -f "$chart_defaults_file" || fail 'Chart 默认 values 不存在'
test -f "$delivery_file" || fail 'Terraform delivery JSON 不存在'
printf '%s\n' "$namespace" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$' || \
  fail 'namespace 不是严格 DNS label'
command -v ruby >/dev/null 2>&1 || fail '缺少 ruby'
command -v jq >/dev/null 2>&1 || fail '缺少 jq'
command -v "$kubectl_binary" >/dev/null 2>&1 || fail "缺少命令：$kubectl_binary"

fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/slots-live-secret-gate.XXXXXX")
cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

requirements_file="$fixture_root/requirements.json"
ruby -ryaml -rjson -e '
  def deep_merge(base, override)
    base.merge(override) do |_key, old_value, new_value|
      old_value.is_a?(Hash) && new_value.is_a?(Hash) ? deep_merge(old_value, new_value) : new_value
    end
  end

  defaults = YAML.safe_load(File.binread(ARGV.fetch(0)), permitted_classes: [],
    permitted_symbols: [], aliases: false)
  override = YAML.safe_load(File.binread(ARGV.fetch(1)), permitted_classes: [],
    permitted_symbols: [], aliases: false)
  abort "Chart 默认 values 顶层不是对象" unless defaults.is_a?(Hash)
  abort "Helm values 顶层不是对象" unless override.is_a?(Hash)
  values = deep_merge(defaults, override)
  delivery = JSON.parse(File.binread(ARGV.fetch(2)))
  abort "Helm values 顶层不是对象" unless values.is_a?(Hash)
  external = values.fetch("externalSecrets")
  abort "externalSecrets 不是对象" unless external.is_a?(Hash)
  application_names = delivery.fetch("application_secret_names")
  abort "application_secret_names 不是对象" unless application_names.is_a?(Hash)

  active_slot = delivery.fetch("valkey_active_slot")
  user_names = delivery.fetch("valkey_user_names")
  password_versions = delivery.fetch("valkey_password_versions")
  rotation = delivery.fetch("valkey_rotation_contract")
  active_user_name = delivery.fetch("valkey_user_name")
  configured_endpoint = values.fetch("rgs").fetch("sharedAdmission").fetch("endpointURL")
  abort "Helm values 的 Valkey endpoint 与 Terraform delivery 不一致" unless
    configured_endpoint == delivery.fetch("valkey_endpoint_url")
  abort "Valkey active slot 不合法" unless %w[a b].include?(active_slot)
  abort "Valkey A/B 用户集合不完整" unless
    user_names.is_a?(Hash) && user_names.keys.sort == %w[a b] &&
      user_names.values.uniq.length == 2 &&
      user_names.values.all? { |name| name.match?(/\A[a-z0-9][a-z0-9-]{0,39}\z/) }
  abort "Valkey A/B 密码版本集合不完整" unless
    password_versions.is_a?(Hash) && password_versions.keys.sort == %w[a b] &&
      password_versions.values.all? { |version| version.is_a?(Integer) && version >= 1 }
  abort "Valkey 活动用户名与槽位不一致" unless active_user_name == user_names.fetch(active_slot)
  expected_rotation_keys = %w[
    active_slot
    active_user_name
    acl_schema_dual_permissions_allowed
    acl_schema_migration_order
    acl_schema_migration_requires_quiesced
    acl_schema_rolling_compatible
    acl_schema_transition
    acl_schema_version
    application_release_allowed
    both_users_remain_in_user_group
    contract_version
    hmac_bucket_reset_requires_separate_change
    hmac_maintenance_forbids_parallel_rollout
    hmac_maintenance_attestation_schema
    hmac_maintenance_evidence_maximum_ttl_seconds
    hmac_maintenance_exit_requires_separate_plan
    hmac_maintenance_persistent_lock_name
    hmac_maintenance_requires_zero_replicas
    hmac_maintenance_single_attested_plan
    hmac_maintenance_target_identity
    hmac_key_fingerprint
    old_slot_reset_requires_live_evidence
    maintenance_in_progress
    password_fingerprints
    password_versions
    published_secret_version
    rotation_mode
  ]
  abort "Valkey A/B 轮换字段集合不完整" unless
    rotation.is_a?(Hash) && rotation.keys.sort == expected_rotation_keys.sort
  abort "Valkey A/B 轮换契约与 delivery 不一致" unless
    rotation.fetch("contract_version") == "1.0.0" &&
      rotation.fetch("active_slot") == active_slot &&
      rotation.fetch("active_user_name") == active_user_name &&
      rotation.fetch("password_versions") == password_versions &&
      rotation.fetch("rotation_mode") == delivery.fetch("valkey_rotation_mode") &&
      rotation.fetch("application_release_allowed") == delivery.fetch("application_release_allowed") &&
      rotation.fetch("maintenance_in_progress") == delivery.fetch("maintenance_in_progress") &&
      rotation.fetch("application_release_allowed") == true &&
      rotation.fetch("maintenance_in_progress") == false &&
      rotation.fetch("both_users_remain_in_user_group") == true &&
      rotation.fetch("old_slot_reset_requires_live_evidence") == true &&
      rotation.fetch("hmac_bucket_reset_requires_separate_change") == true &&
      rotation.fetch("hmac_maintenance_requires_zero_replicas") == true &&
      rotation.fetch("hmac_maintenance_forbids_parallel_rollout") == true &&
      rotation.fetch("hmac_maintenance_single_attested_plan") == true &&
      rotation.fetch("hmac_maintenance_exit_requires_separate_plan") == true &&
      rotation.fetch("hmac_maintenance_attestation_schema") == "slots-game/hmac-quiesce-attestation/v1" &&
      rotation.fetch("hmac_maintenance_evidence_maximum_ttl_seconds") == 3600 &&
      rotation.fetch("hmac_maintenance_persistent_lock_name") == "slots-hmac-maintenance-lock" &&
      rotation.fetch("acl_schema_version") == "v2" &&
      rotation.fetch("acl_schema_transition") == "maintenance-quiesced" &&
      rotation.fetch("acl_schema_migration_requires_quiesced") == true &&
      rotation.fetch("acl_schema_rolling_compatible") == false &&
      rotation.fetch("acl_schema_dual_permissions_allowed") == false &&
      rotation.fetch("acl_schema_migration_order") == %w[
        stop-new-intents drain-old-api-pods apply-v2-acl start-v2-runtime
        verify-v2-shared-admission resume-new-intents
      ] &&
      rotation.fetch("hmac_maintenance_target_identity") == {
        "environment" => delivery.fetch("environment"),
        "aws_account_id" => delivery.fetch("aws_account_id"),
        "aws_region" => delivery.fetch("aws_region"),
        "eks_cluster_name" => delivery.fetch("cluster_name"),
        "kubernetes_namespace" => delivery.fetch("application_namespace"),
        "helm_release_name" => delivery.fetch("helm_release_name"),
      }
  abort "HMAC 停机维护期间禁止应用发布" if rotation.fetch("rotation_mode") == "hmac-maintenance"
  abort "Valkey rotation mode 不允许应用发布" unless
    %w[steady password-rotation].include?(rotation.fetch("rotation_mode"))
  password_fingerprints = rotation.fetch("password_fingerprints")
  abort "Valkey A/B 密码 fingerprint 集合不完整" unless
    password_fingerprints.is_a?(Hash) && password_fingerprints.keys.sort == %w[a b] &&
      password_fingerprints.values.all? { |fingerprint| fingerprint.match?(/\A[0-9a-f]{64}\z/) }
  abort "共享准入 HMAC fingerprint 不合法" unless
    rotation.fetch("hmac_key_fingerprint").match?(/\A[0-9a-f]{64}\z/)
  secret_version = delivery.fetch("valkey_secret_name").match(/-v([1-9][0-9]*)\z/)&.captures&.first&.to_i
  abort "Valkey Secret 名称无法提取版本" unless secret_version
  abort "Valkey Secret 发布版本与轮换契约不一致" unless
    rotation.fetch("published_secret_version") == secret_version
  abort "Valkey Secret 版本与活动槽奇偶契约不一致" unless
    (active_slot == "a" && secret_version.odd?) || (active_slot == "b" && secret_version.even?)
  shared_admission_keys = external.fetch("sharedAdmission").fetch("keys")
  abort "共享准入 Secret 必须使用规范 username key" unless
    shared_admission_keys.is_a?(Hash) && shared_admission_keys.fetch("username") == "username"

  definitions = [
    ["runtimeDatabase", application_names.fetch("runtime-database"),
      [external.fetch("runtimeDatabase").fetch("urlKey")]],
    ["migratorDatabase", application_names.fetch("migrator-database"),
      [external.fetch("migratorDatabase").fetch("urlKey")]],
    ["operationsBearer", application_names.fetch("operations-bearer"),
      [external.fetch("operationsBearer").fetch("key")]],
    ["sharedAdmission", delivery.fetch("valkey_secret_name"),
      shared_admission_keys.values],
    ["apiRuntimeAssets", application_names.fetch("api-runtime-assets"),
      external.fetch("apiRuntimeAssets").fetch("keys").values +
        external.fetch("apiRuntimeAssets").fetch("additionalItems", []).map { |item| item.fetch("key") }],
    ["workerRuntimeAssets", application_names.fetch("worker-runtime-assets"),
      external.fetch("workerRuntimeAssets").fetch("keys").values +
        external.fetch("workerRuntimeAssets").fetch("additionalItems", []).map { |item| item.fetch("key") }],
  ]

  requirements = definitions.map do |section, expected_name, keys|
    configured_name = external.fetch(section).fetch("name")
    abort "#{section} 与 Terraform delivery Secret 名不一致" unless configured_name == expected_name
    abort "#{section} Secret 名没有以 -v<正整数> 版本化" unless
      configured_name.match?(/\A[a-z0-9]([-a-z0-9]{0,52}[a-z0-9])?-v[1-9][0-9]*\z/) &&
        configured_name.length <= 63
    abort "#{section} 没有必需 key" unless keys.is_a?(Array) && !keys.empty?
    abort "#{section} 包含非规范 Secret key" unless
      keys.all? { |key| key.is_a?(String) && key.match?(/\A[A-Za-z0-9._-]{1,253}\z/) }
    abort "#{section} 包含重复 Secret key" unless keys.uniq.length == keys.length
    { "section" => section, "name" => configured_name, "keys" => keys.sort }
  end
  abort "六个职责必须使用六个不同的版本化 Secret" unless
    requirements.map { |item| item.fetch("name") }.uniq.length == 6
  STDOUT.write(JSON.generate(requirements))
' "$chart_defaults_file" "$values_file" "$delivery_file" > "$requirements_file" || \
  fail 'Helm values 与 Terraform delivery 交接契约失败'

jq -e 'type == "array" and length == 6' "$requirements_file" >/dev/null || \
  fail 'Secret 要求列表不完整'
items_file="$fixture_root/requirements.jsonl"
jq -c '.[]' "$requirements_file" > "$items_file"

item_index=0
while IFS= read -r requirement; do
  item_index=$((item_index + 1))
  section=$(printf '%s\n' "$requirement" | jq -er '.section') || fail 'Secret 职责为空'
  secret_name=$(printf '%s\n' "$requirement" | jq -er '.name') || fail 'Secret 名为空'
  required_keys=$(printf '%s\n' "$requirement" | jq -c '.keys') || fail 'Secret key 列表无效'
  secret_json=$("$kubectl_binary" -n "$namespace" get secret "$secret_name" -o json) || \
    fail "$section 的原生 Secret 尚未同步"
  printf '%s\n' "$secret_json" | jq -e \
    --arg namespace "$namespace" --arg name "$secret_name" --argjson keys "$required_keys" '
    . as $secret |
    $secret.apiVersion == "v1" and
    $secret.kind == "Secret" and
    $secret.metadata.namespace == $namespace and
    $secret.metadata.name == $name and
    $secret.type == "Opaque" and
    $secret.immutable == true and
    all($keys[];
      . as $key |
      ($secret.data[$key] | type == "string" and length > 0)
    )
  ' >/dev/null || fail "$section 的 Secret 不可变标志或必需 key 不完整"
  unset secret_json
done < "$items_file"

test "$item_index" -eq 6 || fail '未校验全部六个应用 Secret'
printf '%s\n' 'AWS 应用 Secret 实时门禁通过。'
