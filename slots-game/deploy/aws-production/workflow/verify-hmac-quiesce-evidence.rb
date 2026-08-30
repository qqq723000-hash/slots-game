#!/usr/bin/env ruby
# 验证 HMAC 停机证据的规范化内容、固定生产身份、目标边界与有效期。
# English: Verify the normalized content, fixed artifactsion identity, target boundaries and validity period of
# HMAC outage evidence.
require "digest"
require "json"
require "time"

module HmacQuiesceEvidence
  class Violation < StandardError; end

  module_function

  def assert(condition, message)
    raise Violation, message unless condition
  end

  def canonical(value)
    case value
    when Hash
      value.keys.sort.to_h { |key| [key, canonical(value.fetch(key))] }
    when Array
      value.map { |item| canonical(item) }
    else
      value
    end
  end

  def canonical_json(value)
    JSON.generate(canonical(value))
  end

  def strict_keys(value, keys, label)
    assert(value.is_a?(Hash), "#{label} 必须是对象")
    assert(value.keys.sort == keys.sort, "#{label} 字段集合不精确")
  end

  def string(value, pattern, label)
    assert(value.is_a?(String) && value.match?(pattern), "#{label} 格式错误")
  end

  def positive_integer(value, label)
    assert(value.is_a?(Integer) && value.positive?, "#{label} 必须是正整数")
  end

  def nonnegative_integer(value, label)
    assert(value.is_a?(Integer) && value >= 0, "#{label} 必须是非负整数")
  end

  def string_map(value, label)
    assert(value.is_a?(Hash), "#{label} 必须是对象")
    assert(value.all? { |key, item| key.is_a?(String) && item.is_a?(String) },
      "#{label} 只能包含字符串键值")
  end

  def env(name)
    value = ENV.fetch(name)
    assert(!value.empty?, "#{name} 不能为空")
    value
  end

  def verify(path, purpose)
    raw = File.binread(path)
    document = JSON.parse(raw)
    expected_raw = "#{canonical_json(document)}\n"
    assert(raw == expected_raw, "证据必须是带单个换行的规范化 JSON")
    content_sha256 = Digest::SHA256.hexdigest(raw)
    assert(content_sha256 == env("HMAC_EVIDENCE_EXPECTED_SHA256"), "证据 SHA-256 与固定标识不一致")

    strict_keys(document,
      %w[producer quiescence rotation schema source_delivery target], "证据根对象")
    assert(document.fetch("schema") == "slots-game/hmac-quiesce-attestation/v1",
      "证据 schema 不受支持")

    producer = document.fetch("producer")
    strict_keys(producer,
      %w[environment repository role_arn run_attempt run_id source_sha workflow_ref], "producer")
    assert(producer.fetch("repository") == env("GITHUB_REPOSITORY"), "producer.repository 不匹配")
    assert(producer.fetch("workflow_ref") == env("AWS_HMAC_QUIESCE_PRODUCER_WORKFLOW_REF"),
      "producer.workflow_ref 不匹配")
    assert(producer.fetch("role_arn") == env("AWS_HMAC_QUIESCE_PRODUCER_ROLE_ARN"),
      "producer.role_arn 不匹配")
    assert(producer.fetch("environment") == env("TARGET_ENVIRONMENT"),
      "producer.environment 不匹配")
    string(producer.fetch("source_sha"), /\A[0-9a-f]{40}\z/, "producer.source_sha")
    string(producer.fetch("run_id"), /\A[1-9][0-9]*\z/, "producer.run_id")
    string(producer.fetch("run_attempt"), /\A[1-9][0-9]*\z/, "producer.run_attempt")

    target = document.fetch("target")
    strict_keys(target,
      %w[aws_account_id aws_region eks_cluster_name environment helm_release_name kubernetes_namespace],
      "target")
    expected_target = {
      "environment" => env("TARGET_ENVIRONMENT"),
      "aws_account_id" => env("AWS_ACCOUNT_ID"),
      "aws_region" => env("AWS_REGION"),
      "eks_cluster_name" => env("AWS_EKS_CLUSTER_NAME"),
      "kubernetes_namespace" => env("AWS_EKS_NAMESPACE"),
      "helm_release_name" => env("AWS_HELM_RELEASE_NAME"),
    }
    assert(target == expected_target, "证据 target 与受保护 Environment 不一致")

    delivery = document.fetch("source_delivery")
    strict_keys(delivery, %w[bucket key sha256 version_id], "source_delivery")
    assert(delivery.fetch("bucket") == env("AWS_TERRAFORM_DELIVERY_BUCKET"),
      "source_delivery.bucket 不匹配")
    assert(delivery.fetch("key") == env("AWS_TERRAFORM_DELIVERY_KEY"), "source_delivery.key 不匹配")
    string(delivery.fetch("version_id"), /\A[A-Za-z0-9._~+\/=\-]{1,1024}\z/,
      "source_delivery.version_id")
    string(delivery.fetch("sha256"), /\A[0-9a-f]{64}\z/, "source_delivery.sha256")

    rotation = document.fetch("rotation")
    strict_keys(rotation,
      %w[observed_active_slot observed_hmac_key_fingerprint observed_secret_version target_secret_version],
      "rotation")
    assert(%w[a b].include?(rotation.fetch("observed_active_slot")), "observed_active_slot 不合法")
    string(rotation.fetch("observed_hmac_key_fingerprint"), /\A[0-9a-f]{64}\z/,
      "observed_hmac_key_fingerprint")
    positive_integer(rotation.fetch("observed_secret_version"), "observed_secret_version")
    positive_integer(rotation.fetch("target_secret_version"), "target_secret_version")
    assert(rotation.fetch("target_secret_version") == rotation.fetch("observed_secret_version") + 2,
      "目标 Secret 版本必须精确递增 2")
    expected_parity = rotation.fetch("observed_active_slot") == "a" ? 1 : 0
    assert(rotation.fetch("observed_secret_version") % 2 == expected_parity &&
      rotation.fetch("target_secret_version") % 2 == expected_parity,
      "Secret 版本与活动槽奇偶契约不一致")

    quiescence = document.fetch("quiescence")
    strict_keys(quiescence, %w[api expires_at lock observed_at worker], "quiescence")
    observed_at = Time.iso8601(quiescence.fetch("observed_at"))
    expires_at = Time.iso8601(quiescence.fetch("expires_at"))
    assert(observed_at.utc.iso8601 == quiescence.fetch("observed_at"), "observed_at 必须是 UTC RFC3339 秒精度")
    assert(expires_at.utc.iso8601 == quiescence.fetch("expires_at"), "expires_at 必须是 UTC RFC3339 秒精度")
    assert((expires_at - observed_at).to_i == 3600, "证据 TTL 必须精确为 60 分钟")
    now = Time.at(ENV.fetch("HMAC_EVIDENCE_NOW_EPOCH", Time.now.to_i.to_s).to_i).utc
    assert(observed_at <= now + 300, "证据观察时间来自未来")
    assert(now < expires_at, "证据已过期") if purpose == "consume"

    lock = quiescence.fetch("lock")
    strict_keys(lock, %w[name uid], "quiescence.lock")
    assert(lock.fetch("name") == "slots-hmac-maintenance-lock", "maintenance lock 名称不受支持")
    string(lock.fetch("uid"), /\A[0-9a-f]{8}-[0-9a-f-]{27}\z/, "maintenance lock UID")

    api = quiescence.fetch("api")
    strict_keys(api,
      %w[available deployment_name desired hpa_name hpa_restore_manifest hpa_spec_sha256 hpa_uid
        original_replicas pod_count ready uid], "quiescence.api")
    string(api.fetch("deployment_name"), /\A[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\z/,
      "api.deployment_name")
    string(api.fetch("uid"), /\A[0-9a-f]{8}-[0-9a-f-]{27}\z/, "api.uid")
    string(api.fetch("hpa_name"), /\A[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\z/, "api.hpa_name")
    string(api.fetch("hpa_uid"), /\A[0-9a-f]{8}-[0-9a-f-]{27}\z/, "api.hpa_uid")
    string(api.fetch("hpa_spec_sha256"), /\A[0-9a-f]{64}\z/, "api.hpa_spec_sha256")
    positive_integer(api.fetch("original_replicas"), "api.original_replicas")
    %w[desired ready available pod_count].each do |field|
      nonnegative_integer(api.fetch(field), "api.#{field}")
      assert(api.fetch(field).zero?, "api.#{field} 必须为 0")
    end

    manifest = api.fetch("hpa_restore_manifest")
    strict_keys(manifest, %w[apiVersion kind metadata spec], "api.hpa_restore_manifest")
    assert(manifest.fetch("apiVersion") == "autoscaling/v2" &&
      manifest.fetch("kind") == "HorizontalPodAutoscaler", "恢复 HPA API 不合法")
    metadata = manifest.fetch("metadata")
    strict_keys(metadata, %w[annotations labels name namespace], "恢复 HPA metadata")
    assert(metadata.fetch("name") == api.fetch("hpa_name"), "恢复 HPA 名称不匹配")
    assert(metadata.fetch("namespace") == env("AWS_EKS_NAMESPACE"), "恢复 HPA namespace 不匹配")
    string_map(metadata.fetch("labels"), "恢复 HPA labels")
    string_map(metadata.fetch("annotations"), "恢复 HPA annotations")
    assert(metadata.fetch("labels").fetch("app.kubernetes.io/instance", nil) == env("AWS_HELM_RELEASE_NAME"),
      "恢复 HPA 缺少固定 Helm release label")
    assert(metadata.fetch("labels").fetch("app.kubernetes.io/component", nil) == "rgs",
      "恢复 HPA component 不是 rgs")
    spec = manifest.fetch("spec")
    assert(spec.is_a?(Hash) && !spec.empty?, "恢复 HPA spec 不能为空")
    assert(Digest::SHA256.hexdigest(canonical_json(spec)) == api.fetch("hpa_spec_sha256"),
      "恢复 HPA spec SHA-256 不匹配")
    target_ref = spec.fetch("scaleTargetRef")
    assert(target_ref == {
      "apiVersion" => "apps/v1", "kind" => "Deployment", "name" => api.fetch("deployment_name")
    }, "恢复 HPA scaleTargetRef 不匹配")

    worker = quiescence.fetch("worker")
    strict_keys(worker,
      %w[available deployment_name desired hpa_name hpa_uid pod_count ready ready_pod_count uid],
      "quiescence.worker")
    string(worker.fetch("deployment_name"), /\A[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\z/,
      "worker.deployment_name")
    string(worker.fetch("uid"), /\A[0-9a-f]{8}-[0-9a-f-]{27}\z/, "worker.uid")
    string(worker.fetch("hpa_name"), /\A[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\z/, "worker.hpa_name")
    string(worker.fetch("hpa_uid"), /\A[0-9a-f]{8}-[0-9a-f-]{27}\z/, "worker.hpa_uid")
    %w[desired ready available pod_count ready_pod_count].each do |field|
      nonnegative_integer(worker.fetch(field), "worker.#{field}")
    end
    positive_integer(worker.fetch("desired"), "worker.desired")
    assert(worker.fetch("ready") == worker.fetch("desired") &&
      worker.fetch("available") == worker.fetch("desired"),
      "Worker Deployment 未保持完全就绪")
    assert(worker.fetch("pod_count") >= worker.fetch("desired") &&
      worker.fetch("ready_pod_count") == worker.fetch("pod_count"), "Worker Pod 未保持全部就绪")

    content_sha256
  rescue ArgumentError => error
    raise Violation, "时间字段格式错误：#{error.message}"
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    purpose = ARGV.shift
    path = ARGV.shift
    abort "用法: verify-hmac-quiesce-evidence.rb <consume|resume|finalize> <evidence.json>" unless
      %w[consume resume finalize].include?(purpose) && path && ARGV.empty?
    digest = HmacQuiesceEvidence.verify(path, purpose)
    puts "HMAC quiesce evidence contract: passed #{digest}"
  rescue KeyError, JSON::ParserError, HmacQuiesceEvidence::Violation => error
    warn "HMAC quiesce evidence contract: #{error.message}"
    exit 1
  end
end
