#!/usr/bin/env bash
# 用真实 Helm 渲染证明 maintenance-complete 只允许 API 共享 HMAC 边界变化。
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
slots_directory=$(CDPATH='' cd -- "$script_directory/../../.." && pwd)
chart="$slots_directory/deploy/cluster-production/chart"
base_values="$slots_directory/deploy/aws-production/values.example.yaml"
fixture="$script_directory/fixtures/live-values.yaml"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/slots-hmac-diff-test.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT

fail() {
  printf '%s\n' "HMAC 单一变更 fixture 失败：$*" >&2
  exit 1
}

target_values="$temporary_directory/target-values.yaml"
ruby -ryaml -e '
  value = YAML.load_file(ARGV.fetch(0))
  value.fetch("externalSecrets").fetch("sharedAdmission")["name"] = ARGV.fetch(2)
  File.binwrite(ARGV.fetch(1), YAML.dump(value))
' "$fixture" "$target_values" slots-rgs-shared-admission-v3

current_all="$temporary_directory/current-all.yaml"
current_manifest="$temporary_directory/current-manifest.yaml"
current_hooks="$temporary_directory/current-hooks.yaml"
evidence="$temporary_directory/evidence.json"
safe="$temporary_directory/safe.yaml"
active="$temporary_directory/active.yaml"
helm template slots "$chart" --namespace slots-production --values "$base_values" --values "$fixture" --is-upgrade \
  --set rgs.maintenanceQuiesced=false > "$current_all"
helm template slots "$chart" --namespace slots-production --values "$base_values" --values "$target_values" --is-upgrade \
  --set rgs.maintenanceQuiesced=true > "$safe"
helm template slots "$chart" --namespace slots-production --values "$base_values" --values "$target_values" --is-upgrade \
  --set rgs.maintenanceQuiesced=false > "$active"
ruby -ryaml -e '
  documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
  hooks, regular = documents.partition { |item|
    item.is_a?(Hash) && !item.dig("metadata", "annotations", "helm.sh/hook").to_s.empty?
  }
  File.binwrite(ARGV.fetch(1), regular.map { |item| YAML.dump(item) }.join)
  File.binwrite(ARGV.fetch(2), hooks.map { |item| YAML.dump(item) }.join)
' "$current_all" "$current_manifest" "$current_hooks"
ruby -ryaml -rjson -e '
  documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
  hpa = documents.find { |item| item["kind"] == "HorizontalPodAutoscaler" &&
    item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" }
  abort "找不到 API HPA" unless hpa
  File.binwrite(ARGV.fetch(1), JSON.generate(hpa))
' "$current_manifest" "$temporary_directory/hpa.json"
hpa_sha=$(jq -j -S -c '.spec' "$temporary_directory/hpa.json" | sha256sum | awk '{ print $1 }')
jq -n --slurpfile hpa "$temporary_directory/hpa.json" --arg sha "$hpa_sha" '{
  quiescence: {api: {hpa_restore_manifest: $hpa[0], hpa_spec_sha256: $sha}}
}' > "$evidence"

ruby "$script_directory/verify-hmac-only-release-diff.rb" safe \
  "$current_manifest" "$current_hooks" "$safe" slots-rgs-shared-admission-v3 1 "$evidence" >/dev/null
ruby "$script_directory/verify-hmac-only-release-diff.rb" active \
  "$current_manifest" "$current_hooks" "$active" slots-rgs-shared-admission-v3 1 "$evidence" >/dev/null

mutate_and_reject() {
  label=$1
  expression=$2
  source=$3
  output="$temporary_directory/mutated-${label}.yaml"
  ruby -ryaml -e '
    documents = YAML.load_stream(File.binread(ARGV.fetch(0))).compact
    eval(ARGV.fetch(2), binding, "fixture-mutation", 1)
    File.binwrite(ARGV.fetch(1), documents.map { |item| YAML.dump(item) }.join)
  ' "$source" "$output" "$expression"
  if ruby "$script_directory/verify-hmac-only-release-diff.rb" \
    "$(test "$source" = "$safe" && printf safe || printf active)" \
    "$current_manifest" "$current_hooks" "$output" slots-rgs-shared-admission-v3 1 "$evidence" \
    >/dev/null 2>&1; then
    fail "$label 漂移仍通过 HMAC 单一变更门禁"
  fi
}

mutate_and_reject worker-image '
  worker = documents.find { |item| item["kind"] == "Deployment" &&
    item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs-worker" }
  worker.dig("spec", "template", "spec", "containers").first["image"] = "invalid.example/worker@sha256:" + "f" * 64
' "$safe"
mutate_and_reject definition '
  api = documents.find { |item| item["kind"] == "Deployment" &&
    item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" }
  api.dig("spec", "template", "metadata", "annotations")["slots-game.io/definition-version"] = "drifted"
' "$safe"
mutate_and_reject migrator-hook '
  hook = documents.find { |item| !item.dig("metadata", "annotations", "helm.sh/hook").to_s.empty? }
  hook["metadata"]["annotations"]["fixture-drift"] = "true"
' "$safe"
mutate_and_reject api-hpa '
  hpa = documents.find { |item| item["kind"] == "HorizontalPodAutoscaler" &&
    item.dig("metadata", "labels", "app.kubernetes.io/component") == "rgs" }
  hpa["spec"]["maxReplicas"] += 1
' "$active"

jq '.quiescence.api.hpa_restore_manifest.spec.maxReplicas += 1' "$evidence" > \
  "$temporary_directory/hpa-drift-evidence.json"
if ruby "$script_directory/verify-hmac-only-release-diff.rb" safe \
  "$current_manifest" "$current_hooks" "$safe" slots-rgs-shared-admission-v3 1 \
  "$temporary_directory/hpa-drift-evidence.json" >/dev/null 2>&1; then
  fail 'live HPA spec 漂移仍通过旧 Helm manifest 单一变更门禁'
fi

printf '%s\n' 'HMAC 单一变更、Worker/定义/Migrator/HPA 负向 fixture 通过。'
