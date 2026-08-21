#!/usr/bin/env ruby
# 用内存 plan 和静默证据证明 A/B 状态机会拒绝合并变更、自证和过期证据。
require "digest"
require "json"
require "time"
require_relative "verify-valkey-rotation-plan"

TEST_NOW = Time.iso8601("2026-08-21T00:15:00Z")
CACHE_PREFIX = "module.environment.module.platform.module.cache"

def deep_copy(value)
  JSON.parse(JSON.generate(value))
end

def managed_change(address:, type:, name:, provider_name:, actions:, before:, after:, after_unknown: {}, replace_paths: [])
  {
    "address" => address,
    "mode" => "managed",
    "type" => type,
    "name" => name,
    "provider_name" => provider_name,
    "change" => {
      "actions" => actions,
      "before" => before,
      "after" => after,
      "after_unknown" => after_unknown,
      "replace_paths" => replace_paths,
    },
  }
end

def plan(before_input, after_input, actions, extra_changes = [])
  {
    "resource_changes" => [
      managed_change(
        address: "#{CACHE_PREFIX}.terraform_data.rotation_guard",
        type: "terraform_data",
        name: "rotation_guard",
        provider_name: "terraform.io/builtin/terraform",
        actions: actions,
        before: before_input && { "input" => before_input },
        after: after_input && { "input" => after_input },
      ),
      *extra_changes,
    ],
  }
end

def shared_admission_secret_attributes(version, current: true)
  # 属性集合固定对应 AWS 提供程序 6.57.1 的真实计划结构，避免只测简化对象而产生假阳性。
  name = "slots-prod-primary-rgs-shared-admission-v#{version}"
  arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:#{name}-ABCDEF"
  {
    "arn" => current ? arn : nil,
    "description" => "RGS 共享准入使用的 Valkey ACL、HMAC 与显式根证书；值通过 write-only 参数写入",
    "force_overwrite_replica_secret" => false,
    "id" => current ? arn : nil,
    "kms_key_id" => "arn:aws:kms:ap-southeast-1:123456789012:key/11111111-2222-3333-4444-555555555555",
    "name" => name,
    "name_prefix" => nil,
    "policy" => nil,
    "recovery_window_in_days" => 30,
    "region" => "ap-southeast-1",
    "tags" => {
      "Boundary" => "rgs-shared-admission",
      "Environment" => "prod-primary",
      "ManagedValueByTerraform" => "write-only",
    },
    "tags_all" => {
      "Boundary" => "rgs-shared-admission",
      "Environment" => "prod-primary",
      "ManagedValueByTerraform" => "write-only",
    },
    "type" => nil,
  }
end

def shared_admission_secret_version_attributes(version, current: true)
  name = "slots-prod-primary-rgs-shared-admission-v#{version}"
  secret_arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:#{name}-ABCDEF"
  version_id = "#{version}" * 32
  {
    "arn" => current ? secret_arn : nil,
    "has_secret_string_wo" => current ? true : nil,
    "id" => current ? "#{secret_arn}|#{version_id}" : nil,
    "region" => "ap-southeast-1",
    "secret_arn" => current ? secret_arn : nil,
    "secret_binary" => nil,
    "secret_id" => current ? secret_arn : nil,
    "secret_string" => nil,
    "secret_string_wo" => nil,
    "secret_string_wo_version" => version,
    "version_id" => current ? version_id : nil,
    "version_stages" => current ? ["AWSCURRENT"] : nil,
  }
end

def hmac_entry_plan(before_input, after_input)
  before_version = before_input.fetch("published_secret_version")
  after_version = after_input.fetch("published_secret_version")
  secret_change = managed_change(
    address: "#{CACHE_PREFIX}.aws_secretsmanager_secret.shared_admission",
    type: "aws_secretsmanager_secret",
    name: "shared_admission",
    provider_name: "registry.terraform.io/hashicorp/aws",
    actions: ["create", "delete"],
    before: shared_admission_secret_attributes(before_version),
    after: shared_admission_secret_attributes(after_version, current: false),
    after_unknown: { "arn" => true, "id" => true },
    replace_paths: [["name"]],
  )
  version_change = managed_change(
    address: "#{CACHE_PREFIX}.aws_secretsmanager_secret_version.shared_admission",
    type: "aws_secretsmanager_secret_version",
    name: "shared_admission",
    provider_name: "registry.terraform.io/hashicorp/aws",
    actions: ["delete", "create"],
    before: shared_admission_secret_version_attributes(before_version),
    after: shared_admission_secret_version_attributes(after_version, current: false),
    after_unknown: {
      "arn" => true,
      "has_secret_string_wo" => true,
      "id" => true,
      "secret_arn" => true,
      "secret_id" => true,
      "secret_string_wo" => true,
      "version_id" => true,
      "version_stages" => true,
    },
    replace_paths: [["secret_id"]],
  )
  plan(before_input, after_input, ["update"], [secret_change, version_change])
end

def unrelated_update(address, type, name, provider_name = "registry.terraform.io/hashicorp/aws")
  managed_change(
    address: address,
    type: type,
    name: name,
    provider_name: provider_name,
    actions: ["update"],
    before: { "marker" => "before" },
    after: { "marker" => "after" },
  )
end

def with_computed_resource_fields(payload)
  candidate = deep_copy(payload)
  candidate["resource_changes"][0]["change"]["after_unknown"] = {
    "id" => true,
    "input" => {},
    "output" => true,
  }
  candidate
end

def canonical_evidence(evidence)
  "#{ValkeyRotationPlanContract.canonical_json(evidence)}\n"
end

def bind_evidence(after, evidence)
  payload = canonical_evidence(evidence)
  after["hmac_maintenance_approval"] = {
    "bucket_reset_accepted" => true,
    "evidence_reference" => {
      "bucket" => "slots-hmac-evidence-prod",
      "key" => "prod-primary/hmac-quiesce/run-100.json",
      "version_id" => "evidence-version-100",
      "sha256" => Digest::SHA256.hexdigest(payload),
    },
  }
  payload
end

def expect_accept(name, payload, evidence: nil)
  ValkeyRotationPlanContract.verify(payload, evidence_payload: evidence, now: TEST_NOW)
rescue ValkeyRotationPlanContract::Violation => error
  abort "Valkey rotation plan test: 正样例 #{name} 被拒绝: #{error.message}"
end

def expect_reject(name, payload, evidence: nil)
  ValkeyRotationPlanContract.verify(payload, evidence_payload: evidence, now: TEST_NOW)
  abort "Valkey rotation plan test: 危险变体 #{name} 被错误接受"
rescue ValkeyRotationPlanContract::Violation
  nil
end

def hpa_manifest
  {
    "apiVersion" => "autoscaling/v2",
    "kind" => "HorizontalPodAutoscaler",
    "metadata" => {
      "name" => "slots-rgs",
      "namespace" => "slots-production",
      "labels" => { "app.kubernetes.io/instance" => "slots" },
      "annotations" => { "slots.example.com/owner" => "platform" },
    },
    "spec" => {
      "minReplicas" => 3,
      "maxReplicas" => 10,
      "scaleTargetRef" => {
        "apiVersion" => "apps/v1",
        "kind" => "Deployment",
        "name" => "slots-rgs",
      },
      "metrics" => [
        {
          "type" => "Resource",
          "resource" => {
            "name" => "cpu",
            "target" => { "type" => "Utilization", "averageUtilization" => 60 },
          },
        },
      ],
    },
  }
end

def attestation(before, after)
  manifest = hpa_manifest
  {
    "schema" => "slots-game/hmac-quiesce-attestation/v1",
    "producer" => {
      "repository" => "example/slots-game",
      "workflow_ref" => "example/slots-game/.github/workflows/hmac.yml@refs/heads/main",
      "source_sha" => "1" * 40,
      "run_id" => "100",
      "run_attempt" => "1",
      "environment" => "prod-primary",
      "role_arn" => "arn:aws:iam::123456789012:role/slots-hmac-quiesce",
    },
    "target" => deep_copy(before.fetch("target_identity")),
    "source_delivery" => {
      "bucket" => "slots-delivery-prod",
      "key" => "prod-primary/application-platform.json",
      "version_id" => "delivery-version-42",
      "sha256" => "d" * 64,
    },
    "rotation" => {
      "observed_active_slot" => before.fetch("active_slot"),
      "observed_secret_version" => before.fetch("published_secret_version"),
      "observed_hmac_key_fingerprint" => before.fetch("hmac_key_fingerprint"),
      "target_secret_version" => after.fetch("published_secret_version"),
    },
    "quiescence" => {
      "observed_at" => "2026-08-21T00:00:00Z",
      "expires_at" => "2026-08-21T00:45:00Z",
      "lock" => {
        "name" => "slots-hmac-maintenance-lock",
        "uid" => "55555555-5555-5555-5555-555555555555",
      },
      "api" => {
        "deployment_name" => "slots-rgs",
        "uid" => "11111111-1111-1111-1111-111111111111",
        "hpa_name" => "slots-rgs",
        "hpa_uid" => "22222222-2222-2222-2222-222222222222",
        "hpa_spec_sha256" => Digest::SHA256.hexdigest(ValkeyRotationPlanContract.canonical_json(manifest.fetch("spec"))),
        "original_replicas" => 3,
        "hpa_restore_manifest" => manifest,
        "desired" => 0,
        "ready" => 0,
        "available" => 0,
        "pod_count" => 0,
      },
      "worker" => {
        "deployment_name" => "slots-worker",
        "uid" => "33333333-3333-3333-3333-333333333333",
        "hpa_name" => "slots-worker",
        "hpa_uid" => "44444444-4444-4444-4444-444444444444",
        "desired" => 2,
        "ready" => 2,
        "available" => 2,
        "pod_count" => 2,
        "ready_pod_count" => 2,
      },
    },
  }
end

base = {
  "contract_version" => "1.0.0",
  "active_slot" => "a",
  "rotation_mode" => "steady",
  "password_versions" => { "a" => 1, "b" => 1 },
  "password_fingerprints" => { "a" => "a" * 64, "b" => "b" * 64 },
  "reset_approvals" => {},
  "published_secret_version" => 1,
  "hmac_key_fingerprint" => "c" * 64,
  "hmac_maintenance_approval" => nil,
  "hmac_bucket_continuity" => "密码轮换期间禁止改变 HMAC key",
  "target_identity" => {
    "environment" => "prod-primary",
    "aws_account_id" => "123456789012",
    "aws_region" => "ap-southeast-1",
    "eks_cluster_name" => "slots-prod-primary",
    "kubernetes_namespace" => "slots-production",
    "helm_release_name" => "slots",
  },
}

expect_accept("首次创建", plan(nil, base, ["create"]))
expect_accept("Terraform data 计算属性未知但 input 完全已知", with_computed_resource_fields(plan(nil, base, ["create"])))
expect_accept("普通无变更", plan(base, base, ["no-op"]))

unknown_input = plan(base, base, ["update"])
unknown_input["resource_changes"][0]["change"]["after_unknown"] = {
  "input" => { "active_slot" => true },
}
expect_reject("rotation_guard input 存在未知字段", unknown_input)

prepared_b = deep_copy(base)
prepared_b["rotation_mode"] = "password-rotation"
prepared_b["password_versions"]["b"] = 2
prepared_b["password_fingerprints"]["b"] = "d" * 64
prepared_b["reset_approvals"]["b"] = {
  "approved_password_version" => 2,
  "observed_active_slot" => "a",
  "observed_secret_version" => 1,
  "old_slot_connections_drained" => true,
  "hmac_key_unchanged" => true,
  "live_evidence_reference" => "change/VALKEY-0001",
}
expect_accept("准备非活动 B 槽", plan(base, prepared_b, ["update"]))

switched_b = deep_copy(prepared_b)
switched_b["active_slot"] = "b"
switched_b["published_secret_version"] = 2
expect_accept("发布已准备的 B 槽", plan(prepared_b, switched_b, ["update"]))

retired_a = deep_copy(switched_b)
retired_a["password_versions"]["a"] = 2
retired_a["password_fingerprints"]["a"] = "e" * 64
retired_a["reset_approvals"]["a"] = {
  "approved_password_version" => 2,
  "observed_active_slot" => "b",
  "observed_secret_version" => 2,
  "old_slot_connections_drained" => true,
  "hmac_key_unchanged" => true,
  "live_evidence_reference" => "change/VALKEY-0002",
}
expect_accept("排空后退休 A 槽", plan(switched_b, retired_a, ["update"]))

active_reset = deep_copy(base)
active_reset["rotation_mode"] = "password-rotation"
active_reset["password_versions"]["a"] = 2
active_reset["password_fingerprints"]["a"] = "e" * 64
active_reset["reset_approvals"]["a"] = retired_a["reset_approvals"]["a"]
expect_reject("用 tfvars 自证后重置活动 A 槽", plan(base, active_reset, ["update"]))

switch_and_reset = deep_copy(prepared_b)
switch_and_reset["active_slot"] = "b"
switch_and_reset["published_secret_version"] = 2
switch_and_reset["password_versions"]["b"] = 3
switch_and_reset["password_fingerprints"]["b"] = "f" * 64
switch_and_reset["reset_approvals"]["b"]["approved_password_version"] = 3
expect_reject("切换活动槽同时修改其密码", plan(prepared_b, switch_and_reset, ["update"]))

version_without_password = deep_copy(base)
version_without_password["password_versions"]["b"] = 2
version_without_password["reset_approvals"]["b"] = prepared_b["reset_approvals"]["b"]
expect_reject("只伪造密码版本", plan(base, version_without_password, ["update"]))

password_without_version = deep_copy(base)
password_without_version["password_fingerprints"]["b"] = "d" * 64
expect_reject("改变密码但不递增版本", plan(base, password_without_version, ["update"]))

hmac_reset = deep_copy(base)
hmac_reset["hmac_key_fingerprint"] = "f" * 64
expect_reject("密码流程混入 HMAC 桶重置", plan(base, hmac_reset, ["update"]))

switch_and_hmac_reset = deep_copy(prepared_b)
switch_and_hmac_reset["active_slot"] = "b"
switch_and_hmac_reset["published_secret_version"] = 2
switch_and_hmac_reset["hmac_key_fingerprint"] = "f" * 64
expect_reject("首次 A 到 B 切换同时更换 HMAC", plan(prepared_b, switch_and_hmac_reset, ["update"]))

hmac_maintenance = deep_copy(base)
hmac_maintenance["rotation_mode"] = "hmac-maintenance"
hmac_maintenance["hmac_key_fingerprint"] = "f" * 64
hmac_maintenance["published_secret_version"] = 3
evidence_hash = attestation(base, hmac_maintenance)
evidence_payload = bind_evidence(hmac_maintenance, evidence_hash)
hmac_maintenance_plan = hmac_entry_plan(base, hmac_maintenance)
expect_accept("单个已保存 plan 内执行受证据绑定的 HMAC 维护", hmac_maintenance_plan, evidence: evidence_payload)

intrusive_resources = {
  "HMAC 入口夹带 RDS 变化" => unrelated_update(
    "module.environment.module.platform.module.rds.aws_db_instance.this", "aws_db_instance", "this"
  ),
  "HMAC 入口夹带 EKS 变化" => unrelated_update(
    "module.environment.module.platform.module.eks.aws_eks_cluster.this", "aws_eks_cluster", "this"
  ),
  "HMAC 入口夹带 IAM 变化" => unrelated_update(
    "module.environment.module.platform.module.secrets.aws_iam_role_policy.controller", "aws_iam_role_policy", "controller"
  ),
  "HMAC 入口夹带网络变化" => unrelated_update(
    "module.environment.module.platform.module.network.aws_security_group.alb", "aws_security_group", "alb"
  ),
  "HMAC 入口夹带其他 Secret 变化" => unrelated_update(
    "module.environment.module.platform.module.secrets.aws_secretsmanager_secret.application[\"api-runtime-assets\"]",
    "aws_secretsmanager_secret", "application"
  ),
  "HMAC 入口夹带 Valkey ACL 用户变化" => unrelated_update(
    "#{CACHE_PREFIX}.aws_elasticache_user.rate_limiter_a", "aws_elasticache_user", "rate_limiter_a"
  ),
}
intrusive_resources.each do |name, resource|
  candidate = deep_copy(hmac_maintenance_plan)
  candidate.fetch("resource_changes") << resource
  expect_reject(name, candidate, evidence: evidence_payload)
end

missing_secret_version = deep_copy(hmac_maintenance_plan)
missing_secret_version.fetch("resource_changes").reject! do |resource|
  resource.fetch("address").end_with?("aws_secretsmanager_secret_version.shared_admission")
end
expect_reject("HMAC 入口遗漏 SecretVersion 替换", missing_secret_version, evidence: evidence_payload)

wrong_secret_action = deep_copy(hmac_maintenance_plan)
wrong_secret = wrong_secret_action.fetch("resource_changes").find do |resource|
  resource.fetch("address").end_with?("aws_secretsmanager_secret.shared_admission")
end
wrong_secret.fetch("change")["actions"] = ["update"]
expect_reject("HMAC 入口 Secret 没有按固定顺序替换", wrong_secret_action, evidence: evidence_payload)

wrong_version_action = deep_copy(hmac_maintenance_plan)
wrong_version = wrong_version_action.fetch("resource_changes").find do |resource|
  resource.fetch("address").end_with?("aws_secretsmanager_secret_version.shared_admission")
end
wrong_version.fetch("change")["actions"] = ["create", "delete"]
expect_reject("HMAC 入口 SecretVersion 替换顺序漂移", wrong_version_action, evidence: evidence_payload)

wrong_write_only_version = deep_copy(hmac_maintenance_plan)
wrong_version = wrong_write_only_version.fetch("resource_changes").find do |resource|
  resource.fetch("address").end_with?("aws_secretsmanager_secret_version.shared_admission")
end
wrong_version.fetch("change").fetch("after")["secret_string_wo_version"] = 5
expect_reject("HMAC 入口 write-only 版本没有绑定 guard", wrong_write_only_version, evidence: evidence_payload)

secret_kms_change = deep_copy(hmac_maintenance_plan)
changed_secret = secret_kms_change.fetch("resource_changes").find do |resource|
  resource.fetch("address").end_with?("aws_secretsmanager_secret.shared_admission")
end
changed_secret.fetch("change").fetch("after")["kms_key_id"] = "arn:aws:kms:ap-southeast-1:123456789012:key/99999999-2222-3333-4444-555555555555"
expect_reject("HMAC 入口夹带 Secret KMS 普通配置变化", secret_kms_change, evidence: evidence_payload)

hmac_maintenance_exited = deep_copy(hmac_maintenance)
hmac_maintenance_exited["rotation_mode"] = "steady"
hmac_maintenance_exited["hmac_maintenance_approval"] = nil
expect_accept("单独退出 HMAC 维护", plan(hmac_maintenance, hmac_maintenance_exited, ["update"]))

hmac_exit_with_network_change = plan(
  hmac_maintenance,
  hmac_maintenance_exited,
  ["update"],
  [unrelated_update("module.environment.module.platform.module.network.aws_vpc.this", "aws_vpc", "this")],
)
expect_reject("HMAC 出口夹带网络变化", hmac_exit_with_network_change)

expect_reject("HMAC 维护缺少独立证据", hmac_entry_plan(base, hmac_maintenance))
expect_reject("HMAC 维护状态 no-op", plan(hmac_maintenance, hmac_maintenance, ["no-op"]))
expect_reject("退出 HMAC 维护时复用旧证据", plan(hmac_maintenance, hmac_maintenance_exited, ["update"]), evidence: evidence_payload)
expect_reject("普通轮换携带 HMAC 证据", plan(base, base, ["no-op"]), evidence: evidence_payload)

self_certified_approval = deep_copy(hmac_maintenance)
self_certified_approval["hmac_maintenance_approval"]["application_replicas_scaled_to_zero"] = true
expect_reject("HMAC 批准企图恢复 tfvars 零副本自证字段", hmac_entry_plan(base, self_certified_approval), evidence: evidence_payload)

hmac_with_password_change = deep_copy(hmac_maintenance)
hmac_with_password_change["password_versions"]["b"] = 2
hmac_with_password_change["password_fingerprints"]["b"] = "8" * 64
hmac_with_password_change["reset_approvals"]["b"] = prepared_b["reset_approvals"]["b"]
hmac_with_password_evidence = attestation(base, hmac_with_password_change)
hmac_with_password_payload = bind_evidence(hmac_with_password_change, hmac_with_password_evidence)
expect_reject("HMAC 维护同时轮换非活动槽密码", hmac_entry_plan(base, hmac_with_password_change), evidence: hmac_with_password_payload)

hmac_with_target_change = deep_copy(hmac_maintenance)
hmac_with_target_change["target_identity"]["kubernetes_namespace"] = "other"
hmac_with_target_evidence = attestation(base, hmac_with_target_change)
hmac_with_target_payload = bind_evidence(hmac_with_target_change, hmac_with_target_evidence)
expect_reject("HMAC 维护同时改写持久化目标", hmac_entry_plan(base, hmac_with_target_change), evidence: hmac_with_target_payload)

hmac_without_change = deep_copy(hmac_maintenance)
hmac_without_change["hmac_key_fingerprint"] = base["hmac_key_fingerprint"]
no_change_evidence = attestation(base, hmac_without_change)
no_change_payload = bind_evidence(hmac_without_change, no_change_evidence)
expect_reject("进入维护但不更换 HMAC", hmac_entry_plan(base, hmac_without_change), evidence: no_change_payload)

wrong_hash = deep_copy(hmac_maintenance)
wrong_hash["hmac_maintenance_approval"]["evidence_reference"]["sha256"] = "0" * 64
expect_reject("批准 SHA-256 与证据不匹配", hmac_entry_plan(base, wrong_hash), evidence: evidence_payload)

dangerous_evidence_variants = {
  "证据自证其他活动槽" => lambda { |value| value["rotation"]["observed_active_slot"] = "b" },
  "证据自证其他 Secret 前版本" => lambda { |value| value["rotation"]["observed_secret_version"] = 3 },
  "证据自证其他 HMAC 前指纹" => lambda { |value| value["rotation"]["observed_hmac_key_fingerprint"] = "9" * 64 },
  "证据目标未精确递增两版" => lambda { |value| value["rotation"]["target_secret_version"] = 5 },
  "证据目标 namespace 与 Terraform 前态不同" => lambda { |value| value["target"]["kubernetes_namespace"] = "other" },
  "证据已过期" => lambda { |value| value["quiescence"]["expires_at"] = "2026-08-21T00:10:00Z" },
  "证据有效期超过六十分钟" => lambda { |value| value["quiescence"]["expires_at"] = "2026-08-21T01:01:00Z" },
  "API 实际仍有 Pod" => lambda { |value| value["quiescence"]["api"]["pod_count"] = 1 },
  "API 原始副本数不可恢复" => lambda { |value| value["quiescence"]["api"]["original_replicas"] = 0 },
  "Worker 在维护期间不健康" => lambda { |value| value["quiescence"]["worker"]["ready"] = 1 },
  "HPA 恢复 manifest 目标错误" => lambda { |value| value["quiescence"]["api"]["hpa_restore_manifest"]["spec"]["scaleTargetRef"]["name"] = "other" },
  "证据包含未批准字段" => lambda { |value| value["self_certified"] = true },
  "维护锁名称不符合固定契约" => lambda { |value| value["quiescence"]["lock"]["name"] = "other-lock" },
}

dangerous_evidence_variants.each do |name, mutate|
  candidate_after = deep_copy(hmac_maintenance)
  candidate_evidence = deep_copy(evidence_hash)
  mutate.call(candidate_evidence)
  candidate_payload = bind_evidence(candidate_after, candidate_evidence)
  expect_reject(name, hmac_entry_plan(base, candidate_after), evidence: candidate_payload)
end

noncanonical_payload = JSON.pretty_generate(evidence_hash)
noncanonical_after = deep_copy(hmac_maintenance)
noncanonical_after["hmac_maintenance_approval"]["evidence_reference"]["sha256"] = Digest::SHA256.hexdigest(noncanonical_payload)
expect_reject("非规范化 JSON 证据", hmac_entry_plan(base, noncanonical_after), evidence: noncanonical_payload)

switch_skip_secret = deep_copy(prepared_b)
switch_skip_secret["active_slot"] = "b"
switch_skip_secret["published_secret_version"] = 4
expect_reject("切槽时跳过 Secret 版本", plan(prepared_b, switch_skip_secret, ["update"]))

approval_only = deep_copy(prepared_b)
approval_only["reset_approvals"]["b"]["live_evidence_reference"] = "change/VALKEY-9999"
expect_reject("没有密码变更却改写批准", plan(prepared_b, approval_only, ["update"]))

puts "Valkey rotation plan test: passed"
