#!/usr/bin/env ruby
# 读取 Terraform plan JSON，用前后状态和版本化实时证据强制 Valkey A/B 轮换顺序。
require "digest"
require "json"
require "optparse"
require "time"

module ValkeyRotationPlanContract
  class Violation < StandardError; end

  HMAC_SECRET_REPLACEMENT_ACTIONS = [["create", "delete"]].freeze
  HMAC_SECRET_VERSION_REPLACEMENT_ACTIONS = [["delete", "create"]].freeze
  LEGACY_SHARED_ADMISSION_ACL = "on ~rgs:shared-admission:v1:* -@all +evalsha +eval +time +hmget +hset +pexpire +ping +hello +auth +client|setname +client|setinfo".freeze
  PRE_ECONOMIC_SHARED_ADMISSION_ACL = "on ~rgs:shared-admission:v2:* -@all +evalsha +eval +get +pttl +set +ping +hello +auth +client|setname +client|setinfo".freeze
  CURRENT_SHARED_ADMISSION_ACL = "on ~rgs:shared-admission:v2:* -@all +evalsha +eval +get +pttl +set +time +mset +pexpire +ping +hello +auth +client|setname +client|setinfo".freeze
  SHARED_ADMISSION_SECRET_ATTRIBUTE_KEYS = %w[
    arn description force_overwrite_replica_secret id kms_key_id name name_prefix policy
    recovery_window_in_days region tags tags_all type
  ].freeze
  SHARED_ADMISSION_SECRET_VERSION_ATTRIBUTE_KEYS = %w[
    arn has_secret_string_wo id region secret_arn secret_binary secret_id secret_string
    secret_string_wo secret_string_wo_version version_id version_stages
  ].freeze

  module_function

  def assert(condition, message)
    raise Violation, message unless condition
  end

  def assert_exact_keys(value, expected, label)
    assert(value.is_a?(Hash), "#{label}必须是对象")
    assert(value.keys.sort == expected.sort, "#{label}字段集不符合固定契约")
  end

  def assert_string(value, label, pattern = nil, maximum = 1024)
    assert(value.is_a?(String) && !value.empty? && value.bytesize <= maximum, "#{label}必须是非空字符串")
    assert(pattern.nil? || value.match?(pattern), "#{label}格式不合法")
  end

  def assert_integer(value, label, minimum = 0)
    assert(value.is_a?(Numeric) && value.to_i == value && value >= minimum, "#{label}必须是不小于 #{minimum} 的整数")
  end

  def unknown?(value)
    case value
    when Hash
      value.values.any? { |child| unknown?(child) }
    when Array
      value.any? { |child| unknown?(child) }
    else
      value == true
    end
  end

  def canonicalize(value)
    case value
    when Hash
      value.keys.sort.to_h { |key| [key, canonicalize(value.fetch(key))] }
    when Array
      value.map { |item| canonicalize(item) }
    else
      value
    end
  end

  def canonical_json(value)
    JSON.generate(canonicalize(value))
  end

  def validate_reference(reference, label)
    assert_exact_keys(reference, %w[bucket key sha256 version_id], label)
    assert_string(reference["bucket"], "#{label}.bucket", /\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\z/, 63)
    assert_string(reference["key"], "#{label}.key", /\A[^\x00-\x1f\x7f]+\z/, 1024)
    assert_string(reference["version_id"], "#{label}.version_id", /\A\S+\z/, 1024)
    assert_string(reference["sha256"], "#{label}.sha256", /\A[0-9a-f]{64}\z/, 64)
  end

  def validate_hmac_approval(approval)
    assert_exact_keys(approval, %w[bucket_reset_accepted evidence_reference], "HMAC 维护批准")
    assert(approval["bucket_reset_accepted"] == true, "HMAC 维护没有接受限流桶重置影响")
    validate_reference(approval["evidence_reference"], "HMAC 静默证据引用")
  end

  def validate_target_identity(identity)
    expected = %w[aws_account_id aws_region eks_cluster_name environment helm_release_name kubernetes_namespace]
    assert_exact_keys(identity, expected, "Terraform 目标身份")
    assert_string(identity["environment"], "Terraform environment", /\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\z/, 63)
    assert_string(identity["aws_account_id"], "Terraform AWS account", /\A[0-9]{12}\z/, 12)
    assert_string(identity["aws_region"], "Terraform AWS region", /\A[a-z]{2}(-gov)?-[a-z]+-[0-9]\z/, 32)
    assert_string(identity["eks_cluster_name"], "Terraform EKS cluster", /\A[0-9A-Za-z][0-9A-Za-z_-]{0,99}\z/, 100)
    assert_string(identity["kubernetes_namespace"], "Terraform Kubernetes namespace", /\A[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\z/, 63)
    assert_string(identity["helm_release_name"], "Terraform Helm release", /\A[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?\z/, 53)
  end

  def validate_shape(input)
    expected = %w[
      active_slot contract_version hmac_bucket_continuity hmac_key_fingerprint
      hmac_maintenance_approval password_fingerprints password_versions
      published_secret_version reset_approvals rotation_mode target_identity
    ]
    assert_exact_keys(input, expected, "rotation_guard input")
    assert(input["contract_version"] == "1.0.0", "A/B 轮换契约版本不受支持")
    assert(%w[a b].include?(input["active_slot"]), "活动槽必须是 a 或 b")
    assert(%w[steady password-rotation hmac-maintenance].include?(input["rotation_mode"]), "轮换模式不合法")
    assert(input["hmac_bucket_continuity"] == "密码轮换期间禁止改变 HMAC key", "HMAC 桶连续性常量被篡改")
    validate_target_identity(input["target_identity"])

    versions = input["password_versions"]
    fingerprints = input["password_fingerprints"]
    approvals = input["reset_approvals"]
    assert_exact_keys(versions, %w[a b], "密码版本集合")
    assert_exact_keys(fingerprints, %w[a b], "密码 fingerprint 集合")
    assert(approvals.is_a?(Hash), "槽位重置批准必须是对象")
    versions.each_value { |version| assert_integer(version, "密码版本", 1) }
    fingerprints.each_value do |fingerprint|
      assert_string(fingerprint, "密码 fingerprint", /\A[0-9a-f]{64}\z/, 64)
    end
    assert_string(input["hmac_key_fingerprint"], "HMAC fingerprint", /\A[0-9a-f]{64}\z/, 64)

    secret_version = input["published_secret_version"]
    assert_integer(secret_version, "Secret 版本", 1)
    parity_valid = (input["active_slot"] == "a" && secret_version.to_i.odd?) ||
      (input["active_slot"] == "b" && secret_version.to_i.even?)
    assert(parity_valid, "Secret 版本与活动槽奇偶契约不一致")

    hmac_approval = input["hmac_maintenance_approval"]
    if input["rotation_mode"] == "hmac-maintenance"
      validate_hmac_approval(hmac_approval)
    else
      assert(hmac_approval.nil?, "非 HMAC 维护模式禁止携带 HMAC 静默证据批准")
    end

    expected_approval_slots = versions.select { |_slot, version| version > 1 }.keys.sort
    assert(approvals.keys.sort == expected_approval_slots, "密码版本大于 1 的槽位必须精确对应重置批准")
    approvals.each do |slot, approval|
      fields = %w[
        approved_password_version hmac_key_unchanged live_evidence_reference
        observed_active_slot observed_secret_version old_slot_connections_drained
      ]
      assert_exact_keys(approval, fields, "槽位 #{slot} 重置批准")
      assert(approval["approved_password_version"] == versions.fetch(slot), "槽位 #{slot} 的批准版本不匹配")
      assert(approval["observed_active_slot"] == (slot == "a" ? "b" : "a"), "槽位 #{slot} 的批准没有观察另一活动槽")
      observed_secret_version = approval["observed_secret_version"]
      assert_integer(observed_secret_version, "槽位 #{slot} 证据 Secret 版本", 1)
      assert(observed_secret_version <= secret_version, "槽位 #{slot} 的证据 Secret 版本来自未来")
      assert(approval["old_slot_connections_drained"] == true, "槽位 #{slot} 未证明旧连接已经排空")
      assert(approval["hmac_key_unchanged"] == true, "槽位 #{slot} 的密码变更错误混入 HMAC 轮换")
      assert_string(approval["live_evidence_reference"], "槽位 #{slot} live evidence", /\A[A-Za-z0-9][A-Za-z0-9._:\/#-]{7,255}\z/, 256)
    end
  end

  def changed_keys(before, after)
    (before.keys | after.keys).select { |key| before[key] != after[key] }.sort
  end

  def validate_string_map(value, label)
    assert(value.is_a?(Hash), "#{label}必须是对象")
    value.each do |key, item|
      assert_string(key, "#{label} key", /\A[^\x00-\x1f\x7f]+\z/, 253)
      assert(item.is_a?(String) && item.bytesize <= 8192, "#{label} value 必须是字符串")
    end
  end

  def validate_hpa_restore_manifest(manifest, api, target)
    assert_exact_keys(manifest, %w[apiVersion kind metadata spec], "HPA 恢复 manifest")
    assert(manifest["apiVersion"] == "autoscaling/v2", "HPA 恢复 manifest apiVersion 必须是 autoscaling/v2")
    assert(manifest["kind"] == "HorizontalPodAutoscaler", "HPA 恢复 manifest kind 不合法")

    metadata = manifest["metadata"]
    assert_exact_keys(metadata, %w[annotations labels name namespace], "HPA 恢复 manifest metadata")
    assert(metadata["name"] == api["hpa_name"], "HPA 恢复 manifest 名称与证据不一致")
    assert(metadata["namespace"] == target["kubernetes_namespace"], "HPA 恢复 manifest namespace 与目标不一致")
    validate_string_map(metadata["labels"], "HPA 恢复 labels")
    validate_string_map(metadata["annotations"], "HPA 恢复 annotations")

    spec = manifest["spec"]
    assert(spec.is_a?(Hash), "HPA 恢复 spec 必须是对象")
    allowed_spec_keys = %w[behavior maxReplicas metrics minReplicas scaleTargetRef]
    assert((spec.keys - allowed_spec_keys).empty?, "HPA 恢复 spec 包含不受支持字段")
    assert(%w[maxReplicas metrics minReplicas scaleTargetRef].all? { |key| spec.key?(key) }, "HPA 恢复 spec 缺少必需字段")
    assert_integer(spec["minReplicas"], "HPA minReplicas", 1)
    assert_integer(spec["maxReplicas"], "HPA maxReplicas", spec["minReplicas"])
    assert(spec["metrics"].is_a?(Array) && !spec["metrics"].empty?, "HPA 恢复 spec 必须保留 metrics")
    assert(spec["metrics"].all? { |metric| metric.is_a?(Hash) }, "HPA metrics 必须是对象数组")
    assert(spec["behavior"].nil? || spec["behavior"].is_a?(Hash), "HPA behavior 必须是对象")
    target_ref = spec["scaleTargetRef"]
    assert_exact_keys(target_ref, %w[apiVersion kind name], "HPA scaleTargetRef")
    assert(target_ref == {
      "apiVersion" => "apps/v1",
      "kind" => "Deployment",
      "name" => api["deployment_name"],
    }, "HPA 恢复目标不是已静默的 API Deployment")

    fingerprint = Digest::SHA256.hexdigest(canonical_json(spec))
    assert(api["hpa_spec_sha256"] == fingerprint, "HPA 恢复 spec SHA-256 与 manifest 不一致")
  end

  def parse_timestamp(value, label)
    assert_string(value, label, /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\z/, 40)
    Time.iso8601(value)
  rescue ArgumentError
    raise Violation, "#{label}不是合法 RFC3339 UTC 时间"
  end

  def validate_attestation(payload, approval, before, after, now)
    raw = payload
    evidence = JSON.parse(raw)
    canonical_bytes = "#{canonical_json(evidence)}\n"
    assert(raw == canonical_bytes, "HMAC 静默证据必须是按 key 排序的单行规范 JSON，并以换行结束")
    reference = approval.fetch("evidence_reference")
    assert(Digest::SHA256.hexdigest(raw) == reference.fetch("sha256"), "HMAC 静默证据内容与批准 SHA-256 不一致")

    assert_exact_keys(evidence, %w[producer quiescence rotation schema source_delivery target], "HMAC 静默证据")
    assert(evidence["schema"] == "slots-game/hmac-quiesce-attestation/v1", "HMAC 静默证据 schema 不受支持")

    producer = evidence["producer"]
    producer_fields = %w[environment repository role_arn run_attempt run_id source_sha workflow_ref]
    assert_exact_keys(producer, producer_fields, "HMAC 证据 producer")
    assert_string(producer["repository"], "producer.repository", /\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/, 200)
    assert_string(producer["workflow_ref"], "producer.workflow_ref", /\A[^\x00-\x20\x7f]+@[^\x00-\x20\x7f]+\z/, 512)
    assert_string(producer["source_sha"], "producer.source_sha", /\A[0-9a-f]{40}\z/, 40)
    assert_string(producer["run_id"], "producer.run_id", /\A[1-9][0-9]*\z/, 32)
    assert_string(producer["run_attempt"], "producer.run_attempt", /\A[1-9][0-9]*\z/, 16)
    assert_string(producer["environment"], "producer.environment", /\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\z/, 63)
    assert_string(producer["role_arn"], "producer.role_arn", /\Aarn:(aws|aws-us-gov):iam::[0-9]{12}:role\/.+\z/, 2048)

    target = evidence["target"]
    target_fields = %w[aws_account_id aws_region eks_cluster_name environment helm_release_name kubernetes_namespace]
    assert_exact_keys(target, target_fields, "HMAC 证据 target")
    assert(target == before.fetch("target_identity"), "HMAC 证据目标与 Terraform 已持久化前态不一致")
    assert(before["target_identity"] == after["target_identity"], "HMAC 维护禁止改写部署目标身份")
    assert(producer["environment"] == target["environment"], "HMAC 证据 producer 环境与目标不一致")

    delivery = evidence["source_delivery"]
    validate_reference(delivery, "HMAC 证据 source_delivery")

    rotation = evidence["rotation"]
    rotation_fields = %w[observed_active_slot observed_hmac_key_fingerprint observed_secret_version target_secret_version]
    assert_exact_keys(rotation, rotation_fields, "HMAC 证据 rotation")
    assert(rotation["observed_active_slot"] == before["active_slot"], "HMAC 证据没有绑定 Terraform 前态活动槽")
    assert(rotation["observed_secret_version"] == before["published_secret_version"], "HMAC 证据没有绑定 Terraform 前态 Secret 版本")
    assert(rotation["observed_hmac_key_fingerprint"] == before["hmac_key_fingerprint"], "HMAC 证据没有绑定 Terraform 前态 HMAC fingerprint")
    assert(rotation["target_secret_version"] == before["published_secret_version"] + 2, "HMAC 证据目标 Secret 必须是同槽下一版本")
    assert(rotation["target_secret_version"] == after["published_secret_version"], "HMAC 证据目标 Secret 与 plan 结果不一致")

    quiescence = evidence["quiescence"]
    assert_exact_keys(quiescence, %w[api expires_at lock observed_at worker], "HMAC 证据 quiescence")
    observed_at = parse_timestamp(quiescence["observed_at"], "quiescence.observed_at")
    expires_at = parse_timestamp(quiescence["expires_at"], "quiescence.expires_at")
    assert(observed_at <= now, "HMAC 静默证据观察时间来自未来")
    assert(expires_at > now, "HMAC 静默证据已过期")
    assert(expires_at > observed_at && expires_at - observed_at <= 3600, "HMAC 静默证据有效期必须大于零且不超过 60 分钟")

    lock = quiescence["lock"]
    assert_exact_keys(lock, %w[name uid], "HMAC 持久维护锁")
    assert(lock["name"] == "slots-hmac-maintenance-lock", "HMAC 持久维护锁名称不符合固定契约")
    assert_string(lock["uid"], "HMAC 持久维护锁 UID", /\A[0-9a-f-]{36}\z/, 36)

    api = quiescence["api"]
    api_fields = %w[
      available deployment_name desired hpa_name hpa_restore_manifest hpa_spec_sha256
      hpa_uid original_replicas pod_count ready uid
    ]
    assert_exact_keys(api, api_fields, "HMAC 证据 API 静默快照")
    %w[deployment_name hpa_name].each do |key|
      assert_string(api[key], "api.#{key}", /\A[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\z/, 253)
    end
    %w[uid hpa_uid].each { |key| assert_string(api[key], "api.#{key}", /\A[0-9a-f-]{36}\z/, 36) }
    assert_string(api["hpa_spec_sha256"], "api.hpa_spec_sha256", /\A[0-9a-f]{64}\z/, 64)
    %w[desired ready available pod_count].each do |key|
      assert(api[key] == 0, "HMAC 维护要求 API #{key} 精确为 0")
    end
    assert_integer(api["original_replicas"], "api.original_replicas", 1)
    validate_hpa_restore_manifest(api["hpa_restore_manifest"], api, target)

    worker = quiescence["worker"]
    worker_fields = %w[available deployment_name desired hpa_name hpa_uid pod_count ready ready_pod_count uid]
    assert_exact_keys(worker, worker_fields, "HMAC 证据 Worker 健康快照")
    %w[deployment_name hpa_name].each do |key|
      assert_string(worker[key], "worker.#{key}", /\A[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\z/, 253)
    end
    %w[uid hpa_uid].each { |key| assert_string(worker[key], "worker.#{key}", /\A[0-9a-f-]{36}\z/, 36) }
    %w[desired ready available pod_count ready_pod_count].each { |key| assert_integer(worker[key], "worker.#{key}", 0) }
    assert(worker["desired"] >= 1, "HMAC 维护期间 Worker desired 必须大于等于 1")
    assert(worker["ready"] == worker["desired"] && worker["available"] == worker["desired"], "HMAC 维护期间 Worker 必须全部健康")
    assert(worker["pod_count"] >= worker["desired"] && worker["ready_pod_count"] >= worker["desired"], "HMAC 维护期间 Worker Pod 数量不足")
  rescue JSON::ParserError => error
    raise Violation, "HMAC 静默证据 JSON 无法解析: #{error.message}"
  end

  def validate_resource_identity(resource, address, type, name, provider_name, accepted_actions)
    assert(resource.fetch("address", nil) == address, "HMAC 维护 plan 包含非固定资源地址")
    assert(resource.fetch("mode", nil) == "managed", "HMAC 维护 plan 只允许 managed resource")
    assert(resource.fetch("type", nil) == type, "HMAC 维护资源类型与固定地址不一致")
    assert(resource.fetch("name", nil) == name, "HMAC 维护资源名称与固定地址不一致")
    assert(resource.fetch("provider_name", nil) == provider_name, "HMAC 维护资源 provider 不符合固定契约")
    actions = resource.fetch("change").fetch("actions")
    assert(accepted_actions.include?(actions), "HMAC 维护资源 #{address} 的动作不在精确 allowlist")
  end

  def validate_shared_admission_secret_change(resource, before_guard, after_guard)
    change = resource.fetch("change")
    before = change.fetch("before")
    after = change.fetch("after")
    stable_keys = %w[description force_overwrite_replica_secret kms_key_id recovery_window_in_days region tags type]
    assert_exact_keys(before, SHARED_ADMISSION_SECRET_ATTRIBUTE_KEYS, "shared-admission Secret 前态")
    assert_exact_keys(after, SHARED_ADMISSION_SECRET_ATTRIBUTE_KEYS, "shared-admission Secret 后态")

    before_suffix = "-rgs-shared-admission-v#{before_guard.fetch("published_secret_version")}"
    after_suffix = "-rgs-shared-admission-v#{after_guard.fetch("published_secret_version")}"
    before_name = before.fetch("name")
    after_name = after.fetch("name")
    assert_string(before_name, "shared-admission Secret 前态名称", /\A[A-Za-z0-9_+=.@\/-]+\z/, 512)
    assert_string(after_name, "shared-admission Secret 后态名称", /\A[A-Za-z0-9_+=.@\/-]+\z/, 512)
    assert(before_name.end_with?(before_suffix), "shared-admission Secret 前态名称没有绑定已发布版本")
    assert(after_name.end_with?(after_suffix), "shared-admission Secret 后态名称没有绑定目标版本")
    assert(before_name.delete_suffix(before_suffix) == after_name.delete_suffix(after_suffix), "HMAC 维护禁止改变 Secret 名称前缀")

    stable_keys.each do |key|
      assert(before[key] == after[key], "HMAC 维护禁止改变 shared-admission Secret 的 #{key}")
    end
    assert(before.fetch("region") == before_guard.fetch("target_identity").fetch("aws_region"), "shared-admission Secret 区域没有绑定 guard 目标")
    assert(before["name_prefix"].nil? && after["name_prefix"].nil?, "HMAC 维护 Secret 禁止切换到 name_prefix 管理")
    assert(before["policy"].nil? && after["policy"].nil?, "HMAC 维护 Secret 禁止夹带 resource policy")
    assert(before["type"].nil? && after["type"].nil?, "HMAC 维护 Secret 禁止改变 Secret type")
    assert(before.fetch("tags").fetch("Boundary", nil) == "rgs-shared-admission", "shared-admission Secret 缺少固定边界标签")
    assert(before.fetch("tags").fetch("ManagedValueByTerraform", nil) == "write-only", "shared-admission Secret 不是 write-only 管理")

    allowed_changed_keys = %w[arn id name tags_all]
    unexpected_changes = changed_keys(before, after) - allowed_changed_keys
    assert(unexpected_changes.empty?, "HMAC 维护 Secret 替换混入普通配置变化: #{unexpected_changes.join(",")}")
    after_unknown = change.fetch("after_unknown", {})
    assert(after_unknown.is_a?(Hash), "shared-admission Secret after_unknown 必须是对象")
    unexpected_unknown = after_unknown.keys - %w[arn id name_prefix policy region tags_all]
    assert(unexpected_unknown.empty?, "HMAC 维护 Secret 替换包含非固定未知属性: #{unexpected_unknown.join(",")}")
  end

  def validate_shared_admission_secret_version_change(resource, before_guard, after_guard)
    change = resource.fetch("change")
    before = change.fetch("before")
    after = change.fetch("after")
    assert_exact_keys(before, SHARED_ADMISSION_SECRET_VERSION_ATTRIBUTE_KEYS, "shared-admission SecretVersion 前态")
    assert_exact_keys(after, SHARED_ADMISSION_SECRET_VERSION_ATTRIBUTE_KEYS, "shared-admission SecretVersion 后态")
    assert(before["secret_string_wo"].nil? && after["secret_string_wo"].nil?, "write-only Secret 值禁止出现在 plan JSON")
    assert(before["secret_binary"].nil? && after["secret_binary"].nil?, "HMAC 维护禁止改用 secret_binary")
    assert(before["secret_string"].nil? && after["secret_string"].nil?, "HMAC 维护禁止把秘密写入有状态 secret_string")
    assert(before.fetch("secret_string_wo_version") == before_guard.fetch("published_secret_version"), "SecretVersion 前态 write-only 版本没有绑定 guard")
    assert(after.fetch("secret_string_wo_version") == after_guard.fetch("published_secret_version"), "SecretVersion 目标 write-only 版本没有绑定 guard")
    assert_string(before.fetch("secret_id"), "SecretVersion 前态 secret_id", /\Aarn:(aws|aws-us-gov):secretsmanager:/, 2048)
    assert(before.fetch("region") == before_guard.fetch("target_identity").fetch("aws_region"), "SecretVersion 区域没有绑定 guard 目标")
    assert(after.fetch("region") == after_guard.fetch("target_identity").fetch("aws_region"), "SecretVersion 目标区域没有绑定 guard 目标")

    allowed_changed_keys = %w[arn has_secret_string_wo id secret_arn secret_id secret_string_wo_version version_id version_stages]
    unexpected_changes = changed_keys(before, after) - allowed_changed_keys
    assert(unexpected_changes.empty?, "HMAC 维护 SecretVersion 替换混入普通配置变化: #{unexpected_changes.join(",")}")
    after_unknown = change.fetch("after_unknown", {})
    assert(after_unknown.is_a?(Hash), "shared-admission SecretVersion after_unknown 必须是对象")
    allowed_unknown_keys = %w[arn has_secret_string_wo id region secret_arn secret_id secret_string_wo version_id version_stages]
    unexpected_unknown = after_unknown.keys - allowed_unknown_keys
    assert(unexpected_unknown.empty?, "HMAC 维护 SecretVersion 包含非固定未知属性: #{unexpected_unknown.join(",")}")
  end

  def validate_hmac_plan_change_set(plan, transition, guard_resource, before_guard, after_guard)
    return unless %i[hmac_entry hmac_exit].include?(transition)

    resources = plan.fetch("resource_changes", [])
    assert(resources.is_a?(Array), "plan.resource_changes 必须是数组")
    actionful = resources.reject do |resource|
      resource.fetch("change").fetch("actions") == ["no-op"]
    end
    cache_prefix = guard_resource.fetch("address").delete_suffix(".terraform_data.rotation_guard")
    guard_address = "#{cache_prefix}.terraform_data.rotation_guard"
    secret_address = "#{cache_prefix}.aws_secretsmanager_secret.shared_admission"
    secret_version_address = "#{cache_prefix}.aws_secretsmanager_secret_version.shared_admission"
    acl_addresses = %w[a b].map { |slot| "#{cache_prefix}.aws_elasticache_user.rate_limiter_#{slot}" }
    actual_addresses = actionful.map { |resource| resource.fetch("address", nil) }
    migrating_acl = (actual_addresses & acl_addresses).any?

    expected_addresses = if transition == :hmac_entry
      [guard_address, secret_address, secret_version_address] + (migrating_acl ? acl_addresses : [])
    else
      [guard_address]
    end
    assert(actual_addresses.sort == expected_addresses.sort, "HMAC #{transition == :hmac_entry ? "入口" : "出口"} plan 的非 no-op 资源集合不符合精确 allowlist")
    assert(actual_addresses.uniq.length == actual_addresses.length, "HMAC 维护 plan 包含重复资源地址")

    by_address = actionful.to_h { |resource| [resource.fetch("address"), resource] }
    validate_resource_identity(
      by_address.fetch(guard_address), guard_address, "terraform_data", "rotation_guard",
      "terraform.io/builtin/terraform", [["update"]],
    )
    return if transition == :hmac_exit

    secret = by_address.fetch(secret_address)
    validate_resource_identity(
      secret, secret_address, "aws_secretsmanager_secret", "shared_admission",
      "registry.terraform.io/hashicorp/aws", HMAC_SECRET_REPLACEMENT_ACTIONS,
    )
    validate_shared_admission_secret_change(secret, before_guard, after_guard)

    secret_version = by_address.fetch(secret_version_address)
    validate_resource_identity(
      secret_version, secret_version_address, "aws_secretsmanager_secret_version", "shared_admission",
      "registry.terraform.io/hashicorp/aws", HMAC_SECRET_VERSION_REPLACEMENT_ACTIONS,
    )
    validate_shared_admission_secret_version_change(secret_version, before_guard, after_guard)
  rescue KeyError => error
    raise Violation, "HMAC 维护 plan 资源结构缺失: #{error.message}"
  end

  def validate_acl_schema_plan_change_set(plan, transition, guard_resource)
    resources = plan.fetch("resource_changes", [])
    assert(resources.is_a?(Array), "plan.resource_changes 必须是数组")
    cache_prefix = guard_resource.fetch("address").delete_suffix(".terraform_data.rotation_guard")
    expected = %w[a b].to_h do |slot|
      address = "#{cache_prefix}.aws_elasticache_user.rate_limiter_#{slot}"
      [address, "rate_limiter_#{slot}"]
    end
    changes = resources.select do |resource|
      expected.key?(resource.fetch("address", nil)) &&
        resource.fetch("change").fetch("actions") != ["no-op"]
    end
    return if changes.empty?

    addresses = changes.map { |resource| resource.fetch("address") }
    assert(addresses.sort == expected.keys.sort, "Valkey ACL schema 迁移必须在同一计划精确更新 A/B 两个用户")
    assert(addresses.uniq.length == addresses.length, "Valkey ACL schema 迁移包含重复资源地址")

    before_accesses = changes.map { |resource| resource.fetch("change").fetch("before").fetch("access_string", nil) }
    if before_accesses.all? { |access| access == PRE_ECONOMIC_SHARED_ADMISSION_ACL }
      # v2 keyspace/HMAC 均不变，只追加新脚本所需命令；旧 runtime 使用的权限是严格子集。
      # 该扩权必须作为独立 steady 状态迁移先于应用发布，不能伪装成密码或 HMAC 轮换。
      # English: v2 keyspace/HMAC are unchanged, only the commands required by the new script are appended; the
      # permissions used by the old runtime are a strict subset. This entitlement must be issued as a separate
      # steady state transition before the application is released, and cannot be disguised as a password or
      # HMAC rotation.
      assert(transition == :steady, "Valkey v2 economic ACL 追加只能在 steady 计划中先于新 runtime 应用")
      expected_before = PRE_ECONOMIC_SHARED_ADMISSION_ACL
    else
      assert(before_accesses.all? { |access| access == LEGACY_SHARED_ADMISSION_ACL }, "Valkey ACL schema 迁移前态不是唯一受支持的 v1 或 v2-basic 契约")
      assert(transition == :hmac_entry, "Valkey v1 keyspace 迁移只能进入有静默证据的 HMAC 维护计划")
      expected_before = LEGACY_SHARED_ADMISSION_ACL
    end
    changes.each do |resource|
      address = resource.fetch("address")
      validate_resource_identity(
        resource, address, "aws_elasticache_user", expected.fetch(address),
        "registry.terraform.io/hashicorp/aws", [["update"]],
      )
      change = resource.fetch("change")
      before = change.fetch("before")
      after = change.fetch("after")
      assert(before.is_a?(Hash) && after.is_a?(Hash), "Valkey ACL schema 迁移缺少完整前后态")
      assert(before.fetch("access_string", nil) == expected_before, "Valkey ACL schema 迁移 A/B 前态不一致")
      assert(after.fetch("access_string", nil) == CURRENT_SHARED_ADMISSION_ACL, "Valkey ACL schema 迁移后态不是唯一受支持的 v2 契约")
      assert(changed_keys(before, after) == ["access_string"], "Valkey ACL schema 迁移禁止夹带密码、身份、标签或其他资源变化")
      after_unknown = change.fetch("after_unknown", {})
      assert(after_unknown.is_a?(Hash), "Valkey ACL schema after_unknown 必须是对象")
      assert(!unknown?(after_unknown.fetch("access_string", false)), "Valkey ACL schema 目标权限不得未知")
    end
  rescue KeyError => error
    raise Violation, "Valkey ACL schema plan 资源结构缺失: #{error.message}"
  end

  def verify_transition(before, after, evidence_payload: nil, now: Time.now.utc)
    validate_shape(before)
    validate_shape(after)
    assert(before["contract_version"] == after["contract_version"], "禁止原地改变轮换契约版本")

    before_versions = before.fetch("password_versions")
    after_versions = after.fetch("password_versions")
    before_fingerprints = before.fetch("password_fingerprints")
    after_fingerprints = after.fetch("password_fingerprints")
    version_changed_slots = changed_keys(before_versions, after_versions)
    fingerprint_changed_slots = changed_keys(before_fingerprints, after_fingerprints)
    assert(version_changed_slots == fingerprint_changed_slots, "密码版本与绑定实际 ephemeral 值的 fingerprint 必须同步改变")

    hmac_changed = before["hmac_key_fingerprint"] != after["hmac_key_fingerprint"]
    active_changed = before["active_slot"] != after["active_slot"]
    before_hmac_mode = before["rotation_mode"] == "hmac-maintenance"
    after_hmac_mode = after["rotation_mode"] == "hmac-maintenance"

    if before_hmac_mode || after_hmac_mode
      assert(!active_changed, "HMAC 停机维护禁止切换活动槽")
      assert(version_changed_slots.empty?, "HMAC 停机维护禁止修改任何槽位密码")
      assert(before["reset_approvals"] == after["reset_approvals"], "HMAC 停机维护禁止改写密码退休批准")
      assert(before["target_identity"] == after["target_identity"], "HMAC 停机维护禁止改写目标身份")

      if !before_hmac_mode && after_hmac_mode
        assert(before["rotation_mode"] == "steady", "HMAC 维护只能从 steady 模式进入")
        assert(hmac_changed, "有独立静默证据时，进入 HMAC 维护的同一个保存 plan 必须完成换 key")
        assert(after["published_secret_version"] == before["published_secret_version"] + 2, "HMAC 更换必须保持活动槽并把 Secret 版本精确递增 2")
        expected_changes = %w[hmac_key_fingerprint hmac_maintenance_approval published_secret_version rotation_mode]
        assert(changed_keys(before, after) == expected_changes, "HMAC 单计划维护包含契约外状态变更")
        assert(!evidence_payload.nil?, "HMAC 单计划维护缺少 --evidence 静默证据")
        validate_attestation(evidence_payload, after.fetch("hmac_maintenance_approval"), before, after, now)
        return :hmac_entry
      end

      assert(before_hmac_mode && !after_hmac_mode, "HMAC 维护模式禁止 no-op 或再次换 key；只能单独退出")
      assert(after["rotation_mode"] == "steady", "HMAC 维护结束后只能回到 steady")
      assert(evidence_payload.nil?, "退出 HMAC 维护的独立 plan 禁止复用旧静默证据")
      assert(!hmac_changed, "退出 HMAC 维护模式时禁止再次改变 key")
      assert(after["published_secret_version"] == before["published_secret_version"], "退出 HMAC 维护模式时禁止改变 Secret")
      assert(changed_keys(before, after) == %w[hmac_maintenance_approval rotation_mode], "退出 HMAC 维护的 plan 只能清除批准并回到 steady")
      return :hmac_exit
    end

    assert(evidence_payload.nil?, "普通 A/B 轮换禁止携带 HMAC 静默证据")
    assert(before["target_identity"] == after["target_identity"], "轮换过程禁止改写目标身份")
    assert(!hmac_changed, "普通 A/B 密码轮换禁止改变 HMAC；HMAC 桶重置必须使用独立静默维护计划")

    if active_changed
      assert(after["rotation_mode"] == "password-rotation", "活动槽切换必须显式使用 password-rotation 模式")
      assert(after["active_slot"] == (before["active_slot"] == "a" ? "b" : "a"), "活动槽只能在 a/b 之间切换")
      assert(version_changed_slots.empty?, "切换活动槽的同一次 apply 禁止修改任何密码")
      assert(before["reset_approvals"] == after["reset_approvals"], "切换活动槽时禁止伪造或改写退休批准")
      assert(after["published_secret_version"] == before["published_secret_version"] + 1, "切换活动槽必须把不可变 Secret 版本精确递增 1")
      return :password_switch
    end

    assert(after["published_secret_version"] == before["published_secret_version"], "活动槽不变时禁止改变共享准入 Secret 版本")
    if version_changed_slots.empty?
      assert(before["reset_approvals"] == after["reset_approvals"], "没有密码变更时禁止改写退休批准")
      return :steady
    end

    inactive_slot = before["active_slot"] == "a" ? "b" : "a"
    assert(after["rotation_mode"] == "password-rotation", "非活动槽准备必须显式使用 password-rotation 模式")
    assert(version_changed_slots == [inactive_slot], "禁止重置当前活动槽；一次 apply 只能准备唯一非活动槽")
    assert(after_versions[inactive_slot] == before_versions[inactive_slot] + 1, "非活动槽密码版本必须精确递增 1")
    approval_changed_slots = changed_keys(before.fetch("reset_approvals"), after.fetch("reset_approvals"))
    assert(approval_changed_slots == [inactive_slot], "非活动槽密码变更必须同时提交该槽的新 live evidence 批准")
    :password_prepare
  end

  def verify(plan, evidence_payload: nil, now: Time.now.utc)
    changes = plan.fetch("resource_changes", []).select do |resource|
      resource["type"] == "terraform_data" && resource["name"] == "rotation_guard" &&
        resource.fetch("address", "").end_with?("module.cache.terraform_data.rotation_guard")
    end
    assert(changes.length == 1, "plan 必须精确包含一个 Valkey rotation_guard")

    change = changes.first.fetch("change")
    after_unknown = change.fetch("after_unknown", {})
    input_unknown = after_unknown.is_a?(Hash) ? after_unknown.fetch("input", false) : after_unknown
    assert(!unknown?(input_unknown), "Valkey rotation_guard input 在 plan 中不得未知")
    actions = change.fetch("actions")
    assert(!actions.include?("delete"), "禁止销毁或替换 Valkey rotation_guard")
    after = change["after"]
    assert(after.is_a?(Hash), "Valkey rotation_guard 计划结果缺失")
    after_input = after.fetch("input")

    if actions == ["create"]
      assert(evidence_payload.nil?, "首次创建禁止携带 HMAC 静默证据")
      validate_shape(after_input)
      assert(after_input["active_slot"] == "a", "首次创建必须从 A 槽开始")
      assert(after_input["rotation_mode"] == "steady", "首次创建必须处于 steady 模式")
      assert(after_input["password_versions"] == { "a" => 1, "b" => 1 }, "首次创建两个密码版本必须都是 1")
      assert(after_input["published_secret_version"] == 1, "首次创建共享准入 Secret 必须是 v1")
      assert(after_input["reset_approvals"] == {}, "首次创建不得携带槽位退休批准")
      return true
    end

    assert(actions == ["no-op"] || actions == ["update"], "不支持的 rotation_guard 计划动作: #{actions.join(",")}")
    before = change["before"]
    assert(before.is_a?(Hash), "更新计划缺少 Valkey 前态")
    before_input = before.fetch("input")
    transition = verify_transition(before_input, after_input, evidence_payload: evidence_payload, now: now)
    validate_hmac_plan_change_set(plan, transition, changes.first, before_input, after_input)
    validate_acl_schema_plan_change_set(plan, transition, changes.first)
    true
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    options = {}
    parser = OptionParser.new do |arguments|
      arguments.banner = "用法: verify-valkey-rotation-plan.rb [--evidence FILE] <terraform-plan.json|->"
      arguments.on("--evidence FILE", "HMAC 维护的规范化静默证据 JSON") { |value| options[:evidence] = value }
    end
    parser.parse!(ARGV)
    abort parser.to_s unless ARGV.length == 1
    path = ARGV.fetch(0)
    plan_payload = path == "-" ? STDIN.read : File.binread(path)
    evidence_payload = options[:evidence] && File.binread(options.fetch(:evidence))
    ValkeyRotationPlanContract.verify(JSON.parse(plan_payload), evidence_payload: evidence_payload)
    puts "Valkey A/B rotation plan contract: passed"
  rescue Errno::ENOENT, KeyError, JSON::ParserError, OptionParser::ParseError, ValkeyRotationPlanContract::Violation => error
    warn "Valkey A/B rotation plan contract: #{error.message}"
    exit 1
  end
end
