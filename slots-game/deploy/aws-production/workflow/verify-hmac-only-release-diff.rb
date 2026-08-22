#!/usr/bin/env ruby
# 验证 HMAC maintenance 候选与当前 Helm release 之间只有 API 共享准入凭据和停机形态差异。
require "yaml"
require "json"
require "digest"

def fail_closed(message)
  warn "HMAC 单一变更门禁失败：#{message}"
  exit 1
end

mode, current_manifest_path, current_hooks_path, candidate_path, target_secret, old_version, evidence_path = ARGV
fail_closed("参数不完整") unless %w[safe active].include?(mode) && ARGV.length == 7
fail_closed("target Secret 名称不合法") unless target_secret.match?(/-v[1-9][0-9]*\z/)
fail_closed("旧 Secret 版本不合法") unless old_version.match?(/\A[1-9][0-9]*\z/)

load_documents = lambda do |path|
  YAML.load_stream(File.binread(path)).compact.select { |item| item.is_a?(Hash) && item["kind"] }
rescue StandardError => error
  fail_closed("无法解析 #{File.basename(path)}：#{error.message}")
end

resource_key = lambda do |document|
  metadata = document.fetch("metadata")
  [document.fetch("apiVersion"), document.fetch("kind"), metadata.fetch("namespace", ""), metadata.fetch("name")]
rescue KeyError
  fail_closed("manifest 存在缺少资源身份的文档")
end

index_documents = lambda do |documents, label|
  result = {}
  documents.each do |document|
    key = resource_key.call(document)
    fail_closed("#{label} 存在重复资源 #{key.join("/")}") if result.key?(key)
    result[key] = document
  end
  result
end

hook = lambda do |document|
  document.dig("metadata", "annotations", "helm.sh/hook").to_s != ""
end

current_regular = index_documents.call(load_documents.call(current_manifest_path).reject(&hook), "当前 manifest")
current_hooks = load_documents.call(current_hooks_path)
candidate_documents = load_documents.call(candidate_path)
candidate_regular = index_documents.call(candidate_documents.reject(&hook), "候选 manifest")
candidate_hooks = candidate_documents.select(&hook)
fail_closed("当前 hooks 文件含非 hook 资源") unless current_hooks.all?(&hook)
canonicalize = lambda do |value|
  case value
  when Hash
    value.keys.sort.each_with_object({}) { |key, result| result[key] = canonicalize.call(value.fetch(key)) }
  when Array
    value.map { |item| canonicalize.call(item) }
  else
    value
  end
end
current_hook_set = current_hooks.map { |item| JSON.generate(canonicalize.call(item)) }.sort
candidate_hook_set = candidate_hooks.map { |item| JSON.generate(canonicalize.call(item)) }.sort
fail_closed("Migrator/Helm hooks 与当前成功 release 不同") unless candidate_hook_set == current_hook_set

find_component = lambda do |documents, kind, component|
  matches = documents.select do |_key, document|
    document["kind"] == kind &&
      document.dig("metadata", "labels", "app.kubernetes.io/component") == component
  end
  fail_closed("#{kind}/#{component} 数量不是 1") unless matches.length == 1
  matches.first
end

current_api_key, current_api = find_component.call(current_regular, "Deployment", "rgs")
candidate_api_key, candidate_api = find_component.call(candidate_regular, "Deployment", "rgs")
fail_closed("API Deployment 身份发生变化") unless current_api_key == candidate_api_key
current_hpa_key, current_hpa = find_component.call(current_regular, "HorizontalPodAutoscaler", "rgs")
begin
  evidence = JSON.parse(File.binread(evidence_path))
  evidence_hpa = evidence.fetch("quiescence").fetch("api").fetch("hpa_restore_manifest")
  evidence_hpa_sha = evidence.fetch("quiescence").fetch("api").fetch("hpa_spec_sha256")
rescue StandardError => error
  fail_closed("无法读取 HPA 证据：#{error.message}")
end
fail_closed("证据 HPA 身份与当前 Helm manifest 不一致") unless
  evidence_hpa["apiVersion"] == current_hpa["apiVersion"] && evidence_hpa["kind"] == current_hpa["kind"] &&
    evidence_hpa.dig("metadata", "name") == current_hpa.dig("metadata", "name") &&
    evidence_hpa.fetch("spec") == current_hpa.fetch("spec")
canonical_hpa_spec = JSON.generate(canonicalize.call(evidence_hpa.fetch("spec")))
fail_closed("证据 HPA spec SHA 与当前 Helm manifest 不一致") unless
  Digest::SHA256.hexdigest(canonical_hpa_spec) == evidence_hpa_sha
candidate_api_hpas = candidate_regular.select do |_key, document|
  document["kind"] == "HorizontalPodAutoscaler" &&
    document.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs"
end

expected_candidate_keys = current_regular.keys.dup
if mode == "safe"
  fail_closed("安全 Phase A 仍包含 API HPA") unless candidate_api_hpas.empty?
  expected_candidate_keys.delete(current_hpa_key)
else
  fail_closed("Phase B 的 API HPA 数量不是 1") unless candidate_api_hpas.length == 1
  candidate_hpa_key, candidate_hpa = candidate_api_hpas.first
  fail_closed("Phase B API HPA 身份或内容改变") unless candidate_hpa_key == current_hpa_key && candidate_hpa == current_hpa
end
fail_closed("候选资源集合包含 HMAC 维护范围外变化") unless candidate_regular.keys.sort == expected_candidate_keys.sort

(expected_candidate_keys - [current_api_key, current_hpa_key]).each do |key|
  fail_closed("HMAC maintenance 混入其他资源变化：#{key.join("/")}") unless
    candidate_regular.fetch(key) == current_regular.fetch(key)
end

extract_api_boundary = lambda do |deployment|
  containers = deployment.dig("spec", "template", "spec", "containers") || []
  rgs = containers.select { |item| item["name"] == "rgs" }
  fail_closed("API 主容器数量不是 1") unless rgs.length == 1
  username = (rgs.first["env"] || []).select { |item| item["name"] == "RGS_SHARED_ADMISSION_USERNAME" }
  fail_closed("USERNAME SecretKeyRef 数量不是 1") unless username.length == 1
  volumes = deployment.dig("spec", "template", "spec", "volumes") || []
  source = volumes.select { |item| item["name"] == "shared-admission-source" }
  fail_closed("共享准入 Secret volume 数量不是 1") unless source.length == 1
  env_secret = username.first.dig("valueFrom", "secretKeyRef", "name")
  volume_secret = source.first.dig("secret", "secretName")
  fail_closed("USERNAME 与 volume 没有引用同一个 Secret") unless env_secret == volume_secret
  runtime_hash = deployment.dig("spec", "template", "metadata", "annotations",
    "slots-game.io/runtime-secret-references")
  fail_closed("API runtime Secret 摘要不合法") unless runtime_hash.to_s.match?(/\A[0-9a-f]{64}\z/)
  [env_secret, runtime_hash]
end

current_secret, current_runtime_hash = extract_api_boundary.call(current_api)
candidate_secret, candidate_runtime_hash = extract_api_boundary.call(candidate_api)
fail_closed("当前 API Secret 版本与证据不一致") unless current_secret.end_with?("-v#{old_version}")
fail_closed("候选 API 没有引用 target Secret") unless candidate_secret == target_secret
fail_closed("HMAC Secret 变化没有改变 API runtime 摘要") if candidate_runtime_hash == current_runtime_hash

current_maintenance = current_api.dig("spec", "template", "metadata", "annotations",
  "slots-game.io/hmac-maintenance-quiesced")
candidate_maintenance = candidate_api.dig("spec", "template", "metadata", "annotations",
  "slots-game.io/hmac-maintenance-quiesced")
fail_closed("当前成功 release 已处于 maintenanceQuiesced") unless current_maintenance == "false"
if mode == "safe"
  fail_closed("Phase A 没有固定 replicas=0") unless candidate_api.dig("spec", "replicas") == 0
  fail_closed("Phase A 缺少 maintenanceQuiesced=true") unless candidate_maintenance == "true"
else
  fail_closed("Phase B 不得固定 API replicas") if candidate_api.fetch("spec").key?("replicas")
  fail_closed("Phase B 必须显式 maintenanceQuiesced=false") unless candidate_maintenance == "false"
end

normalized_candidate = Marshal.load(Marshal.dump(candidate_api))
normalized_current = Marshal.load(Marshal.dump(current_api))
if mode == "safe"
  normalized_candidate.fetch("spec").delete("replicas")
end
candidate_annotations = normalized_candidate.dig("spec", "template", "metadata", "annotations")
current_annotations = normalized_current.dig("spec", "template", "metadata", "annotations")
candidate_annotations["slots-game.io/hmac-maintenance-quiesced"] =
  current_annotations["slots-game.io/hmac-maintenance-quiesced"]
candidate_annotations["slots-game.io/runtime-secret-references"] =
  current_annotations["slots-game.io/runtime-secret-references"]

normalized_candidate.dig("spec", "template", "spec", "containers").each do |container|
  next unless container["name"] == "rgs"
  container.fetch("env").each do |item|
    next unless item["name"] == "RGS_SHARED_ADMISSION_USERNAME"
    item.dig("valueFrom", "secretKeyRef")["name"] = current_secret
  end
end
normalized_candidate.dig("spec", "template", "spec", "volumes").each do |volume|
  next unless volume["name"] == "shared-admission-source"
  volume.fetch("secret")["secretName"] = current_secret
end
fail_closed("API Deployment 混入共享 HMAC 边界以外变化") unless normalized_candidate == normalized_current

puts "HMAC #{mode} 候选只包含允许的 API Secret 与停机形态差异。"
