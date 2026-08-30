#!/usr/bin/env ruby
# 验证私网 runner 对过期原停机证据所做的短时实时复证，并绑定同一 delivery、lock 与 target 轮换。
# English: Verify the private runner's short-term real-time verification of the expired original outage
# evidence, and bind the same delivery, lock and target rotation.
require "digest"
require "json"
require "time"

def fail_closed(message)
  warn "HMAC finalize 实时复证失败：#{message}"
  exit 1
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

def strict_keys(value, keys, label)
  fail_closed("#{label} 不是对象") unless value.is_a?(Hash)
  fail_closed("#{label} 字段集合不精确") unless value.keys.sort == keys.sort
end

attestation_path, delivery_path, evidence_path = ARGV
fail_closed("参数不完整") unless ARGV.length == 3

begin
  raw = File.binread(attestation_path)
  attestation = JSON.parse(raw)
  delivery = JSON.parse(File.binread(delivery_path))
  evidence_raw = File.binread(evidence_path)
  evidence = JSON.parse(evidence_raw)
rescue StandardError => error
  fail_closed("无法读取复证输入：#{error.message}")
end

expected_raw = "#{JSON.generate(canonical(attestation))}\n"
fail_closed("复证必须是带单个末尾换行的规范化 JSON") unless raw == expected_raw
strict_keys(attestation,
  %w[evidence_reference producer quiescence rotation schema target target_delivery], "复证根对象")
fail_closed("复证 schema 不受支持") unless
  attestation.fetch("schema") == "slots-game/hmac-finalize-attestation/v1"

producer = attestation.fetch("producer")
strict_keys(producer,
  %w[environment repository role_arn run_attempt run_id source_sha workflow_ref], "producer")
expected_workflow = "#{ENV.fetch('GITHUB_REPOSITORY')}/.github/workflows/aws-application-deploy.yml@refs/heads/main"
fail_closed("producer 身份不匹配") unless producer == {
  "repository" => ENV.fetch("GITHUB_REPOSITORY"),
  "workflow_ref" => expected_workflow,
  "source_sha" => ENV.fetch("GITHUB_SHA"),
  "run_id" => ENV.fetch("GITHUB_RUN_ID"),
  "run_attempt" => ENV.fetch("GITHUB_RUN_ATTEMPT"),
  "environment" => ENV.fetch("TARGET_ENVIRONMENT"),
  "role_arn" => ENV.fetch("AWS_APPLICATION_DEPLOY_ROLE_ARN"),
}
fail_closed("source SHA 格式错误") unless producer.fetch("source_sha").match?(/\A[0-9a-f]{40}\z/)
%w[run_id run_attempt].each do |field|
  fail_closed("#{field} 格式错误") unless producer.fetch(field).match?(/\A[1-9][0-9]*\z/)
end

target = attestation.fetch("target")
strict_keys(target,
  %w[aws_account_id aws_region eks_cluster_name environment helm_release_name kubernetes_namespace],
  "target")
fail_closed("target 与受保护 Environment 不匹配") unless target == {
  "environment" => ENV.fetch("TARGET_ENVIRONMENT"),
  "aws_account_id" => ENV.fetch("AWS_ACCOUNT_ID"),
  "aws_region" => ENV.fetch("AWS_REGION"),
  "eks_cluster_name" => ENV.fetch("AWS_EKS_CLUSTER_NAME"),
  "kubernetes_namespace" => ENV.fetch("AWS_EKS_NAMESPACE"),
  "helm_release_name" => ENV.fetch("AWS_HELM_RELEASE_NAME"),
}

evidence_reference = attestation.fetch("evidence_reference")
strict_keys(evidence_reference, %w[bucket key sha256 version_id], "evidence_reference")
fail_closed("复证没有绑定 dispatch 指定的原证据") unless evidence_reference == {
  "bucket" => ENV.fetch("AWS_HMAC_QUIESCE_EVIDENCE_BUCKET"),
  "key" => ENV.fetch("AWS_HMAC_QUIESCE_EVIDENCE_KEY"),
  "version_id" => ENV.fetch("INPUT_EVIDENCE_VERSION_ID"),
  "sha256" => ENV.fetch("INPUT_EVIDENCE_SHA256"),
}
fail_closed("原证据内容 SHA 不匹配") unless
  Digest::SHA256.hexdigest(evidence_raw) == evidence_reference.fetch("sha256")

target_delivery = attestation.fetch("target_delivery")
strict_keys(target_delivery, %w[bucket key sha256 version_id], "target_delivery")
delivery_raw = File.binread(delivery_path)
fail_closed("复证没有绑定当前 latest delivery") unless target_delivery == {
  "bucket" => ENV.fetch("AWS_TERRAFORM_DELIVERY_BUCKET"),
  "key" => ENV.fetch("AWS_TERRAFORM_DELIVERY_KEY"),
  "version_id" => ENV.fetch("AWS_TERRAFORM_DELIVERY_VERSION_ID"),
  "sha256" => Digest::SHA256.hexdigest(delivery_raw),
}

rotation = attestation.fetch("rotation")
strict_keys(rotation, %w[active_slot hmac_key_fingerprint target_secret_name target_secret_version],
  "rotation")
expected_rotation = {
  "active_slot" => evidence.dig("rotation", "observed_active_slot"),
  "target_secret_version" => evidence.dig("rotation", "target_secret_version"),
  "target_secret_name" => delivery.fetch("valkey_secret_name"),
  "hmac_key_fingerprint" => delivery.dig("valkey_rotation_contract", "hmac_key_fingerprint"),
}
fail_closed("复证轮换目标与原证据或 latest delivery 不匹配") unless rotation == expected_rotation
fail_closed("latest delivery 不是允许发布应用的 target steady") unless
  delivery.fetch("valkey_rotation_mode") == "steady" &&
    delivery.fetch("valkey_active_slot") == rotation.fetch("active_slot") &&
    delivery.dig("valkey_rotation_contract", "published_secret_version") ==
      rotation.fetch("target_secret_version") &&
    delivery.fetch("application_release_allowed") == true &&
    delivery.fetch("maintenance_in_progress") == false &&
    delivery.dig("valkey_rotation_contract", "hmac_key_fingerprint") !=
      evidence.dig("rotation", "observed_hmac_key_fingerprint")

quiescence = attestation.fetch("quiescence")
strict_keys(quiescence, %w[api expires_at lock observed_at worker], "quiescence")
observed_at = Time.iso8601(quiescence.fetch("observed_at"))
expires_at = Time.iso8601(quiescence.fetch("expires_at"))
now = Time.at(ENV.fetch("HMAC_FINALIZE_NOW_EPOCH", Time.now.to_i.to_s).to_i).utc
fail_closed("复证观察时间来自未来") unless observed_at <= now + 60
fail_closed("复证已过期") unless now < expires_at
fail_closed("复证 TTL 必须精确为 15 分钟") unless (expires_at - observed_at).to_i == 900

lock = quiescence.fetch("lock")
strict_keys(lock, %w[name uid], "quiescence.lock")
fail_closed("复证 lock 与原证据不匹配") unless lock == evidence.dig("quiescence", "lock")

api = quiescence.fetch("api")
strict_keys(api, %w[available deployment_name desired hpa_present pod_count ready uid], "quiescence.api")
fail_closed("复证 API 身份不匹配") unless
  api.fetch("deployment_name") == evidence.dig("quiescence", "api", "deployment_name") &&
    api.fetch("uid") == evidence.dig("quiescence", "api", "uid")
fail_closed("复证 API 不是无 HPA、零副本、零 Pod") unless
  api.values_at("desired", "ready", "available", "pod_count") == [0, 0, 0, 0] &&
    api.fetch("hpa_present") == false

worker = quiescence.fetch("worker")
strict_keys(worker,
  %w[available deployment_name desired hpa_name hpa_uid pod_count ready ready_pod_count uid],
  "quiescence.worker")
evidence_worker = evidence.dig("quiescence", "worker")
%w[deployment_name uid hpa_name hpa_uid].each do |field|
  fail_closed("复证 Worker #{field} 漂移") unless worker.fetch(field) == evidence_worker.fetch(field)
end
fail_closed("复证 Worker 没有保持全部健康") unless
  worker.fetch("desired").positive? && worker.fetch("ready") == worker.fetch("desired") &&
    worker.fetch("available") == worker.fetch("desired") &&
    worker.fetch("pod_count") >= worker.fetch("desired") &&
    worker.fetch("ready_pod_count") == worker.fetch("pod_count")

puts "HMAC finalize 短时实时复证通过：#{Digest::SHA256.hexdigest(raw)}"
